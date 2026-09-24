import fs from "node:fs";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { LoadedConfig, ResolvedConfig } from "../config/config.js";
import { BridgeError } from "../errors.js";
import type { ProfileCapabilities } from "../security/policy.js";
import type { AgentDefinition, AgentWorkspace } from "../types/index.js";
import type { Logger } from "../util/logger.js";
import { type ResolveWorkspaceInput, resolveWorkspace } from "../workspace/resolver.js";
import {
  agentCapabilities,
  buildAgentDefinitions,
  findAgentDefinition,
  loadBuiltinAgentDefinitions,
  loadProjectAgentDefinitions,
  toOpenCodeAgentConfig,
} from "./agents.js";
import type { OpenCodeManager } from "./manager.js";
import { formatModelRef, type ModelRef, resolveModel } from "./run.js";

export interface PrepareRunInput {
  cwd?: string | undefined;
  agent?: string | undefined;
  model?: string | undefined;
}

export interface PreparedRun {
  workspace: AgentWorkspace;
  config: ResolvedConfig;
  definitions: AgentDefinition[];
  definition: AgentDefinition;
  capabilities: ProfileCapabilities;
  client: OpencodeClient;
  serverKey: string;
  model: ModelRef | null;
  modelString: string | null;
}

export interface PrepareDeps {
  manager: OpenCodeManager;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  globalConfig: ResolvedConfig;
  /** Override per-workspace config loading (tests/embedding). */
  loadProjectConfig?: (cwd: string) => Promise<LoadedConfig>;
}

let builtinCache: AgentDefinition[] | null = null;

const verifiedClients = new WeakSet<OpencodeClient>();

/**
 * Ask the OpenCode instance which directory it is serving and refuse to
 * delegate when it is not the requested workspace. This is the last line of
 * defence against a misrouted request reaching the wrong repository.
 */
async function assertWorkspaceRouting(
  client: OpencodeClient,
  workspace: AgentWorkspace,
  logger: Logger,
): Promise<void> {
  if (verifiedClients.has(client)) return;

  let served: string | undefined;
  try {
    const result = await client.path.get();
    if (result.error) {
      logger.debug("workspace routing probe returned an error", {
        error: JSON.stringify(result.error),
      });
      return;
    }
    served = result.data?.directory;
  } catch (error) {
    logger.debug("workspace routing probe failed; continuing without it", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!served) return;

  let servedCanonical = served;
  try {
    servedCanonical = await fs.promises.realpath(served);
  } catch {
    // keep the server-reported path
  }
  if (servedCanonical !== workspace.cwd) {
    throw new BridgeError(
      "WORKSPACE_MISMATCH",
      `OpenCode is serving ${servedCanonical} but the workspace is ${workspace.cwd}.`,
      { details: { requested: workspace.cwd, served: servedCanonical } },
    );
  }
  verifiedClients.add(client);
}

export async function getBuiltinDefinitions(): Promise<AgentDefinition[]> {
  if (!builtinCache) builtinCache = await loadBuiltinAgentDefinitions();
  return builtinCache;
}

export function clearBuiltinCache(): void {
  builtinCache = null;
}

export async function prepareRun(
  deps: PrepareDeps,
  input: PrepareRunInput,
  workspaceOverride?: AgentWorkspace,
): Promise<PreparedRun> {
  const resolution = workspaceOverride
    ? null
    : await resolveWorkspace({
        cwd: input.cwd,
        env: deps.env,
        globalConfig: deps.globalConfig,
        ...(deps.loadProjectConfig ? { loadProjectConfig: deps.loadProjectConfig } : {}),
      } as ResolveWorkspaceInput);

  const workspace = workspaceOverride ?? resolution!.workspace;
  const config = resolution?.config ?? deps.globalConfig;

  const [builtin, project] = await Promise.all([
    getBuiltinDefinitions(),
    loadProjectAgentDefinitions(workspace.cwd),
  ]);
  const definitions = buildAgentDefinitions({ builtin, project, config });

  const agentName = (input.agent ?? config.defaults.agent).trim();
  const definition = findAgentDefinition(definitions, agentName);
  if (!definition) {
    throw new BridgeError("AGENT_NOT_FOUND", `Unknown agent: ${agentName}`, {
      details: {
        requested: agentName,
        available: definitions.map((entry) => entry.name),
      },
    });
  }

  const agentConfig = toOpenCodeAgentConfig(definitions, config);
  const serverKey = await deps.manager.ensure({
    cwd: workspace.cwd,
    config,
    agentConfig,
  });

  const client = await deps.manager.clientFor({ cwd: workspace.cwd, config, agentConfig });
  await assertWorkspaceRouting(client, workspace, deps.logger);
  const resolved = await resolveModel(client, config, input.model ?? definition.model);

  return {
    workspace: { ...workspace, readOnly: agentCapabilities(definition).readOnly },
    config,
    definitions,
    definition,
    capabilities: agentCapabilities(definition),
    client,
    serverKey,
    model: resolved,
    modelString: formatModelRef(resolved),
  };
}

export async function getClientForWorkspace(
  deps: PrepareDeps,
  workspace: AgentWorkspace,
  definitions: AgentDefinition[],
  config: ResolvedConfig,
): Promise<{ client: OpencodeClient; serverKey: string }> {
  const agentConfig = toOpenCodeAgentConfig(definitions, config);
  const serverKey = await deps.manager.ensure({ cwd: workspace.cwd, config, agentConfig });
  const client = await deps.manager.clientFor({ cwd: workspace.cwd, config, agentConfig });
  await assertWorkspaceRouting(client, workspace, deps.logger);
  return { client, serverKey };
}
