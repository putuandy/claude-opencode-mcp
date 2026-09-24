# OpenCode setup

The bridge treats OpenCode as the agent runtime: tools, sessions, permissions,
LSP and provider execution all come from OpenCode. It does not reimplement any
of that.

## Install

```bash
npm install -g opencode-ai
opencode --version
```

Other installation methods are listed on
<https://opencode.ai/docs/>. The bridge also finds a locally installed
`opencode` in `node_modules/.bin`, so adding `opencode-ai` to a project's
dependencies works:

```bash
npm install -D opencode-ai
```

## How the bridge starts OpenCode

For each workspace, on first use:

1. It resolves the executable (see
   [configuration.md](configuration.md#environment-variables)).
2. It starts:

   ```bash
   opencode serve --hostname=127.0.0.1 --port=0 [--log-level=...]
   ```

   with the **workspace as the working directory**, and passes the agent
   definitions and permissions through `OPENCODE_CONFIG_CONTENT`.

3. It waits for `opencode server listening on <url>`, then polls
   `GET /global/health` until healthy.
4. The server stays alive for the rest of the session and is reused by every
   call in that workspace.

Servers are stopped on shutdown (SIGTERM, then SIGKILL after 5 seconds), and a
crashed server is detected and restarted on the next call. `opencode.maxServers`
(default 4) bounds how many idle servers are kept alive for multi-project use.

## Permissions from this bridge

The bridge injects four agents (`deepseek-researcher`, `deepseek-reviewer`,
`deepseek-coder`, `deepseek-tester`) with explicit `permission` rules covering
every permission key OpenCode supports: `read`, `edit`, `glob`, `grep`, `list`,
`bash`, `task`, `external_directory`, `todowrite`, `webfetch`, `websearch`,
`lsp`, `skill`, `question`, `doom_loop`.

Nothing is set to `ask`: the bridge is headless, and an `ask` rule would block a
run until a human answers. The bridge additionally watches OpenCode's event
stream and rejects any permission request that still appears, so a run can never
hang on approval.

If you already run OpenCode with your own global configuration, agent rules from
the bridge take precedence for these four agents only; everything else in your
configuration is preserved because inline config is merged, not replaced.

## Connecting to an existing server

```json
{
  "opencode": { "url": "http://127.0.0.1:4096", "autoStart": false }
}
```

The server must expose the v1 HTTP API (OpenCode 1.18+), and the four agents
must exist in that server's configuration. `claude-opencode init` writes agent
files under `.claude-opencode/agents/`; copy them to `.opencode/agents/` in the
project, or add them to the server's global config, to make them available.

## Authentication for the server itself

If the OpenCode server is protected with HTTP basic auth, set
`OPENCODE_SERVER_PASSWORD` (and optionally `OPENCODE_SERVER_USERNAME`) or the
`opencode.username` / `opencode.password` config keys. The bridge sends the
credentials on every request and passes them to servers it starts itself.

## Multiple workspaces

One server per workspace directory is intentional: project OpenCode
configuration (`.opencode/`, `opencode.json`, project agents) is loaded
naturally, and each server's working directory is exactly the delegated
workspace. Idle servers are evicted LRU when `opencode.maxServers` is exceeded.

## Headless caveats

- The bridge disables `OPENCODE_CLIENT` when spawning the server, so it runs as
  a plain headless server rather than inheriting desktop/TUI flags.
- Interactive TUI features (share prompts, dialogs) are not used.
- Streaming is not consumed from the model; the bridge polls session status and
  emits MCP progress notifications to Claude Code while waiting.
