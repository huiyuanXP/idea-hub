import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../lib/database.mts';
import { claimWorkspaceRun,decideWorkspaceRun,failWorkspaceRun,prepareWorkspaceRun } from '../../lib/workspace-runs/service.mts';
import { handleWorkspaceAgentRequest,handleWorkspaceRequest } from '../../lib/workspace-runs/http.mts';
import { ackRunInput,appendTranscript,claimRunInputs,getTranscriptPage,setRunCapabilities,streamWorkspaceRun,submitRunInput,TRANSCRIPT_RUN_ENTRIES } from '../../lib/workspace-runs/live.mts';

async function fixture(t,{mockTime=true}={}) {
 const dir=mkdtempSync(join(tmpdir(),'hub-workspace-live-')),db=openDatabase(':memory:');
 let now=Date.now();if(mockTime)t.mock.method(Date,'now',()=>now);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 await db.prepare('INSERT INTO local_users VALUES(?,?,?,?,?)').bind('alice','alice','Alice','synthetic-unusable-hash',now).run();
 await db.prepare('INSERT INTO local_users VALUES(?,?,?,?,?)').bind('bob','bob','Bob','synthetic-unusable-hash',now).run();
 await db.prepare('INSERT INTO workspace_projects VALUES(?,?,?,?)').bind('project','alice','test',now).run();
 for(const id of ['connection','connection2'])
  await db.prepare(`INSERT INTO workspace_connections(id,owner,project_id,name,workspace,version,capabilities,token_hash,token_expires_at,created_at)
   VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id,'alice','project',id,'test-repository','1','["read","execute"]',id+'-synthetic-hash',now+86400000,now).run();
 const principal={id:'connection',owner:'alice',projectId:'project',project:'test',capabilities:['read','execute']};
 const raw=JSON.stringify({title:'Implement addition',project:'test',status:'todo'});
 await db.prepare("INSERT INTO records(id,owner,kind,body,revision,created,updated) VALUES('ticket','alice','ticket',?,1,?,?)").bind(raw,new Date(now).toISOString(),new Date(now).toISOString()).run();
 async function running(){
  const run=await prepareWorkspaceRun(db,'alice',{ticketId:'ticket',revision:1,connectionId:'connection',requestId:'request',timeoutMs:120000});
  await decideWorkspaceRun(db,'alice',run.id,'approve');const {job}=await claimWorkspaceRun(db,principal);assert.ok(job);return job;
 }
 return {db,principal,running,advance(ms){now+=ms;}};
}
const status=expected=>error=>{assert.equal(typeof expected==='number'?error.status:error.code,expected);return true;};
const entry=(n,body={text:`step ${n}`})=>({id:`inst:run:t${n}`,kind:'message',body});
const input=(job,requestId='r1',mode='guide',text='Please also run lint')=>({runId:job.id,requestId,mode,text});

test('owner reads paginated transcript; others get 404; connector lease is required',async t=>{
 const f=await fixture(t),job=await f.running();
 const appended=await appendTranscript(f.db,f.principal,job.id,job.leaseToken,[1,2,3,4,5].map(n=>entry(n)));
 assert.deepEqual(appended,{accepted:5,lastSequence:5,limited:false});
 const first=await getTranscriptPage(f.db,'alice',job.id,0,2),second=await getTranscriptPage(f.db,'alice',job.id,first.nextAfter,2),third=await getTranscriptPage(f.db,'alice',job.id,second.nextAfter,2);
 assert.deepEqual([first,second,third].flatMap(page=>page.entries.map(item=>item.sequence)),[1,2,3,4,5]);
 assert.deepEqual([first.hasMore,second.hasMore,third.hasMore],[true,true,false]);
 assert.equal((await getTranscriptPage(f.db,'alice',job.id,5)).nextAfter,5);
 await assert.rejects(getTranscriptPage(f.db,'bob',job.id,0),status(404));
 const http=await handleWorkspaceRequest(f.db,'bob',new Request(`http://localhost/api/workspace-runs?runId=${job.id}&transcriptAfter=0`));assert.equal(http.status,404);
 const own=await (await handleWorkspaceRequest(f.db,'alice',new Request(`http://localhost/api/workspace-runs?runId=${job.id}&transcriptAfter=3&transcriptLimit=1`))).json();
 assert.deepEqual(own.transcript.entries.map(item=>item.sequence),[4]);assert.equal(own.transcript.state,'running');
 await assert.rejects(appendTranscript(f.db,f.principal,job.id,'wrong-token',[entry(9)]),status('LEASE_CONFLICT'));
 await assert.rejects(appendTranscript(f.db,{...f.principal,id:'connection2'},job.id,job.leaseToken,[entry(9)]),status('LEASE_CONFLICT'));
 f.advance(30000);await assert.rejects(appendTranscript(f.db,f.principal,job.id,job.leaseToken,[entry(9)]),status('LEASE_CONFLICT'));
});

