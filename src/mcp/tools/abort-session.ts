import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError } from "../../errors.js";
import { requestId } from "../../util/text.js";
import type { AppContext } from "../execute.js";
import { assertSession } from "../execute.js";
import { errorResult, jsonResult } from "../tool-utils.js";

export function registerAbortSession(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "abort_session",
    {
      title: "Abort a running delegated session",
      description:
        "Stop a long-running or unwanted delegated task. Safe to call when the session is already idle.",
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .max(200)
          .describe("Session id returned by delegate_task/create_session."),
      },
      annotations: { destructiveHint: true },
    },
    async (args: { session_id: string }) => {
      const rid = requestId();
      try {
        const session = assertSession(ctx.registry.get(args.session_id), args.session_id);
        const client = ctx.manager.existingClient(session.cwd);
        if (!client) {
          ctx.registry.setStatus(session.id, "aborted");
          return jsonResult({
            session_id: session.id,
            aborted: true,
            note: "No OpenCode server is running for this workspace; session marked as aborted.",
          });
        }

        const result = await client.session.abort({ path: { id: session.id } });
        if (result.error) {
          throw new BridgeError(
            "OPENCODE_ERROR",
            `OpenCode refused to abort the session: ${JSON.stringify(result.error)}`,
          );
        }
        ctx.registry.setStatus(session.id, "aborted");
        ctx.logger.info("aborted delegated session", { session_id: session.id });
        return jsonResult({ session_id: session.id, aborted: Boolean(result.data) });
      } catch (error) {
        ctx.logger.error("abort_session failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}
