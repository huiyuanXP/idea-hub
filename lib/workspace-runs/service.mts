import { createHash,randomBytes,randomUUID } from 'node:crypto';
import type { LocalDatabase,SqlValue } from '../database.mts';
import type { ConnectorPrincipal,OwnerAction,PrepareInput,RunRow,WorkspaceEvent,WorkspaceRun } from './types.mts';
import { evidence,integer,invalid,logText,object,text,WorkspaceError } from './validation.mts';
import { dependencyKeys } from '../tickets/dependencies.mts';
import { notifyRun } from './notify.mts';

export const WORKSPACE_LEASE_MS=30000;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const redact=(value:string)=>value.replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/\b(sk-[A-Za-z0-9_-]+)\b/g,'[redacted]');
// These predicates execute at the write boundary, after all asynchronous reads.
export const connectionScope=`EXISTS(SELECT 1 FROM workspace_connections c JOIN workspace_projects p ON p.id=c.project_id AND p.owner=c.owner
 WHERE c.id=workspace_runs.connection_id AND c.owner=workspace_runs.owner AND c.project_id=workspace_runs.project_id
 AND p.name=workspace_runs.project AND c.workspace=workspace_runs.workspace AND c.revoked_at IS NULL AND c.token_expires_at>?
 AND EXISTS(SELECT 1 FROM json_each(c.capabilities) WHERE value='execute'))`;
const ticketScope=`EXISTS(SELECT 1 FROM records t WHERE t.id=workspace_runs.ticket_id AND t.owner=workspace_runs.owner AND t.kind='ticket'
 AND t.revision=workspace_runs.ticket_revision AND t.body=workspace_runs.ticket_body
 AND COALESCE(NULLIF(json_extract(t.body,'$.project'),''),'通用')=workspace_runs.project)`;
export const scope=`${connectionScope} AND ${ticketScope}`;

export async function row(db:LocalDatabase,owner:string,id:string):Promise<RunRow> {
 text(id);const found=await db.prepare('SELECT * FROM workspace_runs WHERE owner=? AND id=?').bind(owner,id).first<RunRow>();
 if(!found)throw new WorkspaceError(404,'Workspace Run not found','NOT_FOUND');return found;
}
async function dto(db:LocalDatabase,run:RunRow,eventAfter=0,eventLimit=200):Promise<WorkspaceRun> {
 const events=await db.prepare('SELECT id,sequence,stage,message,created_at AS createdAt FROM workspace_run_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?')
  .bind(run.id,eventAfter,eventLimit+1).all<WorkspaceEvent>();
 const selected=events.results.slice(0,eventLimit);
 return {id:run.id,ticketId:run.ticket_id,revision:run.ticket_revision,connectionId:run.connection_id,project:run.project,state:run.state,
  createdAt:run.created_at,updatedAt:run.updated_at,timeoutMs:run.timeout_ms,error:run.error,result:run.result===null?null:JSON.parse(run.result),
  events:selected,eventsCursor:events.results.length>eventLimit?selected.at(-1)!.sequence:null,workspace:run.workspace,operation:run.operation};
}
export async function getWorkspaceRun(db:LocalDatabase,owner:string,id:string,eventAfter=0,eventLimit=200) {
 integer(eventAfter,0,Number.MAX_SAFE_INTEGER,'event cursor');integer(eventLimit,1,500,'event limit');
 return dto(db,await row(db,owner,id),eventAfter,eventLimit);
}
function cursorContext(owner:string,ticketId:string|undefined){return hash(JSON.stringify([owner,ticketId??null]));}
export async function listWorkspaceRuns(db:LocalDatabase,owner:string,input:{ticketId?:string;limit?:number;cursor?:string;eventAfter?:number;eventLimit?:number}={}) {
 const {ticketId,cursor,eventAfter=0,eventLimit=200}=input,limit=input.limit??20;
 if(ticketId!==undefined)text(ticketId);integer(limit,1,100,'limit');integer(eventAfter,0,Number.MAX_SAFE_INTEGER,'event cursor');integer(eventLimit,1,500,'event limit');
 const clauses=['owner=?'],params:SqlValue[]=[owner];
 if(ticketId!==undefined){clauses.push('ticket_id=?');params.push(ticketId);}
 if(cursor!==undefined){
  text(cursor,2048,'cursor');
  try {
   const decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));object(decoded,['context','createdAt','id']);
   integer(decoded.createdAt,0,Number.MAX_SAFE_INTEGER);text(decoded.id);
   if(decoded.context!==cursorContext(owner,ticketId) || Buffer.from(JSON.stringify(decoded)).toString('base64url')!==cursor)invalid();
   clauses.push('(created_at<? OR (created_at=? AND id<?))');params.push(decoded.createdAt,decoded.createdAt,decoded.id);
  }catch{invalid('Invalid workspace cursor');}
 }
 const records=await db.prepare(`SELECT * FROM workspace_runs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`).bind(...params,limit+1).all<RunRow>();
 const selected=records.results.slice(0,limit),last=selected.at(-1);
 return {runs:await Promise.all(selected.map(run=>dto(db,run,eventAfter,eventLimit))),nextCursor:records.results.length>limit&&last?
  Buffer.from(JSON.stringify({context:cursorContext(owner,ticketId),createdAt:last.created_at,id:last.id})).toString('base64url'):null};
}

