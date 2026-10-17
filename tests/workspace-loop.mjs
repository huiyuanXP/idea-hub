// Run after the controller's build: node --experimental-strip-types tests/workspace-loop.mjs
// Actual archive/native API/STDIO/browser integration; the model runner is explicitly synthetic.
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,writeFile,rm,stat } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { localFixture,fixtureEnvironment } from './local/fixture.mjs';
import { chromium } from './browser/node_modules/playwright/index.mjs';
import { launchRestrictedBrowser } from './browser/network.mjs';

const projectName='Workspace archive integration',connectionName='Archive integration Agent';
const ideaTitle='Workspace archive synthetic planning input',ticketTitle='Workspace archive actual README check';
const runnerSource=`import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]==='login'){console.log('Explicit synthetic runner, no real model authentication');process.exit(0);}
const overrides=new Map();
for(let index=0;index<args.length;index++)if(args[index]==='-c'){
 const value=args[++index],boundary=value.indexOf('=');overrides.set(value.slice(0,boundary),value.slice(boundary+1));
}
for(const name of ['unapproved','legacy.host','inline_host','workspace_extra']){
 if(overrides.get('mcp_servers.'+JSON.stringify(name)+'.enabled')!=='false')throw Error('Unapproved MCP server was not disabled: '+name);
}
if(overrides.get('approval_policy')!==JSON.stringify('never'))throw Error('Interactive approval policy must not widen granted authority');
if(overrides.get('mcp_servers.agent_task_hub.enabled')!=='true')throw Error('Bound project MCP is missing');
const mcpArgs=JSON.parse(overrides.get('mcp_servers.agent_task_hub.args')||'null');
const installed=JSON.parse(readFileSync(mcpArgs?.[3]||'', 'utf8'));
if(JSON.parse(overrides.get('mcp_servers.agent_task_hub.command')||'null')!==process.execPath||
 JSON.stringify(mcpArgs)!==JSON.stringify([installed.runtime,'mcp','--config',installed.file])||
 JSON.parse(overrides.get('mcp_servers.agent_task_hub.cwd')||'null')!==installed.workspace)throw Error('MCP does not use this installed project identity');
if(overrides.get('mcp_servers.agent_task_hub.enabled_tools')!==JSON.stringify(['get_idea','get_ticket','get_plan','list_tickets','list_plans']))throw Error('MCP tool scope must remain the exact read-only allowlist');
const option=name=>args[args.indexOf(name)+1];
const cwd=option('--cd'),output=option('--output-last-message');
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
if(option('--sandbox')==='read-only'){
 writeFileSync(output,JSON.stringify({plan:{title:'Workspace archive synthetic Plan',goal:'Test the real planning contract',scope:'Temporary Git project',acceptance:'One scoped Ticket saved',assumptions:'Explicit synthetic model fixture'},tickets:[{key:'readme',title:'Workspace archive actual README check',goal:'Append a checked README change',scope:'README and its actual Node test only',acceptance:'Actual isolated diff and passing Node receipt',dependencies:'',assumptions:'Explicit synthetic model fixture'}]}));
}else{
 if(option('--sandbox')!=='workspace-write')throw Error('Development must use workspace-write');
 if(!prompt.includes('Ticket revision: 1'))throw Error('Approved revision missing');
 writeFileSync(join(cwd,'README.md'),readFileSync(join(cwd,'README.md'),'utf8')+'actual isolated integration change\\n');
 writeFileSync(join(cwd,'workspace-loop.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('actual isolated README change',()=>assert.match(readFileSync(new URL('./README.md',import.meta.url),'utf8'),/actual isolated integration change/));");
 const receiptEnvironment={...process.env};delete receiptEnvironment.NODE_TEST_CONTEXT;
 const receipt=spawnSync(process.execPath,['--test','workspace-loop.test.mjs'],{cwd,encoding:'utf8',env:receiptEnvironment});
 console.log(JSON.stringify({type:'thread.started',thread_id:'explicit-synthetic-integration-session'}));
 console.log(JSON.stringify({type:'item.completed',item:{id:'actual-node-test',type:'command_execution',command:'node --test workspace-loop.test.mjs',exit_code:receipt.status,aggregated_output:receipt.stdout+receipt.stderr}}));
 if(receipt.status!==0)process.exit(receipt.status??1);
 writeFileSync(output,JSON.stringify({summary:'Explicit synthetic model runner appended an isolated README change and executed a real passing Node test'}));
}
`;

