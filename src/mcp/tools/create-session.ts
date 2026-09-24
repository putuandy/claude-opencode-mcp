import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prepareRun } from "../../opencode/setup.js";
import { requestId } from "../../util/text.js";
import type { AppContext } from "../execute.js";
import { createDelegatedSession, defaultSessionTitle } from "../session-utils.js";
import { errorResult, jsonResult } from "../tool-utils.js";

export function registerCreateSession(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "create_session",
    {
      title: "Create a persistent OpenCode agent session",
      description:
        "Create a persistent delegation session in a workspace without running a task yet. Follow up with send_message to keep the agent's context between calls.",
      inputSchema: {
        cwd: z.string().min(1).max(4_096).describe("Workspace directory for the session."),
        agent: z
          .string()
          .max(200)
          .optional()
          .describe("Agent to use (default: deepseek-researcher). See list_agents."),
        model: z
          .string()
          .max(200)
          .optional()
          .describe('Override the model, e.g. "deepseek/deepseek-v4-pro".'),
        title: z.string().max(500).optional().describe("Human-readable session title."),
      },
      annotations: { openWorldHint: true },
    },
    async (args: { cwd: string; agent?: string; model?: string; title?: string }) => {
      const rid = requestId();
      try {
        const prepared = await prepareRun(ctx, {
          cwd: args.cwd,
          agent: args.agent,
          model: args.model,
        });
        const session = await createDelegatedSession(
          ctx,
          prepared,
          args.title ?? defaultSessionTitle(prepared.definition.name, "session"),
        );
        return jsonResult({
          session_id: session.id,
          cwd: session.cwd,
          agent: session.agent,
          model: session.model,
          title: session.title,
          status: session.status,
          created_at: session.createdAt,
        });
      } catch (error) {
        ctx.logger.error("create_session failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}
