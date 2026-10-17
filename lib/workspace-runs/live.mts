import { randomUUID } from 'node:crypto';
import type { LocalDatabase,SqlValue } from '../database.mts';
import { TRANSCRIPT_KINDS } from './types.mts';
import type { ConnectorPrincipal,InputMode,RunInput,RunnerCapabilities,RunRow,RunState,TranscriptEntry,TranscriptKind,TranscriptPage } from './types.mts';
import { machineParams,machineRun,machineScope,principal,reconcile,redact,row,scope } from './service.mts';
import { integer,invalid,logText,object,text,WorkspaceError } from './validation.mts';
import { notifyRun,subscribeRun } from './notify.mts';

export const TRANSCRIPT_BATCH_LIMIT=100;
export const TRANSCRIPT_ENTRY_CHARS=32000;
export const TRANSCRIPT_RUN_ENTRIES=20000;
export const TRANSCRIPT_RUN_CHARS=8*1024*1024;
export const RUN_INPUT_LIMIT=200;
export const TRANSCRIPT_LIMIT_ID='system:limit';
const LIMIT_BODY=JSON.stringify({text:'Transcript limit reached; later output omitted'});
const ENDED_REASON='Run ended before delivery';
export const TERMINAL_STATES:readonly RunState[]=['review','succeeded','failed','cancelled'];

export { notifyRun,subscribeRun };

interface TranscriptRow {id:string;sequence:number;kind:TranscriptKind;step_id:string|null;body:string;truncated:number;created_at:number}
interface InputRow {id:string;request_id:string;sequence:number;mode:InputMode;text:string;state:RunInput['state'];reason:string|null;created_at:number;updated_at:number}
interface CapabilityRow {runner:string;guide:number;interrupt:number;note:string|null;updated_at:number}
const entryDto=(item:TranscriptRow):TranscriptEntry=>({id:item.id,sequence:item.sequence,kind:item.kind,stepId:item.step_id,body:JSON.parse(item.body) as Record<string,unknown>,truncated:item.truncated===1,createdAt:item.created_at});
const inputDto=(item:InputRow):RunInput=>({id:item.id,requestId:item.request_id,sequence:item.sequence,mode:item.mode,text:item.text,state:item.state,reason:item.reason,createdAt:item.created_at,updatedAt:item.updated_at});
const capabilityDto=(item:CapabilityRow):RunnerCapabilities=>({runner:item.runner,guide:item.guide===1,interrupt:item.interrupt===1,note:item.note});

/** A machine write is only authorised while the lease, deadline and Ticket/connection scope still hold. */
const liveRun=`${machineScope} AND state='running' AND cancel_requested=0 AND lease_expires_at>? AND deadline_at>? AND ${scope}`;
const liveParams=(actor:ConnectorPrincipal,run:RunRow,token:string,now:number):SqlValue[]=>[...machineParams(actor,run,token),now,now,now];
async function assertLive(db:LocalDatabase,actor:ConnectorPrincipal,run:RunRow,token:string,now:number) {
 const live=await db.prepare(`SELECT id FROM workspace_runs WHERE ${liveRun}`).bind(...liveParams(actor,run,token,now)).first();
 if(!live)throw new WorkspaceError(409,'Workspace lease expired, cancelled or scope changed','LEASE_CONFLICT');
}

/** Inputs never outlive the running process: once a Run leaves running, undelivered/unacknowledged inputs are rejected. */
export async function settleRunInputs(db:LocalDatabase,owner:string,runId?:string):Promise<number> {
 const now=Date.now();
 const result=await db.prepare(`UPDATE workspace_run_inputs SET state='rejected',reason=?,updated_at=MAX(updated_at,?)
  WHERE state IN ('queued','delivered') AND run_id IN (SELECT id FROM workspace_runs WHERE owner=? ${runId===undefined?'':'AND id=?'} AND state<>'running')`)
  .bind(ENDED_REASON,now,owner,...(runId===undefined?[]:[runId])).run();
 return result.meta.changes;
}

