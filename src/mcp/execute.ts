import type { LoadedConfig, ResolvedConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { BridgeError, isBridgeError } from "../errors.js";
import type { OpenCodeManager } from "../opencode/manager.js";
import { runPrompt } from "../opencode/run.js";
import type { SessionRegistry } from "../opencode/sessions.js";
import type { PreparedRun } from "../opencode/setup.js";
import type { AgentSession, DelegateResult } from "../types/index.js";
import { diffSinceBaseline, type GitBaseline } from "../util/git.js";
import type { Logger } from "../util/logger.js";
import { truncate } from "../util/text.js";
import { createProgressReporter, type ToolExtra } from "./tool-utils.js";

export interface AppContext {
  logger: Logger;
  manager: OpenCodeManager;
  registry: SessionRegistry;
  globalConfig: ResolvedConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  /** Override per-workspace config loading (tests/embedding). */
  loadProjectConfig?: (cwd: string) => Promise<LoadedConfig>;
}

export async function loadWorkspaceConfig(ctx: AppContext, cwd: string): Promise<ResolvedConfig> {
  if (ctx.loadProjectConfig) {
    return (await ctx.loadProjectConfig(cwd)).config;
  }
  return (await loadConfig({ cwd, env: ctx.env })).config;
}

export interface ExecuteRunInput {
  prepared: PreparedRun;
  session: AgentSession;
  text: string;
  timeoutMs: number;
  disableEdits: boolean;
  extra: ToolExtra;
  requestId: string;
}

export async function executeRun(ctx: AppContext, input: ExecuteRunInput): Promise<DelegateResult> {
  const { prepared, session } = input;
  const progress = createProgressReporter(input.extra, ctx.logger, input.requestId);
  const runLogger = ctx.logger.child({
    request_id: input.requestId,
    session_id: session.id,
    agent: session.agent,
    cwd: session.cwd,
  });

  ctx.registry.update(session.id, { status: "running", lastError: undefined });
  ctx.manager.beginRun(prepared.serverKey, session.id);

  try {
    const result = await runPrompt({
      client: prepared.client,
      sessionId: session.id,
      agent: session.agent,
      model: prepared.model,
      text: input.text,
      timeoutMs: input.timeoutMs,
      disableEdits: input.disableEdits,
      ...(progress ? { onProgress: progress } : {}),
      ...(input.extra.signal ? { signal: input.extra.signal } : {}),
      logger: runLogger,
    });

    const truncatedSummary = truncate(result.summary, prepared.config.limits.summaryChars);
    const filesChanged = await countChangedFiles(session);

    const status: AgentSession["status"] =
      result.status === "completed"
        ? "completed"
        : result.status === "timeout"
          ? "timeout"
          : "failed";

    ctx.registry.update(session.id, {
      status,
      ...(truncatedSummary.text ? { lastSummary: truncatedSummary.text } : {}),
      ...(result.error
        ? { lastError: { code: result.error.code, message: result.error.message } }
        : { lastError: undefined }),
      durationMs: result.durationMs,
      ...(result.messageID ? { lastMessageID: result.messageID } : {}),
    });

    runLogger.info("delegated run finished", {
      status: result.status,
      duration_ms: result.durationMs,
      files_changed: filesChanged,
      findings: result.findings.length,
    });

    return {
      status: result.status,
      session_id: session.id,
      agent: session.agent,
      cwd: session.cwd,
      model: prepared.modelString,
      summary: truncatedSummary.text,
      findings: result.findings,
      files_changed: filesChanged,
      duration_ms: result.durationMs,
      truncated: truncatedSummary.truncated,
      ...(result.error
        ? {
            error: {
              code: result.error.code,
              message: result.error.message,
              ...(result.error.details ? { details: result.error.details } : {}),
            },
          }
        : {}),
    };
  } catch (error) {
    const code = isBridgeError(error) ? error.code : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    ctx.registry.update(session.id, {
      status: code === "AGENT_ABORTED" ? "aborted" : "failed",
      lastError: { code, message },
    });
    throw error;
  } finally {
    ctx.manager.endRun(prepared.serverKey, session.id);
  }
}

export async function countChangedFiles(session: AgentSession): Promise<number> {
  const baseline: GitBaseline | null = session.baseline
    ? {
        head: session.baseline.head,
        stashRef: session.baseline.stashRef,
        untracked: session.baseline.untracked,
        unborn: session.baseline.unborn,
        dirty: session.baseline.stashRef !== null,
      }
    : null;
  if (!baseline) return 0;
  try {
    const diff = await diffSinceBaseline(session.cwd, baseline, {
      maxPatchChars: 20_000,
      maxNewFiles: 50,
    });
    return diff.files.length;
  } catch {
    return 0;
  }
}

export function assertSession(session: AgentSession | null, sessionId: string): AgentSession {
  if (!session) {
    throw new BridgeError("OPENCODE_SESSION_NOT_FOUND", `Unknown session: ${sessionId}`, {
      details: {
        session_id: sessionId,
        hint: "Create a session with create_session or delegate_task first.",
      },
    });
  }
  return session;
}