const directory=await mkdtemp(join(tmpdir(),'hub-workspace-loop-')),children=new Set(),checks=[];
const codexHome=join(directory,'synthetic-codex-home');
let fixture,browser,mcp,agent,config,evidence,status='failed';
const artifactDirectory=process.env.TEST_ARTIFACT_DIR?resolve(process.env.TEST_ARTIFACT_DIR):null;
const secrets=[];
const redact=value=>secrets.reduce((text,secret)=>secret?text.split(secret).join('[redacted]'):text,String(value));
function ok(message){checks.push(message);console.log('PASS:',message);}
function launch(executable,args,options={}) {
 const child=spawn(executable,args,{cwd:directory,env:{...fixtureEnvironment(),CODEX_HOME:codexHome},detached:true,stdio:['pipe','pipe','pipe'],...options});
 children.add(child);let stdout='',stderr='';
 child.stdout.on('data',data=>{stdout+=data;if(stdout.length>8*1024*1024)child.kill('SIGKILL');});
 child.stderr.on('data',data=>{stderr+=data;if(stderr.length>1024*1024)child.kill('SIGKILL');});
 const closed=new Promise((accept,reject)=>{child.once('error',reject);child.once('close',code=>{children.delete(child);accept({code,stdout,stderr});});});closed.catch(()=>{});
 return {child,closed,stderr:()=>stderr};
}
function signalGroup(child,signal){if(!child.pid)return;try{process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}}
async function stop(process) {
 if(!process)return;
 signalGroup(process.child,'SIGTERM');let timer;
 try {await Promise.race([process.closed,new Promise(accept=>{timer=setTimeout(accept,3000);})]);}
 finally {clearTimeout(timer);signalGroup(process.child,'SIGKILL');await process.closed.catch(()=>{});}
}
async function command(executable,args,options={}) {
 const process=launch(executable,args,options);process.child.stdin.end(options.input??'');let timer;
 try {
  const result=await Promise.race([process.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned integration subprocess timed out')),60000);})]);
  assert.equal(result.code,0,redact(result.stderr));return result;
 }finally{clearTimeout(timer);await stop(process);}
}
async function owner(path,body) {
 const response=await fetch(fixture.origin+path,{headers:{authorization:'Bearer '+fixture.aliceToken,origin:fixture.origin,...(body?{'content-type':'application/json'}:{})},
  ...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
 assert.equal(response.ok,true,`Owner ${path} returned ${response.status}`);return response.json();
}
function stdio(config) {
 const runtime=launch(process.execPath,[config.runtime,'mcp','--config',config.file],{cwd:config.workspace}),pending=new Map();let nextId=0;
 const lines=createInterface({input:runtime.child.stdout});
 lines.on('line',line=>{
  let value;try{value=JSON.parse(line);}catch{for(const wait of pending.values())wait.reject(Error('STDIO stdout contained non-protocol output'));return;}
  const wait=pending.get(value.id);if(wait){pending.delete(value.id);clearTimeout(wait.timer);wait.accept(value);}
 });
 runtime.closed.then(()=>{for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(Error('STDIO closed before response: '+redact(runtime.stderr())));}pending.clear();});
 async function rpc(method,params={}) {
  const id=++nextId;
  const reply=await new Promise((accept,reject)=>{
   const timer=setTimeout(()=>{pending.delete(id);reject(Error(`STDIO ${method} timed out`));},15000);
   pending.set(id,{accept,reject,timer});runtime.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  assert.equal(reply.error,undefined,redact(reply.error?.message));return reply.result;
 }
 return {process:runtime,rpc,async tool(name,args={}){const result=await rpc('tools/call',{name,arguments:args});assert.equal(result.isError,false,redact(result.content?.[0]?.text));return result.structuredContent;},
  async close(){runtime.child.stdin.end();await stop(runtime);lines.close();}};
}
async function waitFor(callback,message,timeout=30000) {
 const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await callback();if(value)return value;await new Promise(accept=>setTimeout(accept,250));}throw Error(message);
}
async function screenshot(page,name){if(artifactDirectory)await page.screenshot({path:join(artifactDirectory,name+'.png'),fullPage:true});}

try {
 if(artifactDirectory)await mkdir(artifactDirectory,{recursive:true});
 // A temporary host config proves inherited MCP isolation without reading real model credentials.
 await mkdir(codexHome);
 await writeFile(join(codexHome,'config.toml'),'mcp_servers.inline_host = { command = "synthetic-inline", enabled = true }\n[mcp_servers.unapproved]\ncommand = "synthetic-host"\n[mcp_servers."legacy.host"]\ncommand = "synthetic-quoted"\n');
 fixture=await localFixture();secrets.push(fixture.aliceToken,fixture.bobToken);
 const project=join(directory,'temporary-project'),unpacked=join(directory,'download');await mkdir(project);await mkdir(unpacked);
 await command('git',['init','--quiet',project]);await writeFile(join(project,'README.md'),'original committed integration baseline\n');
 await command('git',['-C',project,'add','README.md']);await command('git',['-C',project,'-c','user.name=Synthetic integration','-c','user.email=synthetic@example.invalid','commit','--quiet','-m','Synthetic integration baseline']);
 const invitation=await owner('/api/connectors',{action:'invite',project:projectName,name:connectionName,capabilities:['read','submit','plan','execute']});secrets.push(invitation.code);
 const archive=await fetch(fixture.origin+'/api/connectors/download',{headers:{authorization:'Bearer '+fixture.aliceToken},signal:AbortSignal.timeout(15000)});
 assert.equal(archive.status,200);assert.match(archive.headers.get('content-type'),/gzip/);
 const archiveFile=join(directory,'connector.tgz');await writeFile(archiveFile,Buffer.from(await archive.arrayBuffer()));await command('tar',['-xzf',archiveFile,'-C',unpacked]);
 await command(process.execPath,[join(unpacked,'agent-task-hub-connector/cli.mjs'),'install','--url',fixture.origin,'--workspace',project,'--name',connectionName,'--code-stdin'],{input:invitation.code+'\n'});
 const configFile=join(project,'.agent-task-hub/connection.json');config=JSON.parse(await readFile(configFile,'utf8'));secrets.push(config.token);
 assert.equal((await stat(configFile)).mode&0o777,0o600);assert.equal(config.projectId,invitation.projectId);assert.equal(config.project,projectName);
 // Removing the extracted download proves the installed runtime is self-contained.
 await rm(unpacked,{recursive:true,force:true});
 const connections=await owner('/api/connectors');assert.equal(connections.connections.length,1);assert.equal(connections.connections[0].id,config.connectionId);
 assert.equal(connections.connections[0].version,config.version);ok('HTTP archive download installs a standalone private client with the backend connection identity');

 mcp=stdio(config);
 const initialization=await mcp.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'workspace-loop-native',version:'1'}});assert.equal(initialization.protocolVersion,'2025-11-25');
 mcp.process.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const tools=await mcp.rpc('tools/list');for(const name of ['create_idea','create_ticket','list_tickets','claim_planning_job'])assert.ok(tools.tools.some(tool=>tool.name===name));
 assert.equal(tools.tools.some(tool=>/approve|accept|revoke/.test(tool.name)),false);
 const idea=await mcp.tool('create_idea',{request_id:'archive_idea',title:ideaTitle,text:'Plan a narrow README change and verify it in the temporary project.'});
 const standalone=await mcp.tool('create_ticket',{request_id:'archive_ticket',title:'Workspace archive submitted standalone Ticket',goal:'Exercise project-scoped submission',scope:'Planning only',acceptance:'No execution without owner approval'});
 const listed=await mcp.tool('list_tickets',{});assert.ok(listed.items.some(ticket=>ticket.id===standalone.ticket_id));assert.ok(listed.items.every(ticket=>ticket.project===projectName));
 const retry=await mcp.tool('create_idea',{request_id:'archive_idea',title:ideaTitle,text:'Plan a narrow README change and verify it in the temporary project.'});assert.equal(retry.idea_id,idea.idea_id);
 ok('Real STDIO MCP negotiates, lists tools and submits/lists project-scoped Ideas and Tickets without owner decisions');

 const runner=join(directory,'explicit-synthetic-model-runner.mjs');await writeFile(runner,runnerSource);
 const workspaceConfig=join(project,'.codex/config.toml');
 await writeFile(workspaceConfig,(await readFile(workspaceConfig,'utf8'))+'\n[mcp_servers.workspace_extra]\ncommand = "synthetic-project"\n');
 await writeFile(join(project,'README.md'),'existing uncommitted owner change\n');
 const mainStatus=(await command('git',['-C',project,'status','--porcelain'])).stdout;
 await command(process.execPath,[config.runtime,'agent','--config',config.file,'--test-runner',runner,'--once'],{cwd:project});
 const jobs=await mcp.tool('list_planning_jobs');const planned=jobs.jobs.find(job=>job.id===idea.job_id);assert.equal(planned.status,'done');
 const planningResult=JSON.parse(planned.result);assert.equal(planningResult.ticket_ids.length,1);
 const plannedTicket=(await mcp.tool('get_ticket',{ticket_id:planningResult.ticket_ids[0]})).ticket;assert.equal(plannedTicket.title,ticketTitle);assert.match(plannedTicket.assumptions,/synthetic/i);
 assert.equal((await owner('/api/workspace-runs')).runs.length,0);ok('Explicit synthetic read-only model runner saves a revision-bound Plan with inherited MCPs disabled and the exact bound read-only MCP allowlist');

 const prepared=await owner('/api/workspace-runs',{action:'prepare',ticketId:plannedTicket.id,revision:plannedTicket.revision,connectionId:config.connectionId,requestId:'archive-development',timeoutMs:120000});assert.equal(prepared.run.state,'pending');
 await owner('/api/workspace-runs',{action:'approve',runId:prepared.run.id});
 agent=launch(process.execPath,[config.runtime,'agent','--config',config.file,'--test-runner',runner],{cwd:project});agent.child.stdin.end();
 const reviewed=await waitFor(async()=>{
  const run=(await owner('/api/workspace-runs?runId='+encodeURIComponent(prepared.run.id))).run;
  if(run.state==='failed')throw Error('Synthetic daemon development failed: '+redact(run.error));return run.state==='review'?run:null;
 },'Approved daemon did not deliver a review candidate');
 assert.match(reviewed.result.summary,/^\[synthetic test runner\]/);assert.match(reviewed.result.diff,/actual isolated integration change/);
 assert.ok(reviewed.result.files.includes('README.md'));assert.ok(reviewed.result.files.includes('workspace-loop.test.mjs'));
 assert.equal(reviewed.result.tests[0].exitCode,0);assert.match(reviewed.result.tests[0].output,/pass 1/);assert.equal(reviewed.result.tests[0].command,'node --test workspace-loop.test.mjs');
 assert.notEqual(reviewed.result.worktree,project);assert.equal(await readFile(join(project,'README.md'),'utf8'),'existing uncommitted owner change\n');
 assert.equal((await command('git',['-C',project,'status','--porcelain'])).stdout,mainStatus);
 assert.equal((await mcp.tool('get_ticket',{ticket_id:plannedTicket.id})).ticket.status,'todo');
 ok('Approved installed daemon changes a real isolated worktree and supplies actual passing Node receipts while preserving main edits');

 browser=await launchRestrictedBrowser(chromium,[fixture.origin],{viewport:{width:1440,height:1050}});const page=await browser.context.newPage(),pageErrors=[];
 page.on('pageerror',error=>pageErrors.push(redact(error.message)));page.setDefaultTimeout(15000);
 await page.goto(fixture.origin+'/signin?return_to=/',{waitUntil:'domcontentloaded'});await page.getByLabel('用户名').fill('alice');await page.getByLabel('密码').fill('synthetic-password');
 await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'收集点子',exact:true}).waitFor();
 await page.getByRole('button',{name:'连接与执行',exact:false}).click();const connectionCard=page.getByRole('region',{name:'MCP 连接管理'}).locator('article').filter({has:page.getByRole('heading',{name:connectionName,exact:true})});
 await connectionCard.getByText('在线',{exact:true}).waitFor();assert.match(await connectionCard.innerText(),new RegExp('客户端 v'+config.version.replaceAll('.','\\.')));
 await connectionCard.getByText('开发 Agent：未就绪',{exact:true}).waitFor();
 await connectionCard.getByText('Synthetic test runner; this is not real model evidence',{exact:true}).waitFor();await screenshot(page,'workspace-connections');
 await page.getByRole('button',{name:'Ticket 看板',exact:false}).click();await page.getByRole('combobox',{name:'项目筛选',exact:true}).selectOption(projectName);
 const developmentSummary=page.getByText('本机 Agent 开发执行 · 申请、进度与验收',{exact:true});
 if(await developmentSummary.count() && !(await developmentSummary.evaluate(summary=>summary.parentElement.open)))await developmentSummary.click();
 const development=page.locator('section[aria-label="本机 Agent 开发执行"]');
 await development.getByLabel('开发 Ticket',{exact:true}).selectOption(plannedTicket.id);
 const runCard=development.locator('[data-run-id="'+prepared.run.id+'"]');
 await runCard.getByText('等待审核',{exact:true}).waitFor();await runCard.getByText('查看实际变更',{exact:true}).click();await runCard.getByText('查看测试证据',{exact:true}).click();
 assert.match(await runCard.innerText(),/actual isolated integration change/);assert.match(await runCard.innerText(),/node --test workspace-loop\.test\.mjs · 退出码 0/);assert.match(await runCard.innerText(),/synthetic test runner/);
 await screenshot(page,'workspace-review');const acceptedResponse=page.waitForResponse(response=>response.url()===fixture.origin+'/api/workspace-runs'&&response.request().method()==='POST'&&response.request().postDataJSON()?.action==='accept');
 await runCard.getByRole('button',{name:'审核通过并归档',exact:true}).click();assert.equal((await acceptedResponse).status(),200);
 // Acceptance increments the Ticket revision: reopen the explicitly chosen refreshed contract.
 await development.getByRole('button',{name:'重新选择 Ticket',exact:true}).waitFor();
 await development.getByRole('button',{name:'重新选择 Ticket',exact:true}).click();
 await development.getByLabel('开发 Ticket',{exact:true}).selectOption(plannedTicket.id);
 await runCard.getByText('审核通过 · 已归档',{exact:true}).waitFor();await screenshot(page,'workspace-accepted');
 const accepted=await owner('/api/workspace-runs?runId='+encodeURIComponent(prepared.run.id));assert.equal(accepted.run.state,'succeeded');
 const ticketAfter=(await mcp.tool('get_ticket',{ticket_id:plannedTicket.id})).ticket;assert.equal(ticketAfter.status,'done');assert.equal(ticketAfter.revision,2);
 const records=await owner('/api/records');assert.ok(records.records.some(record=>record.kind==='history'&&record.recordId===plannedTicket.id&&record.previousRevision===1));
 assert.equal(pageErrors.length,0,JSON.stringify(pageErrors));await browser.flushNetworkEvidence();assert.equal(browser.errors.length,0,JSON.stringify(browser.errors));assert.deepEqual(browser.requestedExternal,[]);
 ok('Actual Chromium shows online client/version and real diff/tests; browser owner acceptance marks Ticket done with revision history');

 await stop(agent);agent=undefined;await mcp.close();mcp=undefined;
 await owner('/api/connectors',{action:'revoke',connectionId:config.connectionId});
 const denied=await fetch(fixture.origin+'/api/connector/heartbeat',{method:'POST',headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},body:JSON.stringify({mode:'agent',version:config.version,agentReady:true}),signal:AbortSignal.timeout(10000)});assert.equal(denied.status,401);
 const after=await owner('/api/connectors');assert.equal(after.connections[0].id,config.connectionId);assert.equal(after.connections[0].status,'revoked');
 ok('Stopped daemon retains its registered identity; revocation denies the machine credential with HTTP 401');
 evidence={source:'real archive/native APIs/STDIO/Chromium; explicit synthetic model runner',realModel:false,connectionId:config.connectionId,version:config.version,runId:prepared.run.id,ticketId:plannedTicket.id,
  state:accepted.run.state,files:reviewed.result.files,tests:reviewed.result.tests.map(({command,exitCode})=>({command,exitCode})),mainWorkspacePreserved:true,offlineThresholdObserved:false,
  pageErrors,blockedExternalRequests:browser.blocked,requestedExternalOrigins:browser.requestedExternal,networkPolicyErrors:browser.errors};status='passed';
 console.log('VERIFIED_WORKSPACE_LOOP_EVIDENCE',JSON.stringify(evidence));
}catch(error){
 if(artifactDirectory)await writeFile(join(artifactDirectory,'workspace-loop-failure.txt'),redact(error.stack??error.message)+'\n');
 throw error;
}finally{
 if(artifactDirectory)await writeFile(join(artifactDirectory,'workspace-loop-evidence.json'),JSON.stringify({status,checks,...evidence},null,2)+'\n');
 await stop(agent);await mcp?.close();await browser?.close();
 for(const child of children)signalGroup(child,'SIGKILL');
 await fixture?.close();await rm(directory,{recursive:true,force:true});
}
