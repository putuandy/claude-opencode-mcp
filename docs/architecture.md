# Architecture

The bridge is intentionally thin. It owns workspace resolution, security
policy, session bookkeeping, and the MCP surface. Everything else is OpenCode's
job.

```text
┌────────────────────────────────────────────────────────────────────┐
│ Claude Code                                                        │
│  · understands the request, decomposes work, picks agents          │
│  · calls mcp__opencode__* tools                                    │
└───────────────────────────────┬────────────────────────────────────┘
                                │ MCP over stdio
┌───────────────────────────────▼────────────────────────────────────┐
│ claude-opencode-mcp                                                │
│                                                                    │
│  mcp/server.ts ── tools/*.ts   seven tools, zod schemas            │
│  workspace/*                  resolution, validation, context      │
│  security/*                   path policy, permission profiles     │
│  config/config.ts             layered configuration                │
│  opencode/manager.ts          one server per workspace, LRU        │
│  opencode/agents.ts           built-in + project agent definitions │
│  opencode/run.ts              prompt, poll, timeout, abort         │
│  opencode/sessions.ts         registry persisted to disk           │
│  opencode/permission-watcher  auto-reject asks over SSE            │
└───────────────┬────────────────────────────────────────────────────┘
                │ @opencode-ai/sdk (v1 HTTP API) + OPENCODE_CONFIG_CONTENT
┌───────────────▼────────────────────────────────────────────────────┐
│ OpenCode server (one per workspace directory)                      │
│  · tools: read, glob, grep, edit, write, apply_patch, bash, …      │
│  · sessions, permissions, LSP, providers                           │
└───────────────┬────────────────────────────────────────────────────┘
                │ provider API (DeepSeek by default)
                ▼
        DeepSeek / any configured provider
                │
                ▼
        the same project/worktree
```

## Components

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | CLI: default command runs the MCP stdio server; `init` subcommand. |
| `src/mcp/server.ts` | Creates `McpServer`, registers tools, passes app context. |
| `src/mcp/tools/*` | Thin validation + orchestration per tool. |
| `src/mcp/execute.ts` | Run lifecycle: registry status, run, truncate, count files. |
| `src/workspace/resolver.ts` | Resolution priority and project-config loading. |
| `src/workspace/validator.ts` | Existence, readability, canonicalization, allowed roots, git root. |
| `src/security/policy.ts` | Maps agent profiles to OpenCode permission configs. |
| `src/opencode/manager.ts` | Server lifecycle, auth, health, LRU, crash detection. |
| `src/opencode/run.ts` | `session.prompt` + polling progress + timeout/abort + result extraction. |
| `src/opencode/agents.ts` | Loads prompts, merges overrides, emits OpenCode agent config. |
| `src/opencode/sessions.ts` | Session registry with atomic persistence and pruning. |
| `src/opencode/permission-watcher.ts` | SSE watcher that rejects stray permission asks. |
| `src/util/git.ts` | Non-invasive baseline (`git stash create`) and diff since baseline. |

## Request flow for `delegate_task`

```text
1. Resolve + validate workspace            (workspace/*)
2. Load project config, merge agents       (config/, opencode/agents.ts)
3. Ensure OpenCode server for the cwd      (opencode/manager.ts)
   · spawn `opencode serve` with OPENCODE_CONFIG_CONTENT
   · wait for "listening", poll /global/health
4. Resolve model (request → config → provider default)
5. Create session, capture git baseline    (opencode/sessions.ts, util/git.ts)
6. POST /session/:id/message with agent + model + parts
7. While pending: poll status/messages, emit MCP progress notifications
8. On completion: read assistant message, map errors, extract findings
9. Count files changed from the baseline, persist result, return JSON
```

## Why these choices

- **One server per workspace** keeps OpenCode's project configuration, cwd and
  snapshots honest, and avoids per-request directory routing bugs.
  Per-request `x-opencode-directory` remains available in the SDK but the
  bridge does not rely on it for isolation.
- **Sync prompt + polling** instead of streaming: the v1 HTTP API returns the
  final assistant message from `POST /session/:id/message`, which gives a
  definitive completion signal. Progress is reported to Claude Code via MCP
  notifications.
- **Git baseline for diffs**: OpenCode 1.18's `GET /session/:id/diff` returns
  empty for API-driven sessions in testing, so the bridge computes
  `git diff` against a baseline captured at session creation
  (`git stash create` for dirty trees) plus new untracked files. Pre-existing
  uncommitted work is therefore not attributed to the agent.
- **Inline agent config** (`OPENCODE_CONFIG_CONTENT`) instead of writing files
  into the repository: permissions cannot be forgotten, and the project tree
  stays untouched.
- **No ask rules + SSE auto-reject**: a headless bridge must never block on
  human approval.

## Error model

`BridgeError` carries a stable code, message, optional details, and a
`retryable` flag. Tools catch it and return `isError: true` with
`{ "error": { code, message, details?, retryable, request_id } }`. The codes are
listed in [troubleshooting.md](troubleshooting.md#error-codes) and in
`src/errors.ts`.

## State on disk

| Path | Contents |
| --- | --- |
| `~/.config/claude-opencode-mcp/config.json` | global configuration |
| `<project>/.claude-opencode/config.json` | project configuration |
| `<project>/.claude-opencode/agents/*.md` | optional project agents |
| `~/.local/state/claude-opencode-mcp/sessions.json` | session registry |
| `~/.local/state/claude-opencode-mcp/bridge.log` | rotating log (5 MB) |

No state is written into the repository except what `init` creates inside
`.claude-opencode/`.