function redactDeep(value:unknown):unknown {
 if(typeof value==='string')return redact(value);
 if(Array.isArray(value))return value.map(redactDeep);
 if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redactDeep(item)]));
 return value;
}
interface NormalizedEntry {id:string;kind:TranscriptKind;stepId:string|null;body:string;truncated:number}
function normalizeEntries(value:unknown):NormalizedEntry[] {
 if(!Array.isArray(value) || value.length<1 || value.length>TRANSCRIPT_BATCH_LIMIT)invalid('Transcript requires 1 to 100 entries');
 return value.map(item=>{
  object(item,['id','kind','stepId','body','truncated']);text(item.id,200,'transcript entry ID');
  if(item.id.startsWith('system:') || item.id.startsWith('input:'))invalid('Transcript entry ID uses a reserved namespace');
  // input_echo is written only by the owner input endpoint so a connector cannot forge owner guidance.
  if(typeof item.kind!=='string' || !(TRANSCRIPT_KINDS as readonly string[]).includes(item.kind) || item.kind==='input_echo')invalid('Invalid transcript kind');
  if(item.stepId!==undefined && item.stepId!==null)text(item.stepId,200,'transcript step ID');
  if(item.truncated!==undefined && typeof item.truncated!=='boolean')invalid('Invalid transcript truncation flag');
  if(!item.body || typeof item.body!=='object' || Array.isArray(item.body))invalid('Transcript body must be an object');
  const body=JSON.stringify(redactDeep(item.body));
  if(body.length>TRANSCRIPT_ENTRY_CHARS)invalid('Transcript entry body is too large');
  return {id:item.id,kind:item.kind as TranscriptKind,stepId:(item.stepId as string|null|undefined)??null,body,truncated:item.truncated===true?1:0};
 });
}
const sameEntry=(stored:TranscriptRow,entry:NormalizedEntry)=>stored.kind===entry.kind && stored.step_id===entry.stepId && stored.body===entry.body && stored.truncated===entry.truncated;
const transcriptConflict=()=>new WorkspaceError(409,'Transcript entry ID reused with different content','TRANSCRIPT_CONFLICT');

export async function appendTranscript(db:LocalDatabase,identity:ConnectorPrincipal,id:string,leaseToken:string,entries:unknown) {
 const normalized=normalizeEntries(entries),actor=principal(identity),now=Date.now(),run=await machineRun(db,actor,id,leaseToken);
 const unique=new Map<string,NormalizedEntry>();
 for(const entry of normalized){
  const prior=unique.get(entry.id);
  if(prior && (prior.kind!==entry.kind || prior.stepId!==entry.stepId || prior.body!==entry.body || prior.truncated!==entry.truncated))throw transcriptConflict();
  unique.set(entry.id,entry);
 }
 const ids=[...unique.keys()];
 const stored=await db.prepare(`SELECT * FROM workspace_run_transcript WHERE run_id=? AND id IN (${ids.map(()=>'?').join(',')})`).bind(id,...ids).all<TranscriptRow>();
 const existing=new Map(stored.results.map(item=>[item.id,item]));
 for(const [entryId,item] of existing)if(!sameEntry(item,unique.get(entryId)!))throw transcriptConflict();
 await assertLive(db,actor,run,leaseToken,now);
 const stats=await db.prepare(`SELECT count(*) AS count,COALESCE(SUM(length(body)),0) AS chars,
  EXISTS(SELECT 1 FROM workspace_run_transcript WHERE run_id=? AND id=?) AS limited FROM workspace_run_transcript WHERE run_id=?`)
  .bind(id,TRANSCRIPT_LIMIT_ID,id).first<{count:number;chars:number;limited:number}>();
 let count=stats?.count??0,chars=stats?.chars??0,limited=stats?.limited===1;
 const accepted:NormalizedEntry[]=[];
 for(const entry of unique.values()){
  if(existing.has(entry.id))continue;
  if(limited || count+1>TRANSCRIPT_RUN_ENTRIES || chars+entry.body.length>TRANSCRIPT_RUN_CHARS){limited=true;break;}
  accepted.push(entry);count+=1;chars+=entry.body.length;
 }
 const insert=(entryId:string,kind:string,stepId:string|null,body:string,truncated:number)=>db.prepare(`INSERT INTO workspace_run_transcript(run_id,id,sequence,kind,step_id,body,truncated,created_at)
  SELECT id,?,COALESCE((SELECT MAX(sequence) FROM workspace_run_transcript WHERE run_id=workspace_runs.id),0)+1,?,?,?,?,? FROM workspace_runs WHERE ${liveRun}
  AND NOT EXISTS(SELECT 1 FROM workspace_run_transcript WHERE run_id=workspace_runs.id AND id=?)`)
  .bind(entryId,kind,stepId,body,truncated,now,...liveParams(actor,run,leaseToken,now),entryId);
 const statements=accepted.map(entry=>insert(entry.id,entry.kind,entry.stepId,entry.body,entry.truncated));
 if(limited)statements.push(insert(TRANSCRIPT_LIMIT_ID,'system',null,LIMIT_BODY,1));
 const results=statements.length?await db.batch(statements):[];
 const missed=accepted.filter((_,index)=>results[index].meta.changes!==1);
 if(missed.length){
  // A concurrent identical retry may have won the race; anything else lost the lease in between.
  const raced=await db.prepare(`SELECT * FROM workspace_run_transcript WHERE run_id=? AND id IN (${missed.map(()=>'?').join(',')})`).bind(id,...missed.map(entry=>entry.id)).all<TranscriptRow>();
  const found=new Map(raced.results.map(item=>[item.id,item]));
  for(const entry of missed){const item=found.get(entry.id);if(!item)throw new WorkspaceError(409,'Workspace lease expired or cancelled','LEASE_CONFLICT');if(!sameEntry(item,entry))throw transcriptConflict();}
 }
 const last=await db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence FROM workspace_run_transcript WHERE run_id=?').bind(id).first<{sequence:number}>();
 const inserted=results.reduce((total,result,index)=>total+(index<accepted.length?result.meta.changes:0),0);
 if(results.some(result=>result.meta.changes>0))notifyRun(id);
 return {accepted:inserted,lastSequence:last?.sequence??0,limited};
}

