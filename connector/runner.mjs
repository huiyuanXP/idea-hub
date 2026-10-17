import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command, privateDirectory, redact } from './common.mjs';
import { codexMetadata, selectedCodexOptions } from './codex-config.mjs';

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return `linux:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    const result = await command('ps', ['-o', 'lstart=', '-p', String(pid)]).catch(() => null);
    return result?.code === 0 && result.stdout.trim() ? `ps:${result.stdout.trim()}` : null;
  }
}
function killGroup(pid, signal) {
  try { process.kill(process.platform === 'win32' ? pid : -pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function identifiedAlive(pid, identity) {
  if (await processIdentity(pid) !== identity) return false;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch { return true; }
}
export async function stopRecoveredProcess(journal) {
  if (!journal.pid || !journal.processIdentity || await processIdentity(journal.pid) !== journal.processIdentity) return;
  killGroup(journal.pid, 'SIGTERM');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && await identifiedAlive(journal.pid, journal.processIdentity)) await new Promise(accept => setTimeout(accept, 50));
  killGroup(journal.pid, 'SIGKILL');
  // Do not release ownership while an identified previous model process remains alive.
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline && await identifiedAlive(journal.pid, journal.processIdentity)) await new Promise(accept => setTimeout(accept, 50));
  if (await identifiedAlive(journal.pid, journal.processIdentity)) throw Error('Previous model process remains alive; refusing duplicate execution');
}
export function runnerInvocation(options, args) {
  return options['test-runner'] ? { executable: process.execPath, args: [options['test-runner'], ...args] } : { executable: options.codex || 'codex', args };
}
const preview = (value, limit = 4000) => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)?.slice(0, limit) ?? '';
function mcpOutput(result) {
  if (!result) return '';
  if (Array.isArray(result.content)) return result.content.map(part => part.text ?? preview(part)).join('\n');
  return preview(result.structured_content ?? result);
}
// Map one `codex exec --json` event to transcript entries [kind, body, { stepId }].
// `state` remembers started items so a completed item never repeats its start.
export function mapCodexEvent(value, state = {}, prefix = '') {
  state.started ||= new Set();
  const out = [], type = value?.type, item = value?.item;
  if (type === 'thread.started') return [['system', { text: `Codex session started${value.thread_id ? ` (${value.thread_id})` : ''}` }, {}]];
  if (type === 'turn.started') return out;
  if (type === 'turn.completed') return [['result', { ...(value.usage ? { usage: value.usage } : {}) }, {}]];
  if (type === 'turn.failed' || type === 'error') return [['error', { message: String(value.error?.message || value.message || 'Codex model request failed') }, {}]];
  if (!/^item\.(started|updated|completed)$/.test(type || '') || !item) return [['system', { text: `Codex event ${type || 'unknown'}: ${preview(value, 2000)}` }, {}]];
  const phase = type.slice(5), stepId = item.id == null ? null : prefix + item.id, key = stepId ?? '';
  const first = !state.started.has(key);
  if (first) state.started.add(key);
  const opts = { stepId };
  switch (item.type) {
    case 'agent_message': if (phase === 'completed') out.push(['message', { text: String(item.text ?? '') }, opts]); break;
    case 'reasoning': if (phase === 'completed') out.push(['reasoning', { text: String(item.text ?? '') }, opts]); break;
    case 'command_execution':
      if (first) out.push(['command_start', { command: String(item.command ?? '') }, opts]);
      if (phase === 'completed') out.push(['command_output', { command: String(item.command ?? ''), output: String(item.aggregated_output ?? ''), exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null }, opts]);
      break;
    case 'file_change':
      if (phase === 'completed') out.push(['file_change', { changes: (Array.isArray(item.changes) ? item.changes : []).map(change => ({ path: String(change.path ?? ''), kind: ['add', 'update', 'delete'].includes(change.kind) ? change.kind : 'other' })) }, opts]);
      break;
    case 'mcp_tool_call': {
      const name = [item.server, item.tool].filter(Boolean).join('.') || 'mcp';
      if (first) out.push(['tool_call', { name, input: preview(item.arguments ?? '') }, opts]);
      if (phase === 'completed') out.push(['tool_result', { name, output: item.error ? String(item.error.message ?? preview(item.error)) : mcpOutput(item.result), isError: Boolean(item.error) || item.status === 'failed' }, opts]);
      break;
    }
    case 'web_search':
      if (first) out.push(['tool_call', { name: 'web_search', input: String(item.query ?? '') }, opts]);
      break;
    case 'todo_list':
      if (phase !== 'completed' || first) out.push(['system', { text: 'Plan:\n' + (Array.isArray(item.items) ? item.items : []).map(entry => `${entry.completed ? '[x]' : '[ ]'} ${entry.text ?? ''}`).join('\n') }, opts]);
      break;
    case 'error': out.push(['error', { message: String(item.message ?? 'Codex reported an error') }, opts]); break;
    default: if (first || phase === 'completed') out.push(['system', { text: `Codex ${item.type || 'item'} ${phase}: ${preview(item, 2000)}` }, opts]);
  }
  return out;
}
const TEST_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|build)\b|\bnode\s+(?:[^\n]*\s)?--test\b|\b(?:pytest|vitest|jest|cargo\s+test|go\s+test|make\s+(?:test|check))\b/;
// Codex accepts exec-level sandbox/profile/config flags before the `resume` subcommand.
// Only resumable (live development) runs persist a Codex session; planning stays ephemeral.
export function codexArgs({ config, options, metadata, sandbox, cwd, schemaFile, outputFile, resume, ephemeral = false }) {
  const args = ['exec', ...(ephemeral ? ['--ephemeral'] : []), '--sandbox', sandbox, '--color', 'never'];
  if (options.profile && options.profile !== 'default') args.push('--profile', options.profile);
  if (options.model) args.push('--model', options.model);
  if (options.reasoning) args.push('-c', `model_reasoning_effort=${JSON.stringify(options.reasoning)}`);
  args.push('-c', 'approval_policy="never"');
  for (const name of metadata.mcp) if (name !== 'agent_task_hub') args.push('-c', `mcp_servers.${JSON.stringify(name)}.enabled=false`);
  for (const [name, value] of Object.entries({ command: process.execPath, args: [config.runtime, 'mcp', '--config', config.file], cwd: config.workspace, enabled: true, enabled_tools: ['get_idea', 'get_ticket', 'get_plan', 'list_tickets', 'list_plans'] })) args.push('-c', `mcp_servers.agent_task_hub.${name}=${JSON.stringify(value)}`);
  args.push('--cd', cwd);
  if (resume) args.push('resume', '--json', '-c', `sandbox_mode=${JSON.stringify(sandbox)}`, ...(options.model ? ['--model', options.model] : []), '--output-schema', schemaFile, '--output-last-message', outputFile, resume, '-');
  else args.push('--json', '--output-schema', schemaFile, '--output-last-message', outputFile, '-');
  return args;
}
// Runs Codex as one or more supervised segments. Owner guides are applied by
// resuming the same thread after a segment ends; interrupts stop the current
// process group and resume immediately. Deadline, signal and receipts span all segments.
export async function runCodex({ config, options, cwd, directory, schema, prompt, sandbox, timeoutMs, signal, started, event, transcript, inputs }) {
  options = selectedCodexOptions(config, options);
  const metadata = await codexMetadata(options, cwd);
  Object.defineProperty(config, 'runtimeSecrets', { value: metadata.secrets, writable: true, configurable: true });
  await privateDirectory(directory);
  const schemaFile = join(directory, 'schema.json'), outputFile = join(directory, 'result.json');
  await writeFile(schemaFile, JSON.stringify(schema), { mode: 0o600 });
  const childEnvironment = { ...process.env, NO_COLOR: '1' };
  const ownerIdentity = await processIdentity(process.pid);
  const deadline = Date.now() + timeoutMs;
  const receipts = [], commands = new Set(), guides = [];
  let session, fatal, current = null, interrupt = null, segmentIndex = 0, finished = false;
  let eventQueue = Promise.resolve();
  const emit = (kind, body, opts) => transcript?.emit(kind, body, opts);
  const notify = (stage, message) => { eventQueue = eventQueue.then(() => event?.(stage, redact(message, config))).catch(error => { fail(error); }); };
  function fail(error) { fatal ||= error; current?.stop(error.message); }
  const abort = () => fail(Error(String(signal.reason?.message || signal.reason || 'Run cancelled')));
  const timer = setTimeout(() => fail(Error('Codex execution timed out')), timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  if (inputs) {
    await inputs.capabilities({ runner: 'codex', guide: true, interrupt: true, note: 'Guides apply when the current Codex turn ends, by resuming the same thread; interrupts stop the turn and resume with the message.' });
    inputs.onInput(input => {
      if (finished || fatal) return inputs.ack(input.id, 'rejected', 'Codex run already finished');
      if (input.mode === 'guide') { guides.push(input); emit('system', { text: 'Guide queued; it is applied when the current Codex turn ends' }); return; }
      if (!session) return inputs.ack(input.id, 'rejected', 'Codex has not reported a resumable thread yet; send a guide instead or retry shortly');
      if (interrupt) return inputs.ack(input.id, 'rejected', 'Another interrupt is already being applied');
      interrupt = input;
      emit('system', { text: 'Interrupt received; stopping the current Codex turn' });
      current?.interrupt();
    });
  }
  async function segment(text, resume) {
    const index = ++segmentIndex, prefix = index > 1 ? `s${index}:` : '', mapState = {};
    const invocation = runnerInvocation(options, codexArgs({ config, options, metadata, sandbox, cwd, schemaFile, outputFile, resume, ephemeral: !inputs }));
    const supervisedArgs = [join(import.meta.dirname, 'supervisor.mjs'), String(process.pid), ownerIdentity, String(deadline), invocation.executable, ...invocation.args];
    const child = spawn(process.execPath, supervisedArgs, { cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment });
    // Attach all process listeners before awaiting persistent journal I/O.
    let buffered = '', stderr = '', stopReason, interrupted = false, bytes = 0, forceTimer;
    const state = {
      stop(reason) {
        if (stopReason) return;
        stopReason = reason;
        if (child.pid) { killGroup(child.pid, 'SIGTERM'); forceTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 2000); }
      },
      interrupt() { if (!stopReason) { interrupted = true; state.stop('Interrupted by owner'); } },
    };
    current = state;
    if (fatal) state.stop(fatal.message);
    const closed = new Promise((accept, reject) => { child.once('error', reject); child.once('close', code => accept(code)); });
    closed.catch(() => {});
    function line(raw) {
      if (!raw.trim()) return;
      let value;
      try { value = JSON.parse(raw); } catch { fail(Error('Codex emitted invalid JSONL')); return; }
      for (const [kind, body, opts] of mapCodexEvent(value, mapState, prefix)) emit(kind, body, opts);
      if (value.type === 'thread.started') session = value.thread_id;
      if ((value.type === 'turn.failed' || value.type === 'error') && !interrupted) fail(Error(redact(value.error?.message || value.message || 'Codex model request failed', config)));
      if (value.type === 'item.completed' && value.item?.type === 'command_execution') {
        const item = value.item;
        if (TEST_COMMAND.test(item.command || '') && Number.isInteger(item.exit_code) && !commands.has(prefix + item.id)) {
          commands.add(prefix + item.id);
          receipts.push({ command: redact(item.command, config), exitCode: item.exit_code, output: redact(item.aggregated_output ?? '', config, 20000) });
          notify('checking', `Test command finished (${item.exit_code}): ${item.command}`);
        }
      }
    }
    child.stdout.on('data', data => {
      bytes += data.length;
      if (bytes > 8 * 1024 * 1024) { fail(Error('Codex output exceeds the limit')); return; }
      buffered += data.toString();
      let boundary;
      while ((boundary = buffered.indexOf('\n')) !== -1) { line(buffered.slice(0, boundary)); buffered = buffered.slice(boundary + 1); }
    });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-12000); });
    try {
      const identity = await processIdentity(child.pid);
      if (child.pid && identity) await started({ pid: child.pid, processIdentity: identity });
      child.stdin.on('error', () => {});
      child.stdin.end(text);
      const code = await closed;
      // Dispose of background descendants whose stdio was redirected before returning evidence.
      killGroup(child.pid, 'SIGTERM');
      await new Promise(accept => setTimeout(accept, 50));
      killGroup(child.pid, 'SIGKILL');
      if (buffered.trim()) line(buffered);
      await eventQueue;
      if ((code !== 0 || fatal) && !interrupted && stderr.trim()) emit('system', { text: `Codex stderr (tail):\n${stderr.trim().slice(-4000)}` });
      if (fatal) throw fatal;
      if (interrupted) return { interrupted: true };
      if (stopReason) throw Error(stopReason);
      if (code !== 0) throw Error(`Codex failed (${code}): ${redact(stderr.trim() || 'No diagnostic output', config)}`);
      return { interrupted: false };
    } catch (error) {
      state.stop(redact(error, config));
      await closed.catch(() => {});
      throw error;
    } finally { clearTimeout(forceTimer); current = null; }
  }
  const take = (items, mode) => (mode === 'interrupt' ? 'The owner interrupted the previous turn. Follow this instruction, then continue the same approved Ticket:\n' : 'Owner guidance for this Run (continue the same approved Ticket):\n') + items.map(input => input.text).join('\n\n');
  try {
    let text = prompt, resume = null, applying = [];
    while (true) {
      if (interrupt && resume) { applying.push(interrupt); text += `\n\nThe owner also sent this instruction:\n${interrupt.text}`; interrupt = null; }
      const pendingAck = applying;
      applying = [];
      await rm(outputFile, { force: true });
      const running = segment(text, resume);
      // The continuation started in the same worktree, so its inputs are now applied.
      for (const input of pendingAck) inputs?.ack(input.id, 'applied');
      const outcome = await running;
      // An interrupt that arrives as the turn ends normally is applied the same way.
      if (outcome.interrupted || interrupt) {
        if (!session) throw Error('Codex interrupted before reporting a resumable thread');
        applying = [interrupt, ...guides.splice(0)]; interrupt = null;
        text = take(applying, 'interrupt'); resume = session;
        continue;
      }
      if (guides.length && session) {
        applying = guides.splice(0);
        text = take(applying, 'guide'); resume = session;
        continue;
      }
      finished = true;
      for (const input of guides.splice(0)) inputs?.ack(input.id, 'rejected', 'Codex reported no resumable thread for this guide');
      let result;
      try { result = JSON.parse(await readFile(outputFile, 'utf8')); } catch { throw Error('Codex did not produce valid schema output'); }
      return { result, tests: receipts, agentSession: session };
    }
  } finally {
    finished = true;
    clearTimeout(timer); signal.removeEventListener('abort', abort);
  }
}
