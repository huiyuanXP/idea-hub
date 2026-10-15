#!/usr/bin/env node
import { copyFile, access, mkdir, readFile, realpath, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkNode, configPath, git, heartbeat, loadConfig, privateDirectory, privateJson, request, RUNTIME_FILES, serviceUrl, VERSION } from './common.mjs';
import { serveMcp } from './mcp.mjs';
import { runAgent, codexReadiness } from './agent.mjs';
import { codexMetadata, selectedCodexOptions } from './codex-config.mjs';
import { apiBaseUrl } from './api-runner.mjs';

const begin = '# BEGIN agent-task-hub connector';
const end = '# END agent-task-hub connector';
const booleanOptions = new Set(['code-stdin', 'once', 'help']);
const valueOptions = new Set(['url', 'workspace', 'config', 'name', 'codex', 'test-runner', 'claude', 'profile', 'model', 'reasoning', 'access', 'api-base-url', 'api-key-env', 'api-model', 'api-profile']);
function optionsFor(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || (!booleanOptions.has(name) && !valueOptions.has(name))) throw Error(`Unknown option: ${args[index]}`);
    if (booleanOptions.has(name)) options[name] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error(`Missing --${name} value`);
      options[name] = args[++index];
    }
  }
  if (options.profile && !/^[A-Za-z0-9_-]+$/.test(options.profile)) throw Error('--profile must be a name without path separators');
  if (options.model && (!/^[A-Za-z0-9._:/-]+$/.test(options.model) || options.model.length > 120)) throw Error('--model must be a model name (up to 120 characters)');
  if (options.reasoning && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(options.reasoning)) throw Error('--reasoning must be none, minimal, low, medium, high or xhigh');
  if (options.access && !['codex', 'api', 'claude'].includes(options.access)) throw Error('--access must be codex, api or claude');
  if (options['api-base-url']) options['api-base-url'] = apiBaseUrl(options['api-base-url']);
  if (options['api-key-env'] && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options['api-key-env'])) throw Error('--api-key-env must name an environment variable, not contain the key');
  if (options['api-model'] && (!/^[A-Za-z0-9._:/-]+$/.test(options['api-model']) || options['api-model'].length > 120)) throw Error('--api-model must be a model name (up to 120 characters)');
  if (options['api-profile'] && !/^[A-Za-z0-9_-]+$/.test(options['api-profile'])) throw Error('--api-profile must be a name without path separators');
  return options;
}
// Only the key's environment variable name is saved; the key itself never is.
async function persistAccessOptions(config, options) {
  const api = Object.fromEntries([['baseUrl', 'api-base-url'], ['keyEnv', 'api-key-env'], ['model', 'api-model'], ['profile', 'api-profile']].filter(([, flag]) => options[flag] !== undefined).map(([name, flag]) => [name, options[flag]]));
  if (!options.access && !Object.keys(api).length) return;
  if (options.access) config.access = options.access === 'codex' ? undefined : options.access;
  if (Object.keys(api).length) { config.api = { ...(config.api || {}), ...api }; if (!options.access) config.access = 'api'; }
  if (options.reasoning && config.access === 'api') config.api = { ...config.api, reasoning: options.reasoning };
  await privateJson(config.file, config);
}
async function persistCodexOptions(config, options) {
  if (options.claude) { config.claude = { executable: options.claude }; await privateJson(config.file, config); }
  const selected = Object.fromEntries(['profile', 'model', 'reasoning'].filter(name => options[name] !== undefined).map(name => [name, options[name]]));
  if (!Object.keys(selected).length) return;
  if (selected.profile) await codexMetadata(selectedCodexOptions(config, options), config.workspace);
  config.codex = { ...(config.codex || {}), ...selected };
  await privateJson(config.file, config);
}
async function invitation(options) {
  if (options['code-stdin']) {
    let value = '';
    for await (const chunk of process.stdin) {
      value += chunk;
      if (value.length > 512) throw Error('Invitation code exceeds the limit');
    }
    if (!value.trim()) throw Error('Invitation code is empty');
    return value.trim();
  }
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw Error('Use --code-stdin when no interactive terminal is available');
  process.stderr.write('Invitation code (hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((accept, reject) => {
    let code = '';
    const finish = error => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', handle);
      process.stderr.write('\n');
      if (error) reject(error); else accept(code.trim());
    };
    const handle = buffer => {
      for (const character of buffer.toString()) {
        if (character === '\u0003') return finish(Error('Installation cancelled'));
        if (character === '\r' || character === '\n') return finish(code.trim() ? undefined : Error('Invitation code is empty'));
        if (character === '\u007f' || character === '\b') code = code.slice(0, -1);
        else code += character;
        if (code.length > 512) return finish(Error('Invitation code exceeds the limit'));
      }
    };
    process.stdin.on('data', handle);
  });
}
async function clientConfig(config, remove = false) {
  const directory = join(config.workspace, '.codex');
  const file = join(directory, 'config.toml');
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (text.includes(begin)) {
    const start = text.indexOf(begin), stop = text.indexOf(end, start);
    if (stop < 0) throw Error('Incomplete managed MCP configuration block; preserve it and repair manually');
    text = text.slice(0, start) + text.slice(stop + end.length).replace(/^\r?\n/, '');
  } else if (!remove && /^\s*\[mcp_servers\.agent_task_hub(?:\]|\.)/m.test(text)) throw Error('An existing agent_task_hub MCP entry is not managed by this installer');
  if (!remove) {
    if (text && !text.endsWith('\n')) text += '\n';
    text += `${begin}\n[mcp_servers.agent_task_hub]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([config.runtime, 'mcp', '--config', config.file])}\ncwd = ${JSON.stringify(config.workspace)}\nstartup_timeout_sec = 15\ntool_timeout_sec = 30\n${end}\n`;
    await mkdir(directory, { recursive: true });
  }
  if (text || !remove) await writeFile(file, text, { mode: 0o600 });
  else await rm(file, { force: true });
}
async function excludePrivate(workspace) {
  const relative = (await git(workspace, ['rev-parse', '--git-path', 'info/exclude'])).trim();
  const file = resolve(workspace, relative);
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!text.split('\n').includes('/.agent-task-hub/')) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text + (text && !text.endsWith('\n') ? '\n' : '') + '/.agent-task-hub/\n');
  }
}
function instructions(config) {
  process.stdout.write(`Connected: ${config.connectionId} (${config.project})\nMCP: ${JSON.stringify({ command: process.execPath, args: [config.runtime, 'mcp', '--config', config.file], cwd: config.workspace })}\nAgent: ${[process.execPath, config.runtime, 'agent', '--config', config.file].map(value => JSON.stringify(value)).join(' ')}\nCodex reads project .codex/config.toml after you trust this project.\n`);
}
async function installRuntime(directory) {
  const runtimeDirectory = join(directory, 'runtime', VERSION);
  await privateDirectory(directory);
  await privateDirectory(runtimeDirectory);
  if (await realpath(import.meta.dirname) !== await realpath(runtimeDirectory)) {
    for (const name of RUNTIME_FILES) {
      const target = join(runtimeDirectory, name), temporary = `${target}.${randomUUID()}.tmp`;
      await copyFile(join(import.meta.dirname, name), temporary);
      await chmod(temporary, 0o600);
      await rename(temporary, target);
    }
  }
  return join(runtimeDirectory, 'cli.mjs');
}
async function install(options) {
  const workspace = await realpath(resolve(options.workspace || process.cwd()));
  const root = await realpath((await git(workspace, ['rev-parse', '--show-toplevel'])).trim());
  if (workspace !== root) throw Error('--workspace must identify the Git repository root');
  const file = configPath({ ...options, workspace });
  try {
    await access(file);
    const existing = await loadConfig(file);
    if (existing.workspace !== workspace) throw Error('Existing connection belongs to another workspace');
    await heartbeat(existing, 'mcp');
    existing.runtime = await installRuntime(dirname(file));
    existing.version = VERSION;
    await persistCodexOptions(existing, options);
    await persistAccessOptions(existing, options);
    await privateJson(file, existing);
    await clientConfig(existing);
    instructions(existing);
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const url = serviceUrl(options.url);
  // Validate the target before consuming a single-use invitation.
  const clientFile = join(workspace, '.codex/config.toml');
  const clientText = await readFile(clientFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  if (clientText.includes(begin) || /^\s*\[mcp_servers\.agent_task_hub(?:\]|\.)/m.test(clientText)) throw Error('Existing agent_task_hub MCP configuration must be resolved before installing');
  const enrollment = await request({ url }, '/api/connector/enroll', { code: await invitation(options), name: (options.name || basename(workspace)).slice(0, 120), version: VERSION, workspace: basename(workspace).slice(0, 120) });
  if (!enrollment.token || !enrollment.connection?.id) throw Error('Enrollment returned incomplete connection credentials');
  const directory = dirname(file);
  const runtime = await installRuntime(directory);
  const config = { version: VERSION, installationId: randomUUID(), connectionId: enrollment.connection.id, projectId: enrollment.connection.projectId, project: enrollment.connection.project, capabilities: enrollment.connection.capabilities || [], token: enrollment.token, url, workspace, file, runtime };
  await persistCodexOptions(config, options);
  await persistAccessOptions(config, options);
  await privateJson(file, config);
  await excludePrivate(workspace);
  await clientConfig(config);
  await heartbeat(config, 'mcp');
  instructions(config);
}
async function main() {
  checkNode();
  const subcommand = process.argv[2] || 'help';
  const options = optionsFor(process.argv.slice(3));
  if (subcommand === 'help' || options.help) {
    process.stdout.write('agent-task-hub: install | doctor | mcp | agent | set-url | uninstall\nOptions: --url ORIGIN --workspace GIT_ROOT --config FILE --name NAME --code-stdin\nCodex: --profile NAME|default --model MODEL --reasoning EFFORT (saved locally); omitted values inherit user configuration.\nClaude Code: --access claude [--claude EXECUTABLE] (uses the local claude login; --model/--reasoning apply).\nAPI Call: --access codex|api --api-profile NAME | --api-base-url URL --api-key-env VAR --api-model MODEL (OpenAI-compatible; only the variable name is saved).\nagent: --once --codex EXECUTABLE; --test-runner FILE is synthetic testing only.\n');
    return;
  }
  if (subcommand === 'install') return install(options);
  const file = configPath(options), config = await loadConfig(file);
  if (subcommand === 'mcp') return serveMcp(config);
  if (subcommand === 'agent') {
    await persistCodexOptions(config, options);
    await persistAccessOptions(config, options);
    return runAgent(config, selectedCodexOptions(config, options));
  }
  if (subcommand === 'doctor') {
    await git(config.workspace, ['rev-parse', '--show-toplevel']);
    await persistCodexOptions(config, options);
    await persistAccessOptions(config, options);
    const readiness = await codexReadiness(selectedCodexOptions(config, options), config.workspace, config);
    await heartbeat(config, 'mcp');
    process.stdout.write(`Connection: ${config.connectionId}\nVersion: ${VERSION}\nService: reachable\n${config.access === 'claude' ? `Access: Claude Code CLI model=${config.runtimeSelection.model || 'default'}` : config.access === 'api' ? `Access: API Call (OpenAI-compatible) model=${config.runtimeSelection.model || 'unset'} endpoint=${config.runtimeSelection.provider || 'unset'} key=$${config.runtimeSelection.keyEnv || config.api?.keyEnv || 'unset'}` : `Access: Codex ${config.runtimeSelection.access === 'codex-login' ? 'account login' : 'local configuration'} profile=${config.runtimeSelection.profile || 'default'} model=${config.runtimeSelection.model || 'default'} provider=${config.runtimeSelection.provider || 'default'}`}\nAgent: ${readiness.ready ? 'ready' : readiness.error}\n`);
    return;
  }
  if (subcommand === 'set-url') {
    const candidate = { ...config, url: serviceUrl(options.url) };
    await heartbeat(candidate, 'mcp');
    await privateJson(file, candidate);
    process.stdout.write('Service URL updated; connection identity retained.\n');
    return;
  }
  if (subcommand === 'uninstall') {
    const lock = join(dirname(file), 'agent.lock');
    try {
      const owner = JSON.parse(await readFile(lock, 'utf8'));
      process.kill(owner.pid, 0);
      throw Error('Stop the Agent before uninstalling its local configuration');
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    await clientConfig(config, true);
    await rm(file, { force: true });
    const expectedRuntime = join(dirname(file), 'runtime', VERSION, 'cli.mjs');
    if (config.runtime === expectedRuntime) await rm(dirname(config.runtime), { recursive: true, force: true });
    process.stdout.write('Local credentials and managed MCP entry removed; retained worktree evidence and server history remain available.\n');
    return;
  }
  throw Error(`Unknown subcommand: ${subcommand}`);
}
main().catch(error => { process.stderr.write(`agent-task-hub: ${error.message}\n`); process.exitCode = 1; });
