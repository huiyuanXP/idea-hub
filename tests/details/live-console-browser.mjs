// Live Agent console: real native server + fresh SQLite + restricted Chromium. Transcript and input
// acknowledgements go through the contract connector endpoint with a synthetic connector bearer token.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { localFixture } from '../local/fixture.mjs';
import { issueToken } from '../../lib/local-auth.mts';
import { prepareWorkspaceRun, decideWorkspaceRun, claimWorkspaceRun } from '../../lib/workspace-runs/service.mts';
import { chromium } from '../browser/node_modules/playwright/index.mjs';
import { launchRestrictedBrowser } from '../browser/network.mjs';

const f = await localFixture();
const evidence = resolve(process.env.LIVE_CONSOLE_EVIDENCE_DIR ?? 'test-results/live-console'); mkdirSync(evidence, { recursive: true });
const errors = [], failures = [];
let restricted, renewer;
const check = async (name, fn) => { try { await fn(); console.log('PASS ' + name); } catch (error) { failures.push({ name, error: String(error) }); console.error('FAIL ' + name + ' ' + String(error)); throw error; } };
try {
  const owner = f.alice.userId, now = Date.now(), project = '控制台测试';
  const connectorToken = randomBytes(32).toString('base64url');
  await f.db.prepare('INSERT INTO workspace_projects VALUES(?,?,?,?)').bind('console-project', owner, project, now).run();
  await f.db.prepare('INSERT INTO workspace_connections(id,owner,project_id,name,workspace,version,capabilities,token_hash,token_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind('console-connection', owner, 'console-project', 'Synthetic console Agent', 'synthetic-repo', '1', '["execute"]', createHash('sha256').update(connectorToken).digest('hex'), now + 86400000, now).run();
  const created = await fetch(f.origin + '/api/records', { method: 'POST', headers: { authorization: 'Bearer ' + f.aliceToken, origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ticket', title: '控制台实时任务', project, status: 'todo', goal: '实时输出' }) });
  assert.equal(created.status, 201); const ticket = await created.json();
  const run = await prepareWorkspaceRun(f.db, owner, { ticketId: ticket.id, revision: 1, connectionId: 'console-connection', requestId: 'console-prepare', timeoutMs: 1800000 });
  await decideWorkspaceRun(f.db, owner, run.id, 'approve');
  const { job } = await claimWorkspaceRun(f.db, { id: 'console-connection', owner, projectId: 'console-project', project, capabilities: ['execute'] });
  assert.equal(job?.id, run.id, 'synthetic connector claims the approved Run');
  const agent = async body => {
    const response = await fetch(f.origin + '/api/connector/agent', { method: 'POST', headers: { authorization: 'Bearer ' + connectorToken, 'content-type': 'application/json' }, body: JSON.stringify({ runId: run.id, leaseToken: job.leaseToken, ...body }) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  renewer = setInterval(() => void agent({ action: 'renew' }).catch(error => errors.push('renew ' + error)), 10000);
  let n = 0;
  const append = (...entries) => agent({ action: 'transcript', entries: entries.map(entry => ({ id: `console:${run.id}:t${++n}`, ...entry })) });
  await agent({ action: 'capabilities', capabilities: { runner: 'claude', guide: true, interrupt: true } });
  await append({ kind: 'system', body: { text: 'session started' } }, { kind: 'message', body: { text: '开始阅读 Ticket' } });

  const session = await issueToken(f.db, owner, { kind: 'browser' });
  restricted = await launchRestrictedBrowser(chromium, [f.origin], { viewport: { width: 1280, height: 1000 } });
  await restricted.context.addCookies([{ name: 'hub_session', value: session.token, url: f.origin }]);
  const page = await restricted.context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const openConsole = async () => {
    await page.goto(f.origin, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^Ticket 看板/ }).click();
    await page.locator('.project-list').getByRole('button', { name: project }).click();
    const card = page.locator(`[data-ticket-id="${ticket.id}"]`).first();
    await card.getByRole('button', { name: '执行 / 查看执行', exact: true }).click();
    const terminal = page.getByRole('dialog').getByRole('region', { name: 'Agent 实时控制台' });
    await terminal.waitFor(); return terminal;
  };
  let consoleRegion = await openConsole();
  const log = () => consoleRegion.getByRole('log', { name: 'Agent 输出' });

  await check('existing entries load and new entries appear live without reload', async () => {
    await log().getByText('开始阅读 Ticket').waitFor();
    await append({ kind: 'command_start', stepId: 's1', body: { command: 'npm test' } }, { kind: 'command_output', stepId: 's1', body: { command: 'npm test', output: 'ok 1 - live\n# pass 1', exitCode: 0 } });
    await log().getByText('npm test', { exact: true }).waitFor();
    await log().getByText('退出码 0').waitFor();
    assert.equal(await log().locator('[data-step="s1"] [data-kind]').count(), 2, 'command start and output share one step group');
    await consoleRegion.getByText('实时连接', { exact: true }).waitFor();
  });
  await check('follow pauses when the user scrolls up and resumes on demand', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ kind: 'reasoning', body: { text: `思考行 ${i}` } }));
    await append(...many);
    await log().getByText('思考行 59', { exact: true }).waitFor();
    await page.waitForFunction(el => el.scrollHeight - el.scrollTop - el.clientHeight < 4, await log().elementHandle());
    await log().evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await consoleRegion.getByRole('button', { name: '恢复跟随', exact: true }).waitFor();
    await append({ kind: 'message', body: { text: '暂停期间的新输出' } });
    await log().getByText('暂停期间的新输出').waitFor();
    assert.equal(await log().evaluate(el => el.scrollTop), 0, 'paused console keeps the reader position');
    await consoleRegion.getByRole('button', { name: '恢复跟随', exact: true }).click();
    await page.waitForFunction(el => el.scrollHeight - el.scrollTop - el.clientHeight < 4, await log().elementHandle());
    await consoleRegion.getByRole('button', { name: '暂停跟随', exact: true }).waitFor();
  });
  await check('guide input shows queued and then applied after connector acknowledgement', async () => {
    const box = consoleRegion.getByRole('textbox', { name: '给 Agent 的输入' });
    await box.fill('请先补测试');
    const posted = page.waitForResponse(r => r.url() === f.origin + '/api/workspace-runs' && r.request().method() === 'POST');
    await box.press('Enter');
    const response = await posted; assert.equal(response.status(), 200);
    const { input } = await response.json(); assert.equal(input.mode, 'guide'); assert.equal(input.text, '请先补测试');
    assert.equal(await box.inputValue(), '', 'draft cleared after acceptance');
    const line = log().locator('.kind-input_echo').filter({ hasText: '请先补测试' }).first();
    await line.locator('[data-input-state="queued"]').waitFor();
    const { inputs } = await agent({ action: 'inputs' }); assert.equal(inputs[0].id, input.id);
    await agent({ action: 'input-ack', inputId: input.id, state: 'applied' });
    await line.locator('[data-input-state="applied"]').waitFor();
    await page.screenshot({ path: evidence + '/live-console-running.png', fullPage: true });
  });
  await check('terminal (failed) run disables input and reload replays all entries', async () => {
    await append({ kind: 'result', body: { text: '交付完成' } });
    await agent({ action: 'fail', error: 'Synthetic runner stopped' });
    await log().getByText('交付完成').waitFor();
    await consoleRegion.getByRole('textbox', { name: '给 Agent 的输入' }).and(page.locator(':disabled')).waitFor();
    assert.equal(await consoleRegion.getByRole('button', { name: '引导', exact: true }).isDisabled(), true);
    assert.equal(await consoleRegion.getByRole('button', { name: '打断并发送', exact: true }).isDisabled(), true);
    const expected = (await f.db.prepare('SELECT count(*) AS n FROM workspace_run_transcript WHERE run_id=?').bind(run.id).first()).n;
    consoleRegion = await openConsole();
    await log().getByText('交付完成').waitFor();
    assert.equal(await log().locator('[data-sequence]').count(), expected, 'reload replays every persisted entry once');
    await log().locator('[data-input-state="applied"]').waitFor();
    assert.equal(await consoleRegion.getByRole('textbox', { name: '给 Agent 的输入' }).isDisabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await consoleRegion.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'console fits a narrow screen');
    await page.screenshot({ path: evidence + '/live-console-mobile.png', fullPage: true });
  });
  await restricted.flushNetworkEvidence();
  assert.deepEqual(errors, []); assert.deepEqual(restricted.errors, []); assert.deepEqual(restricted.requestedExternal, []);
  console.log('LIVE_CONSOLE_BROWSER_EVIDENCE ' + JSON.stringify({ failures, screenshots: evidence, requestedExternal: restricted.requestedExternal }));
  assert.deepEqual(failures, []);
} finally { clearInterval(renewer); await restricted?.close(); await f.close(); }
