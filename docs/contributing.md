# Contributing

Thanks for helping improve claude-opencode-mcp.

## Ground rules

- Keep the bridge thin. If OpenCode can already do it, the bridge should call
  OpenCode rather than reimplement it.
- Never add an `ask` permission rule: the bridge is headless.
- Never make the bridge write into a user's repository unless the user asks for
  it (`init` writes only inside `.claude-opencode/`).
- Do not hard-code provider specifics beyond defaults; providers must stay
  configurable.
- Validate against real documentation, not assumptions. Check OpenCode's
  [server API](https://opencode.ai/docs/server/) and SDK, and this repository's
  installed `@opencode-ai/sdk` types, before relying on an endpoint.

## Workflow

1. Fork and branch.
2. `npm install`
3. Make the change with tests.
4. Run the full gate:

   ```bash
   npm run lint
   npm run typecheck
   npm test
   npm run build
   ```

5. If your change touches the OpenCode integration, run the real E2E suite:

   ```bash
   CLAUDE_OPENCODE_E2E=1 npm run test:e2e
   ```

6. Open a pull request describing the problem, the change, and how you
   verified it.

## Commit style

Conventional-ish and scoped, for example:

```text
fix(manager): restart OpenCode when the agent config changes
feat(tools): add timeout override to send_message
docs(security): document shell write caveat
```

## Reporting bugs

Include:

- the bridge version (`claude-opencode-mcp --version`),
- OpenCode version (`opencode --version`),
- the failing tool call and its JSON error (with `request_id`),
- relevant `~/.local/state/claude-opencode-mcp/bridge.log` lines.

Never paste API keys or auth files.

## Security issues

Please report privately rather than in a public issue, and avoid sharing live
credentials. See [security.md](security.md) for the threat model and known
limits.

## License

By contributing you agree your contributions are licensed under the MIT
License.
