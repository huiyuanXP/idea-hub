import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loopbackUrl } from '../harness.mjs';
import { launchRestrictedBrowser } from './network.mjs';

const dev = loopbackUrl(process.env.TEST_DEV_URL).origin;
const preview = loopbackUrl(process.env.TEST_PREVIEW_URL).origin;
const out = process.env.TEST_ARTIFACT_DIR;
const moduleUrl = new URL(process.env.TEST_PLAYWRIGHT_MODULE);
assert.equal(moduleUrl.protocol, 'file:', 'Playwright must use the separately locked local package');
const { chromium } = await import(moduleUrl.href);
const fixture = JSON.parse(await readFile(join(out, 'fixtures.json'), 'utf8'));
const errors = [], checks = [];
let blocked = [], requestedExternal = [], networkErrors = [], page, closeBrowser;
function ok(name) { checks.push(name); console.log('PASS:', name); }
async function evidence(status, error) {
  await writeFile(join(out, 'browser-evidence.json'), JSON.stringify({ status, checks, pageErrors: errors, blockedExternalRequests: blocked, requestedExternalOrigins: requestedExternal, networkPolicyErrors: networkErrors, ...(error ? { error: error.message } : {}) }, null, 2) + '\n');
}
try {
  const restricted = await launchRestrictedBrowser(chromium, [dev, preview], { viewport: { width: 1440, height: 1000 } });
  const context = restricted.context;
  closeBrowser = restricted.close;
  blocked = restricted.blocked;
  requestedExternal = restricted.requestedExternal;
  networkErrors = restricted.errors;
  context.on('page', current => current.on('pageerror', error => errors.push(error.message)));
  page = await context.newPage();
  await page.goto(dev + '/signin?return_to=/', { waitUntil: 'networkidle' });
  await page.getByLabel('用户名').fill('alice');await page.getByLabel('密码').fill('incorrect-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'用户名或密码无效'}).waitFor();
  assert.equal(new URL(page.url()).pathname,'/signin');ok('Browser password denial preserves the login form without issuing a session');
  await page.getByLabel('密码').fill('synthetic-password');await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('button', { name: '收集点子', exact: true }).waitFor();
  // Views show one project at a time; the fixture lives in its own project.
  await page.getByRole('combobox', { name: '项目筛选', exact: true }).selectOption(fixture.project);
  await page.getByRole('heading', { name: fixture.ideaTitle, exact: true }).waitFor();
  await page.getByLabel('当前账户').getByText('Alice Local', { exact: true }).waitFor();
  await page.getByText(/本地账户/).waitFor();
  assert.equal(await page.getByLabel('账户缩写').innerText(), 'AL');
  ok('Signed-in UI hydrates with actual local account and label');

  const browserTitle = 'Regression browser synthetic idea ' + Date.now();
  await page.getByRole('textbox', { name: '快速记录点子' }).fill(browserTitle);
  const saved = page.waitForResponse(response => response.url() === dev + '/api/records' && response.request().method() === 'POST' && response.status() === 201);
  const planned = page.waitForResponse(response => response.url() === dev + '/api/planning' && response.request().method() === 'GET' && response.status() === 200);
  await page.getByRole('button', { name: '收集点子', exact: true }).click();
  const [savedResponse, planningResponse] = await Promise.all([saved, planned]);
  const created = await savedResponse.json();
  assert.ok((await planningResponse.json()).jobs.some(job => job.idea_id === created.id && job.status === 'queued' && job.delivery === 'no_subscription'));
  await page.getByRole('heading', { name: browserTitle, exact: true }).waitFor();
  await page.locator('article').filter({ has: page.getByRole('heading', { name: browserTitle, exact: true }) }).getByText('已排队 · 等待项目 Agent', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="快速记录点子"]').value === '');
  assert.equal(await page.getByRole('textbox', { name: '快速记录点子' }).inputValue(), '');
  ok('Browser captures idea, creates planning request and updates UI');

  await page.getByRole('button', { name: '规划工作台', exact: false }).click();
  await page.getByRole('heading', { name: fixture.planTitle, exact: true }).waitFor();
  await page.getByRole('button', { name: '点子收件箱', exact: false }).click();
  await page.getByRole('heading', { name: fixture.ideaTitle, exact: true }).click();
  const ideaDialog = page.getByRole('dialog');
  await ideaDialog.getByRole('button', { name: '编辑', exact: true }).click();
  await ideaDialog.getByRole('textbox', { name: '原始内容', exact: true }).fill(fixture.ideaTitle + ' revised');
  const revisionSaved = page.waitForResponse(response => response.url() === dev + '/api/records' && response.request().method() === 'POST' && response.status() === 200);
  await ideaDialog.getByRole('button', { name: '保存到本地', exact: true }).click();
  await revisionSaved;
  await page.getByRole('heading', { name: fixture.ideaTitle + ' revised', exact: true }).waitFor();
  await page.getByRole('button', { name: '规划工作台', exact: false }).click();
  await page.locator('article').filter({ has: page.getByRole('heading', { name: fixture.planTitle, exact: true }) }).getByText('已过期 · 点子 v1 / 当前 v2', { exact: true }).waitFor({ timeout: 3000 });
  ok('Idea edit automatically queues current revision and labels superseded Plans');
  // The fixture Ticket is done (accepted), so it is archived off the board.
  await page.getByRole('button', { name: 'Ticket 看板', exact: false }).click();
  await page.locator('.board').waitFor();
  assert.equal(await page.getByRole('heading', { name: fixture.ticketTitle, exact: true }).count(), 0);
  await page.getByRole('button', { name: /归档/ }).click();
  // The edited fixture Ticket was saved without a project, so it belongs to 通用.
  await page.getByRole('combobox', { name: '项目筛选', exact: true }).selectOption('通用');
  await page.getByRole('heading', { name: fixture.ticketTitle, exact: true }).waitFor();
  await page.getByRole('button', { name: '执行记录', exact: false }).click();
  await page.getByRole('heading', { name: fixture.runTitle, exact: true }).waitFor();
  await page.getByText('查看冻结的任务约定', { exact: true }).click();
  const frozen = page.locator('details[open]').filter({ has: page.getByText('查看冻结的任务约定', { exact: true }) });
  assert.match(await frozen.innerText(), /Validate snapshot/);
  assert.match(await frozen.innerText(), /Loopback only/);
  assert.match(await frozen.innerText(), /Snapshot is immutable/);
  ok('Plan, Ticket board, archive and frozen Run evidence views render');

  const brand = page.getByRole('link', { name: '点子工坊 AGENT TASK HUB' });
  await page.getByRole('button', { name: 'Ticket 看板', exact: false }).click();
  await page.getByRole('textbox', { name: '搜索', exact: true }).fill(fixture.ticketTitle);
  await page.getByRole('combobox', { name: '项目筛选', exact: true }).selectOption(fixture.project);
  await page.getByRole('combobox', { name: '状态筛选', exact: true }).selectOption('done');
  await page.getByRole('heading', { name: 'Ticket 看板', exact: true }).waitFor();
  const popupPromise = context.waitForEvent('page');
  await brand.click({ modifiers: ['Control'] });
  const popup = await popupPromise;
  await popup.waitForLoadState('networkidle');
  await popup.close();
  assert.equal(await page.getByRole('textbox', { name: '搜索', exact: true }).inputValue(), fixture.ticketTitle);
  assert.equal(await page.getByRole('combobox', { name: '项目筛选', exact: true }).inputValue(), fixture.project);
  assert.equal(await page.getByRole('combobox', { name: '状态筛选', exact: true }).inputValue(), 'done');
  await page.getByRole('heading', { name: 'Ticket 看板', exact: true }).waitFor();
  ok('Modified brand navigation opens home while preserving current workspace filters');

  const refreshed = page.waitForResponse(response => response.url() === dev + '/api/records' && response.request().method() === 'GET' && response.status() === 200);
  await brand.click();
  await refreshed;
  await page.getByRole('button', { name: '收集点子', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '搜索', exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('combobox', { name: '项目筛选', exact: true }).inputValue(), '通用');
  assert.equal(await page.getByRole('combobox', { name: '状态筛选', exact: true }).count(), 0);
  // The captured idea was saved to the fixture project, so it reappears once that project is chosen.
  await page.getByRole('combobox', { name: '项目筛选', exact: true }).selectOption(fixture.project);
  await page.getByRole('heading', { name: browserTitle, exact: true }).waitFor();
  ok('Normal brand navigation restores inbox and clears workspace filters');
  await page.screenshot({ path: join(out, 'dev-ui.png'), fullPage: true });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('combobox', { name: '项目筛选', exact: true }).selectOption(fixture.project);
  await page.getByRole('heading', { name: browserTitle, exact: true }).waitFor();
  ok('Synthetic records persist across browser reload');
  const logout = page.waitForResponse(response => response.url() === dev + '/api/auth/logout' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  assert.equal((await logout).status(), 303);
  await page.waitForURL(dev+'/signin');
  await page.getByRole('button',{name:'登录',exact:true}).waitFor();
  assert.equal((await context.cookies()).some(cookie => cookie.name === 'hub_session'), false);
  ok('Local logout uses POST and removes the real browser session');
  // The page polls session state; readiness is its rendered denial, not global network idleness.
  await page.goto(preview + '/', { waitUntil: 'domcontentloaded' });
  await page.locator('.alert[role="alert"]').waitFor();
  assert.match(await page.locator('.alert[role="alert"]').innerText(), /登录/);
  ok('Built preview hydrates and displays anonymous API auth failure');
  await restricted.flushNetworkEvidence();
  assert.deepEqual(errors, [], 'Browser JavaScript errors');
  assert.deepEqual(networkErrors, [], 'Browser network policy errors');
  assert.deepEqual(requestedExternal,[], 'External application requests');
  ok('All UI assets are local; zero external application requests');
  await evidence('passed');
} catch (error) {
  await evidence('failed', error);
  if (page) await page.screenshot({ path: join(out, 'browser-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { await closeBrowser?.(); }