/** Expiry never requeues a started Run. Physical occupancy survives lease loss until the hard deadline. */
export async function reconcile(db:LocalDatabase,owner:string,now:number) {
 await db.batch([
  db.prepare(`UPDATE workspace_runs SET state='failed',cancel_requested=1,error=CASE WHEN deadline_at<=? THEN 'Execution timeout' WHEN lease_expires_at<=? THEN 'Agent lease expired' ELSE 'Ticket or connection scope changed' END,
   version=version+1,updated_at=? WHERE owner=? AND state IN ('pending','approved','running','review') AND
   (NOT (${scope}) OR (state='running' AND (lease_expires_at<=? OR deadline_at<=?)))`).bind(now,now,now,owner,now,now,now),
  db.prepare(`UPDATE workspace_runs SET physical_closed_at=?,version=version+1,updated_at=? WHERE owner=? AND generation>0 AND physical_closed_at IS NULL AND deadline_at<=?`).bind(now,now,owner,now),
 ]);
}
async function prepare(db:LocalDatabase,owner:string,input:PrepareInput,previous:string|null=null) {
 object(input,['ticketId','revision','connectionId','requestId','timeoutMs']);
 const copied={...input};text(copied.ticketId);text(copied.connectionId);text(copied.requestId,128,'request ID');
 if(!/^[A-Za-z0-9._:-]+$/.test(copied.requestId))invalid('Invalid request ID');
 integer(copied.revision,1,Number.MAX_SAFE_INTEGER,'revision');integer(copied.timeoutMs,1000,3600000,'timeout');
 const key=JSON.stringify([copied.ticketId,copied.revision,copied.connectionId,copied.timeoutMs,previous]);
 const existing=await db.prepare('SELECT * FROM workspace_runs WHERE owner=? AND request_id=?').bind(owner,copied.requestId).first<RunRow>();
 if(existing){if(existing.input_key!==key)throw new WorkspaceError(409,'Request ID reused with a different contract','REQUEST_CONFLICT');return dto(db,existing);}
 const now=Date.now();await reconcile(db,owner,now);const id=randomUUID();
 try {
  const result=await db.prepare(`INSERT INTO workspace_runs(id,owner,ticket_id,ticket_revision,ticket_body,connection_id,project_id,project,workspace,request_id,input_key,previous_run_id,timeout_ms,created_at,updated_at)
   SELECT ?,t.owner,t.id,t.revision,t.body,c.id,c.project_id,p.name,c.workspace,?,?,?,?,?,?
   FROM records t JOIN workspace_connections c ON c.owner=t.owner JOIN workspace_projects p ON p.id=c.project_id AND p.owner=c.owner
   WHERE t.id=? AND t.owner=? AND t.kind='ticket' AND t.revision=? AND length(t.body)<=80000
   AND COALESCE(NULLIF(json_extract(t.body,'$.project'),''),'通用')=p.name AND COALESCE(json_extract(t.body,'$.status'),'')<>'done'
   AND c.id=? AND c.revoked_at IS NULL AND c.token_expires_at>? AND EXISTS(SELECT 1 FROM json_each(c.capabilities) WHERE value='execute')`)
   .bind(id,copied.requestId,key,previous,copied.timeoutMs,now,now,copied.ticketId,owner,copied.revision,copied.connectionId,now).run();
  if(result.meta.changes!==1)throw new WorkspaceError(409,'Ticket revision or executable project connection is unavailable','SCOPE_CONFLICT');
 }catch(error){
  if(error instanceof WorkspaceError)throw error;
  const retry=await db.prepare('SELECT * FROM workspace_runs WHERE owner=? AND request_id=?').bind(owner,copied.requestId).first<RunRow>();
  if(retry){if(retry.input_key!==key)throw new WorkspaceError(409,'Request ID reused with a different contract','REQUEST_CONFLICT');return dto(db,retry);}
  if(String(error).includes('UNIQUE constraint'))throw new WorkspaceError(409,'Ticket already has an active workspace Run','ACTIVE_RUN');throw error;
 }
 return getWorkspaceRun(db,owner,id);
}
export async function prepareWorkspaceRun(db:LocalDatabase,owner:string,input:PrepareInput){return prepare(db,owner,input);}

