import test from 'node:test';
import assert from 'node:assert/strict';
import {sortTickets,filterTickets,resolveTicketAction,ticketExecutionContext,boardState,ticketReadiness} from '../../lib/tickets/selectors.mts';
const row=(id,extra={})=>({id,kind:'ticket',revision:2,title:id,project:'test',status:'todo',created:'2026-01-01T00:00:00Z',updated:'2026-01-01T00:00:00Z',...extra});
test('priority directions keep unknown values last and use created descending then ID',()=>{
 const rows=[row('unknown',{priority:'P9'}),row('p3',{priority:'P3'}),row('b',{priority:'P1'}),row('a',{priority:'P1'}),row('new',{priority:'P1',created:'2026-01-02'}),row('bad',{priority:'P1',created:'invalid'}),row('p0',{priority:'P0'}),row('p2',{priority:'P2'})];
 assert.deepEqual(sortTickets(rows,{field:'priority',direction:'asc'}).map(r=>r.id),['p0','new','a','b','bad','p2','p3','unknown']);
 assert.deepEqual(sortTickets(rows,{field:'priority',direction:'desc'}).map(r=>r.id),['p3','p2','new','a','b','bad','p0','unknown']);
 assert.equal(rows[0].id,'unknown');
});
test('persisted time directions put invalid times last, equal time only uses ID, default created desc',()=>{
 const rows=[row('b',{priority:'P0'}),row('a',{priority:'P3'}),row('new',{created:'2026-01-02',updated:'2026-01-02'}),row('invalid',{created:'broken',updated:''})];
 for(const field of ['created','updated']) {
  assert.deepEqual(sortTickets(rows,{field,direction:'asc'}).map(r=>r.id),['a','b','new','invalid']);
  assert.deepEqual(sortTickets(rows,{field,direction:'desc'}).map(r=>r.id),['new','a','b','invalid']);
 }
 assert.deepEqual(sortTickets(rows).map(r=>r.id),['new','a','b','invalid']);
 assert.deepEqual(filterTickets([...rows,row('other',{project:'other'}),row('idea',{kind:'idea'})],{project:'test',query:'a'}).map(r=>r.id),['a','invalid']);
});
const workspace=(id,revision,state,extra={})=>({id,ticketId:'ticket',revision,project:'test',state,...extra});
const docker=(id,revision,state)=>({id,ticketId:'ticket',ticketRevision:revision,ticketBody:'{"project":"test"}',state});
test('actions use exact revision review; old active Run blocks replacement; done never reopens',()=>{
 const ticket=row('ticket');
 assert.deepEqual(resolveTicketAction(ticket,'running'),{type:'open-execution',ticketId:'ticket',revision:2});
 assert.equal(resolveTicketAction(ticket,'todo').type,'no-op');
 assert.equal(resolveTicketAction(ticket,null).type,'no-op');
 assert.equal(resolveTicketAction(ticket,'unknown').type,'no-op');
 assert.deepEqual(resolveTicketAction(ticket,'waiting'),{type:'open-status',status:'waiting'});
 assert.equal(resolveTicketAction(ticket,'done',[workspace('old',1,'review')]).type,'open-active');
 assert.equal(resolveTicketAction(ticket,'done',[workspace('other',2,'review',{project:'other'})]).type,'open-active');
 assert.deepEqual(resolveTicketAction(ticket,'done',[workspace('current',2,'review')]),{type:'open-review',runId:'current'});
 assert.equal(resolveTicketAction(ticket,'done',[],[docker('d',2,'succeeded')]).type,'completed-info');
 for(const target of ['todo','running','waiting','error'])assert.equal(resolveTicketAction(row('ticket',{status:'done'}),target,[workspace('current',2,'review')]).type,'completed-info');
 assert.deepEqual(resolveTicketAction(ticket,'archive',[workspace('current',2,'review')]),{type:'open-review',runId:'current'});
 assert.deepEqual(resolveTicketAction(row('ticket',{status:'waiting',waitingReason:'review',evidence:'ok'}),'archive'),{type:'open-status',status:'done'});
 assert.equal(resolveTicketAction(row('ticket',{status:'waiting',waitingReason:'review'}),'archive').type,'completed-info');
 assert.equal(resolveTicketAction(ticket,'archive').type,'completed-info');
 const context=ticketExecutionContext(ticket,[workspace('old',1,'running'),workspace('recent',2,'failed')],[docker('old-d',1,'queued')]);
 assert.equal(context.currentWorkspace.length,1);assert.equal(context.historicalWorkspace.length,1);
 assert.equal(context.activeWorkspace.id,'old');assert.equal(context.activeDocker.id,'old-d');
});
test('board state follows real Runs: approve and claim move to running, failure to error, done stays done',()=>{
 const ticket=row('ticket');
 assert.deepEqual(boardState(ticket,[workspace('p',2,'pending',{createdAt:1})],[]),{status:'todo',tag:'开发申请待批准'});
 assert.equal(boardState(ticket,[workspace('a',2,'approved',{createdAt:1})],[]).status,'running');
 assert.deepEqual(boardState(ticket,[workspace('r',2,'review',{createdAt:1})],[]),{status:'done',tag:'等待审核'});
 assert.deepEqual(boardState(row('ticket',{status:'waiting',waitingReason:'review'}),[],[]),{status:'done',tag:'等待审核'});
 assert.equal(boardState(ticket,[],[docker('d',2,'running')]).status,'running');
 assert.equal(boardState(ticket,[workspace('f',2,'failed',{createdAt:2,error:'boom'}),workspace('old',2,'succeeded',{createdAt:1})],[]).status,'error');
 assert.equal(boardState(ticket,[workspace('f',1,'failed',{createdAt:2})],[]).status,'todo');
 assert.deepEqual(boardState(row('ticket',{status:'done'}),[workspace('a',2,'approved',{createdAt:1})],[]),{status:'done',archived:true});
 assert.equal(resolveTicketAction(ticket,'todo').type,'no-op');
});
test('recommended order is deterministic: runnable first, then in progress, waiting, blocked, done',()=>{
 const plan={planId:'plan'};
 const tickets=[
  row('done',{...plan,logicalKey:'T0',status:'done'}),
  row('blocked',{...plan,logicalKey:'T2',dependencies:'T1',priority:'P0'}),
  row('root',{...plan,logicalKey:'T1',priority:'P3',created:'2026-01-03T00:00:00Z'}),
  row('free',{...plan,logicalKey:'T3',dependencies:'T0',priority:'P1'}),
  row('waiting',{status:'waiting'}),
  row('running',{}),
  row('unknown',{...plan,dependencies:'missing-key'}),
 ];
 const states=new Map([['running',{status:'running'}]]);
 const readiness=ticketReadiness(tickets,states);
 assert.deepEqual(sortTickets(tickets,{field:'recommended',direction:'asc'},readiness).map(r=>r.id),['root','free','running','waiting','blocked','unknown','done']);
 assert.equal(readiness.get('root').unlocks,1);
 assert.deepEqual(readiness.get('blocked').blockers,['T1']);
 assert.match(readiness.get('unknown').label,/未找到/);
});
