# Security audit

- **Version audited:** 1.0.0
- **Date:** 2026-09-24
- **Scope:** the `claude-opencode-mcp` source tree, its configuration parsing,
  process management, permission model, MCP tool surface, CI workflows, and
  published package contents.

## Method

1. Manual review of every source module with attention to command execution,
   path handling, credential flow, and permission construction.
2. Pattern scan for unsafe primitives: `child_process.exec`, `execSync`,
   `shell: true`, `eval`, `new Function`, non-local `http://` endpoints.
3. Secret scan of the repository (API-key and private-key patterns) and a scan
   for machine-specific paths in shipped files.
4. Dependency audit: `npm audit` and `npm audit --omit=dev`.
5. Review of the permission model against the documented threat model,
   including how a model could bypass intended restrictions.
6. Review of CI workflows for secret exposure and fork safety.
7. Reproduction of security-relevant behavior with the automated test suite,
   including real OpenCode/DeepSeek end-to-end tests.

## Findings

| # | Finding | Risk | Status |
| --- | --- | --- | --- |
| 1 | `opencode.binary` configuration was ignored; the bridge used a PATH-resolved binary instead. | A user explicitly selecting a trusted binary could unknowingly run another. | Fixed: resolver receives the configured path; regression test asserts the configured binary is used. |
| 2 | Shutdown/startup race could orphan a spawned OpenCode process. | Local resource leak; a stale server keeps running after the bridge exits. | Fixed: children are tracked at spawn time, startup aborts during shutdown, and a synchronous `exit`-handler kills anything left. Tested with a fake binary. |
| 3 | Session registry and log file were created with default permissions. | Other local users could read agent output summaries and workspace paths. | Fixed: state directory `0700`, files `0600`; log directory created with `0700`. |
| 4 | Logger had no redaction. | A future code path logging credentials would leak them to disk. | Fixed: log field names matching password/secret/token/authorization/API-key/credential/private-key are redacted; unit-tested. |
| 5 | MCP tool inputs were unbounded. | Oversized payloads could bloat prompts/logs. | Fixed: `.max()` limits on task, message, cwd, model, agent, title, session id, path array (200 items), and timeout (1 hour). |
| 6 | CI E2E job could attempt to use secrets on fork pull requests. | Failed/unsafe runs on untrusted PRs. | Fixed: the E2E job runs only on `push` events, and checkouts disable credential persistence. |
| 7 | `edit: deny` alone is bypassable by shell commands. | Read-only intent could be violated. | Mitigated: read-only profiles also deny `bash`; shell-enabled tester is documented as able to write via shell. Verified end-to-end that a read-only agent cannot create a file. |

No unsafe command construction was found: all external processes use
`execFile`/`spawn` with explicit argument arrays and no shell. Credentials for
external OpenCode servers come only from explicit configuration or the URL,
never from the ambient environment. Dependency audit reports zero known
vulnerabilities.

## Accepted risks

These are intentional and documented in [security.md](security.md):

- Shell-enabled agents (`deepseek-coder`, `deepseek-tester`) can write files
  through shell commands; the tester's edit tools are denied but shell is
  inherently powerful.
- Sensitive-file protection applies to OpenCode's file tools, not to `bash`.
- A delegated agent reads repository content, so prompt injection from a
  hostile repository is possible; review diffs with `get_diff` and keep
  `workspace.allowedRoots` narrow.
- Explicitly configured/`OPENCODE_BIN` executables are trusted by definition.
- Changing `opencode.hostname` from `127.0.0.1` exposes the OpenCode HTTP API
  to the network; use a server password and firewall the port.

## Security test coverage

The suite includes assertions for: workspace canonicalization and traversal
rejection, allowed-root enforcement, path-hint escape rejection, read-only
agent file-creation denial, `.env` secret non-disclosure, `git commit` denial,
unknown-session handling, timeout and abort without hanging, crashed-server
handling, workspace routing mismatch detection, child-process cleanup, log
redaction, and dependency freshness via CI.

## Reproducing

```bash
npm audit --omit=dev
npm audit
grep -rEn "exec\(|execSync|shell: true|eval\(|new Function\(" src/
grep -rEn "sk-[a-zA-Z0-9]{20,}|BEGIN (RSA|OPENSSH|EC) PRIVATE" .
npm test
npm run test:e2e        # real OpenCode + provider required
```

## Reporting

Found something this audit missed? Please use the private process in
[SECURITY.md](../SECURITY.md).
