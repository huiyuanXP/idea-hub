# Agent Task Hub connector

This standalone package needs Node.js 22.23.3 or newer and Git. It has no npm dependencies. Use the local account's **连接与执行** page to create a single-use, project-scoped invitation, download this archive, then unpack it:

```sh
tar -xzf agent-task-hub-connector.tgz
node /absolute/download/agent-task-hub-connector/cli.mjs install --url https://your-hub.example --workspace /absolute/git/project
```

The installer asks for the invitation without echoing it. For automated installation, pipe the code to the same command with `--code-stdin`; keep the code out of shell history. `--name DISPLAY_NAME` selects the connection's display name. HTTP is accepted only on loopback. `--config /absolute/private/connection.json` selects a different private configuration location.

Installation exchanges the invitation at `/api/connector/enroll`, retains only a project-scoped connector credential, copies this runtime to `.agent-task-hub/runtime/1.0.0/`, and writes a managed entry into project `.codex/config.toml`. Existing unrelated entries are preserved. The output includes an absolute Node command and STDIO arguments usable by any MCP client. Codex loads project configuration after the project is trusted. The downloaded directory can then be removed. Private credentials have mode 0600; private directories have mode 0700. Git's local exclude file excludes `.agent-task-hub/` from commits.

Use the absolute installed CLI path printed by installation:

```sh
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs doctor --workspace /absolute/project
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs agent --workspace /absolute/project
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs set-url --workspace /absolute/project --url https://new-hub.example
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs uninstall --workspace /absolute/project
```

All commands accept `--config FILE`. `doctor` verifies Git, service authentication and local Codex readiness. `set-url` authenticates against the new service before retaining the same connection identity. Repeated installation from a newly downloaded package refreshes the installed runtime and reuses the existing connection without redeeming another invitation. `uninstall` removes local credentials/runtime and only its managed MCP entry; stop the Agent first. Retained worktrees/results and server history remain available. Revoke a connection on the Hub page to invalidate its credential immediately.

`mcp` is a JSON Lines STDIO server supporting initialize, initialized notification, ping, tool listing/calls and cancellation. Its stdout contains protocol messages only. It forwards bearer-authenticated requests to the enrolled project's machine endpoint; it never receives the owner's token or approval tools. No inbound listener is opened. Each input JSON line is limited to 200,000 UTF-8 bytes (excluding its line ending); split multibyte characters are preserved. HTTP responses are streamed with a 4 MiB (4,194,304-byte) limit and strict UTF-8 decoding. Each complete output JSON envelope has the same 4 MiB UTF-8 byte limit; an oversized result becomes a bounded JSON-RPC error.

`submit` connections can also call `update_ticket_status` through STDIO with `ticket_id`, `expected_revision`, a stable `request_id`, `status`, and caller-reported `evidence` (combined stored evidence at most 12000 UTF-8 bytes). Status changes respect active/physical Run holds; replay does not duplicate evidence or history. This tool does not approve or prove execution, and the managed model subprocess keeps its existing five read-only tool allowlist. See the Hub’s `docs/MCP-TICKET-WRITES.md` for waiting reasons, CAS and error semantics.

`agent` stays running until SIGINT/SIGTERM, heartbeats every 15 seconds and checks jobs every 5 seconds. It inherits the current machine's Codex default configuration, provider and environment. Configured API credentials, saved authentication metadata and credential-free custom providers can claim work directly; other OpenAI configurations use `codex login status` for readiness. Model calls report their actual failures. Credentials remain on this machine and are never copied into this package or sent to the Hub. `--codex EXECUTABLE` selects an installed Codex executable. `--once` runs one polling cycle.

Planning uses real `codex exec` in read-only mode with strict schema output and the existing revision-bound claim/save tools. Jobs whose planning retry time is still in the future remain queued. Development consumes only approved runs, creates an isolated Git worktree, uses workspace-write sandbox and JSONL events, renews its lease, and reports actual Git diff/files and the final successful receipt for each test command. Failed attempts remain visible in checking events; rerunning the same command successfully permits completion, while an unretried failed command blocks it. Both inherit the selected model and reasoning settings. The subprocess disables unrelated MCP servers individually and allows only the connector's five project read tools; provider configuration and repository instructions remain loaded. It never bypasses sandbox/approvals. Owner acceptance is a separate server action.

`install`, `doctor` and `agent` accept `--profile NAME`, `--model MODEL` and `--reasoning EFFORT`, saving explicit selections in the local connection file for later starts. Named profiles load the machine's `~/.codex/NAME.config.toml` (or `CODEX_HOME` equivalent); `--profile default` restores the default profile. Omitted flags retain saved selections and otherwise inherit Codex configuration. Heartbeats report only profile, model and provider names.

Cancellation, revocation, lease loss and finite timeouts stop the managed process group before a failure acknowledgement. A private journal and installation lock reconcile surviving subprocesses after restart; interrupted work is not automatically executed again. Worktrees remain under the private configuration directory for inspection and application by the owner. Changes to the main workspace, pushes, merges and publishing are not automatic.

`--test-runner FILE` is an explicit synthetic process fixture for the package's tests. Its events and result summaries identify synthetic evidence. It does not demonstrate a real model call. Delivery tests use an actual archive, installer, STDIO subprocess and Git worktree; fixture backend/model receipts are labelled synthetic.

`--access api` selects direct OpenAI-compatible API Call access instead of Codex: `--api-profile NAME` reads `base_url`, `env_key` and model from the machine's `NAME.config.toml` provider, or `--api-base-url URL --api-key-env VAR --api-model MODEL` set them explicitly. Only the endpoint, model and variable name are saved; the key is read from the Agent's environment. Readiness calls `/models`; planning uses read-only list/read/search tools and development adds worktree-confined write, replace and command tools through `/chat/completions` function calls, with the same diff and test-receipt delivery contract. `--access codex` restores Codex.

`--access claude` selects the machine's logged-in Claude Code CLI (`claude auth status`) instead of Codex; `--claude EXECUTABLE` selects a specific binary and `--model`/`--reasoning` map to `--model`/`--effort`. Each job runs `claude -p` with stream-json events, `--json-schema` structured output, no session persistence and a strict MCP configuration exposing only the connector's five project read tools. Planning allows only Read/Grep/Glob; development runs in the same isolated worktree with permissions bypassed inside it, while push, remote/config changes, publishing and web tools are denied. Bash test commands become the same diff and test-receipt delivery evidence. Inherited parent Claude session variables are removed so the Agent can run from inside another Claude session.

Official Codex references: [MCP configuration](https://developers.openai.com/codex/mcp/) and [noninteractive execution](https://developers.openai.com/codex/noninteractive/).
