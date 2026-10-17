"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import type {WorkspaceRun,OwnerAction,PrepareInput} from '../lib/workspace-runs/types.mts';
import type {Run} from '../lib/execution/types.mts';
import type {WorkspaceConnection} from '../components/connectors/types';
import {readTicketWorkspaceRuns,ticketRequest,TicketRequestError} from '../lib/tickets/request.mts';

export function useTicketExecution({ticketId,revision,project,onAuthenticationDenied,onRecordsChanged}:{
 ticketId:string;revision:number;project:string;onAuthenticationDenied:()=>void;onRecordsChanged:()=>void;
}) {
 const [connections,setConnections]=useState<WorkspaceConnection[]>([]);
 const [runs,setRuns]=useState<WorkspaceRun[]>([]),[dockerRuns,setDockerRuns]=useState<Run[]>([]);
 const [connectionId,setConnectionId]=useState(''),[minutes,setMinutes]=useState(20);
 const [error,setError]=useState(''),[conflict,setConflict]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const lifecycle=useRef(0),sequence=useRef(0),writing=useRef(false),pending=useRef<PrepareInput|null>(null);
 const deny=useCallback(()=>{
  ++lifecycle.current;++sequence.current;pending.current=null;
  setConnections([]);setRuns([]);setDockerRuns([]);setConnectionId('');setMinutes(20);setError('登录已失效或无权访问');setLoading(false);setBusy(false);
  onAuthenticationDenied();
 },[onAuthenticationDenied]);
 const request=useCallback(<T,>(url:string,isCurrent:()=>boolean,body?:unknown)=>ticketRequest<T>(url,{body,isCurrent,onAuthenticationDenied:deny}),[deny]);
 const refresh=useCallback(async(preserveError=false)=>{
  const current=++sequence.current,generation=lifecycle.current;
  const valid=()=>current===sequence.current&&generation===lifecycle.current;
  try {
   const [listed,workspaces,docker]=await Promise.all([
    request<{connections:WorkspaceConnection[]}>('/api/connectors',valid),
    readTicketWorkspaceRuns<WorkspaceRun>(ticketId,<T,>(url:string)=>request<T>(url,valid)),
    // Fetch active Docker states separately: an active run cannot hide behind the history limit.
    Promise.all(['queued','running','waiting'].map(state=>request<{runs:Run[]}>('/api/execution?ticketId='+encodeURIComponent(ticketId)+'&state='+state+'&limit=100',valid))),
   ]);
   if(!valid())return;
   setConnections(listed.connections);setRuns(workspaces);setDockerRuns(docker.flatMap(page=>page.runs));setLoading(false);
   if(!preserveError){setError('');setConflict(false);}
  }catch(failure){if(valid()){setError(failure instanceof Error?failure.message:'暂时无法读取执行状态');setLoading(false);}}
 },[request,ticketId]);
 // A running Run has its own live console stream, so the summary poll can slow down.
 const liveConsole=runs.some(run=>run.state==='running');
 useEffect(()=>{
  const generation=lifecycle,reads=sequence;
  const timer=setTimeout(()=>void refresh(),0);
  const poll=setInterval(()=>{if(!writing.current&&document.visibilityState==='visible')void refresh(true);},liveConsole?15000:5000);
  return ()=>{clearTimeout(timer);clearInterval(poll);++generation.current;++reads.current;};
 },[refresh,liveConsole]);
 const availableConnections=connections.filter(c=>!c.revokedAt&&c.project===project&&c.capabilities.includes('execute'));
 const connection=connectionId?availableConnections.find(c=>c.id===connectionId):availableConnections[0];
 async function write(body:unknown,recordsChanged=false) {
  if(writing.current)return;
  writing.current=true;setBusy(true);setError('');setConflict(false);++sequence.current;
  const generation=lifecycle.current,valid=()=>lifecycle.current===generation;
  try {
   await request('/api/workspace-runs',valid,body);
   if(!valid())return;
   pending.current=null;await refresh();if(recordsChanged&&valid())onRecordsChanged();
  }catch(failure){
   if(valid()){
    if(failure instanceof TicketRequestError&&failure.status===409){await refresh(true);if(valid())setConflict(true);}
    if(valid())setError(failure instanceof Error?failure.message:'操作失败，输入已保留');
   }
  }finally{writing.current=false;if(valid())setBusy(false);}
 }
 function prepare() {
  if(!connection||!Number.isFinite(minutes)||minutes<1||minutes>60)return;
  const input={ticketId,revision,connectionId:connection.id,timeoutMs:Math.round(minutes*60000)};
  if(!pending.current||JSON.stringify({...pending.current,requestId:undefined})!==JSON.stringify(input))pending.current={...input,requestId:crypto.randomUUID()};
  void write({action:'prepare',...pending.current},true);
 }
 // Every Run decision changes the board column, so the page re-reads Runs and records.
 function act(runId:string,action:OwnerAction){void write({action,runId},true);}
 return {connections:availableConnections,connection,connectionId,setConnectionId,minutes,setMinutes,runs,dockerRuns,error,conflict,loading,busy,refresh,prepare,act};
}
