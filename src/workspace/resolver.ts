import path from "node:path";
import { type LoadedConfig, loadConfig, type ResolvedConfig } from "../config/config.js";
import { BridgeError } from "../errors.js";
import { resolvePathHint } from "../security/paths.js";
import type { AgentWorkspace } from "../types/index.js";
import { type ValidatedWorkspace, validateWorkspace } from "./validator.js";

export interface ResolveWorkspaceInput {
  /** Explicit cwd supplied to the MCP tool. */
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Global config loaded before workspace resolution. */
  globalConfig?: ResolvedConfig;
  /** Override how per-workspace configuration is loaded (used for tests/embedding). */
  loadProjectConfig?: (cwd: string) => Promise<LoadedConfig>;
}

export interface WorkspaceResolution {
  workspace: AgentWorkspace;
  config: ResolvedConfig;
  configSources: string[];
  warnings: string[];
}

export interface WorkspaceCandidate {
  path: string;
  required: boolean;
  origin: "cwd" | "CLAUDE_PROJECT_DIR" | "process.cwd" | "workspace.defaultCwd";
}

/**
 * Workspace resolution priority (PRD §4.1):
 *   1. explicit `cwd`
 *   2. `CLAUDE_PROJECT_DIR` (set by Claude Code for stdio MCP servers)
 *   3. the MCP server process working directory
 *   4. configured `workspace.defaultCwd`
 *
 * The first two are "required": when they are present and invalid the bridge
 * fails loudly instead of silently delegating somewhere else.
 */
export function candidateWorkspacePaths(input: ResolveWorkspaceInput): WorkspaceCandidate[] {
  const env = input.env ?? process.env;
  const candidates: WorkspaceCandidate[] = [];
  if (input.cwd?.trim()) {
    candidates.push({ path: input.cwd.trim(), required: true, origin: "cwd" });
  }
  const claudeProjectDir = env.CLAUDE_PROJECT_DIR;
  if (claudeProjectDir?.trim()) {
    candidates.push({
      path: claudeProjectDir.trim(),
      required: true,
      origin: "CLAUDE_PROJECT_DIR",
    });
  }
  candidates.push({ path: process.cwd(), required: false, origin: "process.cwd" });
  const defaultCwd = input.globalConfig?.workspace.defaultCwd;
  if (defaultCwd?.trim()) {
    candidates.push({ path: defaultCwd.trim(), required: false, origin: "workspace.defaultCwd" });
  }

  const seen = new Set<string>();
  const unique: WorkspaceCandidate[] = [];
  for (const candidate of candidates) {
    const key = path.resolve(candidate.path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

export async function resolveWorkspace(
  input: ResolveWorkspaceInput = {},
): Promise<WorkspaceResolution> {
  const env = input.env ?? process.env;
  let baseConfig: ResolvedConfig;
  if (input.globalConfig) {
    baseConfig = input.globalConfig;
  } else {
    baseConfig = (await loadConfig({ env })).config;
  }

  const candidates = candidateWorkspacePaths({ ...input, env });
  const failures: string[] = [];

  for (const candidate of candidates) {
    let validated: ValidatedWorkspace;
    try {
      validated = await validateWorkspace({
        requestedPath: candidate.path,
        allowedRoots: baseConfig.workspace.allowedRoots,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (candidate.required) throw error;
      failures.push(`${candidate.origin} (${candidate.path}): ${message}`);
      continue;
    }

    let loaded: LoadedConfig;
    try {
      loaded = input.loadProjectConfig
        ? await input.loadProjectConfig(validated.cwd)
        : await loadConfig({ cwd: validated.cwd, env });
    } catch (error) {
      if (error instanceof BridgeError && error.code === "CONFIG_INVALID") throw error;
      loaded = { config: baseConfig, sources: [] };
    }

    let finalValidated = validated;
    const rootsChanged =
      loaded.config.workspace.allowedRoots.join("\u0000") !==
      baseConfig.workspace.allowedRoots.join("\u0000");
    if (rootsChanged) {
      finalValidated = await validateWorkspace({
        requestedPath: validated.cwd,
        allowedRoots: loaded.config.workspace.allowedRoots,
      });
    }

    const workspace: AgentWorkspace = {
      cwd: validated.cwd,
      requestedPath: validated.requestedPath,
      readOnly: false,
      ...(finalValidated.gitRoot ? { gitRoot: finalValidated.gitRoot } : {}),
    };

    return {
      workspace,
      config: loaded.config,
      configSources: loaded.sources,
      warnings: [...finalValidated.warnings],
    };
  }

  throw new BridgeError(
    "WORKSPACE_NOT_FOUND",
    "Unable to determine project workspace. Provide cwd explicitly.",
    { details: { candidates: candidates.map((c) => `${c.origin}:${c.path}`), failures } },
  );
}

export function resolveWorkspaceHints(cwd: string, hints: string[] | undefined): string[] {
  if (!hints || hints.length === 0) return [];
  return hints.map((hint) => resolvePathHint(cwd, hint));
}
