import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError } from "../../errors.js";
import { requestId } from "../../util/text.js";
import { type AppContext, assertSession, loadWorkspaceConfig } from "../execute.js";
import { errorResult, jsonResult } from "../tool-utils.js";

export function registerGetSession(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_session",
    {
      title: "Get delegated session state",
      description:
        "Return the stored state of a delegated session plus its live OpenCode status when a server is running. Use get_diff to inspect file changes.",
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .max(200)
          .describe("Session id returned by delegate_task/create_session."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args: { session_id: string }) => {
      const rid = requestId();
      try {
        const session = assertSession(ctx.registry.get(args.session_id), args.session_id);
        const config = await loadWorkspaceConfig(ctx, session.cwd);
        const maxChars = config.limits.sessionChars;
        const client = ctx.manager.existingClient(session.cwd);

        let liveStatus: string | null = null;
        let serverVersion: string | null = null;
        let live = false;

        if (client) {
          live = true;
          serverVersion = ctx.manager.getExistingServerVersion(session.cwd);
          try {
            const sessionResult = await client.session.get({ path: { id: session.id } });
            if (sessionResult.error) {
              throw new BridgeError(
                "OPENCODE_SESSION_NOT_FOUND",
                `OpenCode no longer knows session ${session.id}.`,
              );
            }
            const statuses = await client.session.status();
            liveStatus = statuses.data?.[session.id]?.type ?? "idle";
          } catch (error) {
            if (error instanceof BridgeError) throw error;
            ctx.logger.debug("could not fetch live session status", {
              session_id: session.id,
              error: error instanceof Error ? error.message : String(error),
            });
            liveStatus = null;
          }
        }

        const summary = session.lastSummary ?? "";
        const clipped = summary.length > maxChars ? `${summary.slice(0, maxChars)}…` : summary;

        return jsonResult({
          session_id: session.id,
          cwd: session.cwd,
          agent: session.agent,
          provider: session.provider,
          model: session.model,
          title: session.title,
          status: session.status,
          created_at: session.createdAt,
          updated_at: session.updatedAt,
          ...(session.lastError ? { last_error: session.lastError } : {}),
          ...(session.lastSummary ? { last_summary: clipped } : {}),
          ...(session.durationMs !== undefined ? { duration_ms: session.durationMs } : {}),
          ...(session.lastMessageID ? { last_message_id: session.lastMessageID } : {}),
          opencode: live
            ? { live: true, status: liveStatus, server_version: serverVersion }
            : { live: false, status: null, server_version: null },
        });
      } catch (error) {
        ctx.logger.error("get_session failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}
