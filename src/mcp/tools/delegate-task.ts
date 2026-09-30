import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveExecutionTimeout } from "../../config/config.js";
import { prepareRun } from "../../opencode/setup.js";
import { requestId } from "../../util/text.js";
import { buildTaskPrompt } from "../../workspace/context.js";
import { resolveWorkspaceHints } from "../../workspace/resolver.js";
import type { AppContext } from "../execute.js";
import { executeRun } from "../execute.js";
import { createDelegatedSession, defaultSessionTitle } from "../session-utils.js";
import { errorResult, jsonResult, type ToolExtra } from "../tool-utils.js";

export const DELEGATE_TASK_DESCRIPTION = [
  "Delegate a software-engineering task to an OpenCode agent (DeepSeek by default) that runs in the same workspace.",
  "The agent explores the repository itself and returns a concise summary plus structured findings.",
  "Every agent can be granted or denied edits and shell access per call with allow_edits / allow_bash;",
  "grants still enforce the bridge security policy (sensitive-file protection for edits, no git history changes for shell).",
  "Returns { status, session_id, summary, findings, files_changed }.",
].join(" ");

export function registerDelegateTask(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "delegate_task",
    {
      title: "Delegate task to OpenCode agent",
      description: DELEGATE_TASK_DESCRIPTION,
      inputSchema: {
        task: z
          .string()
          .min(1)
          .max(50_000)
          .describe("The task to delegate, written as a clear instruction."),
        agent: z
          .string()
          .max(200)
          .optional()
          .describe("Agent to use (default: deepseek-researcher). See list_agents."),
        cwd: z
          .string()
          .max(4_096)
          .optional()
          .describe(
            "Workspace directory. Defaults to CLAUDE_PROJECT_DIR / the server working directory.",
          ),
        paths: z
          .array(z.string().max(4_096))
          .max(200)
          .optional()
          .describe(
            "Starting path hints relative to the workspace. Hints only, not a restriction.",
          ),
        model: z
          .string()
          .max(200)
          .optional()
          .describe('Override the model, e.g. "deepseek/deepseek-v4-pro".'),
        timeout: z
          .number()
          .int()
          .positive()
          .max(3_600_000)
          .optional()
          .describe("Execution timeout in milliseconds (default from bridge config)."),
        allow_edits: z
          .boolean()
          .optional()
          .describe(
            "Grant (true) or revoke (false) file edits for this call. Omit to use the agent's default.",
          ),
        allow_bash: z
          .boolean()
          .optional()
          .describe(
            "Grant (true) or revoke (false) shell commands for this call. Omit to use the agent's default.",
          ),
      },
      annotations: { openWorldHint: true },
    },
    async (
      args: {
        task: string;
        agent?: string;
        cwd?: string;
        paths?: string[];
        model?: string;
        timeout?: number;
        allow_edits?: boolean;
        allow_bash?: boolean;
      },
      extra: ToolExtra,
    ) => {
      const rid = requestId();
      try {
        const prepared = await prepareRun(ctx, {
          cwd: args.cwd,
          agent: args.agent,
          model: args.model,
          ...(args.allow_edits !== undefined ? { allowEdits: args.allow_edits } : {}),
          ...(args.allow_bash !== undefined ? { allowBash: args.allow_bash } : {}),
        });
        const hints = resolveWorkspaceHints(prepared.workspace.cwd, args.paths);
        const session = await createDelegatedSession(
          ctx,
          prepared,
          defaultSessionTitle(prepared.baseAgentName, args.task),
        );
        const text = buildTaskPrompt({
          workspace: prepared.workspace,
          task: args.task,
          hints,
          capabilities: prepared.capabilities,
          agentName: prepared.baseAgentName,
          ...(args.allow_edits !== undefined || args.allow_bash !== undefined
            ? {
                override: {
                  ...(args.allow_edits !== undefined ? { allowEdits: args.allow_edits } : {}),
                  ...(args.allow_bash !== undefined ? { allowBash: args.allow_bash } : {}),
                },
              }
            : {}),
        });
        const timeoutMs = resolveExecutionTimeout(prepared.config, args.timeout);
        const result = await executeRun(ctx, {
          prepared,
          session,
          text,
          timeoutMs,
          extra,
          requestId: rid,
        });
        return jsonResult(result, { isError: result.status !== "completed" });
      } catch (error) {
        ctx.logger.error("delegate_task failed", {
          request_id: rid,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(error, rid);
      }
    },
  );
}
