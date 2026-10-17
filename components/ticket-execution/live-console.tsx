"use client";
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {KeyboardEvent,ReactNode} from 'react';
import type {InputMode,RunInput,RunnerCapabilities,RunState,TranscriptEntry,TranscriptPage,WorkspaceRun} from '../../lib/workspace-runs/types.mts';
import {ticketRequest,TicketRequestError} from '../../lib/tickets/request.mts';

const TERMINAL:RunState[]=['review','succeeded','failed','cancelled'];
const POLL_MS=1500;
const PREFIX:Record<string,string>={command_start:'$',message:'›',reasoning:'∴',file_change:'✎',tool_call:'⚙',tool_result:'⚙',error:'✗',result:'✓',input_echo:'↳',system:'·',command_output:'$'};
const INPUT_STATES:Record<RunInput['state'],string>={queued:'已排队',delivered:'已送达',applied:'已应用',rejected:'已拒绝'};
const MODES:Record<InputMode,string>={guide:'引导',interrupt:'打断'};
const str=(value:unknown)=>typeof value==='string'?value:value===undefined||value===null?'':JSON.stringify(value);
const noop=()=>{};

type Group={key:string;entries:TranscriptEntry[]};
function groupEntries(entries:TranscriptEntry[]):Group[] {
 const groups:Group[]=[],byStep=new Map<string,Group>();
 for(const entry of entries){
  const existing=entry.stepId?byStep.get(entry.stepId):undefined;
  if(existing){existing.entries.push(entry);continue;}
  const group={key:entry.stepId?'step:'+entry.stepId:'entry:'+entry.sequence,entries:[entry]};
  groups.push(group);if(entry.stepId)byStep.set(entry.stepId,group);
 }
 return groups;
}
function entryText(entry:TranscriptEntry):string {
 const b=entry.body;
 switch(entry.kind){
  case 'message':case 'reasoning':return str(b.text);
  case 'command_start':return str(b.command);
  case 'command_output':return (b.command?str(b.command)+'\n':'')+str(b.output)+(b.exitCode===undefined?'':`\n[exit ${b.exitCode===null?'?':String(b.exitCode)}]`);
  case 'file_change':return Array.isArray(b.changes)?b.changes.map(change=>{const c=change as {path?:unknown;kind?:unknown};return `${str(c.kind)} ${str(c.path)}`;}).join('\n'):'';
  case 'tool_call':return `${str(b.name)} ${str(b.input)}`;
  case 'tool_result':return (b.name?str(b.name)+': ':'')+str(b.output);
  case 'error':return str(b.message);
  case 'result':return str(b.text)||'完成';
  case 'input_echo':return `[${MODES[b.mode as InputMode]??str(b.mode)}] ${str(b.text)}`;
  default:return str(b.text);
 }
}
function capabilityHint(capabilities:RunnerCapabilities|null):string {
 if(!capabilities)return '等待 runner 报告支持的输入方式';
 const name=capabilities.runner||'runner';
 const base=capabilities.guide&&capabilities.interrupt?`${name} 支持引导与打断后续跑`:capabilities.guide?`此 runner（${name}）只支持引导`:capabilities.interrupt?`此 runner（${name}）只支持打断后续跑`:`此 runner（${name}）不支持运行中输入`;
 return capabilities.note?`${base} · ${capabilities.note}`:base;
}

