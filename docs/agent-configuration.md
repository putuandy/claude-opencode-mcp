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

## What the bridge does not do

- It does not copy repository contents into prompts. Agents read files through
  OpenCode's tools.
- It does not restrict agents to the `paths` hints. Those are starting points;
  agents may inspect anything inside the workspace.
- It does not let a project agent override permissions from frontmatter. Edit
  `security.*` or the bridge source if a policy change is needed.
