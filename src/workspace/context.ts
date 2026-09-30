import type { ProfileCapabilities } from "../security/policy.js";
import type { AgentWorkspace } from "../types/index.js";

export interface TaskContextInput {
  workspace: AgentWorkspace;
  task: string;
  hints: string[];
  capabilities: ProfileCapabilities;
  agentName: string;
  /** Orchestrator permission override for this run, when one was requested. */
  override?: { allowEdits?: boolean | undefined; allowBash?: boolean | undefined };
  /** Compact context is used for follow-up messages inside an existing session. */
  compact?: boolean;
}

function permissionLines(capabilities: ProfileCapabilities): string {
  return [
    `- file edits: ${capabilities.canEdit ? "allowed" : "denied"}`,
    `- shell commands: ${capabilities.canRunBash ? "allowed" : "denied"}`,
    `- read-only agent: ${capabilities.readOnly ? "yes" : "no"}`,
  ].join("\n");
}

function overrideLines(override: TaskContextInput["override"]): string | null {
  if (!override || (override.allowEdits === undefined && override.allowBash === undefined)) {
    return null;
  }
  const lines = ["Override (from the orchestrator for this run):"];
  if (override.allowEdits !== undefined) {
    lines.push(`- file edits: ${override.allowEdits ? "granted" : "revoked"}`);
  }
  if (override.allowBash !== undefined) {
    lines.push(`- shell commands: ${override.allowBash ? "granted" : "revoked"}`);
  }
  lines.push("These take precedence over your role's default restrictions for this run.");
  if (override.allowEdits ?? override.allowBash) {
    lines.push("You may now perform the actions granted above when the task requires it.");
  }
  return lines.join("\n");
}

function instructionLines(capabilities: ProfileCapabilities): string {
  const lines = [
    "- Work inside the specified workspace; do not read or write outside it.",
    "- Inspect additional files and directories whenever that helps the task.",
    "- Do not assume relevant code exists only under the supplied path hints.",
    "- Your final message is consumed by an orchestrating agent: be concise, factual and specific.",
  ];
  if (!capabilities.canEdit) {
    lines.push("- You are read-only: do not modify any file, even through shell commands.");
  } else {
    lines.push(
      "- Keep changes minimal and focused; run the relevant tests or checks when possible.",
    );
    lines.push(
      "- Never run `git commit`, `git push`, or any other git command that rewrites history.",
    );
  }
  if (capabilities.canRunBash && !capabilities.canEdit) {
    lines.push(
      "- Only run commands needed for inspection, building or testing; never write files.",
    );
  }
  return lines.join("\n");
}

export function buildTaskPrompt(input: TaskContextInput): string {
  const { workspace, task, hints, capabilities, agentName } = input;
  const hintLines =
    hints.length > 0
      ? hints.map((hint) => `- ${hint}`).join("\n")
      : "- none supplied; discover the relevant files yourself";
  const override = overrideLines(input.override);

  if (input.compact) {
    return [
      `Workspace: ${workspace.cwd}`,
      workspace.gitRoot ? `Git root: ${workspace.gitRoot}` : null,
      `Agent: ${agentName}`,
      "",
      "Task:",
      task,
      "",
      "Constraints:",
      permissionLines(capabilities),
      override,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  return [
    "Workspace:",
    workspace.cwd,
    workspace.gitRoot ? `Git root: ${workspace.gitRoot}` : "Git root: (not a git repository)",
    "",
    `Agent: ${agentName}`,
    "",
    "Task:",
    task,
    "",
    "Relevant paths (starting points only, not a boundary):",
    hintLines,
    "",
    "Permissions:",
    permissionLines(capabilities),
    override,
    "",
    "Instructions:",
    instructionLines(capabilities),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
