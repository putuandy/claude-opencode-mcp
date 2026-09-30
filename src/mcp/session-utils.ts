import { BridgeError } from "../errors.js";
import { createSessionRecord } from "../opencode/sessions.js";
import type { PreparedRun } from "../opencode/setup.js";
import type { AgentSession } from "../types/index.js";
import { captureGitBaseline } from "../util/git.js";
import type { AppContext } from "./execute.js";

export function defaultSessionTitle(agent: string, task: string): string {
  const cleaned = task.replace(/\s+/g, " ").trim();
  const short = cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned;
  return `${agent}: ${short || "delegated task"}`;
}

export async function createDelegatedSession(
  ctx: AppContext,
  prepared: PreparedRun,
  title?: string | null,
): Promise<AgentSession> {
  const baseline = await captureGitBaseline(prepared.workspace.cwd);
  let opencodeId: string;
  try {
    const result = await prepared.client.session.create({
      body: { title: title?.trim() ? title.trim() : undefined },
    });
    if (result.error || !result.data) {
      throw new BridgeError("OPENCODE_ERROR", "OpenCode did not return a session id.", {
        details: { error: result.error },
      });
    }
    opencodeId = result.data.id;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(
      "OPENCODE_UNAVAILABLE",
      `Could not create an OpenCode session: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, retryable: true },
    );
  }

  const session = createSessionRecord({
    id: opencodeId,
    cwd: prepared.workspace.cwd,
    agent: prepared.baseAgentName,
    ...(prepared.definition.name !== prepared.baseAgentName
      ? { promptAgent: prepared.definition.name }
      : {}),
    canEdit: prepared.capabilities.canEdit,
    canRunBash: prepared.capabilities.canRunBash,
    provider: prepared.model?.providerID ?? null,
    model: prepared.modelString,
    title: title?.trim() ? title.trim() : null,
    ...(baseline
      ? {
          baseline: {
            head: baseline.head,
            stashRef: baseline.stashRef,
            untracked: baseline.untracked,
            unborn: baseline.unborn,
          },
        }
      : {}),
  });
  ctx.registry.upsert(session);
  ctx.logger.info("created delegated session", {
    session_id: session.id,
    cwd: session.cwd,
    agent: session.agent,
    model: session.model,
  });
  return session;
}
