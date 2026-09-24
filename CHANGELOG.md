# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-09-24

First stable release.

### Added

- MCP stdio server with seven tools: `delegate_task`, `create_session`,
  `send_message`, `get_session`, `get_diff`, `abort_session`, `list_agents`.
- OpenCode runtime management: lazy start of one headless server per workspace,
  health checks, LRU eviction (`opencode.maxServers`), crash detection,
  graceful shutdown, and no orphaned processes.
- Agent system with four profiles enforced through OpenCode permissions:
  `deepseek-researcher`, `deepseek-reviewer` (read-only),
  `deepseek-coder` (edits + shell), `deepseek-tester` (shell, no edits).
- Workspace resolution (`cwd` → `CLAUDE_PROJECT_DIR` → process cwd →
  configured default) with canonical-path validation, allowed roots, git-root
  detection, and a per-workspace routing probe (`WORKSPACE_MISMATCH`).
- Persistent sessions: `create_session` / `send_message` keep agent context;
  registry stored at `~/.local/state/claude-opencode-mcp/sessions.json`
  (mode `0600`) and pruned after 14 days.
- `get_diff` for reviewing agent changes: OpenCode session diff when
  available, otherwise a git diff against a baseline captured at session
  creation (pre-existing dirty state is isolated).
- Reliability: per-run timeouts (`AGENT_TIMEOUT`), MCP cancellation
  (`AGENT_ABORTED`), progress notifications, structured error codes, request
  IDs, and a rotating `0600` log file.
- Security defaults: `.env`/key/credential read and edit protection, `git
  commit`/`git push` denied for shell-enabled agents, `external_directory`
  denied, no `ask` permission rules, and auto-rejection of stray permission
  requests so headless runs cannot hang. Log fields matching
  password/secret/token/api-key patterns are redacted.
- Configuration layering: global (`~/.config/claude-opencode-mcp/config.json`),
  project (`.claude-opencode/config.json`), explicit
  (`CLAUDE_OPENCODE_CONFIG`), with deep merge and Zod validation.
- `claude-opencode init` validator/scaffolder (config + agent files, optional
  `.mcp.json`) and `claude-opencode-mcp` executable for `npx`.
- Documentation set covering installation, configuration, Claude Code, OpenCode,
  DeepSeek, agents, workspace model, security, architecture, development,
  contributing, and troubleshooting.
- Test suite: unit and integration tests with a fake OpenCode server, plus
  opt-in real OpenCode/DeepSeek E2E checkpoints and a full multi-agent
  workflow acceptance test.
- CI across Node 20/22/24 (Ubuntu) and Node 24 (macOS), plus an opt-in,
  push-only real-provider E2E job.

[Unreleased]: https://github.com/putuandy/claude-opencode-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/putuandy/claude-opencode-mcp/releases/tag/v1.0.0
