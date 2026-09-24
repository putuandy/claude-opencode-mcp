# Workspace model

The core invariant: **a delegated agent operates against the same intended
workspace as Claude Code, and can inspect it directly through OpenCode's
tools.** No repository copying, no temporary clones for normal operation.

## Resolution

For every tool call the workspace is resolved in this order:

1. explicit `cwd` argument
2. `CLAUDE_PROJECT_DIR` (set by Claude Code for stdio MCP servers)
3. the MCP server process working directory
4. `workspace.defaultCwd` from configuration

Candidates 1 and 2 are *required*: if one of them is present but invalid
(`WORKSPACE_NOT_FOUND`, `WORKSPACE_NOT_READABLE`, `WORKSPACE_NOT_ALLOWED`,
`INVALID_PATH`), the call fails immediately. The bridge never silently falls
back to a different directory for an explicitly requested workspace. Only the
process directory and `defaultCwd` are best-effort fallbacks.

If no candidate can be validated, the error is:

```
WORKSPACE_NOT_FOUND: Unable to determine project workspace. Provide cwd explicitly.
```

## Validation

Before a session is created:

- the path must exist, be a directory, and be readable/executable;
- it is canonicalized with `realpath` (symlinks and `..` are resolved);
- when `workspace.allowedRoots` is configured, the canonical path must live
  inside one of the canonical roots — anything else is rejected with
  `WORKSPACE_NOT_ALLOWED`;
- the git root is detected (`git rev-parse --show-toplevel`) for diff
  baselines and reported as `gitRoot`.

Path traversal (for example `cwd: "../../etc"` or a `paths` hint escaping the
workspace) is rejected with `INVALID_PATH`.

## Path hints

`delegate_task` accepts `paths`:

```json
{
  "task": "Review authentication",
  "paths": ["src/auth", "src/middleware/auth.ts", "tests/auth"]
}
```

Hints are turned into absolute paths, must stay inside the workspace, and are
inserted into the task message as starting points. They are **not** a
filesystem boundary: the agent is explicitly told to inspect additional files
and to not assume everything relevant lives under the hints.

## One server per workspace

The bridge starts one OpenCode server per workspace directory and runs it with
that directory as its working directory. Sessions for that workspace reuse it.
`opencode.maxServers` (default 4) bounds how many idle servers are kept; the
least recently used idle server is stopped when the limit is exceeded.

During the first call for a workspace the bridge asks the server
(`GET /path`) which directory it is serving and compares it with the requested
canonical path. A mismatch aborts with `WORKSPACE_MISMATCH` rather than
delegating into the wrong repository.

## The workspace contract

Internally every run carries:

```ts
interface AgentWorkspace {
  cwd: string;          // canonical absolute directory
  requestedPath: string;
  allowedPaths?: string[];  // reserved; hints are not restrictions
  deniedPaths?: string[];   // reserved; sensitive patterns are enforced via permissions
  gitRoot?: string;
  readOnly: boolean;    // derived from the agent profile
}
```

and the agent message always contains:

```text
Workspace:
/abs/path

Task:
...

Relevant paths (starting points only, not a boundary):
- /abs/path/src/auth

Permissions:
- file edits: denied
- shell commands: denied
- read-only agent: yes

Instructions:
- Work inside the specified workspace; do not read or write outside it.
- Inspect additional files and directories whenever that helps the task.
- Do not assume relevant code exists only under the supplied path hints.
...
```

## Demo: two repositories

```text
repo-a/
  ONLY_A.txt
repo-b/
  ONLY_B.txt
```

Delegating to each with the same task ("list the root .txt file and report its
contents") returns `alpha-42` for repo-a and `beta-99` for repo-b. This scenario
is covered by the end-to-end test suite (`tests/e2e/real-opencode.test.ts`).

## Choosing a workspace without Claude Code

Any MCP client can pass `cwd` explicitly. Claude Code additionally provides
`CLAUDE_PROJECT_DIR`, which makes the common case zero-configuration.
