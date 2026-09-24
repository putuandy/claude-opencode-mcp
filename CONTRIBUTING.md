# Contributing

Thanks for your interest in `claude-opencode-mcp`! Full guidelines live in
[docs/contributing.md](docs/contributing.md) and
[docs/development.md](docs/development.md); this page is the short version.

## Quick start

```bash
git clone https://github.com/putuandy/claude-opencode-mcp.git
cd claude-opencode-mcp
npm install
npm run lint && npm run typecheck && npm test && npm run build
```

## Before you open a pull request

- Keep the bridge thin: call OpenCode instead of reimplementing its runtime.
- Never introduce `ask` permission rules — the bridge is headless.
- Never write into a user's repository outside `.claude-opencode/`.
- Keep the provider configurable; DeepSeek is only a default.
- Add or update tests and documentation for behavior changes.
- Run the gate above and, for integration changes, the real E2E suite:

  ```bash
  npm run test:e2e   # requires OpenCode + an authenticated provider
  ```

## Commit messages

Conventional and scoped, for example:

```text
fix(manager): restart OpenCode when the agent config changes
feat(tools): add timeout override to send_message
docs(security): document shell write caveat
```

## Reporting bugs and security issues

- Bugs: use the issue template and include the bridge version, OpenCode
  version, tool call, error JSON (with `request_id`), and relevant log lines.
- Security: follow [SECURITY.md](SECURITY.md) and report privately.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) and that you will follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
