# Development

## Setup

```bash
git clone <repo>
cd claude-opencode-mcp
npm install
```

`opencode-ai` is an optional dependency, so a local OpenCode binary is usually
available for end-to-end tests without a global install.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` (emits the executable). |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `tests/`. |
| `npm run lint` | Biome check (lint + format). |
| `npm run lint:fix` | Biome check with safe fixes. |
| `npm run format` | Biome format. |
| `npm test` | Unit + integration tests (no OpenCode needed). |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:e2e` | Build + real OpenCode/DeepSeek E2E tests (opt-in). |
| `npm run dev` | Run the MCP server from source with tsx. |

## Test layers

```text
tests/unit/          pure logic: workspace, config, policy, git, text, agents
tests/integration/   MCP server + tools against a fake OpenCode HTTP server
tests/e2e/           real OpenCode + DeepSeek (opt-in)
```

The integration suite (`tests/helpers/fake-opencode.ts`) implements the v1
endpoints the bridge uses — health, agents, providers, sessions, messages,
status, abort, diff, events — so the entire pipeline is exercised
deterministically in about two seconds.

### Running end-to-end tests

Requirements: an OpenCode binary the bridge can find, and a provider
authenticated (`opencode auth login`).

```bash
# checkpoints: workspace isolation, read-only agents, coder edits + diff,
# session context, abort, stdio MCP server
npm run test:e2e

# full researcher → coder → reviewer → tester workflow on a generated demo project
CLAUDE_OPENCODE_E2E_WORKFLOW=1 npm run test:e2e

# override the model used
CLAUDE_OPENCODE_E2E_MODEL=deepseek/deepseek-flash npm run test:e2e
```

These tests make real model calls and take tens of seconds to minutes.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

- **test** job — Node 20/22/24 on Ubuntu plus Node 24 on macOS: `npm ci`,
  `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, an
  executable smoke test (`--version`, `--help`) and `npm pack --dry-run`.
- **e2e** job — opt-in and **push-only** (fork PRs never see secrets). Set the
  repository variable `CLAUDE_OPENCODE_E2E=1` and the secret
  `OPENCODE_AUTH_JSON` (contents of a valid OpenCode `auth.json`) to run the
  real DeepSeek checkpoints on Ubuntu.

The `init` integration test adapts when no OpenCode binary is present, so
`npm test` also passes in environments installed with `--omit=optional`.

## Manual smoke test

```bash
npm run build
node dist/index.js init          # in a scratch project
node dist/index.js --version
```

Or drive the server with an MCP client:

```bash
claude mcp add opencode --scope local -- node "$PWD/dist/index.js"
claude mcp list
```

## Code layout

See [architecture.md](architecture.md). House rules:

- Relative imports use `.js` extensions (NodeNext ESM).
- Zod schemas validate every tool input and config layer.
- All errors are `BridgeError` with a code from `src/errors.ts`.
- Never write to stdout in the server process: stdout is the MCP transport.
  Logging goes to stderr and the log file.
- Tests use temporary directories and never touch the developer's repository.

## Adding a tool

1. Create `src/mcp/tools/<name>.ts` exporting `register<Name>(server, ctx)`.
2. Define the zod input schema and annotations (`readOnlyHint`, etc.).
3. Return `jsonResult(...)` on success and `errorResult(error, requestId)` on
   failure.
4. Register it in `src/mcp/server.ts`.
5. Add unit/integration coverage; extend `docs/` and the README table.

## Adding an agent

Add a markdown file under `agents/` and a profile mapping in
`src/security/policy.ts` if none fits. See
[agent-configuration.md](agent-configuration.md).

## Release checklist

```bash
npm run lint && npm run typecheck && npm test && npm run build
npm run test:e2e                 # requires OpenCode + provider credentials
CLAUDE_OPENCODE_E2E_WORKFLOW=1 npm run test:e2e
npm pack --dry-run
```

Versioning follows [Semantic Versioning](https://semver.org). For a release:

1. Update `CHANGELOG.md` (`Unreleased` → the new version) and bump
   `package.json` (`npm version <major|minor|patch>` creates the commit and
   tag).
2. Verify the packed contents with `npm pack --dry-run` (dist, agents, docs,
   README, LICENSE, CHANGELOG, SECURITY).
3. Install and smoke-test the tarball in a scratch directory:

   ```bash
   npm pack
   npm install -g ./claude-opencode-mcp-<version>.tgz
   claude-opencode-mcp --version
   cd /tmp && claude-opencode init
   ```

4. Publish: `npm publish --access public` (add `--provenance` when publishing
   from a GitHub Actions OIDC workflow). Requires npm 2FA.
5. Push the tag and create the GitHub release from the changelog entry.
6. Post-release: remove local tarballs and confirm the
   [CI](https://github.com/putuandy/claude-opencode-mcp/actions) badge is
   green.
