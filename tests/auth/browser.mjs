// Real Next responses delayed at an owned loopback ingress to exercise browser races.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { localFixture } from '../local/fixture.mjs';
import { issueToken } from '../../lib/local-auth.mts';
import { chromium } from '../browser/node_modules/playwright/index.mjs';
import { launchRestrictedBrowser } from '../browser/network.mjs';
const f=await localFixture({aliceName:'Alice Member',bobName:'Bob Member'}),origin=f.origin;
const token=async(sub,seconds=600)=>sub==='outsider'?randomBytes(32).toString('base64url'):(await issueToken(f.db,f[sub].userId,{kind:'browser',ttlSeconds:Math.max(60,seconds),now:Date.now()-Math.max(0,60-seconds)*1000})).token;
const alice=await token('alice'),bob=await token('bob'),outsider=await token('outsider');
let current = alice, denyPath, deniedToken, hold = false, releaseHeld, heldCount = 0, restricted, base;
const errors = [], outbound = [], requests = [];
let holdGroup, panelFault, requestSequence = 0;
const holdGroups = new Set();
let holdPaths = ['/api/records', '/api/planning'];
function holdResponses(paths) {
  holdPaths = paths; heldCount = 0;
  const group = { responses: [] };
  group.gate = new Promise(resolve => { group.release = () => { resolve(); holdGroups.delete(group); }; });
  holdGroup = group; holdGroups.add(group); releaseHeld = group.release; hold = true;
}
function releaseAllHeld() { for (const group of [...holdGroups]) group.release(); }
async function waitForHeld(count) {
  const deadline = Date.now() + 5000;
  while (heldCount < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(heldCount >= count, 'Real Next responses reached the delayed ingress boundary');
}
async function waitForHeldResponse(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = holdGroup.responses.find(predicate);
    if (response) return response;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('The exact requested real Next response reached the delayed ingress boundary');
}
const facade = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin), path = url.pathname, requestId = ++requestSequence, startedAt = Date.now();
    const panelDenied = panelFault && panelFault.path === path && panelFault.method === req.method && (!panelFault.query || url.searchParams.has(panelFault.query));
    requests.push({ path, method: req.method });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers(req.headers);
    headers.delete('host'); headers.delete('authorization'); headers.delete('cookie');
    headers.set('cookie', 'hub_session='+(panelDenied && panelFault.status === 401 ? outsider : path === '/api/records' && deniedToken ? deniedToken : current));
    if (headers.get('origin') === base) headers.set('origin', origin);
    if(denyPath===path||panelDenied&&panelFault.status===403)headers.set('origin','https://foreign.invalid');
    const response = await fetch(origin + req.url, {
      method: req.method, headers, redirect: 'manual', ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (hold && holdPaths.includes(path)) {
      const group = holdGroup, captured = { requestId, path, status: response.status, startedAt, verifiedAt: Date.now() };
      const individual = new Promise(resolve => { captured.release = resolve; });
      group.responses.push(captured); heldCount++;
      await Promise.race([group.gate, individual]);
    }
    const outgoing = Object.fromEntries(response.headers);
    outgoing['x-auth-fixture-request-id'] = String(requestId);
    delete outgoing['content-encoding']; delete outgoing['content-length'];
    if (outgoing.location?.startsWith(origin)) outgoing.location = base + outgoing.location.slice(origin.length);
    res.writeHead(response.status, outgoing); res.end(body);
  } catch (error) { errors.push(String(error)); res.writeHead(500); res.end('Fixture failed'); }
});
async function api(path, jwt = current, body) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + (jwt===alice?f.aliceToken:jwt===bob?f.bobToken:jwt), origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
}
try {
  const db=f.db;
  const idea = await api('/api/records', alice, { kind: 'idea', title: 'Alice private idea', text: 'Private body', project: '通用' });
  await api('/api/planning', alice, { ideaId: idea.id });
  await api('/api/records', bob, { kind: 'idea', title: 'Bob private idea' });
  const ticket = await api('/api/records', alice, { kind: 'ticket', title: 'Alice private authorization Ticket', status: 'todo' });
  const catalog = await api(`/api/authorization?ticketId=${ticket.id}&expectedRevision=1`, alice);
  const prepared = await api('/api/authorization', alice, { action: 'prepare', ticketId: ticket.id, expectedRevision: 1, requestId: 'browser-auth-private', attempt: 1, scope: catalog.operations.map(({ operationId, definitionHash }) => ({ operationId, definitionHash })), budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + 600000 });

  await new Promise(resolve => facade.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${facade.address().port}`;
  restricted = await launchRestrictedBrowser(chromium, [base], { viewport: { width: 1440, height: 1000 } });
  restricted.context.on('page', page => page.on('pageerror', error => errors.push(error.stack ?? error.message)));
  const page = await restricted.context.newPage(); page.setDefaultTimeout(7000);
  const identity = name => page.getByLabel('当前账户').getByText(name, { exact: true });
  const refresh = async () => { const done = page.waitForResponse(r => r.url() === base + '/api/session'); await page.getByRole('button', { name: '刷新数据' }).click(); await done; };
  const visibleAlice = async () => { await identity('Alice Member').waitFor(); await page.getByRole('heading', { name: 'Alice private idea', exact: true }).waitFor(); };
  const privateDraft = async () => {
    await page.getByRole('textbox', { name: '快速记录点子' }).fill('Unsaved private capture');
    await page.getByRole('button', { name: '新点子', exact: true }).click();
    await page.getByRole('dialog').getByRole('textbox').first().fill('Unsaved private draft');
  };
  const cleared = async (timeout = 7000) => {
    // Observe one DOM version: a later, independently verified session may
    // legitimately establish identity after the denial has cleared this state.
    const snapshot = await page.waitForFunction(() => {
      if (![...document.querySelectorAll('a')].some(node => node.textContent.trim() === '登录')) return false;
      return {
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        capture: document.querySelector('[aria-label="快速记录点子"]')?.value,
        account: document.querySelector('[aria-label="当前账户"]')?.textContent ?? null,
        aliceIdea: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(node => node.textContent.trim() === 'Alice private idea').length,
        inbox: [...document.querySelectorAll('button')].find(node => node.textContent.includes('点子收件箱'))?.textContent.replace(/\s/g, ''),
        project: document.querySelector('[aria-label="项目筛选"]')?.value,
      };
    }, undefined, { timeout });
    assert.deepEqual(await snapshot.jsonValue(), { dialogs: 0, capture: '', account: null, aliceIdea: 0, inbox: '点子收件箱0', project: '通用' });
    await snapshot.dispose();
  };
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await visibleAlice();
  assert.equal(await page.getByLabel('账户缩写').innerText(), 'AM');
  assert.equal(await page.getByText('本地开发身份').count(), 0);
  console.log('PASS: actual verified session renders name and initials');
  const brand = page.getByRole('link', { name: '点子工坊 AGENT TASK HUB' });
  await page.getByRole('textbox', { name: '搜索', exact: true }).fill('private');
  const popupReady = restricted.context.waitForEvent('page'); await brand.click({ modifiers: ['Control'] }); const popup = await popupReady;
  await popup.waitForLoadState('networkidle'); await popup.close();
  assert.equal(await page.getByRole('textbox', { name: '搜索', exact: true }).inputValue(), 'private');
  await brand.click(); await visibleAlice(); assert.equal(await page.getByRole('textbox', { name: '搜索', exact: true }).inputValue(), '');
  console.log('PASS: independent identity preserves normal and modified home navigation');
  await privateDraft(); current = bob;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await identity('Bob Member').waitFor(); await page.getByRole('heading', { name: 'Bob private idea', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await page.getByRole('textbox', { name: '快速记录点子' }).inputValue(), '');
  assert.equal(await page.getByText('Alice private idea', { exact: true }).count(), 0);
  console.log('PASS: account switch discards old rows and unsaved private state');
  current = alice; await refresh(); await visibleAlice();
  await db.prepare('ALTER TABLE local_tokens RENAME TO unavailable_tokens').run();
  await refresh(); await page.locator('.alert[role="alert"]').waitFor(); await visibleAlice();
  assert.equal(await page.getByRole('link', { name: '登录', exact: true }).count(), 0);
  await db.prepare('ALTER TABLE unavailable_tokens RENAME TO local_tokens').run();
  console.log('PASS: real storage 503 keeps identity distinct from expired authentication');
  await privateDraft(); current = await token('outsider');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await cleared();
  console.log('PASS: real nonmember 401 clears private rows, draft, capture and account');
  current = alice; await refresh(); await visibleAlice(); await privateDraft(); deniedToken = await token('outsider');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await cleared(); deniedToken = undefined;
  console.log('PASS: real records 401 clears private state even when session succeeds');
  current = alice; await refresh(); await visibleAlice(); await privateDraft(); denyPath = '/api/planning';
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await cleared(); denyPath = undefined;
  console.log('PASS: real data 403 clears private state even when session succeeds');
  current = alice; await refresh(); await visibleAlice(); await privateDraft();
  holdResponses(['/api/planning']); deniedToken = await token('outsider');
  const recordsDenied = page.waitForResponse(r => r.url() === base + '/api/records' && r.status() === 401);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await recordsDenied; await waitForHeld(1);
  await cleared(2000); // Must clear while the successful planning response is still held.
  hold = false; releaseHeld(); deniedToken = undefined;
  await page.waitForLoadState('networkidle'); await cleared();
  console.log('PASS: records 401 clears promptly while sibling planning response remains pending');
  current = alice; await refresh(); await visibleAlice(); await privateDraft();
  holdResponses(['/api/records']); denyPath = '/api/planning';
  const planningDenied = page.waitForResponse(r => r.url() === base + '/api/planning' && r.status() === 403);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await planningDenied; await waitForHeld(1); await cleared(2000);
  hold = false; releaseHeld(); denyPath = undefined;
  await page.waitForLoadState('networkidle'); await cleared();
  console.log('PASS: planning 403 clears promptly while sibling records response remains pending');
  current = alice; await refresh(); await visibleAlice();
  holdResponses(['/api/records']); deniedToken = await token('outsider');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await waitForHeld(1);
  // Keep the old denial held, but let the new account's refresh proceed.
  hold = false; deniedToken = undefined; current = bob;
  await refresh(); await identity('Bob Member').waitFor();
  await page.getByRole('heading', { name: 'Bob private idea', exact: true }).waitFor();
  const staleDenial = page.waitForResponse(r => r.url() === base + '/api/records' && r.status() === 401);
  releaseHeld(); await staleDenial; await page.waitForLoadState('networkidle');
  await identity('Bob Member').waitFor();
  await page.getByRole('heading', { name: 'Bob private idea', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: '登录', exact: true }).count(), 0);
  console.log('PASS: delayed old-account denial cannot clear the newer verified account');
  const panel = page.getByRole('region', { name: '执行授权' });
  const openPanel = async (pending = true) => {
    current = alice; await refresh(); await identity('Alice Member').waitFor();
    await page.getByRole('button', { name: /Ticket 看板/ }).click();
    const summary = page.getByText('固定 Docker 操作与独立执行授权', {exact:true});
    const section = page.locator('details').filter({has:summary});
    if (await section.getAttribute('open') === null) await summary.click();
    await panel.getByText(pending ? 'pending' : 'cancelled', { exact: pending }).waitFor();
    await page.waitForLoadState('networkidle');
  };
  const panelDenial = () => page.waitForResponse(r => {
    const url = new URL(r.url());
    return url.pathname === panelFault.path && r.request().method() === panelFault.method && r.status() === panelFault.status && (!panelFault.query || url.searchParams.has(panelFault.query));
  });
  const assertPanelCleared = async () => {
    await cleared(2000);
    assert.equal(await panel.count(), 0);
    assert.equal(await page.getByText('Alice private authorization Ticket', { exact: true }).count(), 0);
  };
  await openPanel();
  assert.ok((await panel.innerText()).includes(prepared.run.id));
  panelFault = { path: '/api/authorization', method: 'GET', query: 'ticketId', status: 401 };
  holdResponses(['/api/execution']);
  const deniedPoll = panelDenial(); // Exercise the actual five-second panel poll.
  await deniedPoll; await waitForHeld(1); await assertPanelCleared();
  hold = false; releaseHeld(); await page.waitForLoadState('networkidle'); panelFault = undefined;
  console.log('PASS: authorization poll 401 immediately clears workspace while sibling Run list is held');
  await openPanel(); panelFault = { path: '/api/execution/dispatch', method: 'GET', status: 401 };
  const deniedBackendHealth = panelDenial(); await panel.getByRole('button', { name: '刷新授权状态' }).click();
  await deniedBackendHealth; await assertPanelCleared(); panelFault = undefined;
  console.log('PASS: execution health denial clears all cached private Run, grant, connection and result state');
  await openPanel();
  panelFault = { path: '/api/execution', method: 'GET', status: 403 }; holdResponses(['/api/authorization']);
  const deniedList = panelDenial(); await panel.getByRole('button', { name: '刷新授权状态' }).click();
  await deniedList; await waitForHeld(1); await assertPanelCleared();
  hold = false; releaseHeld(); await page.waitForLoadState('networkidle'); panelFault = undefined;
  console.log('PASS: Run-list 403 immediately clears workspace while sibling catalog is held');
  await openPanel();
  panelFault = { path: '/api/authorization', method: 'GET', query: 'id', status: 403 };
  const deniedDetail = panelDenial(); await panel.getByRole('button', { name: '刷新授权状态' }).click();
  await deniedDetail; await assertPanelCleared(); panelFault = undefined;
  console.log('PASS: authorization detail 403 clears previously displayed private Run and grant');
  await openPanel();
  await db.prepare('ALTER TABLE execution_authorizations RENAME TO unavailable_authorizations').run();
  const unavailablePanel = page.waitForResponse(r => new URL(r.url()).pathname === '/api/authorization' && r.status() === 503);
  await panel.getByRole('button', { name: '刷新授权状态' }).click(); await unavailablePanel;
  await panel.getByRole('alert').waitFor(); await identity('Alice Member').waitFor();
  await panel.getByText('pending', { exact: true }).waitFor();
  assert.ok((await panel.innerText()).includes(prepared.run.id));
  assert.equal(await page.getByRole('link', { name: '登录', exact: true }).count(), 0);
  await db.prepare('ALTER TABLE unavailable_authorizations RENAME TO execution_authorizations').run();
  console.log('PASS: real panel storage 503 retains verified account and prior Run/grant');
  for (const [path, button, status] of [['/api/authorization', '批准授权', 403], ['/api/execution', '取消 Run，允许重新申请', 401]]) {
    await openPanel(); panelFault = { path, method: 'POST', status };
    // Hold successful session responses so the clearing assertion cannot race
    // a newly authenticated periodic refresh. Also exercise an older session
    // request that was verified before denial but has not reached the browser.
    holdResponses(['/api/session']);
    let staleSession, staleResponse;
    if (status === 401) {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await waitForHeld(1);
      staleResponse = holdGroup.responses.find(r => r.path === '/api/session' && r.status === 200);
      assert.ok(staleResponse, 'Capture the successful session verified before the denied write');
      staleSession = page.waitForResponse(r => r.headers()['x-auth-fixture-request-id'] === String(staleResponse.requestId));
    }
    const beforeWrite = Date.now();
    const deniedWrite = panelDenial(); await panel.getByRole('button', { name: button }).click();
    const deniedResponse = await deniedWrite; await assertPanelCleared(); panelFault = undefined;
    console.log(`PASS: ${button} write denial clears workspace before response-body processing`);
    if (staleSession) {
      assert.ok(staleResponse.verifiedAt <= beforeWrite, 'Released session was verified before the denied write began');
      assert.ok(staleResponse.requestId < Number(deniedResponse.headers()['x-auth-fixture-request-id']), 'Released session request predates the denied write');
      const capturedGroup = holdGroup;
      holdResponses(['/api/session']); // Any later refresh remains separate.
      // Release only the captured verified response. Periodic refreshes verified
      // after the denial may also have reached the old group and must stay held.
      staleResponse.release();
      assert.equal((await staleSession).status(), 200);
      // Allow fetch continuations and React's render to run, without a sleep.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await assertPanelCleared();
      console.log('AUTH_SESSION_RACE_EVIDENCE ' + JSON.stringify({ stale: { requestId: staleResponse.requestId, startedAt: staleResponse.startedAt, verifiedAt: staleResponse.verifiedAt }, deniedRequestId: Number(deniedResponse.headers()['x-auth-fixture-request-id']), separatelyHeldSessions: capturedGroup.responses.filter(r => r !== staleResponse).map(({ requestId, startedAt, verifiedAt }) => ({ requestId, startedAt, verifiedAt })) }));
      console.log('PASS: pre-denial verified session response cannot restore identity or execution cache');
      holdResponses(['/api/session']);
      const beforeFreshRequest = requestSequence;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const freshResponse = await waitForHeldResponse(r => r.path === '/api/session' && r.status === 200 && r.requestId > beforeFreshRequest);
      assert.ok(freshResponse, 'Capture an independently initiated successful session after the denial');
      const newSession = page.waitForResponse(r => r.headers()['x-auth-fixture-request-id'] === String(freshResponse.requestId));
      hold = false; freshResponse.release();
      assert.equal((await newSession).status(), 200);
      await visibleAlice();
      assert.equal(await panel.count(), 0);
      assert.equal(await page.getByText(prepared.run.id, { exact: false }).count(), 0);
      releaseAllHeld();
      console.log('PASS: newly initiated verified session restores identity without old execution cache');
    } else { hold = false; releaseHeld(); }
  }
  for (const method of ['GET', 'POST']) {
    await openPanel(); panelFault = { path: '/api/execution', method, status: 401 }; holdResponses(['/api/execution']);
    await panel.getByRole('button', { name: method === 'GET' ? '刷新授权状态' : '取消 Run，允许重新申请' }).click();
    await waitForHeld(1); hold = false; panelFault = undefined; current = bob;
    await refresh(); await identity('Bob Member').waitFor();
    await page.getByRole('heading', { name: 'Bob private idea', exact: true }).waitFor();
    const stalePanel = page.waitForResponse(r => new URL(r.url()).pathname === '/api/execution' && r.status() === 401);
    releaseHeld(); await stalePanel; await page.waitForLoadState('networkidle');
    await identity('Bob Member').waitFor();
    await page.getByRole('heading', { name: 'Bob private idea', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: '登录', exact: true }).count(), 0);
    console.log(`PASS: stale panel ${method} denial cannot clear a newer account`);
  }
  await openPanel(); panelFault = { path: '/api/execution', method: 'GET', status: 401 }; holdResponses(['/api/execution']);
  await panel.getByRole('button', { name: '刷新授权状态' }).click(); await waitForHeld(1);
  await page.getByRole('button', { name: /点子收件箱/ }).click();
  hold = false; panelFault = undefined;
  const unmountedDenial = page.waitForResponse(r => new URL(r.url()).pathname === '/api/execution' && r.status() === 401);
  releaseHeld(); await unmountedDenial; await page.waitForLoadState('networkidle'); await visibleAlice();
  console.log('PASS: unmounted panel denial cannot clear the still-current workspace account');
  await api('/api/execution', alice, { action: 'cancel', id: prepared.run.id, expectedVersion: prepared.run.version });
  await openPanel(false); panelFault = { path: '/api/authorization', method: 'POST', status: 401 };
  const deniedPrepare = panelDenial(); await panel.getByRole('button', { name: '请求执行授权' }).click();
  await deniedPrepare; await assertPanelCleared(); panelFault = undefined;
  assert.equal((await db.prepare('SELECT count(*) AS n FROM execution_authorizations').first()).n, 1);
  console.log('PASS: authorization preparation 401 clears workspace without creating a grant');
  current = await token('alice', 10); await refresh(); await visibleAlice(); await privateDraft();
  holdResponses(['/api/records', '/api/planning']);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitForHeld(2);
  await page.getByRole('link', { name: '登录', exact: true }).waitFor({ timeout: 12000 }); await cleared();
  hold = false; releaseHeld();
  await page.waitForLoadState('networkidle'); await cleared();
  console.log('PASS: deadline expires without refresh and delayed successful responses cannot restore private state');
  current = alice; await refresh(); await visibleAlice();
  const logout = page.waitForResponse(r => r.url() === base + '/api/auth/logout' && r.request().method() === 'POST');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  assert.equal((await logout).status(), 303);
  await page.waitForURL(base + '/signin');
  const replay = await fetch(origin + '/api/session', { headers: { cookie: 'hub_session=' + alice } });
  assert.equal(replay.status, 401); await replay.text();
  console.log('PASS: actual same-origin POST logout immediately revokes the browser token');
  await restricted.flushNetworkEvidence();
  const evidence = JSON.stringify({
    pageErrors: errors, requestedExternalOrigins: restricted.requestedExternal,
    blockedExternalRequests: restricted.blocked, networkPolicyErrors: restricted.errors,
    unexpectedOutboundRequests: outbound,
  });
  assert.ok(Buffer.byteLength(evidence) <= 64 * 1024, 'Synthetic auth browser evidence exceeds its bound');
  console.log('VERIFIED_AUTH_BROWSER_EVIDENCE ' + evidence);
  assert.deepEqual(errors, []); assert.deepEqual(restricted.errors, []);
  assert.deepEqual(restricted.requestedExternal,[], 'External application requests');
  assert.deepEqual(outbound,[]);
  assert.ok(requests.some(r => r.path === '/api/session'));
  console.log('PASS: no page errors or unexpected outbound requests');
} finally {
  if (restricted) {
    await restricted.flushNetworkEvidence();
    console.log('AUTH_BROWSER_FINAL_NETWORK_EVIDENCE ' + JSON.stringify({ blockedExternalRequests: restricted.blocked, requestedExternalOrigins: restricted.requestedExternal, networkPolicyErrors: restricted.errors }));
  }
  hold = false; releaseAllHeld(); await restricted?.close();
  facade.closeAllConnections(); if (facade.listening) await new Promise(resolve => facade.close(resolve));
  await f.close();
}
