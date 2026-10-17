"use client";
import {useState} from 'react';
import type {Row} from '../../lib/types';
import {TicketExecutionPanel} from '../ticket-execution/ticket-execution-panel';

export function DevelopmentPanel({tickets,project,onAuthenticationDenied,onRecordsChanged}:{
 tickets:Row[];project:string;onAuthenticationDenied:()=>void;onRecordsChanged:()=>void;
}) {
 const [selected,setSelected]=useState<{id:string;revision:number}|null>(null);
 const visible=tickets.filter(ticket=>(ticket.project||'通用')===project);
 const ticket=visible.find(ticket=>ticket.id===selected?.id&&ticket.revision===selected.revision);
 return <section className="workspace-section" aria-label="本机 Agent 开发执行">
  <h2>本机 Agent 开发执行</h2>
  <label>开发 Ticket<select aria-label="开发 Ticket" value={selected?.id??''} onChange={event=>{const ticket=visible.find(ticket=>ticket.id===event.target.value);setSelected(ticket?{id:ticket.id,revision:ticket.revision}:null);}}>
   <option value="">请选择 Ticket</option>{selected&&!visible.some(ticket=>ticket.id===selected.id)&&<option value={selected.id}>原 Ticket 当前不可用</option>}
   {visible.map(ticket=><option key={ticket.id} value={ticket.id}>{ticket.title} · v{ticket.revision}</option>)}
  </select></label>
  {selected&&!ticket&&<><p className="form-error">选中的 Ticket 已消失、移出项目或修订已改变，请明确重新选择。</p><button type="button" className="secondary" onClick={()=>setSelected(null)}>重新选择 Ticket</button></>}
  {ticket&&<TicketExecutionPanel ticket={ticket} onAuthenticationDenied={onAuthenticationDenied} onRecordsChanged={onRecordsChanged}/>}
 </section>;
}
