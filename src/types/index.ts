import type { FileDiff } from "@opencode-ai/sdk";

/** The resolved, validated workspace a delegated agent operates in. */
export interface AgentWorkspace {
  /** Canonical (realpath) absolute directory the agent works in. */
  cwd: string;
  /** The path the caller asked for, before canonicalization. */
  requestedPath: string;
  /** Optional soft hints supplied with the task. Never a hard restriction. */
  allowedPaths?: string[];
  /** Paths that are protected by policy (informational). */
  deniedPaths?: string[];
  /** Canonical git repository root, when the workspace is inside one. */
  gitRoot?: string;
  /** Whether the selected agent is restricted to read-only operation. */
  readOnly: boolean;
  /** OpenCode project identifier for the workspace. */
  projectID?: string;
}

export type SessionStatus = "pending" | "running" | "completed" | "failed" | "aborted" | "timeout";

/** A delegated task/agent session tracked by the bridge. */
export interface AgentSession {
  id: string;
  cwd: string;
  /** Base agent name shown to the orchestrator. */
  agent: string;
  /** Permission-variant agent used for prompts, when it differs from `agent`. */
  promptAgent?: string;
  /** Effective per-session capabilities (orchestrator overrides included). */
  canEdit?: boolean;
  canRunBash?: boolean;
  provider: string | null;
  model: string | null;
  title: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /** OpenCode message id of the last assistant response, when known. */
  lastMessageID?: string;
  /** Bridge-level result summary of the last completed run. */
  lastSummary?: string;
  lastError?: { code: string; message: string };
  durationMs?: number;
  /** Git baseline captured when the session was created (for diff isolation). */
  baseline?: {
    head: string | null;
    stashRef: string | null;
    untracked: string[];
    unborn: boolean;
  };
}

export interface Finding {
  severity?: string;
  title: string;
  detail?: string;
  file?: string;
  line?: number;
}

export interface DelegateResult {
  status: "completed" | "failed" | "aborted" | "timeout";
  session_id: string;
  agent: string;
  cwd: string;
  model: string | null;
  summary: string;
  findings: Finding[];
  files_changed: number;
  duration_ms: number;
  truncated: boolean;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface AgentInfo {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  readOnly: boolean;
  canEdit: boolean;
  canRunBash: boolean;
  model: string | null;
  source: "builtin" | "project" | "opencode";
}

export type PermissionAction = "allow" | "ask" | "deny";
export type PermissionRule = PermissionAction | Record<string, PermissionAction>;
export type PermissionConfig = Record<string, PermissionRule>;

export interface AgentDefinition {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  prompt: string;
  permission: PermissionConfig;
  model: string | null;
  temperature?: number;
  /** Permission profile override (only honoured for project/configured agents). */
  profile?: import("../security/policy.js").AgentProfile;
  source: "builtin" | "project";
}

export interface RunProgress {
  progress: number;
  total?: number;
  message: string;
}

export interface RunResult {
  status: "completed" | "failed" | "timeout";
  summary: string;
  findings: Finding[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
  durationMs: number;
  messageID?: string;
  truncated: boolean;
}

export interface DiffFileSummary {
  file: string;
  additions: number;
  deletions: number;
  status: "modified" | "added" | "deleted" | "renamed" | "unknown";
}

export interface DiffResult {
  session_id: string;
  cwd: string;
  source: "opencode" | "git";
  files: DiffFileSummary[];
  diff: string;
  truncated: boolean;
  note?: string;
  /** Raw OpenCode file diffs, when available. */
  opencodeDiff?: FileDiff[];
}