export async function decideWorkspaceRun(db:LocalDatabase,owner:string,id:string,action:OwnerAction) {
 text(id);if(!['approve','reject','cancel','accept','rework'].includes(action))invalid();
 const now=Date.now(),run=await row(db,owner,id);
 if(action==='rework'){
  // Stable link and request key make a lost response safe to retry; earlier evidence stays immutable.
  const successor=await db.prepare('SELECT * FROM workspace_runs WHERE owner=? AND previous_run_id=?').bind(owner,id).first<RunRow>();
  if(successor)return dto(db,successor);
  if(!['review','failed','cancelled'].includes(run.state))throw new WorkspaceError(409,'Only reviewed or stopped Runs can be reworked');
  if(run.state==='review')await decideWorkspaceRun(db,owner,id,'cancel');
  const ticket=await db.prepare("SELECT revision FROM records WHERE owner=? AND id=? AND kind='ticket'").bind(owner,run.ticket_id).first<{revision:number}>();
  if(!ticket)throw new WorkspaceError(404,'Ticket not found','NOT_FOUND');
  return prepare(db,owner,{ticketId:run.ticket_id,revision:ticket.revision,connectionId:run.connection_id,requestId:`rework:${id}`,timeoutMs:run.timeout_ms},id);
 }
 const destination=action==='approve'?'approved':action==='accept'?'succeeded':'cancelled';
 if(run.state===destination && (action==='cancel' || action==='approve' || action==='accept'))return dto(db,run);
 const allowed=action==='approve'||action==='reject'?['pending']:action==='accept'?['review']:['pending','approved','running','review'];
 if(!allowed.includes(run.state))throw new WorkspaceError(409,'Workspace Run decision is no longer available');
 const requiresScope=action==='approve'||action==='accept';
 const updated=await db.batch([
  db.prepare(`UPDATE workspace_runs SET state=?,cancel_requested=CASE WHEN ?='cancelled' THEN 1 ELSE cancel_requested END,
   error=CASE WHEN ?='reject' THEN 'Owner rejected development' ELSE error END,version=version+1,updated_at=?
   WHERE owner=? AND id=? AND version=? AND state=? ${requiresScope?`AND ${scope}`:''}`)
   .bind(destination,destination,action,now,owner,id,run.version,run.state,...(requiresScope?[now]:[])),
  db.prepare(`INSERT INTO workspace_run_decisions(run_id,version,actor,action,created_at) SELECT id,version,?,?,? FROM workspace_runs WHERE owner=? AND id=? AND version=? AND state=?
   AND NOT EXISTS(SELECT 1 FROM workspace_run_decisions WHERE run_id=workspace_runs.id AND version=workspace_runs.version)`)
   .bind(owner,action,now,owner,id,run.version+1,destination),
 ]);
 if(updated[0].meta.changes!==1){
  const current=await row(db,owner,id);
  if(current.state===destination && ['approve','cancel','accept'].includes(action))return dto(db,current);
  throw new WorkspaceError(409,'Ticket revision, connection or Run state changed','SCOPE_CONFLICT');
 }
 notifyRun(id);return getWorkspaceRun(db,owner,id);
}

