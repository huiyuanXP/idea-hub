import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

const root = resolve(import.meta.dirname, '../..'), cli = join(root, 'connector/cli.mjs');
function run(executable, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => accept({ code, stdout, stderr }));
    child.stdin.end(options.input || '');
  });
}
// Synthetic Codex: the first segment streams events then waits (or hangs for an
// interrupt); a `resume` segment makes the real change and runs a real test.
const synthetic = `import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]==='login') process.exit(0);
const option=name=>args[args.indexOf(name)+1];
const cwd=option('--cd');
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
appendFileSync(join(cwd,'.segments.jsonl'),JSON.stringify({args,prompt,cwd:process.cwd()})+'\\n');
const emit=value=>console.log(JSON.stringify(value));
const output=option('--output-last-message');
if(!args.includes('resume')){
 emit({type:'thread.started',thread_id:'thread-123'});
 emit({type:'item.completed',item:{id:'r1',type:'reasoning',text:'Planning the change'}});
 emit({type:'item.started',item:{id:'c1',type:'command_execution',command:'cat big.txt',status:'in_progress'}});
 emit({type:'item.completed',item:{id:'c1',type:'command_execution',command:'cat big.txt',aggregated_output:'z'.repeat(60000),exit_code:0}});
 emit({type:'item.completed',item:{id:'m1',type:'agent_message',text:'First turn done'}});
 if(prompt.includes('HANG')){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(join(cwd,'.hung-pid'),String(child.pid));setInterval(()=>{},1000);}
 else { await new Promise(r=>setTimeout(r,2500)); writeFileSync(output,JSON.stringify({summary:'first segment only'})); emit({type:'turn.completed',usage:{input_tokens:1}}); }
} else {
 writeFileSync(join(cwd,'README.md'),readFileSync(join(cwd,'README.md'),'utf8')+'resumed change\\n');
 writeFileSync(join(cwd,'change.test.mjs'),"import test from 'node:test';test('ok',()=>{});");
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const receipt=spawnSync(process.execPath,['--test','change.test.mjs'],{cwd,encoding:'utf8',env});
 emit({type:'item.completed',item:{id:'c1',type:'command_execution',command:'node --test change.test.mjs',exit_code:receipt.status,aggregated_output:receipt.stdout}});
 emit({type:'item.completed',item:{id:'f1',type:'file_change',changes:[{path:'README.md',kind:'update'}]}});
 writeFileSync(output,JSON.stringify({summary:'resumed segment applied owner input'}));
 emit({type:'turn.completed',usage:{input_tokens:2}});
}
`;
async function setup(t, { mode, title }) {
  const directory = await mkdtemp(join(tmpdir(), 'ath-live-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await run('git', ['init', directory])).code, 0);
  await writeFile(join(directory, 'README.md'), 'original\n');
  await writeFile(join(directory, '.gitignore'), '.segments.jsonl\n.hung-pid\n.agent-task-hub/\n');
  await run('git', ['-C', directory, 'add', '.']);
  assert.equal((await run('git', ['-C', directory, '-c', 'user.name=F', '-c', 'user.email=f@example.test', 'commit', '-m', 'fixture'])).code, 0);
  const runner = join(directory, 'synthetic-codex.mjs');
  await writeFile(runner, synthetic);
  const requests = [], acks = [];
  let claimed = false, inputPolls = 0;
  const input = { id: 'input-1', requestId: 'req-1', sequence: 1, mode, text: `Owner says: use ${mode}`, state: 'delivered' };
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || '{}'); requests.push({ path: request.url, body });
    response.setHeader('content-type', 'application/json');
    let value = {};
    if (request.url === '/api/connector/enroll') value = { token: 'live-token', origin, connection: { id: 'live-connection', projectId: 'p', project: 'P', capabilities: ['read', 'execute'] } };
    else if (request.url === '/api/connector/agent') {
      if (body.action === 'claim') { value = { job: claimed ? null : { id: 'live-run', leaseToken: 'lease', ticketId: 't', revision: 1, body: { title }, timeoutMs: 30000, leaseExpiresAt: Date.now() + 60000 } }; claimed = true; }
      else if (body.action === 'renew') value = { leaseExpiresAt: Date.now() + 60000, cancelRequested: false, pendingInputs: 0 };
      else if (body.action === 'inputs') value = { inputs: ++inputPolls >= 2 && !acks.length ? [input] : [] };
      else if (body.action === 'input-ack') { acks.push(body); value = { input: { ...input, state: body.state } }; }
      else if (body.action === 'capabilities') value = { capabilities: body.capabilities };
      else if (body.action === 'transcript') value = { accepted: body.entries.length, lastSequence: 0, limited: false };
    }
    response.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(accept => server.close(accept)));
  const install = await run(process.execPath, [cli, 'install', '--url', origin, '--workspace', directory, '--code-stdin'], { input: 'invite' });
  assert.equal(install.code, 0, install.stderr);
  return { directory, runner, requests, acks, config: join(directory, '.agent-task-hub/connection.json') };
}
const segments = async worktree => (await readFile(join(worktree, '.segments.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('Codex guide is queued, applied by resuming the thread, and the transcript is mapped in order', async t => {
  const item = await setup(t, { mode: 'guide', title: 'Change README' });
  const result = await run(process.execPath, [cli, 'agent', '--config', item.config, '--test-runner', item.runner, '--once']);
  assert.equal(result.code, 0, result.stderr);
  const complete = item.requests.find(request => request.body.action === 'complete');
  assert.ok(complete, result.stderr);
  assert.match(complete.body.result.summary, /resumed segment applied owner input/);
  assert.match(complete.body.result.diff, /resumed change/);
  assert.equal(complete.body.result.tests[0].exitCode, 0);
  assert.deepEqual(item.requests.find(request => request.body.action === 'capabilities').body.capabilities.guide, true);
  assert.deepEqual(item.acks.map(ack => [ack.inputId, ack.state]), [['input-1', 'applied']]);
  const [first, second] = await segments(complete.body.result.worktree);
  assert.ok(!first.args.includes('--ephemeral'));
  assert.deepEqual(second.args.slice(second.args.indexOf('resume')).slice(-2), ['thread-123', '-']);
  assert.ok(second.args.includes('sandbox_mode="workspace-write"'));
  assert.match(second.prompt, /Owner says: use guide/);
  assert.equal(second.cwd, first.cwd);
  const entries = item.requests.filter(request => request.body.action === 'transcript').flatMap(request => request.body.entries);
  const kinds = entries.map(entry => entry.kind);
  assert.deepEqual(kinds.slice(0, 6), ['system', 'reasoning', 'command_start', 'command_output', 'message', 'system']);
  assert.ok(entries[3].truncated && JSON.stringify(entries[3].body).length <= 30000);
  assert.equal(entries[2].stepId, entries[3].stepId);
  assert.ok(kinds.includes('file_change') && kinds.filter(kind => kind === 'result').length === 2);
  const { installationId } = JSON.parse(await readFile(item.config, 'utf8'));
  assert.deepEqual(entries.map(entry => entry.id), entries.map((_, index) => `${installationId}:live-run:t${index + 1}`));
  assert.ok(!JSON.stringify(entries).includes('live-token'));
  const order = item.requests.map(request => request.body.action);
  assert.ok(order.lastIndexOf('transcript') < order.indexOf('complete'), 'Transcript is flushed before completion');
});

test('Codex interrupt stops the hung process group and resumes in the same worktree', async t => {
  const item = await setup(t, { mode: 'interrupt', title: 'HANG until interrupted' });
  const result = await run(process.execPath, [cli, 'agent', '--config', item.config, '--test-runner', item.runner, '--once']);
  assert.equal(result.code, 0, result.stderr);
  const complete = item.requests.find(request => request.body.action === 'complete');
  assert.ok(complete, result.stderr);
  assert.deepEqual(item.acks.map(ack => [ack.inputId, ack.state]), [['input-1', 'applied']]);
  const [first, second] = await segments(complete.body.result.worktree);
  assert.ok(second.args.includes('resume'));
  assert.match(second.prompt, /interrupted the previous turn[\s\S]*use interrupt/);
  assert.equal(second.cwd, first.cwd);
  const pid = Number(await readFile(join(complete.body.result.worktree, '.hung-pid'), 'utf8'));
  try {
    process.kill(pid, 0);
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 'Z');
  } catch (error) { assert.ok(['ESRCH', 'ENOENT'].includes(error.code)); }
  assert.equal(complete.body.result.tests[0].exitCode, 0);
});
