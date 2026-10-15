import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { LocalDatabase } from '../database.mts';
import { AuthError, checkRequestOrigin, configuredOrigin } from '../local-auth.mts';
import { ensureProject, listProjects } from '../projects/catalog.mts';
export { ensureProject } from '../projects/catalog.mts';

export interface ConnectorPrincipal { id:string; owner:string; projectId:string; project:string; capabilities:string[] }
interface ConnectionRow {
 id:string; owner:string; project_id:string; project:string; name:string; workspace:string; version:string;
 capabilities:string; token_expires_at:number; created_at:number; last_seen:number|null; mcp_last_seen:number|null;
 agent_last_seen:number|null; agent_ready:number; agent_error:string|null; revoked_at:number|null; runtime_json:string|null;
}
export const connectorCapabilities = ['read','submit','plan','execute'] as const;
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
export function connectorInput(value:unknown, keys:string[]): asserts value is Record<string,unknown> {
 if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key))) throw new AuthError(400,'Invalid connector request');
}
export function connectorText(value:unknown, max:number, label:string): string {
 if(typeof value!=='string' || !value.trim() || value.length>max || /[\u0000-\u001f\u007f]/.test(value)) throw new AuthError(400,`Invalid ${label}`);
 return value.trim();
}
export function sanitizedConnectorError(value:unknown):string|null {
 if(value===undefined || value===null || value==='')return null;
 if(typeof value!=='string' || value.length>4000)throw new AuthError(400,'Invalid error summary');
 return value.replace(/Bearer\s+\S+/gi,'[credential]').replace(/\bsk-[A-Za-z0-9_*.-]+/gi,'[credential]').replace(/\b[A-Za-z0-9_-]{43,}\b/g,'[credential]')
  .replace(/https?:\/\/[^\s]+/g,'[url]').replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s<>"']+[\\/])+[^\s<>"']*/g,'[path]')
  .replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,300) || 'Agent unavailable';
}
// Silence longer than the offline threshold counts as a reconnect.
const STATUS_GAP_MS=90000;
export function connectionDTO(row:ConnectionRow, now=Date.now()) {
 const elapsed=now-(row.agent_last_seen??0);
 const status=row.revoked_at!==null?'revoked':row.token_expires_at<=now?'expired':row.agent_last_seen===null?'installed':elapsed<45000?'online':elapsed<90000?'delayed':'offline';
 return {id:row.id,name:row.name,workspace:row.workspace,projectId:row.project_id,project:row.project,version:row.version,status,lastSeen:row.last_seen,mcpLastSeen:row.mcp_last_seen,agentLastSeen:row.agent_last_seen,createdAt:row.created_at,expiresAt:row.token_expires_at,
  agentReady:row.agent_ready===1,agentError:row.agent_error,runtime:row.runtime_json?JSON.parse(row.runtime_json):null,capabilities:JSON.parse(row.capabilities) as string[],revokedAt:row.revoked_at};
}
export async function listConnections(db:LocalDatabase,owner:string) {
 const [projects,connections]=await Promise.all([
  listProjects(db,owner),
  db.prepare('SELECT c.*,p.name AS project FROM workspace_connections c JOIN workspace_projects p ON p.id=c.project_id AND p.owner=c.owner WHERE c.owner=? ORDER BY c.created_at DESC,c.id').bind(owner).all<ConnectionRow>(),
 ]);
 return {projects,connections:await Promise.all(connections.results.map(async row=>{
  const events=await db.prepare('SELECT id,mode,message,created_at FROM workspace_connection_events WHERE connection_id=? AND owner=? ORDER BY created_at DESC,id DESC LIMIT 100').bind(row.id,owner).all<{id:string;mode:string;message:string|null;created_at:number}>();
  return {...connectionDTO(row),events:events.results.map(event=>({id:event.id,mode:event.mode,message:event.message,createdAt:event.created_at}))};
 }))};
}
export async function inviteConnector(db:LocalDatabase,owner:string,input:unknown) {
 connectorInput(input,['action','project','name','capabilities']);
 const project=await ensureProject(db,owner,connectorText(input.project,120,'project'));
 const name=connectorText(input.name,120,'connection name');
 if(!Array.isArray(input.capabilities) || input.capabilities.length<1 || input.capabilities.length>4 || input.capabilities.some(v=>!connectorCapabilities.includes(v)) || new Set(input.capabilities).size!==input.capabilities.length)throw new AuthError(400,'Invalid capabilities');
 const code=randomBytes(32).toString('base64url'),now=Date.now(),expiresAt=now+600000;
 await db.prepare('INSERT INTO workspace_invitations(code_hash,owner,project_id,name,capabilities,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
  .bind(hash(code),owner,project.id,name,JSON.stringify(input.capabilities),now,expiresAt).run();
 const origin=configuredOrigin();return {code,expiresAt,projectId:project.id,project:project.name,origin,downloadUrl:`${origin}/api/connectors/download`};
}
export async function enrollConnector(db:LocalDatabase,input:unknown) {
 connectorInput(input,['code','name','version','workspace']);
 if(typeof input.code!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(input.code))throw new AuthError(401,'Invitation invalid or expired');
 const name=connectorText(input.name,120,'connection name'),version=connectorText(input.version,80,'version'),workspace=connectorText(input.workspace,120,'workspace display name');
 if(workspace.includes('/') || workspace.includes('\\') || /^[A-Za-z]:/.test(workspace))throw new AuthError(400,'Workspace must be a display name');
 const now=Date.now(),id=randomUUID(),token=randomBytes(32).toString('base64url'),codeHash=hash(input.code);
 const results=await db.batch([
  db.prepare('UPDATE workspace_invitations SET consumed_at=?,connection_id=? WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?').bind(now,id,codeHash,now),
  db.prepare(`INSERT INTO workspace_connections(id,owner,project_id,name,workspace,version,capabilities,token_hash,token_expires_at,created_at,last_seen)
   SELECT ?,owner,project_id,?,?,?,capabilities,?,?,?,? FROM workspace_invitations WHERE code_hash=? AND connection_id=? AND consumed_at=?`)
   .bind(id,name,workspace,version,hash(token),now+2592000000,now,now,codeHash,id,now),
  db.prepare(`INSERT INTO workspace_connection_events(id,connection_id,owner,mode,created_at) SELECT ?,id,owner,'enroll',? FROM workspace_connections WHERE id=?`).bind(randomUUID(),now,id),
 ]);
 if(results[0].meta.changes!==1 || results[1].meta.changes!==1)throw new AuthError(401,'Invitation invalid or expired');
 const row=await readConnection(db,id);if(!row)throw Error('Connection unavailable');
 return {token,connection:connectionDTO(row),origin:configuredOrigin()};
}
async function readConnection(db:LocalDatabase,id:string) {
 return db.prepare('SELECT c.*,p.name AS project FROM workspace_connections c JOIN workspace_projects p ON p.id=c.project_id AND p.owner=c.owner WHERE c.id=?').bind(id).first<ConnectionRow>();
}
export async function authenticateConnector(db:LocalDatabase,headers:Headers):Promise<ConnectorPrincipal> {
 checkRequestOrigin(headers,'POST',configuredOrigin(),'bearer');
 if(headers.has('cookie'))throw new AuthError(401,'Connector bearer credential required');
 const credential=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(headers.get('authorization')??'');
 if(!credential)throw new AuthError(401,'Connector bearer credential required');
 const now=Date.now();
 const row=await db.prepare(`SELECT c.*,p.name AS project FROM workspace_connections c JOIN workspace_projects p ON p.id=c.project_id AND p.owner=c.owner
  WHERE c.token_hash=? AND c.revoked_at IS NULL AND c.token_expires_at>?`).bind(hash(credential[1]),now).first<ConnectionRow>();
 if(!row)throw new AuthError(401,'Connector credential expired or revoked');
 const changed=await db.prepare('UPDATE workspace_connections SET last_seen=? WHERE id=? AND revoked_at IS NULL AND token_expires_at>?').bind(now,row.id,now).run();
 if(changed.meta.changes!==1)throw new AuthError(401,'Connector credential expired or revoked');
 return {id:row.id,owner:row.owner,projectId:row.project_id,project:row.project,capabilities:JSON.parse(row.capabilities) as string[]};
}
export async function heartbeatConnector(db:LocalDatabase,principal:ConnectorPrincipal,input:unknown) {
 connectorInput(input,['mode','version','agentReady','error','runtime']);
 if(!['mcp','agent'].includes(input.mode as string) || typeof input.agentReady!=='boolean')throw new AuthError(400,'Invalid heartbeat');
 const version=connectorText(input.version,80,'version'),error=sanitizedConnectorError(input.error),now=Date.now();
 let runtime:string|null=null;
 if(input.runtime!==undefined){
  connectorInput(input.runtime,['profile','model','provider','access']);
  const safe:Record<string,string|null>={};
  const access=input.runtime.access;
  if(access!==undefined&&access!==null&&!['codex-config','codex-login','api','claude'].includes(access as string))throw new AuthError(400,'Invalid runtime metadata');
  if(access!==undefined)safe.access=access as string|null;
  for(const field of ['profile','model','provider']){
   const value=input.runtime[field];
   if(value===undefined||value===null){safe[field]=null;continue;}
   if(typeof value!=='string'||value.length>120||!(/^[A-Za-z0-9._:/-]+$/).test(value)||/^sk-/i.test(value))throw new AuthError(400,'Invalid runtime metadata');
   if(field==='profile'&&!(/^[A-Za-z0-9_-]+$/).test(value))throw new AuthError(400,'Invalid profile');
   safe[field]=value;
  }
  runtime=JSON.stringify(safe);
 }
 const agent=input.mode==='agent';
 const ready=input.agentReady&&!error?1:0;
 // Heartbeats only refresh the latest status; an event records a reconnect or a status change.
 const changed=agent?`(agent_last_seen IS NULL OR agent_last_seen<? OR agent_ready<>? OR COALESCE(agent_error,'')<>COALESCE(?,''))`:`(mcp_last_seen IS NULL OR mcp_last_seen<?)`;
 const results=await db.batch([
  db.prepare(`INSERT INTO workspace_connection_events(id,connection_id,owner,mode,message,created_at) SELECT ?,id,owner,?,?,? FROM workspace_connections WHERE id=? AND owner=? AND revoked_at IS NULL AND token_expires_at>? AND ${changed}`)
   .bind(randomUUID(),agent?'agent':'mcp',agent?(error??(ready?'ready':'not ready')):null,now,principal.id,principal.owner,now,...(agent?[now-STATUS_GAP_MS,ready,error]:[now-STATUS_GAP_MS])),
  db.prepare(`UPDATE workspace_connections SET version=?,last_seen=?,runtime_json=COALESCE(?,runtime_json),${agent?'agent_last_seen=?,agent_ready=?,agent_error=?':'mcp_last_seen=?'} WHERE id=? AND owner=? AND revoked_at IS NULL AND token_expires_at>?`)
   .bind(version,now,runtime,...(agent?[now,ready,error]:[now]),principal.id,principal.owner,now),
  db.prepare('DELETE FROM workspace_connection_events WHERE connection_id=? AND id NOT IN (SELECT id FROM workspace_connection_events WHERE connection_id=? ORDER BY created_at DESC,id DESC LIMIT 100)').bind(principal.id,principal.id),
 ]);
 if(results[1].meta.changes!==1)throw new AuthError(401,'Connector credential expired or revoked');
 const row=await readConnection(db,principal.id);if(!row)throw Error('Connection unavailable');return {connection:connectionDTO(row)};
}
export async function recordConnectorUse(db:LocalDatabase,principal:ConnectorPrincipal) {
 const now=Date.now();const [,result]=await db.batch([
  db.prepare("INSERT INTO workspace_connection_events(id,connection_id,owner,mode,created_at) SELECT ?,id,owner,'mcp',? FROM workspace_connections WHERE id=? AND owner=? AND revoked_at IS NULL AND token_expires_at>? AND (mcp_last_seen IS NULL OR mcp_last_seen<?)").bind(randomUUID(),now,principal.id,principal.owner,now,now-STATUS_GAP_MS),
  db.prepare('UPDATE workspace_connections SET mcp_last_seen=?,last_seen=? WHERE id=? AND owner=? AND revoked_at IS NULL AND token_expires_at>?').bind(now,now,principal.id,principal.owner,now),
  db.prepare('DELETE FROM workspace_connection_events WHERE connection_id=? AND id NOT IN (SELECT id FROM workspace_connection_events WHERE connection_id=? ORDER BY created_at DESC,id DESC LIMIT 100)').bind(principal.id,principal.id),
 ]);
 if(result.meta.changes!==1)throw new AuthError(401,'Connector credential expired or revoked');
}
export async function revokeConnector(db:LocalDatabase,owner:string,input:unknown) {
 connectorInput(input,['action','connectionId']);const id=connectorText(input.connectionId,200,'connection ID'),now=Date.now();
 const results=await db.batch([
  db.prepare('UPDATE workspace_connections SET revoked_at=COALESCE(revoked_at,?),agent_ready=0 WHERE id=? AND owner=?').bind(now,id,owner),
  db.prepare("INSERT INTO workspace_connection_events(id,connection_id,owner,mode,created_at) SELECT ?,id,owner,'revoke',? FROM workspace_connections WHERE id=? AND owner=?").bind(randomUUID(),now,id,owner),
 ]);
 if(!results[0].meta.changes)throw new AuthError(404,'Connection not found');return {revoked:true};
}
