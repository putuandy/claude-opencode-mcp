import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { z } from "zod";
import { BridgeError } from "../../errors.js";
import type { DiffResult } from "../../types/index.js";
import { diffSinceBaseline, type GitBaseline } from "../../util/git.js";
import { requestId, truncate } from "../../util/text.js";
import { type AppContext, assertSession, loadWorkspaceConfig } from "../execute.js";
import { errorResult, jsonResult } from "../tool-utils.js";

function baselineFromSession(sessionBaseline: {
  head: string | null;
  stashRef: string | null;
  untracked: string[];
  unborn: boolean;
}): GitBaseline {
  return {
    head: sessionBaseline.head,
    stashRef: sessionBaseline.stashRef,
    untracked: sessionBaseline.untracked,
    unborn: sessionBaseline.unborn,
    dirty: sessionBaseline.stashRef !== null,
  };
}

async function opencodeDiff(
  client: OpencodeClient,
  sessionId: string,
): Promise<DiffResult["opencodeDiff"] | null> {
  try {
    const result = await client.session.diff({ path: { id: sessionId } });
    if (result.error || !result.data || result.data.length === 0) return null;
    return result.data;
  } catch {
    return null;
  }
}

export function registerGetDiff(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_diff",
    {
      title: "Inspect changes made in a session",
      description:
        "Return the file changes associated with a delegated session: OpenCode's own session diff when available, otherwise a git diff against the baseline captured when the session was created.",
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
        const client = ctx.manager.existingClient(session.cwd);

        const fromOpencode = client ? await opencodeDiff(client, session.id) : null;
        if (fromOpencode && fromOpencode.length > 0) {
          const files = fromOpencode.map((entry) => ({
            file: entry.file,
            additions: entry.additions,
            deletions: entry.deletions,
            status: "modified" as const,
          }));
          const rendered = fromOpencode
            .map(
              (entry) =>
                `diff --git a/${entry.file} b/${entry.file}\n--- a/${entry.file}\n+++ b/${entry.file}\n@@ +${entry.additions} -${entry.deletions} @@`,
            )
            .join("\n");
          const truncated = truncate(rendered, config.limits.diffChars);
          return jsonResult({
            session_id: session.id,
            cwd: session.cwd,
            source: "opencode",
            files,
            diff: truncated.text,
            truncated: truncated.truncated,
          });
        }

        if (!session.baseline) {
          throw new BridgeError(
            "DIFF_UNAVAILABLE",
            "No file changes are available for this session.",
            {
              details: {
                session_id: session.id,
                cwd: session.cwd,
                reason:
                  "The workspace was not a git repository when the session was created and OpenCode reported no session diff.",
              },
            },
          );
        }

        const result = await diffSinceBaseline(session.cwd, baselineFromSession(session.baseline), {
          maxPatchChars: config.limits.diffChars,
        });
        return jsonResult({
          session_id: session.id,
          cwd: session.cwd,
          source: "git",
          files: result.files,
          diff: result.patch,
          truncated: result.truncated,
          ...(result.note ? { note: result.note } : {}),
        });
      } catch (error) {
        ctx.logger.error("get_diff failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}
