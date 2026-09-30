import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveExecutionTimeout } from "../../config/config.js";
import { effectivePermissionOverride, prepareRun } from "../../opencode/setup.js";
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
        "Continue an existing delegated session with another message. The agent keeps its previous context and its permission level; allow_edits / allow_bash can change that level for this and later messages.",
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .max(200)
          .describe("Session id returned by delegate_task/create_session."),
        message: z.string().min(1).max(50_000).describe("Follow-up instruction or question."),
        allow_edits: z
          .boolean()
          .optional()
          .describe(
            "Grant (true) or revoke (false) file edits from this message onward. Omit to keep the session's current level.",
          ),
        allow_bash: z
          .boolean()
          .optional()
          .describe(
            "Grant (true) or revoke (false) shell commands from this message onward. Omit to keep the session's current level.",
          ),
      },
      annotations: { openWorldHint: true },
    },
    async (
      args: {
        session_id: string;
        message: string;
        allow_edits?: boolean;
        allow_bash?: boolean;
      },
      extra: ToolExtra,
    ) => {
      const rid = requestId();
      try {
        const session = assertSession(ctx.registry.get(args.session_id), args.session_id);
        const prepared = await prepareRun(ctx, {
          cwd: session.cwd,
          agent: session.agent,
          model: session.model ?? undefined,
          allowEdits: args.allow_edits ?? session.canEdit,
          allowBash: args.allow_bash ?? session.canRunBash,
        });
        const override = effectivePermissionOverride(prepared);
        const text = buildTaskPrompt({
          workspace: prepared.workspace,
          task: args.message,
          hints: [],
          capabilities: prepared.capabilities,
          agentName: prepared.baseAgentName,
          compact: true,
          ...(override ? { override } : {}),
        });
        const timeoutMs = resolveExecutionTimeout(prepared.config);

        // Keep the session's permission level in sync with what was used.
        const promptAgent =
          prepared.definition.name !== prepared.baseAgentName
            ? prepared.definition.name
            : undefined;
        const updated: typeof session = {
          ...session,
          ...(promptAgent ? { promptAgent } : { promptAgent: undefined }),
          canEdit: prepared.capabilities.canEdit,
          canRunBash: prepared.capabilities.canRunBash,
        };
        ctx.registry.upsert(updated);

        const result = await executeRun(ctx, {
          prepared,
          session: updated,
          text,
          timeoutMs,
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
