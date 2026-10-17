"use client";
import { useState } from "react";
import type { PointerEvent, KeyboardEvent } from "react";
import { GripVertical } from "lucide-react";
import type { Row } from "../../lib/types";
import { REVIEW_TAG } from "../../lib/tickets/selectors.mts";
import type { BoardState, Readiness } from "../../lib/tickets/selectors.mts";
export const ticketStatuses = { todo: "待开始", running: "进行中", waiting: "等待中", done: "已完成", error: "异常" };
export const waitingReasons = { clarification: "需要澄清", approval: "需要授权", review: "等待验收", external: "外部依赖", recovery: "恢复确认" };
export function TicketCard({ ticket, onDetails, onIntent, onExecute, onPointerDown, onKeyDown, dragging = false, state, readiness }: {
    state?: BoardState;
    readiness?: Readiness;
    ticket: Row;
    onDetails: (ticket: Row) => void;
    onIntent: (ticket: Row, target: string) => void;
    onExecute: (ticket: Row) => void;
    onPointerDown?: (event: PointerEvent<HTMLButtonElement>, ticket: Row) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>, ticket: Row) => void;
    dragging?: boolean;
}) {
    const [target, setTarget] = useState("");
    return <article className="ticket-card" data-ticket-id={ticket.id} data-current-state={state?.status || ticket.status || "todo"} data-dragging={dragging || undefined}>
  <div className="card-top"><span className="id">T-{ticket.id.slice(0, 6).toUpperCase()}</span><span className={"priority " + ticket.priority}>{ticket.priority}</span>{onPointerDown && <button type="button" className="icon-btn ticket-drag-handle" aria-label={"拖动：" + ticket.title} aria-pressed={dragging} aria-describedby="board-drag-instructions" onPointerDown={event => onPointerDown(event, ticket)} onKeyDown={event => onKeyDown?.(event, ticket)}><GripVertical size={18}/></button>}</div>
  <button type="button" className="title-button" aria-label={"查看详情：" + ticket.title} onClick={() => onDetails(ticket)}><h3>{ticket.title}</h3></button>
  {ticket.goal && <p>{ticket.goal}</p>}
  <div className="card-bottom"><span className="project-tag">{ticket.project || "通用"}</span><span>v{ticket.revision}</span></div>
  {readiness && <span className={"readiness-tag tier-" + readiness.tier} data-readiness={readiness.tier}>{readiness.label}{readiness.unlocks ? ` · 解锁 ${readiness.unlocks} 个任务` : ""}</span>}
  {state?.tag && <span className={"run-tag" + (state.tag === REVIEW_TAG ? " review-tag" : "")}>{state.tag}</span>}
  {state?.archived && <span className="run-tag">已归档</span>}
  {ticket.status === "waiting" && <span className="wait-tag">{waitingReasons[ticket.waitingReason as keyof typeof waitingReasons] || "等待原因未记录"}</span>}
  <div className="ticket-actions">{state?.tag === REVIEW_TAG && <button type="button" className="primary" onClick={() => onIntent(ticket, "archive")}>审核通过并归档</button>}<button type="button" className="text-btn" onClick={() => onExecute(ticket)}>执行 / 查看执行</button><details><summary>移动 / 处理</summary><label>目标列<select aria-label={"目标列：" + ticket.title} value={target} onChange={event => setTarget(event.target.value)}><option value="">选择目标列</option>{Object.entries(ticketStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button type="button" className="secondary" disabled={!target} onClick={() => onIntent(ticket, target)}>进入操作</button></details></div>
 </article>;
}