export function principal(input:ConnectorPrincipal) {
 if(!input.capabilities.includes('execute'))throw new WorkspaceError(403,'Connector execution capability required','CAPABILITY_DENIED');
 return {...input,capabilities:[...input.capabilities]};
}
async function dependencies(db:LocalDatabase,run:RunRow):Promise<string[]|null> {
 const body=JSON.parse(run.ticket_body) as Record<string,unknown>,keys=dependencyKeys(body.dependencies);
 if(keys===null)return null;
 const ids:string[]=[];
 for(const key of keys){
  const lookup=(value:string)=>db.prepare(`SELECT id,json_extract(body,'$.status') AS status FROM records WHERE owner=? AND kind='ticket' AND id<>? AND COALESCE(NULLIF(json_extract(body,'$.project'),''),'通用')=?
   AND (id=? OR (json_extract(body,'$.logicalKey')=? AND json_extract(body,'$.planId')=?)) LIMIT 2`)
   .bind(run.owner,run.ticket_id,run.project,value,value,typeof body.planId==='string'?body.planId:null).all<{id:string;status:string}>();
  let candidates=await lookup(key);
  // Sentence punctuation is optional, but an exact Ticket ID or logical key takes precedence.
  if(candidates.results.length===0 && /[.。]$/.test(key))candidates=await lookup(key.slice(0,-1));
  if(candidates.results.length!==1 || candidates.results[0].status!=='done')return null;ids.push(candidates.results[0].id);
 }
 return ids;
}
export async function claimWorkspaceRun(db:LocalDatabase,identity:ConnectorPrincipal) {
 const actor=principal(identity),now=Date.now();await reconcile(db,actor.owner,now);
 const candidates=await db.prepare(`SELECT * FROM workspace_runs WHERE owner=? AND connection_id=? AND project_id=? AND project=? AND state='approved' ORDER BY created_at,id LIMIT 100`)
  .bind(actor.owner,actor.id,actor.projectId,actor.project).all<RunRow>();
 for(const run of candidates.results){
  const deps=await dependencies(db,run);
  if(deps===null){
   await db.prepare(`INSERT OR IGNORE INTO workspace_run_events(run_id,id,sequence,stage,message,created_at)
    SELECT id,'system:dependencies',COALESCE((SELECT MAX(sequence) FROM workspace_run_events WHERE run_id=workspace_runs.id),0)+1,'waiting','Waiting for required project Ticket dependencies to be done',?
    FROM workspace_runs WHERE owner=? AND id=? AND connection_id=? AND project_id=? AND project=? AND state='approved' AND ${scope}`)
    .bind(now,actor.owner,run.id,actor.id,actor.projectId,actor.project,now).run();
   continue;
  }
  const leaseToken=randomBytes(32).toString('base64url'),deadline=now+run.timeout_ms,leaseExpiresAt=Math.min(now+WORKSPACE_LEASE_MS,deadline);
  const depGuard=deps.map(()=>`EXISTS(SELECT 1 FROM records d WHERE d.owner=workspace_runs.owner AND d.kind='ticket' AND d.id=? AND json_extract(d.body,'$.status')='done'
   AND COALESCE(NULLIF(json_extract(d.body,'$.project'),''),'通用')=workspace_runs.project)`).join(' AND ');
  try {
   const updated=await db.prepare(`UPDATE workspace_runs SET state='running',generation=generation+1,lease_hash=?,lease_expires_at=?,deadline_at=?,version=version+1,updated_at=?
    WHERE owner=? AND id=? AND connection_id=? AND project_id=? AND project=? AND state='approved' AND generation=0 AND cancel_requested=0 AND ${scope}
    AND NOT EXISTS(SELECT 1 FROM workspace_runs held WHERE held.owner=workspace_runs.owner AND held.ticket_id=workspace_runs.ticket_id AND held.generation>0 AND held.physical_closed_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM workspace_runs held WHERE held.connection_id=workspace_runs.connection_id AND held.generation>0 AND held.physical_closed_at IS NULL)
    ${depGuard?`AND ${depGuard}`:''}`).bind(hash(leaseToken),leaseExpiresAt,deadline,now,actor.owner,run.id,actor.id,actor.projectId,actor.project,now,...deps).run();
   if(updated.meta.changes===1){notifyRun(run.id);return {job:{id:run.id,leaseToken,ticketId:run.ticket_id,revision:run.ticket_revision,body:JSON.parse(run.ticket_body),leaseExpiresAt,timeoutMs:run.timeout_ms}};}
  }catch(error){if(!String(error).includes('UNIQUE constraint'))throw error;}
 }
 return {job:null};
}
export async function machineRun(db:LocalDatabase,actor:ConnectorPrincipal,id:string,leaseToken:string) {
 text(id);text(leaseToken,200,'lease token');
 const run=await row(db,actor.owner,id);
 if(run.connection_id!==actor.id || run.project_id!==actor.projectId || run.project!==actor.project || run.lease_hash!==hash(leaseToken))throw new WorkspaceError(409,'Workspace lease does not belong to this connector','LEASE_CONFLICT');
 return run;
}
export const machineScope='owner=? AND id=? AND connection_id=? AND project_id=? AND project=? AND lease_hash=? AND generation=?';
export function machineParams(actor:ConnectorPrincipal,run:RunRow,token:string):SqlValue[]{return [actor.owner,run.id,actor.id,actor.projectId,actor.project,hash(token),run.generation];}
export async function renewWorkspaceRun(db:LocalDatabase,identity:ConnectorPrincipal,id:string,leaseToken:string) {
 const actor=principal(identity),now=Date.now();await reconcile(db,actor.owner,now);const run=await machineRun(db,actor,id,leaseToken);
 if(run.cancel_requested || run.state==='cancelled' || run.state==='failed')return {leaseExpiresAt:run.lease_expires_at,cancelRequested:true};
 const leaseExpiresAt=Math.min(now+WORKSPACE_LEASE_MS,run.deadline_at??0);
 const result=await db.prepare(`UPDATE workspace_runs SET lease_expires_at=?,version=version+1,updated_at=? WHERE ${machineScope}
  AND state='running' AND cancel_requested=0 AND physical_closed_at IS NULL AND lease_expires_at>? AND deadline_at>? AND ${scope}`)
  .bind(leaseExpiresAt,now,...machineParams(actor,run,leaseToken),now,now,now).run();
 if(result.meta.changes!==1)throw new WorkspaceError(409,'Workspace lease expired or scope changed','LEASE_CONFLICT');
 const pending=await db.prepare("SELECT count(*) AS count FROM workspace_run_inputs WHERE run_id=? AND state='queued'").bind(run.id).first<{count:number}>();
 return {leaseExpiresAt,cancelRequested:false,pendingInputs:pending?.count??0};
}
export async function eventWorkspaceRun(db:LocalDatabase,identity:ConnectorPrincipal,id:string,leaseToken:string,input:{eventId:string;stage:string;message:string}) {
 object(input,['eventId','stage','message']);const copied={...input};text(copied.eventId,128,'event ID');text(copied.stage,64,'event stage');
 if(copied.eventId.startsWith('state:') || copied.eventId.startsWith('system:'))invalid('Event ID uses a reserved system namespace');
 if(typeof copied.message!=='string' || copied.message.length>4000)invalid('Invalid event message');
 copied.message=redact(copied.message);
 const actor=principal(identity),now=Date.now(),run=await machineRun(db,actor,id,leaseToken);
 const old=await db.prepare('SELECT stage,message FROM workspace_run_events WHERE run_id=? AND id=?').bind(id,copied.eventId).first<{stage:string;message:string}>();
 if(old && (old.stage!==copied.stage || old.message!==copied.message))throw new WorkspaceError(409,'Event ID reused with different content','EVENT_CONFLICT');
 const result=await db.prepare(`INSERT INTO workspace_run_events(run_id,id,sequence,stage,message,created_at)
  SELECT id,?,COALESCE((SELECT MAX(sequence) FROM workspace_run_events WHERE run_id=?),0)+1,?,?,? FROM workspace_runs WHERE ${machineScope}
  AND state='running' AND cancel_requested=0 AND lease_expires_at>? AND deadline_at>? AND ${scope}
  AND (SELECT count(*) FROM workspace_run_events WHERE run_id=workspace_runs.id)<2000
  AND NOT EXISTS(SELECT 1 FROM workspace_run_events WHERE run_id=workspace_runs.id AND id=?)`)
  .bind(copied.eventId,id,copied.stage,copied.message,now,...machineParams(actor,run,leaseToken),now,now,now,copied.eventId).run();
 if(result.meta.changes!==1){
  const stored=await db.prepare('SELECT stage,message FROM workspace_run_events WHERE run_id=? AND id=?').bind(id,copied.eventId).first<{stage:string;message:string}>();
  if(!stored)throw new WorkspaceError(409,'Workspace lease expired, cancelled, or event limit reached','LEASE_CONFLICT');
  if(stored.stage!==copied.stage || stored.message!==copied.message)throw new WorkspaceError(409,'Event ID reused with different content','EVENT_CONFLICT');
  const live=await db.prepare(`SELECT id FROM workspace_runs WHERE ${machineScope} AND state='running' AND cancel_requested=0 AND lease_expires_at>? AND deadline_at>? AND ${scope}`)
   .bind(...machineParams(actor,run,leaseToken),now,now,now).first();
  if(!live)throw new WorkspaceError(409,'Workspace lease expired or cancelled','LEASE_CONFLICT');
 }
 return {event:await db.prepare('SELECT id,sequence,stage,message,created_at AS createdAt FROM workspace_run_events WHERE run_id=? AND id=?').bind(id,copied.eventId).first<WorkspaceEvent>()};
}
/** A completion is a stopped-process acknowledgement and a candidate for independent owner acceptance. */
export async function completeWorkspaceRun(db:LocalDatabase,identity:ConnectorPrincipal,id:string,leaseToken:string,input:unknown) {
 const result=evidence(input),serialized=JSON.stringify(result),actor=principal(identity),now=Date.now(),run=await machineRun(db,actor,id,leaseToken);
 if(run.state==='review' && run.result===serialized){
  const live=await db.prepare(`SELECT id FROM workspace_runs WHERE ${machineScope} AND ${scope}`).bind(...machineParams(actor,run,leaseToken),now).first();
  if(live)return {run:await dto(db,run)};
 }
 const updated=await db.prepare(`UPDATE workspace_runs SET state='review',result=?,physical_closed_at=?,version=version+1,updated_at=?
  WHERE ${machineScope} AND state='running' AND cancel_requested=0 AND physical_closed_at IS NULL AND lease_expires_at>? AND deadline_at>? AND ${scope}`)
  .bind(serialized,now,now,...machineParams(actor,run,leaseToken),now,now,now).run();
 if(updated.meta.changes!==1){
  const current=await row(db,actor.owner,id);
  if(current.state==='review' && current.result===serialized){
   const live=await db.prepare(`SELECT id FROM workspace_runs WHERE ${machineScope} AND ${scope}`).bind(...machineParams(actor,current,leaseToken),now).first();
   if(live)return {run:await dto(db,current)};
  }
  throw new WorkspaceError(409,'Result cannot be delivered after lease, revision or approval loss','LEASE_CONFLICT');
 }
 notifyRun(id);return {run:await getWorkspaceRun(db,actor.owner,id)};
}
export async function failWorkspaceRun(db:LocalDatabase,identity:ConnectorPrincipal,id:string,leaseToken:string,error:string) {
 logText(error,4000,'failure summary');error=redact(error);const actor=principal(identity),now=Date.now(),run=await machineRun(db,actor,id,leaseToken);
 // Closing a cancelled/expired process cannot grant result authority or restart permission.
 if(run.physical_closed_at!==null && ['failed','cancelled'].includes(run.state))return {run:await dto(db,run)};
 const updated=await db.prepare(`UPDATE workspace_runs SET state=CASE WHEN state='cancelled' THEN 'cancelled' ELSE 'failed' END,
  error=COALESCE(error,?),cancel_requested=1,physical_closed_at=?,version=version+1,updated_at=?
  WHERE ${machineScope} AND state IN ('running','failed','cancelled') AND physical_closed_at IS NULL AND ${connectionScope}`)
  .bind(error,now,now,...machineParams(actor,run,leaseToken),now).run();
 if(updated.meta.changes!==1)throw new WorkspaceError(409,'Failure does not match a live process lease','LEASE_CONFLICT');
 notifyRun(id);return {run:await getWorkspaceRun(db,actor.owner,id)};
}
