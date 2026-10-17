import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const VERSION = '1.0.0';
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const RUNTIME_FILES = ['package.json', 'cli.mjs', 'common.mjs', 'codex-config.mjs', 'mcp.mjs', 'agent.mjs', 'runner.mjs', 'supervisor.mjs', 'schemas.mjs', 'api-runner.mjs', 'claude-runner.mjs', 'transcript.mjs', 'README.md'];
export function checkNode() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && (minor < 23 || (minor === 23 && patch < 3)))) throw Error('Node.js 22.23.3 or newer is required');
}
export function serviceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('A valid service URL is required'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Service URL must be an origin without credentials, path, query or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('Use HTTPS, or HTTP on loopback');
  return url.origin;
}
export function configPath(options) {
  return resolve(options.config || resolve(options.workspace || process.cwd(), '.agent-task-hub/connection.json'));
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
export async function privateJson(path, value) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
export async function loadConfig(path) {
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); } catch { throw Error('Connection configuration is missing or invalid; run install first'); }
  if (!config.token || !config.connectionId || !config.workspace || !config.runtime || !config.installationId) throw Error('Incomplete connection configuration');
  config.url = serviceUrl(config.url);
  return config;
}
export function redact(value, config, limit = 1800) {
  let text = String(value?.message ?? value ?? 'Request failed');
  for (const secret of [config?.token, config?.workspace, config?.file, process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY, ...(config?.runtimeSecrets || [])]) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_*.-]+/g, '[redacted key]').slice(0, limit);
}
export async function request(config, path, body, { signal, timeoutMs = 10000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(config.url + path, {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'content-type': 'application/json', ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
    body: JSON.stringify(body),
  });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let raw = '', bytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw Error('Service response exceeds the limit');
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof TypeError && error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw Error('Service returned invalid UTF-8');
      throw error;
    } finally { reader.releaseLock(); }
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw Error(`Service returned invalid JSON (${response.status})`); }
  if (!response.ok) {
    const error = Error(redact(value.error?.message || value.error || `Service request failed (${response.status})`, config));
    error.status = response.status;
    if (typeof value.error?.code === 'string') error.code = value.error.code;
    else if (typeof value.code === 'string') error.code = value.code;
    throw error;
  }
  return value;
}
let requestId = 0;
export async function tool(config, name, args = {}, signal) {
  const response = await request(config, '/api/connector/mcp', { jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: args } }, { signal });
  if (response.error) throw Error(redact(response.error.message, config));
  if (response.result?.isError) {
    const error = Error(redact(response.result.content?.[0]?.text || 'Tool failed', config));
    error.toolError = true;
    throw error;
  }
  if (response.result?.structuredContent) return response.result.structuredContent;
  try { return JSON.parse(response.result.content.find(item => item.type === 'text').text); } catch { throw Error('Tool returned no structured result'); }
}
export function command(executable, args, { cwd, timeoutMs = 10000, env } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 1048576) child.kill('SIGKILL'); });
    child.stderr.on('data', data => { stderr += data; if (stderr.length > 1048576) child.kill('SIGKILL'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); accept({ code, stdout, stderr }); });
  });
}
export async function git(workspace, args) {
  const result = await command('git', ['-C', workspace, ...args]);
  if (result.code !== 0) throw Error(`Git operation failed: ${result.stderr.trim().slice(0, 1000)}`);
  return result.stdout;
}
export async function heartbeat(config, mode, agentReady = false, error) {
  const runtime = config.runtimeSelection;
  return request(config, '/api/connector/heartbeat', { mode, version: VERSION, agentReady,
    ...(runtime ? { runtime: Object.fromEntries(['profile', 'model', 'provider', 'access'].map(name => [name, typeof runtime[name] === 'string' ? runtime[name] : null])) } : {}),
    ...(error ? { error: redact(error, config) } : {}) });
}