test('transcript batches are idempotent, conflicting ids are rejected, reserved ids refused and strings redacted',async t=>{
 const f=await fixture(t),job=await f.running(),batch=[entry(1),{id:'inst:run:t2',kind:'command_output',stepId:'s1',body:{output:'Authorization: Bearer abc token sk-live_123',exitCode:0,nested:['sk-abc']}}];
 await appendTranscript(f.db,f.principal,job.id,job.leaseToken,batch);
 assert.deepEqual(await appendTranscript(f.db,f.principal,job.id,job.leaseToken,batch),{accepted:0,lastSequence:2,limited:false});
 await assert.rejects(appendTranscript(f.db,f.principal,job.id,job.leaseToken,[entry(1,{text:'changed'})]),status('TRANSCRIPT_CONFLICT'));
 for(const bad of [{id:'system:limit',kind:'system',body:{text:'x'}},{id:'input:x',kind:'message',body:{text:'x'}},{...entry(3),kind:'input_echo'},{...entry(3),body:{text:'x'.repeat(32001)}}])
  await assert.rejects(appendTranscript(f.db,f.principal,job.id,job.leaseToken,[bad]),status('INVALID_INPUT'));
 await assert.rejects(appendTranscript(f.db,f.principal,job.id,job.leaseToken,Array.from({length:101},(_,n)=>entry(n+10))),status('INVALID_INPUT'));
 const stored=(await getTranscriptPage(f.db,'alice',job.id,0)).entries[1];
 const wire=JSON.stringify(stored.body);assert.ok(!wire.includes('abc') && !wire.includes('sk-'),wire);assert.equal(stored.stepId,'s1');
});

