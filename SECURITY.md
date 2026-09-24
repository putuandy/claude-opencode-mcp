# Security Policy

`claude-opencode-mcp` executes AI agents with file and shell access inside a
workspace. We take security reports seriously and appreciate responsible
disclosure.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | Yes |
| < 1.0 | No |

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting:
<https://github.com/putuandy/claude-opencode-mcp/security/advisories/new>

Include:

- affected version (`claude-opencode-mcp --version`),
- OpenCode version (`opencode --version`),
- a minimal reproduction or proof of concept,
- the impact you believe it has,
- any suggested fix.

We aim to acknowledge reports within 72 hours and to ship a fix or mitigation
for confirmed issues as quickly as practical. We will credit reporters in the
advisory unless you prefer otherwise.

## Scope

In scope:

- bypassing workspace validation, `workspace.allowedRoots`, or path-hint checks,
- escaping the agent permission model (e.g. read-only agents writing files,
  `git push`/`git commit` bypass, `.env` protection bypass),
- credential exposure through logs, errors, or network requests,
- command or argument injection in bridge-spawned processes,
- denial of service that hangs or crashes a Claude Code session,
- supply-chain issues in this package's own code or dependencies.

Out of scope (documented behavior, see [docs/security.md](docs/security.md)):

- an agent with shell access can write files through shell commands,
- `.env` protection applies to file tools, not to `bash`,
- prompt injection from repository content influencing a delegated agent,
- arbitrary code execution caused by a binary you explicitly configure via
  `opencode.binary` / `OPENCODE_BIN`,
- vulnerabilities in OpenCode, Claude Code, or model providers themselves
  (report those upstream).

## Threat model summary

The bridge assumes:

- the local user account and the workspace contents are trusted to the degree
  the user chose to delegate,
- the OpenCode server is bound to `127.0.0.1` by default,
- provider credentials live in OpenCode or the environment, never in this
  package's configuration or state.

Defenses: canonical-path workspace validation, allowed-root containment,
path-traversal rejection, an OpenCode permission matrix per agent profile
(no `ask` rules, auto-rejection of stray permission requests), sensitive-file
patterns, git history protections, bounded inputs/outputs, run timeouts and
cancellation, redacted logs, and `0600` state files.

## Hardening recommendations

- Keep `workspace.allowedRoots` narrow when delegating across projects.
- Leave `opencode.hostname` at `127.0.0.1`; binding to a routable address
  exposes the OpenCode HTTP API to your network (and its token/password, if
  set, becomes the only barrier).
- Review diffs with `get_diff` before accepting changes.
- Prefer read-only agents for untrusted repositories.
- Never commit `.claude-opencode/config.json` if you put credentials in it
  (provider credentials belong in OpenCode or environment variables).
