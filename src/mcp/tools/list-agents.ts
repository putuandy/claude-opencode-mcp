import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  agentCapabilities,
  buildAgentDefinitions,
  isVariantAgentName,
  loadProjectAgentDefinitions,
} from "../../opencode/agents.js";
import { getBuiltinDefinitions } from "../../opencode/setup.js";
import { requestId } from "../../util/text.js";
import { resolveWorkspace } from "../../workspace/resolver.js";
import { type AppContext, loadWorkspaceConfig } from "../execute.js";
import { errorResult, jsonResult } from "../tool-utils.js";

export function registerListAgents(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "list_agents",
    {
      title: "List available delegated agents",
      description:
        "List the agents that delegate_task and create_session can use, including project-local agents from .claude-opencode/agents.",
      inputSchema: {
        cwd: z
          .string()
          .max(4_096)
          .optional()
          .describe("Workspace used to discover project-local agents (optional)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args: { cwd?: string }) => {
      const rid = requestId();
      try {
        let config = ctx.globalConfig;
        let cwd: string | null = null;
        try {
          const resolution = await resolveWorkspace({
            cwd: args.cwd,
            env: ctx.env,
            globalConfig: ctx.globalConfig,
            ...(ctx.loadProjectConfig ? { loadProjectConfig: ctx.loadProjectConfig } : {}),
          });
          config = resolution.config;
          cwd = resolution.workspace.cwd;
        } catch {
          config = await loadWorkspaceConfig(ctx, process.cwd()).catch(() => ctx.globalConfig);
        }

        const [builtin, project] = await Promise.all([
          getBuiltinDefinitions(),
          cwd ? loadProjectAgentDefinitions(cwd) : Promise.resolve([]),
        ]);
        const definitions = buildAgentDefinitions({ builtin, project, config });

        return jsonResult({
          default_agent: config.defaults.agent,
          default_provider: config.defaults.provider,
          default_model: config.defaults.model,
          workspace: cwd,
          permission_overrides:
            "delegate_task / create_session / send_message accept allow_edits and allow_bash (true grants, false revokes, omitted keeps the agent default).",
          agents: definitions
            .filter((definition) => !isVariantAgentName(definition.name))
            .map((definition) => {
              const capabilities = agentCapabilities(definition);
              return {
                name: definition.name,
                description: definition.description,
                mode: definition.mode,
                read_only: capabilities.readOnly,
                can_edit: capabilities.canEdit,
                can_run_bash: capabilities.canRunBash,
                model: definition.model ?? config.defaults.model,
                source: definition.source,
              };
            }),
        });
      } catch (error) {
        ctx.logger.error("list_agents failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}