async function inputs(db:LocalDatabase,runId:string):Promise<RunInput[]> {
 return (await db.prepare('SELECT * FROM workspace_run_inputs WHERE run_id=? ORDER BY sequence').bind(runId).all<InputRow>()).results.map(inputDto);
}
async function capabilities(db:LocalDatabase,runId:string):Promise<RunnerCapabilities|null> {
 const found=await db.prepare('SELECT * FROM workspace_run_capabilities WHERE run_id=?').bind(runId).first<CapabilityRow>();
 return found?capabilityDto(found):null;
}

export async function getTranscriptPage(db:LocalDatabase,owner:string,id:string,after=0,limit=500):Promise<TranscriptPage> {
 integer(after,0,Number.MAX_SAFE_INTEGER,'transcript cursor');integer(limit,1,1000,'transcript limit');
 let run=await row(db,owner,id);
 if(run.state!=='running' && await settleRunInputs(db,owner,id)){notifyRun(id);run=await row(db,owner,id);}
 const found=await db.prepare('SELECT * FROM workspace_run_transcript WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?').bind(id,after,limit+1).all<TranscriptRow>();
 const entries=found.results.slice(0,limit).map(entryDto);
 const limited=await db.prepare('SELECT 1 AS found FROM workspace_run_transcript WHERE run_id=? AND id=?').bind(id,TRANSCRIPT_LIMIT_ID).first();
 return {runId:id,state:run.state,entries,nextAfter:entries.at(-1)?.sequence??after,hasMore:found.results.length>limit,limited:limited!==null,
  inputs:await inputs(db,id),capabilities:await capabilities(db,id)};
}

