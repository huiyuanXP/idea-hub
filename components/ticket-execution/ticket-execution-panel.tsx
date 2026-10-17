"use client";
import {useState} from 'react';
import type {Row} from '../../lib/types';
import {useTicketExecution} from '../../hooks/use-ticket-execution';
import {ticketExecutionContext} from '../../lib/tickets/selectors.mts';
import {WorkspaceRunCard} from './workspace-run-card';
import {AuthorizationPanel} from '../execution/authorization-panel';

type Props={ticket:Row;intent?:'execute'|'review'|'active';runId?:string;initialBackend?:'workspace'|'docker';onAuthenticationDenied:()=>void;onRecordsChanged:()=>void};
export function TicketExecutionPanel(props:Props){return <BoundTicketExecutionPanel key={props.ticket.id+':'+props.ticket.revision} {...props}/>;}
function BoundTicketExecutionPanel({ticket,onAuthenticationDenied,onRecordsChanged,intent,runId,initialBackend}:Props) {
 const controller=useTicketExecution({ticketId:ticket.id,revision:ticket.revision,project:ticket.project||'通用',onAuthenticationDenied,onRecordsChanged});
 const [backend,setBackend]=useState<'workspace'|'docker'>(initialBackend||'workspace');
 const context=ticketExecutionContext(ticket,controller.runs,controller.dockerRuns);
 const active=context.activeWorkspace||context.activeDocker;
 return <section className="workspace-section" aria-label="Ticket 执行">
  <div className="section-heading"><div><h2>执行：{ticket.title}</h2><p>冻结 Ticket v{ticket.revision} · {ticket.project||'通用'} · 手工状态：{ticket.status}</p></div><button type="button" className="secondary" onClick={()=>void controller.refresh()}>刷新执行</button></div>
  <div className="execution-modes" role="tablist" aria-label="执行方式">
   <button type="button" role="tab" aria-selected={backend==='workspace'} className={backend==='workspace'?'active':''} onClick={()=>setBackend('workspace')}><strong>本机 Agent 开发</strong><small>由已连接 workspace 的常驻 Agent 在隔离 worktree 中修改代码并交回 diff 与测试，适合实现 Ticket。</small></button>
   <button type="button" role="tab" aria-selected={backend==='docker'} className={backend==='docker'?'active':''} onClick={()=>setBackend('docker')}><strong>固定 Docker 操作</strong><small>在签名的本地 Docker 后端运行预先登记的固定命令，无网络、无凭据，需单独授权资源预算；不修改代码。</small></button>
  </div>
  {intent==='review'&&!controller.loading&&!context.currentWorkspace.some(run=>run.state==='review'&&(!runId||run.id===runId))&&<p className="form-error">当前修订没有此待验收开发结果，请刷新关联执行。</p>}
  {backend==='workspace'&&<>
   <p>流程：申请开发 → 批准（任务进入“进行中”）→ Agent 领取并开发 → 交付后进入“已完成”并标记等待审核 → 审核通过后自动归档。安装连接不构成此 Ticket 执行许可。</p>
   {!active&&ticket.status!=='done'&&<div className="workspace-form">
    <label>执行 workspace<select aria-label="执行 workspace" value={controller.connection?.id??''} disabled={controller.busy} onChange={e=>controller.setConnectionId(e.target.value)}><option value="" disabled>先安装本项目客户端</option>{controller.connections.map(c=><option value={c.id} key={c.id}>{c.name} · {c.agentReady?'Agent 可用':'Agent 未就绪'}</option>)}</select></label>
    {controller.connection&&<p>目标工作区：{controller.connection.workspace||controller.connection.name}{controller.connection.agentError?' · '+controller.connection.agentError:''}</p>}
    <label>执行期限（分钟）<input aria-label="执行期限（分钟）" type="number" min={1} max={60} value={controller.minutes} disabled={controller.busy} onChange={e=>controller.setMinutes(Number(e.target.value))}/></label>
    <button type="button" className="primary" disabled={controller.loading||controller.busy||!controller.connection||controller.conflict||!Number.isFinite(controller.minutes)||controller.minutes<1||controller.minutes>60} onClick={controller.prepare}>申请开发执行</button>
   </div>}
   {!controller.loading&&!active&&!controller.connection&&ticket.status!=='done'&&<p className="form-help">没有此项目可执行的 workspace 连接，请在连接与执行中安装或恢复连接。</p>}
   {ticket.status==='done'&&<p>此 Ticket 已审核归档，查看已有验收证据；不能直接重新申请开发。</p>}
   {context.activeDocker&&<p>此 Ticket 有活动 Docker Run；请进入固定 Docker 操作查看授权与停止状态。</p>}
   {controller.runs.map(run=><WorkspaceRunCard key={run.id} run={run} current={context.currentWorkspace.includes(run)} busy={controller.busy} onAction={controller.act}/>)}
   {!controller.loading&&!controller.runs.length&&<p className="form-help">当前 Ticket 尚无开发 Run。</p>}
  </>}
  {backend==='docker'&&<AuthorizationPanel tickets={[ticket]} ticketId={ticket.id} revision={ticket.revision} blockedReason={context.activeWorkspace?"此 Ticket 有活动开发 Run，请先查看其批准、取消或验收流程。":undefined} onAuthenticationDenied={onAuthenticationDenied}/>}
  {controller.conflict&&<p className="form-error">关联数据已刷新，输入已保留。请刷新 Ticket 并确认修订后重试。</p>}
  {controller.error&&<p role="alert" className="form-error">{controller.error}</p>}
 </section>;
}
