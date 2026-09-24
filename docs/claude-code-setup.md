# Claude Code setup

## Add the MCP server

### Project scope (recommended)

Create `.mcp.json` at your project root:

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

Claude Code asks for approval the first time it loads a project-scoped server in
an interactive session. Commit `.mcp.json` to share the setup with your team.

### CLI

```bash
# project scope (writes/updates .mcp.json)
claude mcp add opencode --scope project -- npx -y claude-opencode-mcp

# user scope (all projects, private to you)
claude mcp add opencode --scope user -- npx -y claude-opencode-mcp
```

The `--` separator is required: everything after it is the command Claude Code
runs.

### Global install without npx

```bash
npm install -g claude-opencode-mcp
claude mcp add opencode --scope user -- claude-opencode-mcp
```

For a local checkout:

```bash
npm install && npm run build
claude mcp add opencode --scope local -- node /absolute/path/to/dist/index.js
```

## Verify

```bash
claude mcp list
# opencode: npx -y claude-opencode-mcp - ✔ Connected
```

Inside Claude Code, `/mcp` shows the server and the seven tools with the
`mcp__opencode__` prefix.

## Important timeout settings

Delegated runs are long. Three independent limits matter:

1. **Per-tool timeout** — the `timeout` field in `.mcp.json` (milliseconds) or
   `MCP_TOOL_TIMEOUT`. Set it to at least your `timeouts.execution`
   (default 10 minutes).
2. **Automatic backgrounding** — after two minutes Claude Code moves a
   main-conversation tool call to a background task and continues working; the
   result arrives as a task notification. No configuration needed.
3. **Idle timeout** — 30 minutes for stdio servers: a tool call that produces
   no response and no progress notification for that long is aborted. The
   bridge sends MCP progress notifications during runs, so this does not fire
   for active work.

## How the workspace is chosen

Claude Code sets `CLAUDE_PROJECT_DIR` for stdio MCP servers. The bridge uses:

1. an explicit `cwd` argument,
2. `CLAUDE_PROJECT_DIR`,
3. the server process working directory,
4. `workspace.defaultCwd`.

The first two must be valid when present, so delegation cannot silently switch
projects.

## Example prompts

```text
Use delegate_task with deepseek-researcher to find where authentication is
implemented and list the relevant files.

Have deepseek-coder fix the bug in src/auth/session.ts, run the tests, and
report the changes. Then call get_diff on that session.

Create a session with deepseek-researcher, ask it to inspect the payments
module, then send follow-up messages about dependencies it found.

Ask the reviewer to check the diff, then the tester to run the suite.
```

## Multiple projects

Each workspace gets its own lazily started OpenCode server, so you can delegate
into more than one repository from the same Claude Code session by passing
`cwd`. Use `workspace.allowedRoots` to bound which directories are acceptable.

## Uninstalling

```bash
claude mcp remove opencode --scope project
```

and remove the `.mcp.json` entry if you added one manually.
