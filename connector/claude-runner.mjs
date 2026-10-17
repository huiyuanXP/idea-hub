import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { command, privateDirectory, redact } from './common.mjs';
import { TEST_COMMAND } from './api-runner.mjs';
import { processIdentity } from './runner.mjs';

// Claude Code CLI access: `claude -p` with stream-json input/output and --json-schema
// structured output. Authentication stays in the machine's Claude login.
const READ_TOOLS = ['get_idea', 'get_ticket', 'get_plan', 'list_tickets', 'list_plans'];
const EFFORT = { none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' };

export function claudeExecutable(options) { return options.claude || 'claude'; }
// A nested Claude process must not inherit the parent session's control variables.
export function claudeEnvironment() {
  const env = { ...process.env, NO_COLOR: '1', PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}` };
  for (const name of Object.keys(env)) if (name === 'CLAUDECODE' || name === 'CLAUDE_PID' || name === 'CLAUDE_EFFORT' || name.startsWith('CLAUDE_CODE_')) delete env[name];
  return env;
}
export async function claudeReadiness(options, workspace) {
  try {
    const result = await command(claudeExecutable(options), ['auth', 'status'], { cwd: workspace, env: claudeEnvironment(), timeoutMs: 15000 });
    let status; try { status = JSON.parse(result.stdout); } catch { status = null; }
    if (result.code === 0 && status?.loggedIn) return { ready: true, authMode: 'claude' };
    return { ready: false, error: 'Claude Code is not logged in; run claude auth login on this machine' };
  } catch (error) { return { ready: false, error: error.code === 'ENOENT' ? 'Claude Code CLI is missing; install it and log in' : 'Claude Code authentication check failed' }; }
}
function killGroup(pid, signal) { try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
export function exitCode(result) {
  if (!result.is_error) return 0;
  const text = typeof result.content === 'string' ? result.content : (result.content || []).map(part => part.text || '').join('');
  const match = /^Exit code (\d+)/.exec(text);
  return match ? Number(match[1]) : 1;
}
function resultText(content) { return typeof content === 'string' ? content : (content || []).map(part => part.text || '').join(''); }
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const inputText = input => typeof input === 'string' ? input : JSON.stringify(input ?? {});
// Map one Claude Code stream-json event to transcript entries [kind, body, { stepId }].
// `state.tools` remembers tool_use ids so results are attributed to their call.
export function mapClaudeEvent(value, state = {}) {
  state.tools ||= new Map();
  const out = [], content = Array.isArray(value?.message?.content) ? value.message.content : [];
  if (value?.type === 'system') {
    if (value.subtype === 'init') out.push(['system', { text: `Claude Code session started${value.model ? ` (${value.model})` : ''}` }, {}]);
    else out.push(['system', { text: `Claude system event: ${value.subtype || 'unknown'}` }, {}]);
  } else if (value?.type === 'assistant') {
    for (const part of content) {
      if (part.type === 'text' && part.text) out.push(['message', { text: part.text }, {}]);
      else if (part.type === 'thinking' && part.thinking) out.push(['reasoning', { text: part.thinking }, {}]);
      else if (part.type === 'tool_use') {
        const stepId = part.id ?? null, opts = { stepId };
        state.tools.set(part.id, { name: part.name, command: part.input?.command });
        if (part.name === 'Bash') out.push(['command_start', { command: String(part.input?.command ?? '') }, opts]);
        else {
          out.push(['tool_call', { name: String(part.name ?? 'tool'), input: inputText(part.input) }, opts]);
          const path = part.input?.file_path ?? part.input?.notebook_path;
          if (FILE_TOOLS.has(part.name) && path) out.push(['file_change', { changes: [{ path: String(path), kind: 'update' }] }, opts]);
        }
      }
    }
  } else if (value?.type === 'user') {
    for (const part of content) if (part.type === 'tool_result') {
      const tool = state.tools.get(part.tool_use_id), opts = { stepId: part.tool_use_id ?? null };
      state.tools.delete(part.tool_use_id);
      if (tool?.name === 'Bash') out.push(['command_output', { command: String(tool.command ?? ''), output: resultText(part.content), exitCode: exitCode(part) }, opts]);
      else out.push(['tool_result', { ...(tool?.name ? { name: tool.name } : {}), output: resultText(part.content), isError: Boolean(part.is_error) }, opts]);
    }
  } else if (value?.type === 'result') {
    if (value.is_error || (value.subtype && value.subtype !== 'success')) out.push(['error', { message: `Claude turn ended with ${value.subtype || 'error'}: ${value.result || (value.errors || []).join('; ') || 'no detail'}` }, {}]);
    out.push(['result', { ...(typeof value.result === 'string' ? { text: value.result } : {}), ...(value.usage ? { usage: value.usage } : {}) }, {}]);
  } else if (value?.type !== 'stream_event') out.push(['system', { text: `Claude event ${value?.type || 'unknown'}` }, {}]);
  return out;
}
export const userMessage = text => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';

// The run is one or more segments of a stream-json `claude -p` process whose stdin
// stays open: guides are written as further user messages, an interrupt stops the
// process group and continues the same session with --resume.
export async function runClaude({ config, options, cwd, directory, schema, prompt, sandbox, timeoutMs, signal, started, event, transcript, inputs }) {
  await privateDirectory(directory);
  const mcp = { mcpServers: { agent_task_hub: { command: process.execPath, args: [config.runtime, 'mcp', '--config', config.file], cwd: config.workspace } } };
  const mcpFile = join(directory, 'mcp.json');
  await writeFile(mcpFile, JSON.stringify(mcp), { mode: 0o600 });
  const hubTools = READ_TOOLS.map(name => `mcp__agent_task_hub__${name}`);
  const writable = sandbox === 'workspace-write';
  const baseArgs = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema),
    '--strict-mcp-config', '--mcp-config', mcpFile, '--allowedTools', ...hubTools];
  if (writable) baseArgs.push('--permission-mode', 'bypassPermissions', '--disallowedTools', 'Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git config:*)', 'Bash(npm publish:*)', 'WebFetch', 'WebSearch');
  else baseArgs.push('--permission-mode', 'dontAsk', '--tools', 'Read', 'Grep', 'Glob', '--allowedTools', 'Read', 'Grep', 'Glob');
  if (options.model) baseArgs.push('--model', options.model);
  if (options.reasoning && EFFORT[options.reasoning]) baseArgs.push('--effort', EFFORT[options.reasoning]);
  const ownerIdentity = await processIdentity(process.pid);
  const deadline = Date.now() + timeoutMs;
  const eventsFile = join(directory, 'claude-events.jsonl');
  await writeFile(eventsFile, '', { mode: 0o600 });
  const receipts = [], pendingCommands = new Map();
  let session, fatal, final, current = null, interrupt = null, finished = false;
  let eventQueue = Promise.resolve();
  const emit = (kind, body, opts) => transcript?.emit(kind, body, opts);
  const notify = (stage, message) => { eventQueue = eventQueue.then(() => event?.(stage, redact(message, config))).catch(error => fail(error)); };
  function fail(error) { fatal ||= error; current?.stop(error.message); }
  const abort = () => fail(Error(String(signal.reason?.message || signal.reason || 'Run cancelled')));
  const timer = setTimeout(() => fail(Error('Claude execution timed out')), timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  if (inputs) {
    await inputs.capabilities({ runner: 'claude', guide: true, interrupt: true, note: 'Guides are sent to the running Claude Code session as user messages; interrupts stop it and resume the same session.' });
    inputs.onInput(input => {
      if (finished || fatal) return inputs.ack(input.id, 'rejected', 'Claude run already finished');
      if (input.mode === 'guide') {
        if (!current?.write(userMessage(`Owner guidance for this Run (continue the same approved Ticket):\n${input.text}`))) return inputs.ack(input.id, 'rejected', 'Claude Code input is closed for this turn');
        return inputs.ack(input.id, 'applied');
      }
      if (!session) return inputs.ack(input.id, 'rejected', 'Claude Code has not reported a resumable session yet; send a guide instead');
      if (interrupt) return inputs.ack(input.id, 'rejected', 'Another interrupt is already being applied');
      interrupt = input;
      emit('system', { text: 'Interrupt received; stopping the current Claude Code turn' });
      current?.interrupt();
    });
  }
  async function segment(text, resume) {
    const args = resume ? [...baseArgs, '--resume', resume] : baseArgs;
    const child = spawn(process.execPath, [join(import.meta.dirname, 'supervisor.mjs'), String(process.pid), ownerIdentity, String(deadline), claudeExecutable(options), ...args],
      { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: claudeEnvironment() });
    let buffered = '', stderr = '', stopReason, interrupted = false, bytes = 0, forceTimer, idleTimer, outstanding = 1, open = true;
    const mapState = {};
    const close = () => { if (open) { open = false; clearTimeout(idleTimer); child.stdin.end(); } };
    const state = {
      write(line) { if (!open || stopReason) return false; outstanding++; child.stdin.write(line); return true; },
      stop(reason) {
        if (stopReason) return;
        stopReason = reason; open = false; clearTimeout(idleTimer);
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
      try { value = JSON.parse(raw); } catch { return; }
      writeFile(eventsFile, redact(raw, config, 20000) + '\n', { flag: 'a' }).catch(() => {});
      for (const [kind, body, opts] of mapClaudeEvent(value, mapState)) emit(kind, body, opts);
      if (value.type === 'system' && value.subtype === 'init' && value.session_id) session = value.session_id;
      const content = Array.isArray(value.message?.content) ? value.message.content : [];
      if (value.type === 'assistant') {
        for (const part of content) if (part.type === 'tool_use' && part.name === 'Bash' && typeof part.input?.command === 'string') {
          pendingCommands.set(part.id, part.input.command);
          if (writable) notify('agent', `Command started: ${redact(part.input.command, config, 300)}`);
        }
      }
      if (value.type === 'user') {
        for (const part of content) if (part.type === 'tool_result' && pendingCommands.has(part.tool_use_id)) {
          const commandLine = pendingCommands.get(part.tool_use_id);
          pendingCommands.delete(part.tool_use_id);
          if (TEST_COMMAND.test(commandLine)) {
            const code = exitCode(part);
            receipts.push({ command: redact(commandLine, config), exitCode: code, output: redact(resultText(part.content), config, 20000) });
            notify('checking', `Test command finished (${code}): ${commandLine}`);
          }
        }
      }
      clearTimeout(idleTimer);
      if (value.type === 'result') {
        final = value;
        // Each user message yields a turn; finish once no written guide is outstanding.
        // Claude may merge queued messages into one turn, so idle output also ends it.
        outstanding = Math.max(0, outstanding - 1);
        if (!outstanding) close();
        else idleTimer = setTimeout(close, 30000);
      }
    }
    child.stdout.on('data', data => {
      bytes += data.length;
      if (bytes > 32 * 1024 * 1024) { fail(Error('Claude output exceeds the limit')); return; }
      buffered += data.toString();
      let boundary;
      while ((boundary = buffered.indexOf('\n')) !== -1) { line(buffered.slice(0, boundary)); buffered = buffered.slice(boundary + 1); }
    });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-12000); });
    try {
      const identity = await processIdentity(child.pid);
      if (child.pid && identity) await started?.({ pid: child.pid, processIdentity: identity });
      child.stdin.on('error', () => {});
      child.stdin.write(userMessage(text));
      const code = await closed;
      open = false; clearTimeout(idleTimer);
      killGroup(child.pid, 'SIGTERM');
      await new Promise(accept => setTimeout(accept, 50));
      killGroup(child.pid, 'SIGKILL');
      if (buffered.trim()) line(buffered);
      await eventQueue;
      if ((code !== 0 || fatal) && !interrupted && stderr.trim()) emit('system', { text: `Claude stderr (tail):\n${stderr.trim().slice(-4000)}` });
      if (fatal) throw fatal;
      if (interrupted) return { interrupted: true };
      if (stopReason) throw Error(stopReason);
      if (!final) throw Error(`Claude failed (${code}): ${redact(stderr.trim() || 'No result event', config)}`);
      return { interrupted: false };
    } catch (error) {
      state.stop(redact(error, config));
      await closed.catch(() => {});
      throw error;
    } finally { clearTimeout(forceTimer); clearTimeout(idleTimer); current = null; }
  }
  try {
    let text = prompt, resume = null, applying = null;
    while (true) {
      final = null;
      const running = segment(text, resume);
      if (applying) inputs?.ack(applying.id, 'applied');
      applying = null;
      const outcome = await running;
      if (outcome.interrupted || interrupt) {
        if (!session) throw Error('Claude Code interrupted before reporting a resumable session');
        applying = interrupt; interrupt = null;
        text = `The owner interrupted the previous turn. Follow this instruction, then continue the same approved Ticket:\n${applying.text}`; resume = session;
        continue;
      }
      break;
    }
    finished = true;
    if (final.is_error || final.subtype !== 'success') throw Error(redact(`Claude run ended with ${final.subtype}: ${final.result || (final.errors || []).join('; ') || 'no detail'}`, config));
    const result = final.structured_output;
    if (!result || typeof result !== 'object') throw Error('Claude did not produce valid schema output');
    await writeFile(join(directory, 'result.json'), JSON.stringify(result), { mode: 0o600 });
    return { result, tests: receipts, agentSession: session };
  } finally { finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
