import test from 'node:test';
import assert from 'node:assert/strict';
import { boundBody, createTranscript } from '../../connector/transcript.mjs';
import { mapCodexEvent } from '../../connector/runner.mjs';
import { mapClaudeEvent, userMessage } from '../../connector/claude-runner.mjs';
import { mapApiToolCall, mapApiToolResult } from '../../connector/api-runner.mjs';

const config = { installationId: 'inst', token: 'private-connector-token', workspace: '/private/workspace' };
const job = { id: 'run-1' };
const quiet = () => {};
function collector(respond = () => ({ accepted: 1, lastSequence: 1, limited: false })) {
  const batches = [];
  return { batches, send: async entries => { batches.push(entries); return respond(entries, batches.length); } };
}

test('transcript bodies are redacted in every string field and oversize bodies are cut and marked', () => {
  const { body, truncated } = boundBody({ command: 'curl -H "Authorization: Bearer private-connector-token"', output: 'x'.repeat(50000) + ' sk-live_abcdef', nested: { list: ['private-connector-token'] } }, config);
  const text = JSON.stringify(body);
  assert.ok(!text.includes('private-connector-token'));
  assert.ok(text.length <= 30000);
  assert.ok(truncated);
  assert.match(body.output, /\[truncated\]$/);
  assert.deepEqual(boundBody({ text: 'short' }, config), { body: { text: 'short' }, truncated: false });
  assert.equal(boundBody({ text: '/srv/wt/a.js and /srv/wt' }, config, { root: '/srv/wt' }).body.text, 'a.js and .');
});

test('emits batch into one request with stable sequential ids and marked truncation', async () => {
  const peer = collector();
  const transcript = createTranscript({ config, job, send: peer.send, batchMs: 30, log: quiet });
  const ids = [transcript.emit('message', { text: 'one' }), transcript.emit('command_start', { command: 'npm test' }, { stepId: 'c1' }), transcript.emit('command_output', { output: 'y'.repeat(40000), exitCode: 0 }, { stepId: 'c1' })];
  assert.deepEqual(ids, ['inst:run-1:t1', 'inst:run-1:t2', 'inst:run-1:t3']);
  await transcript.close();
  assert.equal(peer.batches.length, 1);
  assert.deepEqual(peer.batches[0].map(entry => [entry.id, entry.kind, entry.stepId, entry.truncated]), [['inst:run-1:t1', 'message', null, false], ['inst:run-1:t2', 'command_start', 'c1', false], ['inst:run-1:t3', 'command_output', 'c1', true]]);
  assert.equal(transcript.emit('message', { text: 'after close' }), null);
});

test('large bursts split at 50 entries and a full queue records one drop notice', async () => {
  const peer = collector();
  const transcript = createTranscript({ config, job, send: peer.send, batchMs: 10, maxQueue: 60, log: quiet });
  for (let index = 0; index < 120; index++) transcript.emit('message', { text: `m${index}` });
  await transcript.close();
  const entries = peer.batches.flat();
  assert.ok(peer.batches.every(batch => batch.length <= 50));
  assert.equal(entries.filter(entry => entry.kind === 'system' && /dropped/.test(entry.body.text)).length, 1);
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
  assert.equal(entries.at(-1).body.text, 'm119');
});

test('conflicts, network failures and service limits never throw and stop when limited', async () => {
  const logs = [];
  let calls = 0;
  const failing = createTranscript({ config, job, batchMs: 5, retries: 1, retryMs: 5, log: message => logs.push(message), send: async () => {
    calls++;
    if (calls === 1) { const error = Error('conflict'); error.status = 409; error.code = 'TRANSCRIPT_CONFLICT'; throw error; }
    throw Error('connect ECONNREFUSED');
  } });
  failing.emit('message', { text: 'a' });
  failing.emit('message', { text: 'b' });
  await failing.close();
  assert.ok(logs.some(message => /409/.test(message)));
  assert.ok(logs.some(message => /ECONNREFUSED/.test(message)));
  const limited = collector(() => ({ accepted: 0, limited: true }));
  const transcript = createTranscript({ config, job, send: limited.send, batchMs: 5, log: quiet });
  transcript.emit('message', { text: 'x' });
  await transcript.flush();
  assert.equal(transcript.emit('message', { text: 'after limit' }), null);
  await transcript.close();
  assert.equal(limited.batches.length, 1);
});