export async function submitRunInput(db:LocalDatabase,owner:string,input:{runId:unknown;requestId:unknown;mode:unknown;text:unknown}):Promise<{input:RunInput}> {
 const {runId,requestId,mode,text:message}=input;
 text(runId);text(requestId,128,'request ID');if(!/^[A-Za-z0-9._:-]+$/.test(requestId))invalid('Invalid request ID');
 if(mode!=='guide' && mode!=='interrupt')invalid('Invalid input mode');
 if(typeof message!=='string' || message.length<1 || message.length>4000 || message.includes('\u0000') || !message.trim())invalid('Input text must be 1 to 4000 characters');
 await row(db,owner,runId);
 const byRequest=async()=>{
  const found=await db.prepare('SELECT * FROM workspace_run_inputs WHERE run_id=? AND request_id=?').bind(runId,requestId).first<InputRow>();
  if(found && (found.mode!==mode || found.text!==message))throw new WorkspaceError(409,'Request ID reused with different input','REQUEST_CONFLICT');
  return found?{input:inputDto(found)}:null;
 };
 const prior=await byRequest();if(prior)return prior;
 const now=Date.now();await reconcile(db,owner,now);
 const run=await row(db,owner,runId);
 if(run.state!=='running' && await settleRunInputs(db,owner,runId))notifyRun(runId);
 if(run.state!=='running' || run.cancel_requested)throw new WorkspaceError(409,'Run is not running','RUN_NOT_RUNNING');
 const caps=await capabilities(db,runId);
 if(caps && !caps[mode])throw new WorkspaceError(409,`Runner does not support ${mode} input`,'MODE_UNSUPPORTED');
 const count=await db.prepare('SELECT count(*) AS count FROM workspace_run_inputs WHERE run_id=?').bind(runId).first<{count:number}>();
 if((count?.count??0)>=RUN_INPUT_LIMIT)throw new WorkspaceError(409,'Run input limit reached','INPUT_LIMIT');
 const inputId=randomUUID(),echo=JSON.stringify({inputId,mode,text:message});
 const results=await db.batch([
  db.prepare(`INSERT INTO workspace_run_inputs(run_id,id,request_id,sequence,mode,text,state,created_at,updated_at)
   SELECT id,?,?,COALESCE((SELECT MAX(sequence) FROM workspace_run_inputs WHERE run_id=workspace_runs.id),0)+1,?,?,'queued',?,? FROM workspace_runs
   WHERE owner=? AND id=? AND state='running' AND cancel_requested=0 AND (SELECT count(*) FROM workspace_run_inputs WHERE run_id=workspace_runs.id)<?
   AND NOT EXISTS(SELECT 1 FROM workspace_run_inputs WHERE run_id=workspace_runs.id AND request_id=?)`)
   .bind(inputId,requestId,mode,message,now,now,owner,runId,RUN_INPUT_LIMIT,requestId),
  db.prepare(`INSERT INTO workspace_run_transcript(run_id,id,sequence,kind,step_id,body,truncated,created_at)
   SELECT run_id,?,COALESCE((SELECT MAX(sequence) FROM workspace_run_transcript WHERE run_id=?),0)+1,'input_echo',NULL,?,0,? FROM workspace_run_inputs WHERE run_id=? AND id=?`)
   .bind(`input:${inputId}`,runId,echo,now,runId,inputId),
 ]);
 if(results[0].meta.changes!==1){
  const raced=await byRequest();if(raced)return raced;
  throw new WorkspaceError(409,'Run is not running','RUN_NOT_RUNNING');
 }
 notifyRun(runId);
 const created=await db.prepare('SELECT * FROM workspace_run_inputs WHERE run_id=? AND id=?').bind(runId,inputId).first<InputRow>();
 return {input:inputDto(created!)};
}

export async function claimRunInputs(db:LocalDatabase,identity:ConnectorPrincipal,id:string,leaseToken:string):Promise<{inputs:RunInput[]}> {
 const actor=principal(identity),now=Date.now(),run=await machineRun(db,actor,id,leaseToken);
 await assertLive(db,actor,run,leaseToken,now);
 const moved=await db.prepare(`UPDATE workspace_run_inputs SET state='delivered',updated_at=MAX(updated_at,?) WHERE run_id=? AND state='queued'
  AND EXISTS(SELECT 1 FROM workspace_runs WHERE ${liveRun})`).bind(now,id,...liveParams(actor,run,leaseToken,now)).run();
 if(moved.meta.changes)notifyRun(id);
 const found=await db.prepare("SELECT * FROM workspace_run_inputs WHERE run_id=? AND state='delivered' ORDER BY sequence").bind(id).all<InputRow>();
 return {inputs:found.results.map(inputDto)};
}

