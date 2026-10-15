import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Read only metadata needed for readiness and scoped MCP overrides. Codex remains
// the authority for TOML validation and merging; no configuration is rewritten.
function metadataToml(source) {
  const values = new Map(), mcp = new Set();
  let offset = 0, section = [];
  function space() { while (offset < source.length && /[ \t\r]/.test(source[offset])) offset++; }
  function quoted() {
    const quote = source[offset], start = offset++;
    if (source.slice(start, start + 3) === quote.repeat(3)) {
      offset = start + 3;
      const end = source.indexOf(quote.repeat(3), offset);
      if (end < 0) throw Error('Unclosed string');
      const value = source.slice(offset, end); offset = end + 3; return value;
    }
    let escaped = false;
    while (offset < source.length) {
      const character = source[offset++];
      if (character === quote && !escaped) {
        const raw = source.slice(start, offset);
        return quote === "'" ? raw.slice(1, -1) : JSON.parse(raw);
      }
      if (quote === '"' && character === '\\' && !escaped) escaped = true;
      else escaped = false;
    }
    throw Error('Unclosed string');
  }
  function key() {
    space();
    if (source[offset] === '"' || source[offset] === "'") return quoted();
    const match = /^[A-Za-z0-9_-]+/.exec(source.slice(offset));
    if (!match) throw Error('Unsupported key');
    offset += match[0].length; return match[0];
  }
  function path() {
    const parts = [key()]; space();
    while (source[offset] === '.') { offset++; parts.push(key()); space(); }
    return parts;
  }
  function value() {
    space();
    if (source[offset] === '"' || source[offset] === "'") return quoted();
    if (source[offset] === '{') {
      offset++; const result = Object.create(null); space();
      while (source[offset] !== '}') {
        const parts = path();
        if (source[offset++] !== '=') throw Error('Invalid inline table');
        const entry = value();
        if (parts.length === 1) result[parts[0]] = entry;
        space(); if (source[offset] !== ',') break; offset++; space();
      }
      if (source[offset++] !== '}') throw Error('Invalid inline table');
      return result;
    }
    if (source[offset] === '[') {
      offset++; const result = [];
      while (offset < source.length) {
        while (/[\s,]/.test(source[offset] || 'x')) offset++;
        if (source[offset] === '#') { while (offset < source.length && source[offset] !== '\n') offset++; continue; }
        if (source[offset] === ']') { offset++; return result; }
        result.push(value());
      }
      throw Error('Invalid array');
    }
    const match = /^[^\s,#\]}]+/.exec(source.slice(offset));
    if (!match) throw Error('Unsupported value');
    offset += match[0].length;
    return match[0] === 'true' ? true : match[0] === 'false' ? false : undefined;
  }
  function record(parts, entry) {
    values.set(JSON.stringify(parts), entry);
    if (parts[0] === 'mcp_servers' && parts.length > 1) mcp.add(parts[1]);
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) for (const [name, nested] of Object.entries(entry)) record([...parts, name], nested);
  }
  while (offset < source.length) {
    space();
    if (source[offset] === '\n') { offset++; continue; }
    if (source[offset] === '#') { while (offset < source.length && source[offset] !== '\n') offset++; continue; }
    try {
      if (source[offset] === '[') {
        offset++; section = path();
        if (source[offset++] !== ']') throw Error('Unsupported table');
        if (section[0] === 'mcp_servers' && section.length > 1) mcp.add(section[1]);
      } else {
        const parts = path();
        if (source[offset++] !== '=') throw Error('Invalid assignment');
        record([...section, ...parts], value());
      }
    } catch { /* Unsupported metadata must never prevent Codex reading its config. */ }
    while (offset < source.length && source[offset] !== '\n') offset++;
  }
  return { values, mcp };
}
export async function codexMetadata(options = {}, workspace = process.cwd()) {
  const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const files = [join(home, 'config.toml')];
  let profileFile;
  if (options.profile && options.profile !== 'default') {
    if (!/^[A-Za-z0-9_-]+$/.test(options.profile)) throw Error('Codex profile must be a name without path separators');
    profileFile = join(home, `${options.profile}.config.toml`);
    files.push(profileFile);
  }
  const ancestors = [];
  for (let directory = resolve(workspace); ; directory = dirname(directory)) {
    ancestors.unshift(join(directory, '.codex/config.toml'));
    if (dirname(directory) === directory) break;
  }
  files.push(...ancestors);
  const values = new Map(), mcp = new Set();
  for (const file of new Set(files)) {
    const source = await readFile(file, 'utf8').catch(error => {
      if (error.code === 'ENOENT' && file !== profileFile) return '';
      if (error.code === 'ENOENT') throw Error(`Codex profile "${options.profile}" is missing; create its NAME.config.toml on this machine`);
      throw error;
    });
    if (source.length > 2 * 1024 * 1024) throw Error('Codex configuration exceeds metadata limit');
    const parsed = metadataToml(source);
    for (const [key, entry] of parsed.values) values.set(key, entry);
    for (const name of parsed.mcp) mcp.add(name);
  }
  const get = (...parts) => values.get(JSON.stringify(parts));
  const provider = get('model_provider') || 'openai';
  const prefix = ['model_providers', provider];
  const envKey = get(...prefix, 'env_key');
  const authKey = get(...prefix, 'experimental_bearer_token');
  const baseUrl = get(...prefix, 'base_url');
  const secrets = [];
  let configuredCredentials = Boolean(typeof envKey === 'string' && process.env[envKey]);
  if (configuredCredentials) secrets.push(process.env[envKey]);
  if (typeof authKey === 'string' && authKey) { secrets.push(authKey); configuredCredentials = true; }
  for (const [rawKey, entry] of values) {
    const parts = JSON.parse(rawKey);
    if (parts.slice(0, 2).join('/') !== prefix.join('/') || parts.length !== 4) continue;
    if (parts[2] === 'http_headers' && typeof entry === 'string' && entry) { secrets.push(entry); configuredCredentials = true; }
    if (parts[2] === 'env_http_headers' && typeof entry === 'string' && process.env[entry]) { secrets.push(process.env[entry]); configuredCredentials = true; }
  }
  const customProvider = provider !== 'openai' || (typeof baseUrl === 'string' && !/^https:\/\/api\.openai\.com(?:\/|$)/.test(baseUrl));
  const requiresOpenaiAuth = get(...prefix, 'requires_openai_auth') === true;
  let persistedAuth = false;
  if (!customProvider || requiresOpenaiAuth) {
    const raw = await readFile(join(home, 'auth.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (raw.length <= 2 * 1024 * 1024) {
      try {
        const auth = JSON.parse(raw);
        persistedAuth = Boolean(auth.OPENAI_API_KEY || auth.tokens?.access_token);
        for (const secret of [auth.OPENAI_API_KEY, auth.tokens?.access_token, auth.tokens?.refresh_token, auth.tokens?.id_token]) if (typeof secret === 'string' && secret) secrets.push(secret);
      } catch { /* Codex reports malformed auth files on the actual invocation. */ }
    }
    for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY']) if (process.env[name]) { secrets.push(process.env[name]); configuredCredentials = true; }
    configuredCredentials ||= persistedAuth;
  }
  // Credential-free local providers may explicitly omit an env key and headers.
  const declaredEnvHeader = [...values.keys()].some(rawKey => {
    const parts = JSON.parse(rawKey);
    return parts[0] === 'model_providers' && parts[1] === provider && parts[2] === 'env_http_headers' && parts.length === 4;
  });
  const credentialFree = customProvider && !envKey && !declaredEnvHeader && !requiresOpenaiAuth;
  return { provider, model: options.model || get('model'), baseUrl: typeof baseUrl === 'string' ? baseUrl : null, envKey: typeof envKey === 'string' ? envKey : null, customProvider, requiresOpenaiAuth, configuredCredentials, persistedAuth, credentialFree, secrets, mcp: [...mcp] };
}
export function selectedCodexOptions(config, options) {
  const selected = { ...options };
  for (const name of ['profile', 'model', 'reasoning']) if (selected[name] === undefined && config.codex?.[name]) selected[name] = config.codex[name];
  if (selected.claude === undefined && config.claude?.executable) selected.claude = config.claude.executable;
  return selected;
}