function CommandOutput({entry}:{entry:TranscriptEntry}) {
 const b=entry.body,exit=b.exitCode,output=str(b.output),lines=output?output.split('\n').length:0;
 return <details className="live-console-output" data-kind="command_output" data-sequence={entry.sequence}>
  <summary><span className={'live-console-exit'+(typeof exit==='number'&&exit!==0?' failed':'')}>退出码 {typeof exit==='number'?exit:'未知'}</span><span>输出 {lines} 行</span>{entry.truncated&&<span className="live-console-truncated">已截断</span>}</summary>
  <pre>{output||'（无输出）'}</pre>
 </details>;
}
function EntryLine({entry,inputs}:{entry:TranscriptEntry;inputs:Map<string,RunInput>}) {
 const b=entry.body;
 if(entry.kind==='command_output')return <CommandOutput entry={entry}/>;
 let body:ReactNode=entryText(entry);
 if(entry.kind==='file_change'&&Array.isArray(b.changes))body=<ul>{b.changes.map((change,index)=>{const c=change as {path?:unknown;kind?:unknown};return <li key={index}><span className="live-console-change">{str(c.kind)}</span> {str(c.path)}</li>;})}</ul>;
 if(entry.kind==='tool_result'&&b.isError===true)body=<span className="live-console-error-text">{entryText(entry)}</span>;
 const input=entry.kind==='input_echo'?inputs.get(str(b.inputId)):undefined;
 return <div className={'live-console-line kind-'+entry.kind} data-kind={entry.kind} data-sequence={entry.sequence}>
  <span className="live-console-prefix" aria-hidden="true">{PREFIX[entry.kind]??'·'}</span>
  <div className="live-console-text">{body}{input&&<InputState input={input}/>}{entry.truncated&&<span className="live-console-truncated">已截断</span>}</div>
 </div>;
}
function InputState({input}:{input:RunInput}) {
 return <span className={'live-console-input-state state-'+input.state} data-input-state={input.state}>{INPUT_STATES[input.state]}{input.state==='rejected'&&input.reason?`：${input.reason}`:''}</span>;
}

