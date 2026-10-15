import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { command, privateDirectory, redact } from './common.mjs';
import { TEST_COMMAND } from './api-runner.mjs';
import { processIdentity } from './runner.mjs';

// Claude Code CLI access: `claude -p` with stream-json events and --json-schema
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
function exitCode(result) {
  if (!result.is_error) return 0;
  const text = typeof result.content === 'string' ? result.content : (result.content || []).map(part => part.text || '').join('');
  const match = /^Exit code (\d+)/.exec(text);
  return match ? Number(match[1]) : 1;
}
function resultText(content) { return typeof content === 'string' ? content : (content || []).map(part => part.text || '').join(''); }

export async function runClaude({ config, options, cwd, directory, schema, prompt, sandbox, timeoutMs, signal, started, event }) {
  await privateDirectory(directory);
  const mcp = { mcpServers: { agent_task_hub: { command: process.execPath, args: [config.runtime, 'mcp', '--config', config.file], cwd: config.workspace } } };
  const mcpFile = join(directory, 'mcp.json');
  await writeFile(mcpFile, JSON.stringify(mcp), { mode: 0o600 });
  const hubTools = READ_TOOLS.map(name => `mcp__agent_task_hub__${name}`);
  const writable = sandbox === 'workspace-write';
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--json-schema', JSON.stringify(schema),
    '--strict-mcp-config', '--mcp-config', mcpFile, '--allowedTools', ...hubTools];
  if (writable) args.push('--permission-mode', 'bypassPermissions', '--disallowedTools', 'Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git config:*)', 'Bash(npm publish:*)', 'WebFetch', 'WebSearch');
  else args.push('--permission-mode', 'dontAsk', '--tools', 'Read', 'Grep', 'Glob', '--allowedTools', 'Read', 'Grep', 'Glob');
  if (options.model) args.push('--model', options.model);
  if (options.reasoning && EFFORT[options.reasoning]) args.push('--effort', EFFORT[options.reasoning]);
  const ownerIdentity = await processIdentity(process.pid);
  const child = spawn(process.execPath, [join(import.meta.dirname, 'supervisor.mjs'), String(process.pid), ownerIdentity, String(Date.now() + timeoutMs), claudeExecutable(options), ...args],
    { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: claudeEnvironment() });
  let buffered = '', stderr = '', session, failure, stopReason, bytes = 0, final, forceTimer;
  const pendingCommands = new Map(), receipts = [];
  let eventQueue = Promise.resolve();
  const notify = (stage, message) => { eventQueue = eventQueue.then(() => event?.(stage, redact(message, config))).catch(error => { failure ||= error; stop(`Event delivery failed: ${redact(error, config)}`); }); };
  function stop(reason) {
    if (stopReason) return;
    stopReason = reason;
    if (child.pid) { killGroup(child.pid, 'SIGTERM'); forceTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 2000); }
  }
  const abort = () => stop(String(signal.reason?.message || signal.reason || 'Run cancelled'));
  const timer = setTimeout(() => stop('Claude execution timed out'), timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const closed = new Promise((accept, reject) => { child.once('error', reject); child.once('close', code => accept(code)); });
  closed.catch(() => {});
  const transcript = join(directory, 'claude-events.jsonl');
  await writeFile(transcript, '', { mode: 0o600 });
  function line(raw) {
    if (!raw.trim()) return;
    let value;
    try { value = JSON.parse(raw); } catch { return; }
    writeFile(transcript, redact(raw, config, 20000) + '\n', { flag: 'a' }).catch(() => {});
    if (value.type === 'system' && value.subtype === 'init') session = value.session_id;
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
    if (value.type === 'result') final = value;
  }
  child.stdout.on('data', data => {
    bytes += data.length;
    if (bytes > 32 * 1024 * 1024) { failure ||= Error('Claude output exceeds the limit'); stop(failure.message); return; }
    buffered += data.toString();
    let boundary;
    while ((boundary = buffered.indexOf('\n')) !== -1) { line(buffered.slice(0, boundary)); buffered = buffered.slice(boundary + 1); }
  });
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-12000); });
  try {
    const identity = await processIdentity(child.pid);
    if (child.pid && identity) await started?.({ pid: child.pid, processIdentity: identity });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const code = await closed;
    killGroup(child.pid, 'SIGTERM');
    await new Promise(accept => setTimeout(accept, 50));
    killGroup(child.pid, 'SIGKILL');
    if (buffered.trim()) line(buffered);
    await eventQueue;
    if (stopReason || failure) throw failure || Error(stopReason);
    if (!final) throw Error(`Claude failed (${code}): ${redact(stderr.trim() || 'No result event', config)}`);
    if (final.is_error || final.subtype !== 'success') throw Error(redact(`Claude run ended with ${final.subtype}: ${final.result || (final.errors || []).join('; ') || 'no detail'}`, config));
    const result = final.structured_output;
    if (!result || typeof result !== 'object') throw Error('Claude did not produce valid schema output');
    await writeFile(join(directory, 'result.json'), JSON.stringify(result), { mode: 0o600 });
    return { result, tests: receipts, agentSession: session };
  } catch (error) {
    stop(redact(error, config));
    await closed.catch(() => {});
    throw error;
  } finally { clearTimeout(timer); clearTimeout(forceTimer); signal.removeEventListener('abort', abort); }
}
