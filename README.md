# claude-opencode-mcp

[![CI](https://github.com/putuandy/claude-opencode-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/putuandy/claude-opencode-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

An MCP server that lets **Claude Code delegate software-engineering tasks to
OpenCode agents** — DeepSeek by default — while keeping every agent inside the
same workspace/worktree.

```text
Claude Code (orchestrator)
     │  MCP
     ▼
claude-opencode-mcp (this bridge)
     │  workspace + task + agent
     ▼
OpenCode (agent runtime: tools, sessions, permissions)
     │
     ▼
DeepSeek (or any provider configured in OpenCode)
     │
     ▼
your repository — the same working tree Claude Code is using
```

Claude Code stays in charge: it decomposes the work, picks agents, reviews the
results and integrates changes. OpenCode does the repository exploration,
editing and test execution. The bridge is deliberately thin.

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Claude Code setup](#claude-code-setup)
- [OpenCode + DeepSeek setup](#opencode--deepseek-setup)
- [Quick start](#quick-start)
- [Tools](#tools)
- [Agents](#agents)
- [Workspace model](#workspace-model)
- [Security](#security)
- [Configuration](#configuration)
- [Sessions](#sessions)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## Features

- **Seven focused MCP tools** — `delegate_task`, `create_session`,
  `send_message`, `get_session`, `get_diff`, `abort_session`, `list_agents`.
- **Same worktree** — the delegated OpenCode server runs with your project as
  its working directory; the agent reads and edits the real files.
- **Persistent sessions** — follow-up messages keep the agent's context across
  separate MCP calls.
- **Four agent profiles** — researcher, reviewer, coder, tester, each with
  permissions enforced by OpenCode (not by prompt wording).
- **Workspace boundaries** — canonical paths, allowed roots, path-traversal
  rejection, and a per-run probe that proves the server is serving the right
  directory.
- **Safety defaults** — `.env`/credential protection, `git commit`/`git push`
  denied, external directories denied, no `ask` rules that could hang a
  headless run.
- **Structured results** — every tool returns JSON with stable error codes, and
  `get_diff` gives Claude Code the exact changes a coding session made.
- **Reliability** — timeouts, cancellation, health checks, crash detection,
  graceful shutdown, request IDs and a rotating log file.

## Requirements

| Component | Version |
| --- | --- |
| Node.js | 20 or newer |
| [Claude Code](https://docs.claude.com/en/docs/claude-code) | recent 2.x |
| [OpenCode](https://opencode.ai) | 1.18+ (tested against 1.18.32) |
| Model provider | DeepSeek by default; any provider OpenCode supports |

## Install

```bash
npm install -g claude-opencode-mcp
```

or run it on demand with `npx -y claude-opencode-mcp` (recommended for
`.mcp.json`).

The bridge can also use an OpenCode installation from `PATH`, from
`node_modules/.bin`, from `~/.opencode/bin`, or from an explicit
`OPENCODE_BIN`.

### From source

```bash
git clone https://github.com/putuandy/claude-opencode-mcp.git
cd claude-opencode-mcp
npm install
npm run build
npm install -g .
```

## Claude Code setup

### Option A — project `.mcp.json` (recommended)

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "claude-opencode-mcp"],
      "type": "stdio",
      "timeout": 600000
    }
  }
}
```

`timeout` is milliseconds and is a **per-tool-call** wall-clock limit. Delegated
runs are long; without it Claude Code falls back to `MCP_TOOL_TIMEOUT`.
Claude Code also moves main-conversation tool calls to a background task after
two minutes, which is fine — the result arrives when the run finishes.

### Option B — `claude mcp add`

```bash
claude mcp add opencode --scope project -- npx -y claude-opencode-mcp
```

Or for one machine only:

```bash
claude mcp add opencode --scope user -- npx -y claude-opencode-mcp
```

Verify:

```bash
claude mcp list        # opencode ... ✔ Connected
```

Inside Claude Code, `/mcp` shows the server and its seven tools.

> The bridge reads `CLAUDE_PROJECT_DIR`, which Claude Code sets for stdio MCP
> servers, so delegation defaults to the project you launched Claude Code in.

## OpenCode + DeepSeek setup

The bridge starts and stops its own headless OpenCode server, so you do not need
to run `opencode serve` yourself. You only need OpenCode installed and a
provider authenticated.

1. **Install OpenCode**

   ```bash
   npm install -g opencode-ai
   # or: brew install sst/tap/opencode
   opencode --version
   ```

2. **Authenticate DeepSeek** (once)

   ```bash
   opencode auth login      # choose DeepSeek, paste your API key
   ```

   Alternatively export `DEEPSEEK_API_KEY` before starting Claude Code; OpenCode
   reads it for the `deepseek` provider.

3. **Check the models**

   ```bash
   opencode models | grep deepseek
   # deepseek/deepseek-flash
   # deepseek/deepseek-v4-pro
   ```

4. **(Optional) validate the project**

   ```bash
   cd my-project
   claude-opencode init
   ```

   `init` only creates `.claude-opencode/` and validates the environment; it
   never modifies source code and is not required for delegation.

If you prefer to control OpenCode yourself, start `opencode serve` and point
the bridge at it with `opencode.url`; see
[docs/configuration.md](docs/configuration.md#connecting-to-an-existing-opencode-server).

## Quick start

Restart Claude Code, then ask:

> Use the `opencode` MCP server to have `deepseek-researcher` map this
> repository: entry points, main modules, and where authentication lives.

Then something that edits:

> Have `deepseek-coder` add input validation to `src/api/users.ts`, run the
> tests, and report what changed. Then show me the diff with `get_diff`.

And a full workflow:

> Ask DeepSeek to inspect the authentication system, identify potential issues,
> implement a fix, and review the changes.

Claude Code typically orchestrates: `deepseek-researcher` → `deepseek-coder`
→ `deepseek-reviewer` → `deepseek-tester`, calling `get_diff` between steps.

## Tools

All tools return JSON in `content[0].text` (mirrored in `structuredContent`).
Errors return `isError: true` with `{ "error": { "code", "message", ... } }`.

### `delegate_task`

Run one task in a fresh session and wait for the agent's answer.

```json
{
  "task": "Review the authentication implementation for bugs and security issues.",
  "agent": "deepseek-reviewer",
  "cwd": "/Users/andy/projects/my-app",
  "paths": ["src/auth", "src/middleware", "tests/auth"],
  "model": "deepseek/deepseek-v4-pro",
  "timeout": 600000,
  "allow_edits": false
}
```

Returns `{ status, session_id, agent, cwd, model, summary, findings,
files_changed, duration_ms, truncated, error? }`.

- `paths` are exploration hints, not a boundary — the agent may inspect the
  whole workspace.
- `allow_edits: false` disables the `edit`/`write`/`apply_patch` tools for that
  call (the agent's own profile still applies; see [Security](#security)).
- `findings` are parsed from a `## Findings` section:
  `- [severity: high] Title (path/to/file:42) — detail`.

### `create_session`

```json
{ "cwd": "/abs/path", "agent": "deepseek-researcher", "model": null, "title": "auth investigation" }
```

Returns `{ session_id, cwd, agent, model, title, status, created_at }`.

### `send_message`

Continue a session; the agent keeps its context.

```json
{ "session_id": "ses_...", "message": "Now inspect the database layer for the same issue." }
```

### `get_session`

Returns the stored session state plus live OpenCode status
(`opencode.status` is `idle`, `busy` or `retry` when a server is running).

### `get_diff`

Returns the changes associated with a session:

- OpenCode's own session diff when the server reports one, otherwise
- a **git diff against a baseline captured when the session was created**, so
  pre-existing uncommitted work is not attributed to the agent.

Returns `{ source, files, diff, truncated, note? }`.

### `abort_session`

Stops a running delegation. Safe to call when the session is idle.

### `list_agents`

Lists the built-in agents plus project-local agents from
`.claude-opencode/agents/`, with `read_only`, `can_edit`, `can_run_bash` flags.

## Agents

| Agent | Purpose | Edit | Shell |
| --- | --- | --- | --- |
| `deepseek-researcher` | architecture, exploration, dependency analysis, recommendations | deny | deny |
| `deepseek-reviewer` | code review, bugs, regressions, security, architecture | deny | deny |
| `deepseek-coder` | implementation, refactoring, running tests and fixing failures | allow | allow (no `git commit`/`git push`) |
| `deepseek-tester` | run tests, inspect failures, root causes, suggested fixes | deny | allow (no `git commit`/`git push`) |

Agent prompts live in [`agents/`](agents/) and are loaded into the OpenCode
server configuration at startup. Project-local copies in
`.claude-opencode/agents/*.md` override the prompt, description, model and
temperature; permissions always come from the bridge policy (configurable
through `security.*`).

See [docs/agent-configuration.md](docs/agent-configuration.md) for frontmatter
details and custom agents.

## Workspace model

Resolution order for every call:

1. explicit `cwd` argument
2. `CLAUDE_PROJECT_DIR` (set by Claude Code)
3. the MCP server process working directory
4. `workspace.defaultCwd` from configuration

The first two are *required*: if they are present but invalid, the call fails
instead of silently using a different directory.

Validation happens before any session is created:

- the path must exist, be a directory, and be readable;
- it is canonicalized with `realpath`;
- when `workspace.allowedRoots` is set, the canonical path must live inside one
  of those roots (traversal is rejected);
- the git root is detected for diff isolation.

During the first request for a workspace the bridge reads back `directory` from
the OpenCode server and compares it with the requested path, so a misrouted
request can never reach the wrong repository.

One OpenCode server is started per workspace directory and reused for all
sessions in that workspace; the server process itself runs with the workspace as
its working directory.

## Security

| Control | Default | Where |
| --- | --- | --- |
| Workspace must exist, be readable, be a directory | always | bridge |
| `workspace.allowedRoots` containment | disabled (empty) | config |
| Path hints cannot escape the workspace | always | bridge |
| `.env`/`.env.*`, keys, `credentials`, `.ssh/*` protection | on | OpenCode permissions |
| `git commit` / `git push` for shell-enabled agents | denied | OpenCode permissions |
| Paths outside the workspace | denied | OpenCode `external_directory` |
| Subagent spawning (`task`) | denied | OpenCode permissions |
| Interactive questions (`question`) | denied (headless) | OpenCode permissions |
| `ask` permission rules | never emitted by the bridge | OpenCode permissions |

The bridge also listens to OpenCode's event stream and **auto-rejects** any
permission request that would otherwise wait for a human, so a delegated run can
never hang on approval.

Caveats, stated plainly:

- A shell-enabled agent (`coder`, `tester`) can technically write files through
  shell commands. The bridge denies the `edit` tools for the tester and forbids
  git history changes for both, but shell access is inherently powerful.
- `.env` protection applies to the file tools. A shell-enabled agent could still
  `cat` a file through `bash`; the OpenCode project permission model has the
  same property.
- When connecting to an **external** OpenCode server (`opencode.url`), the
  bridge cannot inject agent permissions. It verifies the agents exist and
  refuses to run otherwise.

Details and hardening options: [docs/security.md](docs/security.md).

## Configuration

Global file: `~/.config/claude-opencode-mcp/config.json` (honours
`XDG_CONFIG_HOME`).
Project file: `<project>/.claude-opencode/config.json` (overrides global).
Extra file: `CLAUDE_OPENCODE_CONFIG=/path/to/config.json` (highest precedence).

```json
{
  "opencode": {
    "url": null,
    "autoStart": true,
    "hostname": "127.0.0.1",
    "port": 0,
    "startupTimeout": 30000,
    "binary": null,
    "username": null,
    "password": null,
    "maxServers": 4
  },
  "workspace": {
    "allowedRoots": [],
    "defaultCwd": null
  },
  "defaults": {
    "agent": "deepseek-researcher",
    "provider": "deepseek",
    "model": null
  },
  "timeouts": {
    "execution": 600000
  },
  "security": {
    "protectEnvFiles": true,
    "denyGitPush": true,
    "denyGitCommit": true,
    "externalDirectory": "deny",
    "extraProtectedPatterns": []
  },
  "limits": {
    "summaryChars": 6000,
    "sessionChars": 20000,
    "diffChars": 60000
  },
  "agents": {
    "deepseek-researcher": { "model": "deepseek/deepseek-v4-pro" }
  }
}
```

- `defaults.model` accepts `provider/model` or a bare model id (combined with
  `defaults.provider`). When `null`, the provider's default model from OpenCode
  is used.
- Provider credentials stay in OpenCode (`opencode auth login`) or environment
  variables; they are never duplicated in this config.
- For auto-started servers the bridge passes `OPENCODE_SERVER_USERNAME` /
  `OPENCODE_SERVER_PASSWORD` through and authenticates its own requests. For
  external URLs it only uses credentials you configure.

Full reference: [docs/configuration.md](docs/configuration.md).

## Sessions

- Sessions are OpenCode sessions; the bridge keeps a small registry at
  `~/.local/state/claude-opencode-mcp/sessions.json` (override with
  `CLAUDE_OPENCODE_STATE_DIR`) so `get_session`, `get_diff` and `send_message`
  survive a bridge restart.
- Records older than 14 days are pruned at startup.
- If an OpenCode server restarts, persisted sessions are still addressable;
  `get_session` reports live status when a server is running.
- Logs: `~/.local/state/claude-opencode-mcp/bridge.log` (rotated at 5 MB).
  Set `CLAUDE_OPENCODE_LOG=debug|info|warn|error|silent`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `OPENCODE_NOT_AVAILABLE` | `npm install -g opencode-ai` or set `OPENCODE_BIN` / `opencode.binary`. |
| `OPENCODE_START_TIMEOUT` | run `opencode serve` manually to see the error; raise `opencode.startupTimeout`; check `OPENCODE_SERVER_PASSWORD` handling. |
| `MODEL_NOT_AVAILABLE` | authenticate a provider (`opencode auth login`) or set `defaults.model`, e.g. `"deepseek/deepseek-v4-pro"`. |
| `ProviderAuthError` in a result | DeepSeek credentials are missing/expired; re-run `opencode auth login`. |
| `AGENT_NOT_FOUND` with an external server | add the four agents to that server's config or stop using `opencode.url`. |
| `AGENT_TIMEOUT` | raise `timeouts.execution` or the `timeout` argument; consider a narrower task. |
| `WORKSPACE_NOT_ALLOWED` | add the project to `workspace.allowedRoots` or clear the list. |
| Tool call seems to hang in Claude Code | Claude Code backgrounds long calls after 2 minutes; progress notifications are sent, and the bridge always resolves or aborts — check `bridge.log`. |
| Claude Code kills the call at 60s | set `"timeout": 600000` in the `.mcp.json` entry (or `MCP_TOOL_TIMEOUT`). |

More: [docs/troubleshooting.md](docs/troubleshooting.md).

## Development

```bash
npm install
npm run lint        # Biome
npm run typecheck
npm test            # unit + integration (no OpenCode needed)
npm run build
```

Real end-to-end tests need an OpenCode install with DeepSeek authenticated:

```bash
npm run test:e2e                                  # checkpoints: workspace, agents, sessions, diff, abort, stdio
CLAUDE_OPENCODE_E2E_WORKFLOW=1 npm run test:e2e   # full researcher → coder → reviewer → tester workflow
```

Layout:

```text
src/
  index.ts              CLI entry (MCP server + `init`)
  cli/                  `claude-opencode init`
  config/               configuration loading and merging
  workspace/            resolver, validator, task context
  security/             path policy + OpenCode permission profiles
  opencode/             binary resolution, manager, client, agents, sessions, runner
  mcp/                  MCP server and the seven tools
agents/                 built-in agent prompts
tests/                  unit, integration, e2e
docs/                   documentation
```

See [docs/development.md](docs/development.md) and
[docs/architecture.md](docs/architecture.md).

## Documentation

- [Installation](docs/installation.md)
- [Configuration](docs/configuration.md)
- [Claude Code setup](docs/claude-code-setup.md)
- [OpenCode setup](docs/opencode-setup.md)
- [DeepSeek setup](docs/deepseek-setup.md)
- [Agent configuration](docs/agent-configuration.md)
- [Workspace model](docs/workspace-model.md)
- [Security](docs/security.md)
- [Security audit](docs/security-audit.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## Contributing

Bug reports, feature requests, and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md); for vulnerabilities use
[SECURITY.md](SECURITY.md) instead of a public issue.

## License

MIT — see [LICENSE](LICENSE).
