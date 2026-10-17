// Real native HTTP + new SQLite + restricted installed Chromium. No installed account or production data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { localFixture } from '../local/fixture.mjs';
import { issueToken, revokeToken } from '../../lib/local-auth.mts';
import { chromium } from '../browser/node_modules/playwright/index.mjs';
import { launchRestrictedBrowser } from '../browser/network.mjs';
const f=await localFixture();
const session=await issueToken(f.db,f.alice.userId,{kind:'browser'});
const evidence=resolve(process.env.DETAIL_EVIDENCE_DIR ?? 'test-results/details'); mkdirSync(evidence,{recursive:true});
const errors=[], writes=[], failures=[], executionReads=[];
let base, restricted;
const facade=createServer(async(req,res)=>{
  try {
    const chunks=[]; for await(const chunk of req)chunks.push(chunk);
    if(req.method!=='GET' && req.method!=='HEAD')writes.push({url:req.url,method:req.method});
    if(req.method==='GET' && /^\/api\/(workspace-runs|execution)[?]/.test(req.url))executionReads.push(req.url);
    const headers=new Headers(req.headers);headers.delete('host');headers.delete('authorization');headers.delete('cookie');
    if(headers.get('origin')===base)headers.set('origin',f.origin);
    headers.set('cookie','hub_session='+session.token);
    const result=await fetch(f.origin+req.url,{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
    const body=Buffer.from(await result.arrayBuffer()),outgoing=Object.fromEntries(result.headers);delete outgoing['content-encoding'];delete outgoing['content-length'];res.writeHead(result.status,outgoing);res.end(body);
  }catch(error){errors.push(String(error));res.writeHead(500);res.end('Fixture failure');}
});
const request=async(body)=>{const r=await fetch(f.origin+'/api/records',{method:'POST',headers:{authorization:'Bearer '+f.aliceToken,origin:f.origin,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
const create=async(body)=>{const response=await request(body);assert.equal(response.status,201,JSON.stringify(response));return {...body,...response.body};};
const records=async()=>{const r=await fetch(f.origin+'/api/records',{headers:{authorization:'Bearer '+f.aliceToken}});return (await r.json()).records;};
const check=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(error){failures.push({name,error:String(error)});console.error('FAIL '+name+' '+String(error));throw error;}};
try {
  const idea=await create({kind:'idea',title:'详情测试点子',text:'原始想法全文\n不能丢失第二行',project:'详情测试',priority:'P1'});
  const plan=await create({kind:'plan',title:'详情测试计划',ideaId:idea.id,ideaRevision:1,project:'详情测试',priority:'P1',goal:'解决实际问题',scope:'完整范围',acceptance:'可检查完成标准',dependencies:'外部条件',assumptions:'需要确认的前提',budget:'两小时',allowedActions:'仅修改源码',notes:'完整备注'});
  const tickets=[];for(let i=0;i<30;i++)tickets.push(await create({kind:'ticket',title:`任务 ${String(i).padStart(2,'0')} ${i===29?'完整长标题 '.repeat(18):'阅读路径'}`,project:'详情测试',priority:'P2',planId:plan.id,ideaId:idea.id,status:i===0?'waiting':'todo',waitingReason:'external',goal:`任务目标 ${i}`,scope:'任务边界',acceptance:'真实验收标准',dependencies:'任务依赖',assumptions:'待确认前提',budget:'预算保留',allowedActions:'操作保留',queue:'details-queue',category:'recruitment',cadence:'recurring',notes:'补充字段保留',evidence:''}));
  const sparse=await create({kind:'ticket',title:'独立缺字段任务',project:'详情测试',status:'todo'});
  const failedIdea=await create({kind:'idea',title:'规划失败点子',text:'失败原因不能藏起来',project:'详情测试'});
  await f.db.prepare("UPDATE jobs SET delivery='failed',recovery_reason='planner_failed',planner_error='fixture planner error' WHERE idea_id=?").bind(failedIdea.id).run();
  // Current revision still has old planning result, which must remain visibly labelled.
  const editedIdea=await request({...idea,text:'点子当前修订原文'});assert.equal(editedIdea.status,200);
  await new Promise(resolve=>facade.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${facade.address().port}`;
  restricted=await launchRestrictedBrowser(chromium,[base],{viewport:{width:1280,height:1050}});
  const page=await restricted.context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.stack??error.message));
  await page.goto(base,{waitUntil:'networkidle'});
  const dialog=()=>page.getByRole('dialog').filter({has:page.locator('#dialog-title')});
  const openPlan=async()=>{await page.getByRole('button',{name:'规划工作台'}).click();await page.getByRole('button',{name:'详情测试计划',exact:true}).click();await dialog().waitFor();};
  await check('saved Plan reads all fields with no editable inputs and no business writes',async()=>{
    await page.getByRole('button',{name:'规划工作台'}).click();await page.getByRole('combobox',{name:'项目筛选'}).selectOption('详情测试');await page.getByRole('textbox',{name:'搜索',exact:true}).fill('详情测试计划');await openPlan();const d=dialog();assert.equal(await d.locator('input,textarea,select').count(),0);assert.equal(await d.getByRole('button',{name:'保存到本地'}).count(),0);
    for(const heading of ['要解决的问题','完成标准','拆分任务'])await d.getByRole('heading',{name:heading,exact:true}).waitFor();
    assert.equal(await d.locator('[data-related-record]').count(),30);await d.getByText('有依赖 · 有假设与待确认信息',{exact:true}).waitFor();
    await d.getByText('执行约定',{exact:true}).click();await d.getByText('两小时',{exact:true}).waitFor();await d.getByText('执行约定',{exact:true}).click();
    await d.evaluate(el=>{el.scrollTop=0});await page.screenshot({path:evidence+'/plan-reading.png',fullPage:true});assert.deepEqual(writes,[]);
  });
  await check('Plan to 30th long-title Ticket and back retains filter search scroll and focus',async()=>{
    const d=dialog();const ticket=d.locator('[data-related-record]').filter({hasText:tickets[29].title});await ticket.scrollIntoViewIfNeeded();const before=await d.evaluate(el=>el.scrollTop);await ticket.click();
    await d.getByRole('heading',{name:'做什么',exact:true}).waitFor();assert.equal(await d.locator('input,textarea,select').count(),0);await d.getByRole('heading',{name:tickets[29].title,exact:true}).waitFor();
    await d.getByRole('button',{name:'返回计划',exact:true}).click();await d.getByRole('heading',{name:'拆分任务',exact:true}).waitFor();await page.waitForTimeout(80);assert.ok(Math.abs((await d.evaluate(el=>el.scrollTop))-before)<10);
    assert.equal(await page.getByRole('textbox',{name:'搜索',exact:true}).inputValue(),'详情测试计划');assert.equal(await page.getByRole('combobox',{name:'项目筛选'}).inputValue(),'详情测试');assert.equal(await d.locator('[data-related-record]:focus').getAttribute('data-related-record'),tickets[29].id);assert.deepEqual(writes,[]);
  });
  await check('modal keyboard focus is trapped and Escape restores opener',async()=>{
    const d=dialog();await d.getByRole('button',{name:'编辑',exact:true}).focus();await page.keyboard.press('Tab');assert.equal(await d.getByRole('button',{name:'关闭',exact:true}).evaluate(el=>el===document.activeElement),true);await page.keyboard.press('Shift+Tab');assert.equal(await d.getByRole('button',{name:'编辑',exact:true}).evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.getByRole('button',{name:'详情测试计划',exact:true}).evaluate(el=>el===document.activeElement),true);assert.deepEqual(writes,[]);await page.getByRole('textbox',{name:'搜索',exact:true}).fill('');await page.getByRole('combobox',{name:'项目筛选'}).selectOption('详情测试');
  });
  await check('edit cancel and folded-field save preserve all existing contract values',async()=>{
    await openPlan();const d=dialog();await d.getByRole('button',{name:'编辑',exact:true}).click();assert.equal(await d.getByRole('textbox',{name:'标题',exact:true}).evaluate(el=>el===document.activeElement),true,'Edit immediately focuses title');await d.getByRole('textbox',{name:'目标',exact:true}).fill('草稿目标');await d.getByRole('button',{name:'取消编辑',exact:true}).click();await d.getByRole('alertdialog').waitFor();await d.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await d.getByRole('textbox',{name:'目标',exact:true}).inputValue(),'草稿目标');
    await d.getByRole('button',{name:'取消编辑',exact:true}).click();await d.getByRole('button',{name:'放弃修改',exact:true}).click();await d.getByText('解决实际问题',{exact:true}).waitFor();assert.equal(writes.length,0);
    await d.getByRole('button',{name:'编辑',exact:true}).click();await d.getByRole('textbox',{name:'目标',exact:true}).fill('已保存新目标');await d.getByRole('button',{name:'保存到本地',exact:true}).click();await d.waitFor({state:'hidden'});
    const saved=(await records()).find(r=>r.id===plan.id);assert.equal(saved.goal,'已保存新目标');for(const key of ['dependencies','assumptions','allowedActions','budget','notes','ideaId','ideaRevision'])assert.equal(saved[key],plan[key]);assert.equal(saved.revision,2);
  });
  await check('dirty close Escape backdrop and relation navigation never silently lose input',async()=>{
    await openPlan();const d=dialog();await d.getByRole('button',{name:'编辑',exact:true}).click();await d.getByRole('textbox',{name:'目标',exact:true}).fill('未保存保留');await page.keyboard.press('Escape');await d.getByRole('alertdialog').waitFor();await page.keyboard.press('Tab');assert.equal(await d.getByRole('alertdialog').evaluate(el=>el.contains(document.activeElement)),true);await d.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await d.getByRole('textbox',{name:'目标',exact:true}).inputValue(),'未保存保留');
    await page.locator('.modal-overlay').click({position:{x:3,y:3}});await d.getByRole('alertdialog').waitFor();await d.getByRole('button',{name:'继续编辑',exact:true}).click();await d.locator('[data-related-record]').first().click();await d.getByRole('alertdialog').waitFor();await page.screenshot({path:evidence+'/unsaved-confirmation.png',fullPage:true});await d.getByRole('button',{name:'放弃修改',exact:true}).click();await d.getByRole('heading',{name:'做什么',exact:true}).waitFor();await d.getByRole('button',{name:'关闭',exact:true}).click();
  });
  await check('409 retains exact draft and saved revision with visible persistent error',async()=>{
    await openPlan();const d=dialog();await d.locator('[data-related-record]').filter({hasText:tickets[0].title}).click();await d.getByText('等待原因：外部依赖',{exact:true}).waitFor();await d.getByRole('button',{name:'编辑',exact:true}).click();await d.getByRole('textbox',{name:'目标',exact:true}).fill('冲突保留草稿');
    const concurrent=await request({...tickets[0],goal:'其他窗口修改'});assert.equal(concurrent.status,200);const response=page.waitForResponse(r=>r.url()===base+'/api/records'&&r.request().method()==='POST');await d.getByRole('button',{name:'保存到本地',exact:true}).click();assert.equal((await response).status(),409);await d.getByRole('alert').getByText(/另一处已修改/).waitFor();assert.equal(await d.getByRole('textbox',{name:'目标',exact:true}).inputValue(),'冲突保留草稿');const alertRect=await d.getByRole('alert').boundingBox();assert.ok(alertRect && alertRect.y>=0 && alertRect.y+alertRect.height<=1050,'Conflict error stays visible next to sticky save action');await page.screenshot({path:evidence+'/conflict-draft.png',fullPage:true});
    await d.getByRole('button',{name:'关闭',exact:true}).click();await d.getByRole('button',{name:'放弃修改',exact:true}).click();
  });
  await check('real storage 503 retains draft even after successful background refresh',async()=>{
    await openPlan();const d=dialog();await d.getByRole('button',{name:'编辑',exact:true}).click();await d.getByRole('textbox',{name:'目标',exact:true}).fill('503之后保留草稿');await f.db.prepare('ALTER TABLE records RENAME TO unavailable_records').run();
    try {const response=page.waitForResponse(r=>r.url()===base+'/api/records'&&r.request().method()==='POST');await d.getByRole('button',{name:'保存到本地',exact:true}).click();assert.equal((await response).status(),503);await d.getByRole('alert').waitFor();assert.equal(await d.getByRole('textbox',{name:'目标',exact:true}).inputValue(),'503之后保留草稿');} finally {await f.db.prepare('ALTER TABLE unavailable_records RENAME TO records').run();}
    const refreshed=page.waitForResponse(r=>r.url()===base+'/api/records'&&r.request().method()==='GET'&&r.status()===200);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await refreshed;await d.getByRole('alert').waitFor();assert.equal(await d.getByRole('textbox',{name:'目标',exact:true}).inputValue(),'503之后保留草稿');await page.screenshot({path:evidence+'/save-failure-503.png',fullPage:true});await d.getByRole('button',{name:'关闭',exact:true}).click();await d.getByRole('button',{name:'放弃修改',exact:true}).click();
  });
  await check('completed evidence error focuses field and manual snapshot never starts execution',async()=>{
    await openPlan();const d=dialog();await d.locator('[data-related-record]').filter({hasText:tickets[1].title}).click();await d.getByRole('button',{name:'编辑',exact:true}).click();await d.getByRole('combobox',{name:'状态',exact:true}).selectOption('done');const count=writes.length;await d.getByRole('button',{name:'保存到本地',exact:true}).click();await d.getByRole('alert').getByText(/填写验收证据/).waitFor();assert.equal(await d.getByRole('textbox',{name:'验收证据（完成时必填）',exact:true}).evaluate(el=>el===document.activeElement),true);assert.equal(writes.length,count);
    await d.getByRole('button',{name:'取消编辑',exact:true}).click();await d.getByRole('button',{name:'放弃修改',exact:true}).click();await d.getByRole('button',{name:'记录已有执行',exact:true}).click();await d.getByRole('textbox',{name:'执行过程与证据',exact:true}).fill('人工记录已有执行结果');await d.getByRole('button',{name:'保存到本地',exact:true}).click();await d.waitFor({state:'hidden'});
    const snapshot=(await records()).find(r=>r.kind==='run'&&r.ticketId===tickets[1].id);assert.equal(snapshot.source,'manual');assert.equal(snapshot.ticketRevision,1);assert.ok(writes.every(r=>r.url==='/api/records'),'No planning/run/approval calls caused by record writes');
  });
  await check('idea old revision results are labelled and existing Plan opens read-only without replan',async()=>{
    await page.getByRole('button',{name:/^点子收件箱/}).click();await page.getByRole('button',{name:'详情测试点子',exact:true}).click();const d=dialog();await d.getByText('点子当前修订原文',{exact:true}).waitFor();await d.getByText(/旧修订 v1/).waitFor();const count=writes.length;await d.locator('[data-related-record]').filter({hasText:plan.title}).click();await d.getByRole('heading',{name:'要解决的问题',exact:true}).waitFor();assert.equal(await d.locator('input,textarea,select').count(),0);assert.equal(writes.length,count);await d.getByRole('button',{name:'关闭',exact:true}).click();
  });
  await check('new Ticket inherits saved Plan contract and save-after-confirmation navigates without auto-saving Plan',async()=>{
    await openPlan();const d=dialog();const savedPlan=(await records()).find(row=>row.id===plan.id),count=writes.length;
    await d.getByRole('button',{name:'拆分 Ticket',exact:true}).click();await d.getByRole('textbox',{name:'标题',exact:true}).waitFor();assert.equal(await d.getByRole('textbox',{name:'目标',exact:true}).inputValue(),savedPlan.goal);assert.equal(writes.length,count);
    await d.getByText('执行约定',{exact:true}).click();assert.equal(await d.getByRole('textbox',{name:'允许的操作',exact:true}).inputValue(),savedPlan.allowedActions);await d.getByText('执行约定',{exact:true}).click();
    await d.getByRole('textbox',{name:'标题',exact:true}).fill('手工拆分新任务');await d.getByRole('button',{name:'关闭',exact:true}).click();await d.getByRole('button',{name:'保存后继续',exact:true}).click();await d.waitFor({state:'hidden'});
    const all=await records(),created=all.find(row=>row.title==='手工拆分新任务');assert.equal(created.planId,plan.id);assert.equal(created.ideaId,idea.id);for(const key of ['goal','scope','acceptance','allowedActions','budget','project','priority'])assert.equal(created[key],savedPlan[key]);assert.equal(all.find(row=>row.id===plan.id).revision,savedPlan.revision);assert.equal(writes.length,count+1);
  });
  await check('idea edit creates a new revision and authoritative planning job',async()=>{
    await page.getByRole('button',{name:/^点子收件箱/}).click();await page.getByRole('button',{name:'详情测试点子',exact:true}).click();const d=dialog();await d.getByRole('button',{name:'编辑',exact:true}).click();await d.getByRole('textbox',{name:'原始内容',exact:true}).fill('修改点子需要新规划');await d.getByRole('button',{name:'保存到本地',exact:true}).click();await d.waitFor({state:'hidden'});
    const saved=(await records()).find(row=>row.id===idea.id);assert.equal(saved.revision,3);assert.equal(saved.text,'修改点子需要新规划');const job=await f.db.prepare('SELECT idea_revision,status FROM jobs WHERE idea_id=? ORDER BY idea_revision DESC').bind(idea.id).first();assert.equal(job.idea_revision,3);assert.equal(job.status,'queued');
  });
  await check('narrow-screen detail remains readable without horizontal overflow',async()=>{
    await page.setViewportSize({width:390,height:844});await openPlan();const d=dialog();assert.equal(await d.evaluate(el=>el.scrollWidth<=el.clientWidth),true);await d.locator('[data-related-record]').filter({hasText:tickets[29].title}).click();await d.getByRole('heading',{name:'做什么',exact:true}).waitFor();assert.equal(await d.evaluate(el=>el.scrollWidth<=el.clientWidth),true);await page.screenshot({path:evidence+'/ticket-mobile.png',fullPage:true});await d.getByRole('button',{name:'关闭',exact:true}).click();
  });
  await check('missing fields and failed planning keep accurate empty state and visible reasons at 1280px',async()=>{
    await page.setViewportSize({width:1280,height:1050});await page.getByRole('button',{name:/^Ticket 看板/}).click();await page.getByRole('heading',{name:sparse.title,exact:true}).click();const d=dialog();await d.getByText('独立任务',{exact:true}).waitFor();assert.equal(await d.locator('input,textarea,select').count(),0);assert.ok(await d.getByText('尚未填写',{exact:true}).count()>=3);await page.screenshot({path:evidence+'/ticket-sparse-1280.png',fullPage:true});await d.getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByRole('button',{name:/^点子收件箱/}).click();const card=page.locator('article').filter({has:page.getByRole('heading',{name:failedIdea.title,exact:true})});await card.getByText('Agent 错误：fixture planner error',{exact:true}).waitFor();await card.getByText('原因：planner_failed',{exact:true}).waitFor();assert.equal(await card.getByRole('button',{name:'重试规划',exact:true}).isEnabled(),true);const count=writes.length;await card.getByRole('heading',{name:failedIdea.title,exact:true}).click();await d.getByText('Agent 错误：fixture planner error',{exact:true}).waitFor();await d.getByText('原因：planner_failed',{exact:true}).waitFor();await page.screenshot({path:evidence+'/idea-failure-1280.png',fullPage:true});await d.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(writes.length,count);
  });
  await check('explicit execution entry reads only the selected saved Ticket and uses its newest revision',async()=>{
    await openPlan();const d=dialog();await d.locator('[data-related-record]').filter({hasText:tickets[2].title}).click();assert.equal(await d.locator('input,textarea,select').count(),0);const count=writes.length,readStart=executionReads.length;
    await d.getByRole('button',{name:'执行此任务',exact:true}).click();const panel=d.getByRole('region',{name:'Ticket 执行'});await panel.getByText(/冻结 Ticket v1/).waitFor();await panel.getByText('当前 Ticket 尚无开发 Run。',{exact:true}).waitFor();assert.equal(writes.length,count);await panel.getByRole('spinbutton',{name:'执行期限（分钟）',exact:true}).fill('21');await page.keyboard.press('Enter');await page.waitForTimeout(100);assert.equal(writes.length,count,'Enter in execution settings cannot submit the read-only record');// Board-wide background refreshes carry no ticketId; only the panel's own reads are bound to a Ticket.
    const firstReads=executionReads.slice(readStart).filter(url=>new URL(url,base).searchParams.has('ticketId'));assert.ok(firstReads.length>=4);assert.ok(firstReads.every(url=>new URL(url,base).searchParams.get('ticketId')===tickets[2].id));
    await d.getByRole('button',{name:'编辑',exact:true}).click();assert.equal(await panel.count(),0,'Execution panel is unmounted while editing');await d.getByRole('textbox',{name:'目标',exact:true}).fill('执行使用已保存新修订');await d.getByRole('button',{name:'保存到本地',exact:true}).click();await d.waitFor({state:'hidden'});
    await openPlan();await d.locator('[data-related-record]').filter({hasText:tickets[2].title}).click();const saved=(await records()).find(row=>row.id===tickets[2].id);assert.equal(saved.revision,2);const afterSave=writes.length;await d.getByRole('button',{name:'执行此任务',exact:true}).click();await panel.getByText(/冻结 Ticket v2/).waitFor();await panel.getByText('当前 Ticket 尚无开发 Run。',{exact:true}).waitFor();assert.equal(writes.length,afterSave);assert.equal(await panel.getByRole('button',{name:'申请开发执行',exact:true}).isDisabled(),true,'No fixture workspace means no execution request');await panel.scrollIntoViewIfNeeded();await page.screenshot({path:evidence+'/ticket-explicit-execution.png',fullPage:true});await d.getByRole('button',{name:'关闭',exact:true}).click();
  });
  await check('expired session clears private reading draft and pending confirmation',async()=>{
    await page.setViewportSize({width:1280,height:1050});await openPlan();const d=dialog();await d.getByRole('button',{name:'编辑',exact:true}).click();await d.getByRole('textbox',{name:'目标',exact:true}).fill('必须清除的私有草稿');await revokeToken(f.db,session.token);await d.getByRole('button',{name:'保存到本地',exact:true}).click();await d.waitFor({state:'hidden'});assert.equal(await page.getByText('必须清除的私有草稿',{exact:true}).count(),0);assert.equal(await page.getByRole('alertdialog').count(),0);
  });
  await restricted.flushNetworkEvidence();assert.deepEqual(errors,[]);assert.deepEqual(restricted.errors,[]);assert.deepEqual(restricted.requestedExternal,[]);
  console.log('DETAIL_BROWSER_EVIDENCE '+JSON.stringify({failures,requests:writes,screenshots:evidence,pageErrors:errors,networkPolicyErrors:restricted.errors,requestedExternal:restricted.requestedExternal}));assert.deepEqual(failures,[]);
} finally {await restricted?.close();facade.closeAllConnections();if(facade.listening)await new Promise(resolve=>facade.close(resolve));await f.close();}
