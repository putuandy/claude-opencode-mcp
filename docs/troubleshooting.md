# Troubleshooting

Start with the log file:

```bash
tail -f ~/.local/state/claude-opencode-mcp/bridge.log
```

and raise the level:

```bash
CLAUDE_OPENCODE_LOG=debug claude
```

## Error codes

| Code | Meaning | Typical fix |
| --- | --- | --- |
| `WORKSPACE_NOT_FOUND` | No usable workspace could be resolved. | Pass `cwd` explicitly or start Claude Code inside the project. |
| `WORKSPACE_NOT_ALLOWED` | Canonical workspace is outside `workspace.allowedRoots`. | Add the root or clear the list. |
| `WORKSPACE_NOT_READABLE` | Permission problem accessing the workspace. | Fix directory permissions. |
| `WORKSPACE_MISMATCH` | OpenCode reported a different directory than requested. | Restart Claude Code; report a bug if it persists. |
| `INVALID_PATH` | A path hint escaped the workspace, a path had a null byte, or `cwd` was not a directory. | Fix the hint. |
| `OPENCODE_NOT_AVAILABLE` | Executable not found or not executable. | `npm install -g opencode-ai` or set `OPENCODE_BIN`/`opencode.binary`. |
| `OPENCODE_START_TIMEOUT` | Server did not print its listening URL in time. | Run `opencode serve` manually; raise `opencode.startupTimeout`; check auth env vars. |
| `OPENCODE_UNAVAILABLE` | Server died or refused a request. | Retry; check `bridge.log` and `opencode serve` output. |
| `OPENCODE_SESSION_NOT_FOUND` | Unknown or deleted session id. | Create a new session. |
| `OPENCODE_ERROR` | OpenCode returned an error (includes provider auth failures). | Read the message; for auth re-run `opencode auth login`. |
| `AGENT_NOT_FOUND` | Unknown agent, or the external server lacks required agents. | Check `list_agents`; install agents on the external server. |
| `AGENT_TIMEOUT` | Run exceeded the timeout and was aborted. | Raise `timeouts.execution`/`timeout`, or split the task. |
| `AGENT_ABORTED` | Run was cancelled. | Expected after `abort_session` or MCP cancellation. |
| `AGENT_EXECUTION_FAILED` | Provider/API error during the run. | Inspect `details.statusCode`/`responseBody`; retry on `429`. |
| `MODEL_NOT_AVAILABLE` | No model could be resolved. | `opencode auth login` or set `defaults.model`. |
| `DIFF_UNAVAILABLE` | No changes were reported and the workspace is not a git repo. | Initialize git for reliable diffs. |
| `NOT_GIT_REPOSITORY` | A git-only operation was requested outside a repo. | Initialize git. |
| `CONFIG_INVALID` | Configuration file has wrong types or bad JSON. | Fix the file named in `details.file`. |
| `INTERNAL_ERROR` | Unexpected bridge error. | Report with the `request_id` from the log. |

## The tool call times out in Claude Code

- Set `"timeout": 600000` in the `.mcp.json` server entry (per-tool wall clock).
- `MCP_TOOL_TIMEOUT` raises the default for all servers.
- Claude Code backgrounds calls after two minutes; this is normal and the
  result still arrives.
- The stdio idle timeout is 30 minutes with no response *and no progress*; the
  bridge emits progress notifications while polling, so long runs are safe.

## OpenCode server fails to start

Run the same command the bridge runs, in the workspace:

```bash
cd /path/to/project
opencode serve --hostname=127.0.0.1 --port=0
```

Common causes:

- Port/hostname conflicts: leave `opencode.port` at `0` (choose a free port).
- `OPENCODE_SERVER_PASSWORD` set in the environment: the server requires basic
  auth. The bridge handles it; if you connect manually, pass credentials.
- Stale `OPENCODE_CONFIG_CONTENT` with invalid JSON: the bridge ignores
  malformed inherited content and merges its own agents on top.
- A broken global OpenCode config: run `opencode debug config`.

## DeepSeek is not detected by `init`

`claude-opencode init` runs `opencode models` and looks for `deepseek/*`. If the
list is empty:

```bash
opencode auth login
opencode models | grep deepseek
```

## Agents are missing on an external server

`AGENT_NOT_FOUND` with `opencode.url` set means the server has no definitions
for `deepseek-*`. Either:

```bash
claude-opencode init
mkdir -p .opencode/agents
cp .claude-opencode/agents/*.md .opencode/agents/
```

then restart the external server, or remove `opencode.url` and let the bridge
manage the server.

## A run seems stuck

- Check `/tasks` in Claude Code for a backgrounded call.
- `get_session` returns live `opencode.status` (`busy`, `idle`, `retry`).
- `abort_session` stops it.
- The bridge auto-rejects permission prompts it observes, and every run has a
  timeout, so a run cannot wait forever.

## Provider errors during runs

Results include `error.details` from OpenCode, for example:

```json
{
  "status": "failed",
  "error": {
    "code": "AGENT_EXECUTION_FAILED",
    "message": "rate limited",
    "details": { "statusCode": 429, "isRetryable": true }
  }
}
```

Retry by sending a follow-up (`send_message`) on the same session or delegating
again.

## Diagnostics

```bash
claude-opencode-mcp --version
claude-opencode init          # validates binary, provider, workspace, MCP config
claude mcp list               # shows connection health
node dist/index.js --version
```

When reporting a bug, include the `request_id` from the error payload and the
matching lines from `bridge.log`.
