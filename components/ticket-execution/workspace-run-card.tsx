"use client";
import type {WorkspaceRun,OwnerAction} from '../../lib/workspace-runs/types.mts';
import {LiveConsole} from './live-console';
const states:Record<string,string>={pending:'待批准',approved:'等待 Agent',running:'已领取，执行中',review:'等待审核',succeeded:'审核通过 · 已归档',failed:'失败',cancelled:'已取消'};
export function WorkspaceRunCard({run,current,busy,onAction}:{run:WorkspaceRun;current:boolean;busy:boolean;onAction:(id:string,action:OwnerAction)=>void}) {
 return <article className="idea-card" data-run-id={run.id}>
  <div className="card-top"><strong>{states[run.state]||run.state}</strong><span>{current?'当前修订':'历史修订'} · Ticket v{run.revision}</span></div>
  <p>Run {run.id} · {run.project} · {run.workspace} · 最长 {Math.round(run.timeoutMs/60000)} 分钟</p>
  {run.error&&<p className="form-error">{run.error}</p>}
  {['running','review','succeeded','failed','cancelled'].includes(run.state)&&<LiveConsole run={run}/>}
  {run.events.length>0&&<details className="stage-log"><summary>阶段日志（{run.events.length}）</summary><ol className="execution-timeline">{run.events.map(event=><li key={event.id}><strong>{event.stage}</strong> {event.message}</li>)}</ol></details>}
  {run.result&&<div className="development-result"><h4>交付结果</h4><p>{run.result.summary}</p><p>修改文件：{run.result.files.join('、')||'无'}</p><details><summary>查看实际变更</summary><pre>{run.result.diff||'没有文件差异'}</pre></details><details><summary>查看测试证据</summary>{run.result.tests.map((test,index)=><div key={index}><strong>{test.command} · 退出码 {test.exitCode}</strong><pre>{test.output}</pre></div>)}</details></div>}
  <div className="card-actions">
   {current&&run.state==='pending'&&<><button type="button" className="primary" disabled={busy} onClick={()=>onAction(run.id,'approve')}>批准开发</button><button type="button" className="secondary" disabled={busy} onClick={()=>onAction(run.id,'reject')}>拒绝</button></>}
   {['pending','approved','running','review'].includes(run.state)&&<button type="button" className="secondary" disabled={busy} onClick={()=>onAction(run.id,'cancel')}>取消任务</button>}
   {current&&run.state==='review'&&<><button type="button" className="primary" disabled={busy} onClick={()=>onAction(run.id,'accept')}>审核通过并归档</button><button type="button" className="secondary" disabled={busy} onClick={()=>onAction(run.id,'rework')}>要求返工</button></>}
   {current&&['failed','cancelled'].includes(run.state)&&<button type="button" className="secondary" disabled={busy} onClick={()=>onAction(run.id,'rework')}>要求返工</button>}
  </div>
 </article>;
}
