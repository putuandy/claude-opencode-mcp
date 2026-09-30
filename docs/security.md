# Security

Security in this bridge comes from four places: workspace validation in the
bridge, permission rules enforced by OpenCode, the absence of interactive
`ask` rules (headless safety), and honest documentation of the remaining
limits.

## Workspace boundaries

- The workspace must exist, be a directory, and be readable.
- Paths are canonicalized (`realpath`); `..` and symlinks cannot escape.
- `workspace.allowedRoots` (when non-empty) restricts every workspace to those
  canonical roots.
- `paths` hints cannot escape the workspace (`INVALID_PATH`).
- `workspace.defaultCwd` is only a fallback; explicit `cwd` and
  `CLAUDE_PROJECT_DIR` fail loudly when invalid.
- The bridge probes the OpenCode server's `directory` before the first run and
  aborts on mismatch (`WORKSPACE_MISMATCH`).

## File protection

When `security.protectEnvFiles` is `true` (default), the read and edit
permission rules deny:

```text
*.env, *.env.*, *.pem, *.key, *.p12, *.pfx,
id_rsa*, id_ed25519*, id_ecdsa*, credentials, credentials.*, .ssh/*, *.npmrc
```

while keeping `*.env.example`, `*.env.sample` and `*.env.template` readable.
Add your own patterns with `security.extraProtectedPatterns`.

## Git safety

For agents that can run shell commands (`coder`, `tester`), bash rules deny:

```text
git push*     git -C * push*     git -c * push*
git commit*   git -C * commit*   git -c * commit*
```

All other commands are allowed for those profiles. Read-only profiles have
`bash: deny` outright, so they cannot mutate anything through the shell.

The bridge never commits, pushes, stages or reverts anything itself. There is
no automatic commit or push anywhere in the codebase.

## Permission matrix

| Permission | read | review | code | test |
| --- | --- | --- | --- | --- |
| `read` | allow (+ sensitive denies) | same | same | same |
| `edit` | deny | deny | allow (+ sensitive denies) | deny |
| `bash` | deny | deny | allow (git commit/push denied) | allow (git commit/push denied) |
| `glob`, `grep`, `list`, `lsp` | allow | allow | allow | allow |
| `webfetch`, `websearch`, `skill`, `todowrite` | allow | allow | allow | allow |
| `task` (subagents) | deny | deny | deny | deny |
| `external_directory` | deny | deny | deny | deny |
| `question`, `doom_loop` | deny | deny | deny | deny |

`externalDirectory` can be set to `allow`, `ask` or `deny`. `ask` is
discouraged: nothing answers the prompt in headless mode, although the bridge
auto-rejects permission events it sees.

## Permission overrides (orchestrator grants)

`delegate_task`, `create_session` and `send_message` accept `allow_edits` and
`allow_bash`. Grants select one of the four profiles above rather than editing
rules ad hoc:

- `allow_edits: true` uses the `edit`/`code` profile, where the `.env` and
  credential edit denials still apply.
- `allow_bash: true` uses the `test`/`code` profile, where `git commit` and
  `git push` remain denied.
- Grants are enforced by OpenCode exactly like the defaults; the task message
  merely tells the agent that the restriction was lifted.

This was verified end-to-end: a granted researcher can create files, but a
write attempt against `.env` is still rejected.

## Headless safety

- No `ask` rules are emitted by the bridge.
- The bridge subscribes to OpenCode's event stream and rejects any permission
  request for an active delegated session, logging a warning. A run cannot hang
  waiting for a human.
- Every run has a timeout; on timeout the bridge aborts the OpenCode session
  and returns `AGENT_TIMEOUT`.
- Cancellation via MCP (`extra.signal`) aborts the session and returns
  `AGENT_ABORTED`.

## Local data protection

- Session registry: `~/.local/state/claude-opencode-mcp/sessions.json`, written
  with mode `0600` inside a `0700` directory. It contains workspace paths and
  agent output summaries, so treat it as private.
- Log file: `~/.local/state/claude-opencode-mcp/bridge.log`, mode `0600`,
  rotated at 5 MB. Log fields whose names look like credentials (password,
  secret, token, authorization, API key, credential, private key) are redacted
  before writing.
- Provider credentials are never stored by the bridge; they stay in OpenCode's
  auth store or environment variables.

## Network exposure

The started OpenCode server binds to `127.0.0.1` by default and uses a
configurable port (`0` lets OpenCode pick). If you change `opencode.hostname`
to a routable address, the OpenCode HTTP API becomes reachable from your
network: set `OPENCODE_SERVER_PASSWORD` (or `opencode.password`) and firewall
the port. The bridge only sends credentials to the server you configured.

## External OpenCode servers

When `opencode.url` is set, the bridge cannot inject agent definitions or
permissions. It verifies the required agents exist and refuses to delegate
otherwise. The permissions of those agents are whatever the external server's
configuration says — review it yourself.

Provider credentials are never sent to external URLs from the environment;
only explicit `username`/`password` or credentials embedded in the URL are
used.

## Known limits

State these plainly when deciding what to delegate:

1. **Shell access implies write access.** A coder or tester can write files via
   `bash` (`printf > file`, `sed -i`, …). The bridge denies edit tools for the
   tester and forbids git history changes, but shell is powerful. Only delegate
   to shell-enabled agents in repositories you trust.
2. **`.env` protection covers file tools.** A shell-enabled agent could `cat`
   a protected file through `bash`. This matches OpenCode's own permission
   model, which gates the `read` tool, not `bash`.
3. **Prompt injection.** Agents read repository content; a hostile repository
   can attempt to influence them. Keep `allowedRoots` tight and review diffs
   with `get_diff` before accepting changes.
4. **An agent can read anything inside the workspace.** That is intentional:
   hints are not boundaries. Use workspace separation, not hints, to isolate
   code.

## Reporting

If you find a security issue, please open an issue with a minimal reproduction
and avoid sharing live credentials.