export function LiveConsole({run,onAuthenticationDenied=noop}:{run:WorkspaceRun;onAuthenticationDenied?:()=>void}) {
 const [entries,setEntries]=useState<Map<number,TranscriptEntry>>(()=>new Map());
 const [inputs,setInputs]=useState<Map<string,RunInput>>(()=>new Map());
 const [capabilities,setCapabilities]=useState<RunnerCapabilities|null>(null);
 const [liveState,setLiveState]=useState<RunState|null>(null);
 const [limited,setLimited]=useState(false);
 const [transport,setTransport]=useState<'connecting'|'stream'|'polling'|'closed'>('connecting');
 const [follow,setFollow]=useState(true);
 const [draft,setDraft]=useState(''),[sending,setSending]=useState(false),[inputError,setInputError]=useState(''),[copied,setCopied]=useState(false);
 const cursor=useRef(0),scroller=useRef<HTMLDivElement>(null);
 const propTerminal=TERMINAL.includes(run.state);

 const mergeEntries=useCallback((list:TranscriptEntry[])=>{
  if(!list.length)return;
  setEntries(previous=>{
   let next:Map<number,TranscriptEntry>|null=null;
   for(const entry of list)if(!previous.has(entry.sequence)){next??=new Map(previous);next.set(entry.sequence,entry);}
   return next??previous;
  });
  for(const entry of list)cursor.current=Math.max(cursor.current,entry.sequence);
  if(list.some(entry=>entry.id==='system:limit'))setLimited(true);
 },[]);
 const mergeInputs=useCallback((list:RunInput[])=>{
  if(!list.length)return;
  setInputs(previous=>{const next=new Map(previous);for(const input of list){const old=next.get(input.id);if(!old||old.updatedAt<=input.updatedAt)next.set(input.id,input);}return next;});
 },[]);
 const applyPage=useCallback((page:TranscriptPage)=>{
  mergeEntries(page.entries);mergeInputs(page.inputs);setCapabilities(page.capabilities);setLiveState(page.state);
  if(page.limited)setLimited(true);
  cursor.current=Math.max(cursor.current,page.nextAfter);
 },[mergeEntries,mergeInputs]);

 useEffect(()=>{
  let disposed=false,source:EventSource|null=null,timer:ReturnType<typeof setTimeout>|undefined;
  const alive=()=>!disposed;
  const read=()=>ticketRequest<{transcript:TranscriptPage}>(`/api/workspace-runs?runId=${encodeURIComponent(run.id)}&transcriptAfter=${cursor.current}`,{isCurrent:alive,onAuthenticationDenied});
  // Read every available page; returns the last page so callers know the Run state.
  const drain=async()=>{let page:TranscriptPage;do{page=(await read()).transcript;if(disposed)return null;applyPage(page);}while(page.hasMore);return page;};
  const poll=async()=>{
   try {
    const page=await drain();if(!page)return;
    if(TERMINAL.includes(page.state)){setTransport('closed');return;}
   }catch(error){if(disposed||(error instanceof TicketRequestError&&(error.status===401||error.status===403||error.status===404)))return;}
   if(!disposed)timer=setTimeout(()=>void poll(),POLL_MS);
  };
  const stream=()=>{
   if(typeof EventSource==='undefined'){setTransport('polling');void poll();return;}
   source=new EventSource(`/api/workspace-runs/stream?runId=${encodeURIComponent(run.id)}&after=${cursor.current}`);
   const parse=<T,>(event:Event):T|null=>{try{return JSON.parse((event as MessageEvent<string>).data) as T;}catch{return null;}};
   source.onopen=()=>{if(!disposed)setTransport('stream');};
   source.addEventListener('transcript',event=>{const list=parse<TranscriptEntry[]>(event);if(list&&!disposed)mergeEntries(list);});
   source.addEventListener('inputs',event=>{const list=parse<RunInput[]>(event);if(list&&!disposed)mergeInputs(list);});
   source.addEventListener('capabilities',event=>{const value=parse<RunnerCapabilities>(event);if(value&&!disposed)setCapabilities(value);});
   source.addEventListener('state',event=>{const value=parse<{state:RunState}>(event);if(value&&!disposed)setLiveState(value.state);});
   source.addEventListener('end',event=>{
    const value=parse<{state:RunState}>(event);source?.close();source=null;if(disposed)return;
    if(value)setLiveState(value.state);setTransport('closed');
    // Final inputs may have been rejected while the Run ended; one read settles them.
    void drain().catch(()=>{});
   });
   source.onerror=()=>{if(disposed||!source)return;source.close();source=null;setTransport('polling');void poll();};
  };
  void (async()=>{
   try {
    const page=await drain();if(!page)return;
    if(TERMINAL.includes(page.state)||propTerminal){setTransport('closed');return;}
    stream();
   }catch(error){
    if(disposed||(error instanceof TicketRequestError&&(error.status===401||error.status===403||error.status===404)))return;
    if(!propTerminal){setTransport('polling');timer=setTimeout(()=>void poll(),POLL_MS);}
   }
  })();
  return ()=>{disposed=true;source?.close();clearTimeout(timer);};
 },[run.id,propTerminal,applyPage,mergeEntries,mergeInputs,onAuthenticationDenied]);

 const sorted=useMemo(()=>[...entries.values()].sort((a,b)=>a.sequence-b.sequence),[entries]);
 const groups=useMemo(()=>groupEntries(sorted),[sorted]);
 const echoed=useMemo(()=>new Set(sorted.filter(entry=>entry.kind==='input_echo').map(entry=>str(entry.body.inputId))),[sorted]);
 const unechoed=[...inputs.values()].filter(input=>!echoed.has(input.id)).sort((a,b)=>a.sequence-b.sequence);

 useLayoutEffect(()=>{const el=scroller.current;if(follow&&el)el.scrollTop=el.scrollHeight;},[follow,sorted.length,unechoed.length]);
 const onScroll=()=>{const el=scroller.current;if(!el||!follow)return;if(el.scrollHeight-el.scrollTop-el.clientHeight>32)setFollow(false);};

 const state=propTerminal?run.state:liveState&&TERMINAL.includes(liveState)?liveState:run.state;
 const running=state==='running';
 const guideOk=running&&(!capabilities||capabilities.guide),interruptOk=running&&(!capabilities||capabilities.interrupt);
 async function submit(mode:InputMode) {
  const text=draft;
  if(sending||!text.trim()||text.length>4000||(mode==='guide'?!guideOk:!interruptOk))return;
  setSending(true);setInputError('');
  try {
   const {input}=await ticketRequest<{input:RunInput}>('/api/workspace-runs',{body:{action:'input',runId:run.id,requestId:crypto.randomUUID(),mode,text},onAuthenticationDenied});
   mergeInputs([input]);setDraft(current=>current===text?'':current);setFollow(true);
  }catch(error){setInputError(error instanceof Error?error.message:'发送失败，输入已保留');}
  finally{setSending(false);}
 }
 function onKeyDown(event:KeyboardEvent<HTMLTextAreaElement>) {
  if(event.key!=='Enter'||event.shiftKey||event.nativeEvent.isComposing)return;
  event.preventDefault();void submit(guideOk?'guide':'interrupt');
 }
 async function copyAll() {
  const text=sorted.map(entry=>`${PREFIX[entry.kind]??'·'} ${entryText(entry)}`).join('\n');
  try {await navigator.clipboard.writeText(text);setCopied(true);setTimeout(()=>setCopied(false),1500);}
  catch {setInputError('浏览器不允许写入剪贴板');}
 }
 const transportLabel={connecting:'连接中',stream:'实时连接',polling:'轮询更新',closed:running?'已断开':'已结束'}[transport];
 const tooLong=draft.length>4000;
 return <section className="live-console" aria-label="Agent 实时控制台" data-transport={transport}>
  <div className="live-console-toolbar">
   <strong>Agent 控制台</strong>
   <span className={'live-console-status '+transport}>{transportLabel}</span>
   <span className="live-console-count">{sorted.length} 条</span>
   <button type="button" className="live-console-tool" aria-pressed={!follow} onClick={()=>setFollow(value=>!value)}>{follow?'暂停跟随':'恢复跟随'}</button>
   <button type="button" className="live-console-tool" disabled={!sorted.length} onClick={()=>void copyAll()}>{copied?'已复制':'复制全部'}</button>
  </div>
  {limited&&<p className="live-console-banner" role="status">输出已达到记录上限，之后的输出不再保存；Run 本身不受影响。</p>}
  <div className="live-console-screen" ref={scroller} onScroll={onScroll} role="log" aria-label="Agent 输出" aria-live="polite">
   {!groups.length&&<p className="live-console-empty">{running?'等待 Agent 输出…':'此 Run 没有控制台记录。'}</p>}
   {groups.map(group=><div className="live-console-group" key={group.key} data-step={group.entries[0].stepId??undefined}>{group.entries.map(entry=><EntryLine key={entry.sequence} entry={entry} inputs={inputs}/>)}</div>)}
   {unechoed.map(input=><div className="live-console-line kind-input_echo pending" key={input.id}><span className="live-console-prefix" aria-hidden="true">↳</span><div className="live-console-text">[{MODES[input.mode]}] {input.text}<InputState input={input}/></div></div>)}
  </div>
  <div className="live-console-input">
   <textarea aria-label="给 Agent 的输入" rows={2} value={draft} disabled={!running||sending} placeholder={running?'输入引导内容，Enter 发送，Shift+Enter 换行':'Run 未在运行，无法发送输入'} onChange={event=>setDraft(event.target.value)} onKeyDown={onKeyDown}/>
   <div className="live-console-actions">
    <button type="button" className="primary" disabled={!guideOk||sending||!draft.trim()||tooLong} onClick={()=>void submit('guide')}>引导</button>
    <button type="button" className="secondary" disabled={!interruptOk||sending||!draft.trim()||tooLong} onClick={()=>void submit('interrupt')}>打断并发送</button>
   </div>
  </div>
  <p className="live-console-hint">{running?capabilityHint(capabilities):'Run 已不在运行，输入已停用。'}{tooLong?' · 输入超过 4000 字':''}</p>
  {inputError&&<p role="alert" className="form-error live-console-error">{inputError}</p>}
 </section>;
}
