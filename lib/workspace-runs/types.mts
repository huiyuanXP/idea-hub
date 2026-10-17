import type { ConnectorPrincipal } from '../connectors/service.mts';
export type { ConnectorPrincipal };
export type RunState = 'pending'|'approved'|'running'|'review'|'succeeded'|'failed'|'cancelled';
export interface WorkspaceResult {
 summary:string; diff:string; files:string[];
 tests:{command:string;exitCode:number;output:string}[];
 worktree:string; agentSession?:string;
}
export interface RunRow {
 id:string;owner:string;ticket_id:string;ticket_revision:number;ticket_body:string;
 connection_id:string;project_id:string;project:string;workspace:string;operation:string;
 request_id:string;input_key:string;previous_run_id:string|null;timeout_ms:number;state:RunState;version:number;
 generation:number;lease_hash:string|null;lease_expires_at:number|null;deadline_at:number|null;
 physical_closed_at:number|null;cancel_requested:number;error:string|null;result:string|null;
 created_at:number;updated_at:number;
}
export interface WorkspaceEvent {id:string;sequence:number;stage:string;message:string;createdAt:number}
export interface WorkspaceRun {
 id:string;ticketId:string;revision:number;connectionId:string;project:string;state:RunState;
 createdAt:number;updatedAt:number;timeoutMs:number;error:string|null;result:WorkspaceResult|null;
 events:WorkspaceEvent[];eventsCursor:number|null;workspace:string;operation:string;
}
export const TRANSCRIPT_KINDS=['message','reasoning','command_start','command_output','file_change','tool_call','tool_result','error','result','input_echo','system'] as const;
export type TranscriptKind=typeof TRANSCRIPT_KINDS[number];
/** One persisted console step. body is kind-specific JSON (see docs/EXECUTION.md). */
export interface TranscriptEntry {id:string;sequence:number;kind:TranscriptKind;stepId:string|null;body:Record<string,unknown>;truncated:boolean;createdAt:number}
export type InputMode='guide'|'interrupt';
export type InputState='queued'|'delivered'|'applied'|'rejected';
export interface RunInput {id:string;requestId:string;sequence:number;mode:InputMode;text:string;state:InputState;reason:string|null;createdAt:number;updatedAt:number}
export interface RunnerCapabilities {runner:string;guide:boolean;interrupt:boolean;note:string|null}
export interface TranscriptPage {runId:string;state:RunState;entries:TranscriptEntry[];nextAfter:number;hasMore:boolean;limited:boolean;inputs:RunInput[];capabilities:RunnerCapabilities|null}
export interface PrepareInput {ticketId:string;revision:number;connectionId:string;requestId:string;timeoutMs:number}
export type OwnerAction='approve'|'reject'|'cancel'|'accept'|'rework';
