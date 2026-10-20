"use client";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent, KeyboardEvent } from "react";
import type { Row } from "../../lib/types";
import { TicketCard, ticketStatuses } from "./ticket-card";
import type { BoardState, Readiness } from "../../lib/tickets/selectors.mts";
type Drag = {
    ticket: Row;
    target: string | null;
    keyboard: boolean;
};
export function TicketBoard({ tickets, states, readiness, list, statusFilter, onDetails, onIntent, onExecute }: {
    tickets: Row[];
    states: ReadonlyMap<string, BoardState>;
    readiness?: ReadonlyMap<string, Readiness>;
    list: boolean;
    statusFilter: string;
    onDetails: (ticket: Row) => void;
    onIntent: (ticket: Row, target: string) => void;
    onExecute: (ticket: Row) => void;
}) {
    const [drag, setDrag] = useState<Drag | null>(null), [announcement, setAnnouncement] = useState("");
    const dragRef = useRef<Drag | null>(null), pending = useRef<{
        ticket: Row;
        x: number;
        y: number;
        pointerId: number;
    } | null>(null);
    const intentRef = useRef(onIntent);
    const column = (ticket: Row) => states.get(ticket.id)?.status ?? ticket.status ?? "todo";
    const columnRef = useRef(column);
    useEffect(() => { intentRef.current = onIntent; columnRef.current = column; });
    const columns = Object.entries(ticketStatuses).filter(([state]) => statusFilter === "all" || state === statusFilter || (statusFilter === "active" && (state === "todo" || state === "running")));
    const update = (value: Drag | null) => { dragRef.current = value; setDrag(value); };
    const cancel = () => { pending.current = null; update(null); setAnnouncement("已取消移动；任务状态保持不变。"); };
    useEffect(() => {
        let frame = 0, position: {
            x: number;
            y: number;
        } | null = null;
        const targetAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-board-target]")?.dataset.boardTarget ?? null;
        const move = (event: globalThis.PointerEvent) => {
            const start = pending.current;
            if (!start || start.pointerId !== event.pointerId)
                return;
            if (!dragRef.current && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6)
                return;
            event.preventDefault();
            position = { x: event.clientX, y: event.clientY };
            const target = targetAt(event.clientX, event.clientY);
            const value = { ticket: start.ticket, target, keyboard: false };
            dragRef.current = value;
            setDrag(value);
            setAnnouncement(target ? "目标：" + ticketStatuses[target as keyof typeof ticketStatuses] + "；释放后进入操作。" : "列外释放会取消移动。");
        };
        const up = (event: globalThis.PointerEvent) => {
            if (pending.current?.pointerId !== event.pointerId)
                return;
            const current = dragRef.current;
            const target = targetAt(event.clientX, event.clientY);
            pending.current = null;
            position = null;
            dragRef.current = null;
            setDrag(null);
            if (current && target && target !== columnRef.current(current.ticket))
                intentRef.current(current.ticket, target);
            else
                setAnnouncement("移动结束；任务状态保持不变。");
        };
        const cancel = () => { pending.current = null; position = null; dragRef.current = null; setDrag(null); setAnnouncement("已取消移动；任务状态保持不变。"); };
        const key = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape" && (pending.current || dragRef.current)) {
            event.preventDefault();
            cancel();
        } };
        const scroll = () => { if (position && pending.current) {
            const delta = position.y < 70 ? -12 : position.y > innerHeight - 70 ? 12 : 0;
            if (delta) {
                window.scrollBy(0, delta);
                const target = targetAt(position.x, position.y);
                if (dragRef.current) {
                    dragRef.current = { ...dragRef.current, target };
                    setDrag(dragRef.current);
                }
            }
        } frame = requestAnimationFrame(scroll); };
        window.addEventListener("pointermove", move, { passive: false });
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("keydown", key);
        frame = requestAnimationFrame(scroll);
        return () => { cancelAnimationFrame(frame); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", key); pending.current = null; dragRef.current = null; };
    }, []);
    const pointerDown = (event: PointerEvent<HTMLButtonElement>, ticket: Row) => { if (!event.isPrimary || event.button !== 0)
        return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); pending.current = { ticket, x: event.clientX, y: event.clientY, pointerId: event.pointerId }; };
    const keyDown = (event: KeyboardEvent<HTMLButtonElement>, ticket: Row) => {
        if (event.key === "Escape") {
            event.preventDefault();
            cancel();
            return;
        }
        if (event.key === "Tab" && dragRef.current) {
            cancel();
            return;
        }
        if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            const current = dragRef.current;
            if (!current) {
                update({ ticket, target: column(ticket), keyboard: true });
                setAnnouncement("已选中 " + ticket.title + "。方向键选择目标列，Enter 确认，Escape 取消。");
            }
            else {
                update(null);
                if (current.target && current.target !== column(current.ticket))
                    onIntent(current.ticket, current.target);
                else
                    setAnnouncement("同列操作结束；任务状态保持不变。");
            }
            return;
        }
        if (dragRef.current?.keyboard && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const current = dragRef.current, index = columns.findIndex(([state]) => state === current.target), delta = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
            const next = event.key === "Home" ? 0 : event.key === "End" ? columns.length - 1 : Math.max(0, Math.min(columns.length - 1, index + delta));
            const target = columns[next]?.[0];
            if (target) {
                update({ ...current, target });
                setAnnouncement("目标：" + ticketStatuses[target as keyof typeof ticketStatuses] + "。Enter 进入操作，Escape 取消。");
            }
        }
    };
    const card = (ticket: Row) => <TicketCard key={ticket.id} ticket={ticket} onDetails={onDetails} onIntent={onIntent} onExecute={onExecute} onPointerDown={list ? undefined : pointerDown} onKeyDown={keyDown} dragging={drag?.ticket.id === ticket.id} state={states.get(ticket.id)} readiness={readiness?.get(ticket.id)}/>;
    return <section aria-label="Ticket 看板任务"><p id="board-drag-instructions" className="board-help">拖动手柄选择列；键盘用空格选中、方向键选择、Enter 确认、Escape 取消。也可使用卡片的“移动 / 处理”，效果与拖动相同。拖到“进行中”并批准开发后，任务随真实执行状态移动；释放不会直接执行。</p><div role="status" aria-live="polite" className="board-announcement">{announcement}</div>{list ? <div className="ticket-list">{tickets.map(card)}{!tickets.length && <p className="column-empty">暂无任务</p>}</div> : <div className="board">{columns.map(([state, label]) => <section className={"column " + state} key={state} data-board-target={state} data-drop-target={drag?.target === state || undefined} aria-label={label + "列"}><header><span className="state-dot"/><h2>{label}</h2><span>{tickets.filter(ticket => column(ticket) === state).length}</span></header>{tickets.filter(ticket => column(ticket) === state).map(card)}{!tickets.some(ticket => column(ticket) === state) && <div className="column-empty">暂无任务</div>}{drag?.target === state && <p className="board-target-feedback">{state === column(drag.ticket) ? "同列：不保存位置" : "释放后进入操作：" + label}</p>}</section>)}</div>}</section>;
}
