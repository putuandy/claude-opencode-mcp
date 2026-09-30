# Agent configuration

The bridge ships four agents. Their prompts live in [`agents/`](../agents/) as
markdown with YAML frontmatter, and they are injected into the OpenCode server
configuration at startup.

| Agent | Profile | read | edit | bash | Purpose |
| --- | --- | --- | --- | --- | --- |
| `deepseek-researcher` | `read` | allow | deny | deny | architecture, exploration, dependency analysis, recommendations |
| `deepseek-reviewer` | `review` | allow | deny | deny | code review, bugs, regressions, security, architecture |
| `deepseek-coder` | `code` | allow | allow | allow (no `git commit`/`git push`) | implementation, refactoring, tests |
| `deepseek-tester` | `test` | allow | deny | allow (no `git commit`/`git push`) | run tests, diagnose failures, suggest fixes |

Profiles also deny `external_directory`, `task`, `question` and `doom_loop`, and
never emit `ask` rules (a headless bridge cannot answer them).

## Customizing a built-in agent

Create a project-local file with the same name:

```markdown
---
description: My strict reviewer
model: deepseek/deepseek-v4-pro
temperature: 0
---

You are a security-focused reviewer. ...
```

Place it in `<project>/.claude-opencode/agents/deepseek-reviewer.md`. The file
overrides the description, prompt, model and temperature. Permissions still come
from the `review` profile — the frontmatter cannot widen them.

## Adding a new agent

```markdown
---
description: Database migration specialist
mode: all
profile: code
model: deepseek/deepseek-v4-pro
temperature: 0.1
---

You are a database migration specialist. ...
```

Save it as `<project>/.claude-opencode/agents/db-migrator.md`. It appears in
`list_agents` and can be used with `delegate_task({ agent: "db-migrator" })`.

Supported frontmatter keys:

| Key | Values | Notes |
| --- | --- | --- |
| `description` | string | Shown by `list_agents`; required for usefulness. |
| `mode` | `primary`, `subagent`, `all` | Defaults to `all`. |
| `profile` | `read`, `review`, `code`, `test` | Selects the permission policy. Defaults by name heuristics; unknown names get `read` (safest). |
| `model` | `provider/model` | Overrides the bridge default. |
| `temperature` | number | Passed to the provider. |

The prompt is the markdown body.

## Overriding agents in config

The same values can be set in JSON, which is handy for global defaults:

```json
{
  "agents": {
    "deepseek-coder": { "model": "deepseek/deepseek-v4-pro", "temperature": 0.1 },
    "deepseek-tester": { "enabled": false }
  }
}
```

Precedence: config `agents` > project markdown > built-in markdown.

## Writing a good prompt

The bridge appends the workspace, task, path hints, and permission summary to
every delegated message, and asks agents to finish with a structured response:

- `## Summary`
- `## Findings` for review agents, using
  `- [severity: high] Title (path/to/file:42) — detail` so findings come back
  as structured JSON
- `## Changes`, `## Verification`, `## Follow-ups` for coder agents

Keep custom prompts aligned with that contract: the orchestrator depends on the
structure.

## Orchestrator permission overrides

The orchestrator (Claude Code) can grant or revoke edits and shell access for
any agent, per call:

```json
{
  "agent": "deepseek-researcher",
  "task": "Implement the caching fix and run the tests.",
  "allow_edits": true,
  "allow_bash": true
}
```

| Flag | `true` | `false` | omitted |
| --- | --- | --- | --- |
| `allow_edits` | use the edit-capable profile | deny all file edits | keep the agent default |
| `allow_bash` | use the shell-capable profile | deny shell commands | keep the agent default |

`delegate_task`, `create_session` and `send_message` all accept the flags.
Sessions remember their level (`can_edit` / `can_run_bash` in `create_session`
and `get_session`), and `send_message` can change it from that message onward.

Overrides map to the safe profiles below, so grants never bypass the security
policy:

| Effective capability | Profile | Notes |
| --- | --- | --- |
| no edits, no shell | `read` | default for researcher/reviewer |
| edits only | `edit` | `.env`/credential files still denied for edit |
| shell only | `test` | shell allowed, edits denied, git history protected |
| edits + shell | `code` | full coding profile, git history protected |

The bridge implements overrides with generated variant agents
(`<agent>__edit`, `<agent>__bash`, `<agent>__rw`) that are hidden from
`list_agents`; `__` is therefore reserved in agent names. The task message also
states the granted permissions explicitly, so agents whose prompt describes them
as read-only do not refuse the work.

## What the bridge does not do

- It does not copy repository contents into prompts. Agents read files through
  OpenCode's tools.
- It does not restrict agents to the `paths` hints. Those are starting points;
  agents may inspect anything inside the workspace.
- It does not let a project agent override permissions from frontmatter. Edit
  `security.*` or the bridge source if a policy change is needed.
