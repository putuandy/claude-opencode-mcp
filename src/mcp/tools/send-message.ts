import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveExecutionTimeout } from "../../config/config.js";
import { prepareRun } from "../../opencode/setup.js";
import { requestId } from "../../util/text.js";
import { buildTaskPrompt } from "../../workspace/context.js";
import type { AppContext } from "../execute.js";
import { assertSession, executeRun } from "../execute.js";
import { errorResult, jsonResult, type ToolExtra } from "../tool-utils.js";

export function registerSendMessage(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "send_message",
    {
      title: "Send a follow-up message to a session",
      description:
        "Continue an existing delegated session with another message. The agent keeps its previous context, so follow-ups can build on earlier exploration and edits.",
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .max(200)
          .describe("Session id returned by delegate_task/create_session."),
        message: z.string().min(1).max(50_000).describe("Follow-up instruction or question."),
      },
      annotations: { openWorldHint: true },
    },
    async (args: { session_id: string; message: string }, extra: ToolExtra) => {
      const rid = requestId();
      try {
        const session = assertSession(ctx.registry.get(args.session_id), args.session_id);
        const prepared = await prepareRun(ctx, {
          cwd: session.cwd,
          agent: session.agent,
          model: session.model ?? undefined,
        });
        const text = buildTaskPrompt({
          workspace: prepared.workspace,
          task: args.message,
          hints: [],
          capabilities: prepared.capabilities,
          agentName: prepared.definition.name,
          compact: true,
        });
        const timeoutMs = resolveExecutionTimeout(prepared.config);
        const result = await executeRun(ctx, {
          prepared,
          session,
          text,
          timeoutMs,
          disableEdits: false,
          extra,
          requestId: rid,
        });
        return jsonResult(result, { isError: result.status !== "completed" });
      } catch (error) {
        ctx.logger.error("send_message failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}