test('the same input replays to identical entries so server idempotency applies', async () => {
  const run = async () => { const peer = collector(); const transcript = createTranscript({ config, job, send: peer.send, batchMs: 5, log: quiet }); transcript.emit('message', { text: 'same' }); await transcript.close(); return peer.batches.flat(); };
  assert.deepEqual(await run(), await run());
});

test('Codex, Claude and API events map to contract transcript kinds', () => {
  const state = {};
  const codex = [
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking' } },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0 } },
    { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: 2 } },
    { type: 'item.completed', item: { id: 'i3', type: 'file_change', changes: [{ path: 'a.js', kind: 'update' }, { path: 'b', kind: 'rename' }] } },
    { type: 'item.started', item: { id: 'i4', type: 'mcp_tool_call', server: 'hub', tool: 'get_ticket', arguments: { id: 1 } } },
    { type: 'item.completed', item: { id: 'i4', type: 'mcp_tool_call', server: 'hub', tool: 'get_ticket', result: { content: [{ type: 'text', text: 'r' }] } } },
    { type: 'item.completed', item: { id: 'i5', type: 'todo_list', items: [{ text: 'step', completed: true }] } },
    { type: 'item.completed', item: { id: 'i6', type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 1 } },
    { type: 'turn.failed', error: { message: 'bad' } },
    { type: 'brand.new' },
  ].flatMap(event => mapCodexEvent(event, state));
  assert.deepEqual(codex.map(([kind, , opts]) => `${kind}:${opts.stepId ?? ''}`), ['system:', 'reasoning:i0', 'command_start:i1', 'command_output:i1', 'command_start:i2', 'command_output:i2', 'file_change:i3', 'tool_call:i4', 'tool_result:i4', 'system:i5', 'message:i6', 'result:', 'error:', 'system:']);
  assert.deepEqual(codex[3][1], { command: 'npm test', output: 'ok', exitCode: 0 });
  assert.deepEqual(codex[6][1].changes, [{ path: 'a.js', kind: 'update' }, { path: 'b', kind: 'other' }]);
  assert.deepEqual(codex[8][1], { name: 'hub.get_ticket', output: 'r', isError: false });

  const claudeState = {};
  const claude = [
    { type: 'system', subtype: 'init', session_id: 's', model: 'm' },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hi' }, { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'x.js' } }, { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'y' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'Exit code 3\nfail' }, { type: 'tool_result', tool_use_id: 'r1', content: [{ type: 'text', text: 'body' }] }] } },
    { type: 'result', subtype: 'success', result: 'final', usage: { output_tokens: 2 } },
  ].flatMap(event => mapClaudeEvent(event, claudeState));
  assert.deepEqual(claude.map(([kind]) => kind), ['system', 'reasoning', 'message', 'command_start', 'tool_call', 'file_change', 'tool_call', 'command_output', 'tool_result', 'result']);
  assert.equal(claude[7][1].exitCode, 3);
  assert.equal(claude[7][2].stepId, 'b1');
  assert.deepEqual(claude[8][1], { name: 'Read', output: 'body', isError: false });
  assert.deepEqual(JSON.parse(userMessage('go')), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } });

  const run = { id: 'k1', function: { name: 'run_command' } }, write = { id: 'k2', function: { name: 'write_file' } };
  assert.deepEqual(mapApiToolCall(run, { command: 'npm test' }), [['command_start', { command: 'npm test' }, { stepId: 'k1' }]]);
  assert.deepEqual(mapApiToolResult(run, { command: 'npm test' }, 'exit code 0', { exitCode: 0 })[0][1].exitCode, 0);
  assert.deepEqual(mapApiToolCall(write, { path: 'a', content: 'abc' })[0][1], { name: 'write_file', input: '{"path":"a","bytes":3}' });
  assert.deepEqual(mapApiToolResult(write, { path: 'a' }, 'Wrote a').map(([kind]) => kind), ['tool_result', 'file_change']);
});