export async function ackRunInput(db:LocalDatabase,identity:ConnectorPrincipal,id:string,leaseToken:string,input:{inputId:unknown;state:unknown;reason?:unknown}):Promise<{input:RunInput}> {
 const {inputId,state}=input;let reason:string|null=null;
 text(inputId,200,'input ID');if(state!=='applied' && state!=='rejected')invalid('Invalid input state');
 if(input.reason!==undefined && input.reason!==null){logText(input.reason,500,'input reason');reason=redact(input.reason).slice(0,500);}
 const actor=principal(identity),now=Date.now(),run=await machineRun(db,actor,id,leaseToken);
 const load=()=>db.prepare('SELECT * FROM workspace_run_inputs WHERE run_id=? AND id=?').bind(id,inputId).first<InputRow>();
 const current=await load();
 if(!current)throw new WorkspaceError(404,'Run input not found','NOT_FOUND');
 if(current.state===state)return {input:inputDto(current)};
 if(current.state!=='delivered')throw new WorkspaceError(409,'Run input state can only move forward','INPUT_CONFLICT');
 const updated=await db.prepare(`UPDATE workspace_run_inputs SET state=?,reason=?,updated_at=MAX(updated_at,?) WHERE run_id=? AND id=? AND state='delivered'
  AND EXISTS(SELECT 1 FROM workspace_runs WHERE ${liveRun})`).bind(state,reason,now,id,inputId,...liveParams(actor,run,leaseToken,now)).run();
 const after=(await load())!;
 if(updated.meta.changes!==1){
  if(after.state===state)return {input:inputDto(after)};
  if(after.state!=='delivered')throw new WorkspaceError(409,'Run input state can only move forward','INPUT_CONFLICT');
  throw new WorkspaceError(409,'Workspace lease expired or cancelled','LEASE_CONFLICT');
 }
 notifyRun(id);return {input:inputDto(after)};
}

export async function setRunCapabilities(db:LocalDatabase,identity:ConnectorPrincipal,id:string,leaseToken:string,value:unknown):Promise<{capabilities:RunnerCapabilities}> {
 object(value,['runner','guide','interrupt','note']);text(value.runner,64,'runner');
 if(typeof value.guide!=='boolean' || typeof value.interrupt!=='boolean')invalid('Invalid runner capabilities');
 let note:string|null=null;if(value.note!==undefined && value.note!==null){logText(value.note,500,'capability note');note=redact(value.note).slice(0,500);}
 const actor=principal(identity),now=Date.now(),run=await machineRun(db,actor,id,leaseToken);
 const result=await db.prepare(`INSERT INTO workspace_run_capabilities(run_id,runner,guide,interrupt,note,updated_at)
  SELECT id,?,?,?,?,? FROM workspace_runs WHERE ${liveRun}
  ON CONFLICT(run_id) DO UPDATE SET runner=excluded.runner,guide=excluded.guide,interrupt=excluded.interrupt,note=excluded.note,updated_at=MAX(workspace_run_capabilities.updated_at,excluded.updated_at)`)
  .bind(value.runner,value.guide?1:0,value.interrupt?1:0,note,now,...liveParams(actor,run,leaseToken,now)).run();
 if(result.meta.changes!==1)throw new WorkspaceError(409,'Workspace lease expired or cancelled','LEASE_CONFLICT');
 notifyRun(id);return {capabilities:(await capabilities(db,id))!};
}

