import type { SecurityConfig } from "../config/config.js";
import type { PermissionAction, PermissionConfig, PermissionRule } from "../types/index.js";
import { DEFAULT_SENSITIVE_PATTERNS, SENSITIVE_ALLOWLIST } from "./paths.js";

export type AgentProfile = "read" | "review" | "edit" | "code" | "test";

export interface ProfileCapabilities {
  readOnly: boolean;
  canEdit: boolean;
  canRunBash: boolean;
}

export const PROFILE_CAPABILITIES: Record<AgentProfile, ProfileCapabilities> = {
  read: { readOnly: true, canEdit: false, canRunBash: false },
  review: { readOnly: true, canEdit: false, canRunBash: false },
  edit: { readOnly: false, canEdit: true, canRunBash: false },
  code: { readOnly: false, canEdit: true, canRunBash: true },
  test: { readOnly: true, canEdit: false, canRunBash: true },
};

/** Pick the profile that matches an edit/shell capability combination. */
export function profileForCapabilities(canEdit: boolean, canRunBash: boolean): AgentProfile {
  if (canEdit && canRunBash) return "code";
  if (canEdit) return "edit";
  if (canRunBash) return "test";
  return "read";
}

function sensitiveFileRules(security: SecurityConfig): PermissionRule {
  if (!security.protectEnvFiles) return "allow";
  const rules: Record<string, PermissionAction> = { "*": "allow" };
  for (const pattern of DEFAULT_SENSITIVE_PATTERNS) rules[pattern] = "deny";
  for (const pattern of SENSITIVE_ALLOWLIST) rules[pattern] = "allow";
  for (const pattern of security.extraProtectedPatterns ?? []) rules[pattern] = "deny";
  return rules;
}

function gitSafetyBashRules(security: SecurityConfig): Record<string, PermissionAction> {
  const rules: Record<string, PermissionAction> = { "*": "allow" };
  if (security.denyGitPush) {
    rules["git push*"] = "deny";
    rules["git -C * push*"] = "deny";
    rules["git -c * push*"] = "deny";
  }
  if (security.denyGitCommit) {
    rules["git commit*"] = "deny";
    rules["git -C * commit*"] = "deny";
    rules["git -c * commit*"] = "deny";
  }
  return rules;
}

/**
 * Build the OpenCode permission config for an agent profile.
 *
 * `ask` is deliberately never emitted: the bridge is headless and an `ask`
 * rule would leave a delegated agent waiting for a human forever.
 */
export function buildPermissions(
  profile: AgentProfile,
  security: SecurityConfig,
): PermissionConfig {
  const capabilities = PROFILE_CAPABILITIES[profile];
  const externalDirectory: PermissionAction = security.externalDirectory ?? "deny";
  const base: PermissionConfig = {
    read: sensitiveFileRules(security),
    glob: "allow",
    grep: "allow",
    list: "allow",
    todowrite: "allow",
    webfetch: "allow",
    websearch: "allow",
    lsp: "allow",
    skill: "allow",
    task: "deny",
    question: "deny",
    doom_loop: "deny",
    external_directory: externalDirectory,
  };

  if (capabilities.canEdit) {
    base.edit = sensitiveFileRules(security);
  } else {
    base.edit = "deny";
  }

  if (capabilities.canRunBash) {
    base.bash = gitSafetyBashRules(security);
  } else {
    base.bash = "deny";
  }

  return base;
}

export function profileForAgent(name: string): AgentProfile | null {
  switch (name) {
    case "deepseek-researcher":
      return "read";
    case "deepseek-reviewer":
      return "review";
    case "deepseek-coder":
      return "code";
    case "deepseek-tester":
      return "test";
    default:
      return null;
  }
}
