import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveOpenCodeBinary } from "../../opencode/binary.js";
import { listOpenCodeModels, PROVIDER_ID_PATTERN } from "../../opencode/models.js";
import { requestId } from "../../util/text.js";
import { resolveWorkspace } from "../../workspace/resolver.js";
import type { AppContext } from "../execute.js";
import { errorResult, jsonResult } from "../tool-utils.js";

export function registerListModels(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "list_models",
    {
      title: "List available models per provider",
      description:
        "List every model OpenCode can use in the workspace, grouped by provider (from `opencode models`). Any of them can be passed as `model` to delegate_task / create_session with any agent.",
      inputSchema: {
        cwd: z
          .string()
          .max(4_096)
          .optional()
          .describe("Workspace whose OpenCode config (project providers) to include."),
        provider: z
          .string()
          .max(200)
          .regex(PROVIDER_ID_PATTERN)
          .optional()
          .describe('Only list this provider, e.g. "deepseek".'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args: { cwd?: string; provider?: string }) => {
      const rid = requestId();
      try {
        const { workspace, config } = await resolveWorkspace({
          cwd: args.cwd,
          env: ctx.env,
          globalConfig: ctx.globalConfig,
          ...(ctx.loadProjectConfig ? { loadProjectConfig: ctx.loadProjectConfig } : {}),
        });
        const binary = await resolveOpenCodeBinary({
          configured: config.opencode.binary,
          env: ctx.env,
        });
        const providers = await listOpenCodeModels(binary.command, workspace.cwd, args.provider);
        return jsonResult({
          default_provider: config.defaults.provider,
          default_model: config.defaults.model,
          providers,
        });
      } catch (error) {
        ctx.logger.error("list_models failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}