const streamHeaders={'Cache-Control':'no-store','Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no',Connection:'keep-alive'};
export interface StreamOptions {pollMs?:number;heartbeatMs?:number;maxMs?:number}
function cursor(value:string|null):number|null {
 if(value===null || !/^\d{1,16}$/.test(value))return null;const parsed=Number(value);return Number.isSafeInteger(parsed)?parsed:null;
}
/** Server-sent console stream: in-process notifications wake it, a 1s SQL cursor poll covers other processes and missed wakes. */
export async function streamWorkspaceRun(db:LocalDatabase,owner:string|null,request:Request,options:StreamOptions={}):Promise<Response> {
 const json={'Cache-Control':'no-store'};
 if(!owner)return Response.json({error:'Authentication required'},{status:401,headers:json});
 if(request.method!=='GET')return Response.json({error:'Method not allowed'},{status:405,headers:{...json,Allow:'GET'}});
 const query=new URL(request.url).searchParams,keys=[...query.keys()],runId=query.get('runId');
 if(new Set(keys).size!==keys.length || keys.some(key=>!['runId','after'].includes(key)) || runId===null)return Response.json({error:'Invalid query',code:'INVALID_INPUT'},{status:400,headers:json});
 let after=0;
 if(query.has('after')){const parsed=cursor(query.get('after'));if(parsed===null)return Response.json({error:'Invalid cursor',code:'INVALID_INPUT'},{status:400,headers:json});after=parsed;}
 const lastEventId=cursor(request.headers.get('last-event-id'));if(lastEventId!==null)after=lastEventId;
 try{await row(db,owner,runId);}catch(error){
  if(error instanceof WorkspaceError)return Response.json({error:error.message,code:error.code},{status:error.status,headers:json});throw error;
 }
 const {pollMs=1000,heartbeatMs=15000,maxMs=600000}=options,encoder=new TextEncoder(),viewer:string=owner;
 let closed=false,running=false,again=false,lastState:RunState|null=null,capsAt:number|null=null;
 const seenInputs=new Map<string,string>();
 const timers:ReturnType<typeof setInterval>[]=[];let unsubscribe=()=>{};let controllerRef:ReadableStreamDefaultController<Uint8Array>|null=null;
 const cleanup=()=>{
  if(closed)return;closed=true;unsubscribe();for(const timer of timers)clearInterval(timer);
  request.signal.removeEventListener('abort',cleanup);
  try{controllerRef?.close();}catch{/* already closed by the client */}
 };
 const send=(chunk:string)=>{if(!closed)try{controllerRef!.enqueue(encoder.encode(chunk));}catch{cleanup();}};
 const event=(name:string,data:unknown,id?:number)=>send(`${id===undefined?'':`id: ${id}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
 const flush=async()=>{
  if(closed)return;if(running){again=true;return;}running=true;
  try {
   do {
    again=false;
    let run=await row(db,viewer,runId);
    // Surface an abandoned process (lost lease or hard deadline) instead of streaming a stale running state.
    if(run.state==='running' && ((run.lease_expires_at??0)<=Date.now() || (run.deadline_at??0)<=Date.now())){await reconcile(db,viewer,Date.now());run=await row(db,viewer,runId);}
    if(run.state!=='running')await settleRunInputs(db,viewer,runId);
    // State is read before draining entries: a terminal Run accepts no further writes, so the drain is complete.
    while(!closed){
     const found=await db.prepare('SELECT * FROM workspace_run_transcript WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT 500').bind(runId,after).all<TranscriptRow>();
     if(!found.results.length)break;
     const entries=found.results.map(entryDto);after=entries.at(-1)!.sequence;event('transcript',entries,after);
     if(found.results.length<500)break;
    }
    const changed=(await inputs(db,runId)).filter(item=>{const key=`${item.state}:${item.updatedAt}`;if(seenInputs.get(item.id)===key)return false;seenInputs.set(item.id,key);return true;});
    if(changed.length)event('inputs',changed);
    const caps=await db.prepare('SELECT * FROM workspace_run_capabilities WHERE run_id=?').bind(runId).first<CapabilityRow>();
    if(caps && caps.updated_at!==capsAt){capsAt=caps.updated_at;event('capabilities',capabilityDto(caps));}
    if(run.state!==lastState){lastState=run.state;event('state',{state:run.state});}
    if(TERMINAL_STATES.includes(run.state) && !again){event('end',{state:run.state});cleanup();}
   } while(again && !closed);
  }catch{cleanup();}
  finally{running=false;}
 };
 const body=new ReadableStream<Uint8Array>({
  start(controller){
   controllerRef=controller;
   if(request.signal.aborted){cleanup();return;}
   request.signal.addEventListener('abort',cleanup);
   unsubscribe=subscribeRun(runId,()=>{void flush();});
   timers.push(setInterval(()=>{void flush();},pollMs),setInterval(()=>send(': ping\n\n'),heartbeatMs));
   const limit=setTimeout(cleanup,maxMs);timers.push(limit as unknown as ReturnType<typeof setInterval>);
   send('retry: 2000\n\n');void flush();
  },
  cancel(){cleanup();},
 });
 return new Response(body,{headers:streamHeaders});
}
