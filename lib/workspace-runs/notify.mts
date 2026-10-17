import { EventEmitter } from 'node:events';

/** Process-wide Run change notifier shared by every route module instance (Next may load modules more than once). */
const runtime=globalThis as typeof globalThis & {__workspaceRunLive?:EventEmitter};
function emitter():EventEmitter {
 if(!runtime.__workspaceRunLive){runtime.__workspaceRunLive=new EventEmitter();runtime.__workspaceRunLive.setMaxListeners(0);}
 return runtime.__workspaceRunLive;
}
export function notifyRun(runId:string):void {emitter().emit(runId);}
export function subscribeRun(runId:string,listener:()=>void):()=>void {
 const events=emitter();events.on(runId,listener);return ()=>{events.off(runId,listener);};
}