test('per-run limit writes one system:limit marker and never fails the Run',async t=>{
 const f=await fixture(t),job=await f.running();
 // Pre-fill to just below the entry limit with direct inserts (the limit is a storage invariant, not a throughput test).
 await f.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) INSERT INTO workspace_run_transcript(run_id,id,sequence,kind,body,created_at)
  SELECT ?, 'fill:'||i, i, 'message', '{"text":"x"}', 0 FROM n`).bind(TRANSCRIPT_RUN_ENTRIES-1,job.id).run();
 const result=await appendTranscript(f.db,f.principal,job.id,job.leaseToken,[entry(1),entry(2),entry(3)]);
 assert.equal(result.accepted,1);assert.equal(result.limited,true);
 assert.deepEqual(await appendTranscript(f.db,f.principal,job.id,job.leaseToken,[entry(4)]),{accepted:0,lastSequence:TRANSCRIPT_RUN_ENTRIES+1,limited:true});
 const page=await getTranscriptPage(f.db,'alice',job.id,TRANSCRIPT_RUN_ENTRIES-1);
 assert.equal(page.limited,true);assert.equal(page.state,'running');
 assert.deepEqual(page.entries.map(item=>[item.id,item.truncated]),[['inst:run:t1',false],['system:limit',true]]);
});

test('owner input lifecycle: idempotent submit, echo entry, delivery, redelivery, forward-only ack',async t=>{
 const f=await fixture(t),job=await f.running();
 const first=await submitRunInput(f.db,'alice',input(job));assert.equal(first.input.state,'queued');
 assert.equal((await submitRunInput(f.db,'alice',input(job))).input.id,first.input.id);
 await assert.rejects(submitRunInput(f.db,'alice',input(job,'r1','interrupt')),status(409));
 await assert.rejects(submitRunInput(f.db,'bob',input(job,'r2')),status(404));
 const echo=(await getTranscriptPage(f.db,'alice',job.id,0)).entries.find(item=>item.kind==='input_echo');
 assert.deepEqual(echo.body,{inputId:first.input.id,mode:'guide',text:'Please also run lint'});assert.equal(echo.id,`input:${first.input.id}`);
 await assert.rejects(claimRunInputs(f.db,{...f.principal,id:'connection2'},job.id,job.leaseToken),status('LEASE_CONFLICT'));
 const delivered=await claimRunInputs(f.db,f.principal,job.id,job.leaseToken);assert.deepEqual(delivered.inputs.map(item=>[item.id,item.state]),[[first.input.id,'delivered']]);
 assert.deepEqual((await claimRunInputs(f.db,f.principal,job.id,job.leaseToken)).inputs.map(item=>item.id),[first.input.id]);
 const applied=await ackRunInput(f.db,f.principal,job.id,job.leaseToken,{inputId:first.input.id,state:'applied'});assert.equal(applied.input.state,'applied');
 assert.equal((await ackRunInput(f.db,f.principal,job.id,job.leaseToken,{inputId:first.input.id,state:'applied'})).input.state,'applied');
 await assert.rejects(ackRunInput(f.db,f.principal,job.id,job.leaseToken,{inputId:first.input.id,state:'rejected'}),status(409));
 assert.deepEqual((await claimRunInputs(f.db,f.principal,job.id,job.leaseToken)).inputs,[]);
 const queued=await submitRunInput(f.db,'alice',input(job,'r3'));
 await assert.rejects(ackRunInput(f.db,f.principal,job.id,job.leaseToken,{inputId:queued.input.id,state:'applied'}),status(409));
});

test('capabilities gate modes; inputs are refused outside running and rejected when the Run ends',async t=>{
 const f=await fixture(t),job=await f.running();
 const caps=await setRunCapabilities(f.db,f.principal,job.id,job.leaseToken,{runner:'codex',guide:true,interrupt:false});
 assert.deepEqual(caps.capabilities,{runner:'codex',guide:true,interrupt:false,note:null});
 await assert.rejects(submitRunInput(f.db,'alice',input(job,'i1','interrupt')),status('MODE_UNSUPPORTED'));
 const queued=await submitRunInput(f.db,'alice',input(job,'g1')),delivered=await submitRunInput(f.db,'alice',input(job,'g2'));
 await claimRunInputs(f.db,f.principal,job.id,job.leaseToken);await ackRunInput(f.db,f.principal,job.id,job.leaseToken,{inputId:queued.input.id,state:'applied'});
 await decideWorkspaceRun(f.db,'alice',job.id,'cancel');
 await assert.rejects(submitRunInput(f.db,'alice',input(job,'g3')),status('RUN_NOT_RUNNING'));
 const page=await getTranscriptPage(f.db,'alice',job.id,0);
 assert.deepEqual(page.inputs.map(item=>[item.id,item.state,item.reason]),[[queued.input.id,'applied',null],[delivered.input.id,'rejected','Run ended before delivery']]);
 assert.deepEqual(page.capabilities,{runner:'codex',guide:true,interrupt:false,note:null});
 const response=await handleWorkspaceRequest(f.db,'alice',new Request('http://localhost/api/workspace-runs',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost'},body:JSON.stringify({action:'input',...input(job,'g4')})}));
 assert.equal(response.status,409);assert.equal((await response.json()).code,'RUN_NOT_RUNNING');
});

test('machine HTTP actions are wired with strict bodies',async t=>{
 const f=await fixture(t),job=await f.running();
 const call=body=>handleWorkspaceAgentRequest(f.db,f.principal,new Request('http://localhost/api/connector/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runId:job.id,leaseToken:job.leaseToken,...body})}));
 assert.deepEqual(await (await call({action:'transcript',entries:[entry(1)]})).json(),{accepted:1,lastSequence:1,limited:false});
 assert.equal((await call({action:'transcript',entries:[entry(1)],extra:1})).status,400);
 assert.equal((await call({action:'capabilities',capabilities:{runner:'claude',guide:true,interrupt:true,note:'stream-json'}})).status,200);
 await submitRunInput(f.db,'alice',input(job));
 const {inputs}=await (await call({action:'inputs'})).json();assert.equal(inputs.length,1);
 const ack=await (await call({action:'input-ack',inputId:inputs[0].id,state:'rejected',reason:'Bearer secret-value is not usable'})).json();
 assert.equal(ack.input.state,'rejected');assert.equal(ack.input.reason,'Bearer [redacted] is not usable');
});

async function reader(response) {
 const stream=response.body.getReader(),decoder=new TextDecoder();let buffer='';const events=[];
 return {
  events,
  async until(predicate,ms=2000){
   const deadline=Date.now()+ms;
   while(!predicate(events)){
    const remaining=deadline-Date.now();if(remaining<=0)throw new Error(`timed out; got ${JSON.stringify(events.map(item=>item.event))}`);
    const next=await Promise.race([stream.read(),new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),remaining))]);
    if(next.timeout)continue;if(next.done){events.push({event:'<closed>'});break;}
    buffer+=decoder.decode(next.value,{stream:true});
    let index;while((index=buffer.indexOf('\n\n'))>=0){
     const block=buffer.slice(0,index);buffer=buffer.slice(index+2);const item={};
     for(const line of block.split('\n')){const match=/^(id|event|data): (.*)$/.exec(line);if(match)item[match[1]]=match[1]==='data'?JSON.parse(match[2]):match[2];}
     if(item.event)events.push(item);
    }
   }
   return events;
  },
  cancel(){return stream.cancel().catch(()=>{});},
 };
}
const sequences=events=>events.filter(item=>item.event==='transcript').flatMap(item=>item.data.map(entry=>entry.sequence));

test('SSE delivers appended entries promptly, resumes without gaps or duplicates and ends on terminal state',async t=>{
 const f=await fixture(t,{mockTime:false}),job=await f.running(),controller=new AbortController();t.after(()=>controller.abort());
 const url=after=>`http://localhost/api/workspace-runs/stream?runId=${job.id}${after===undefined?'':`&after=${after}`}`;
 assert.equal((await streamWorkspaceRun(f.db,null,new Request(url()))).status,401);
 assert.equal((await streamWorkspaceRun(f.db,'bob',new Request(url()))).status,404);
 await appendTranscript(f.db,f.principal,job.id,job.leaseToken,[entry(1),entry(2)]);
 const response=await streamWorkspaceRun(f.db,'alice',new Request(url(),{signal:controller.signal}),{pollMs:60000});
 assert.equal(response.headers.get('content-type').split(';')[0],'text/event-stream');assert.equal(response.headers.get('x-accel-buffering'),'no');assert.equal(response.headers.get('cache-control'),'no-store');
 const live=await reader(response);await live.until(events=>sequences(events).length===2 && events.some(item=>item.event==='state'));
 // pollMs is effectively disabled, so arrival within 2s proves the in-process notification path.
 await appendTranscript(f.db,f.principal,job.id,job.leaseToken,[entry(3)]);await live.until(events=>sequences(events).includes(3));
 await submitRunInput(f.db,'alice',input(job));await live.until(events=>events.some(item=>item.event==='inputs'));
 const lastId=Number(live.events.filter(item=>item.event==='transcript').at(-1).id);
 controller.abort();await live.cancel();
 await appendTranscript(f.db,f.principal,job.id,job.leaseToken,[entry(4),entry(5)]);
 const resumed=await reader(await streamWorkspaceRun(f.db,'alice',new Request(url(0),{headers:{'last-event-id':String(lastId)}}),{pollMs:60000}));
 await resumed.until(events=>sequences(events).includes(6));
 assert.deepEqual([...sequences(live.events),...sequences(resumed.events)],[1,2,3,4,5,6]);
 await decideWorkspaceRun(f.db,'alice',job.id,'cancel');await failWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,'Process group stopped');
 const ended=await resumed.until(events=>events.some(item=>item.event==='<closed>'));
 const end=ended.find(item=>item.event==='end');assert.deepEqual(end.data,{state:'cancelled'});
 assert.equal(ended.at(-1).event,'<closed>');assert.equal(ended.at(-2).event,'end');
 assert.ok(ended.some(item=>item.event==='inputs' && item.data.some(entry=>entry.state==='rejected')));
});
