import type { AgentSession, SessionStatus } from "../types/index.js";
import { readJsonFileSync, writeFileAtomicSync } from "../util/fs.js";
import type { Logger } from "../util/logger.js";

interface RegistryFile {
  version: 1;
  sessions: AgentSession[];
}

const MAX_SESSION_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 500;
/** A "running" record not refreshed within this window is from a dead bridge. */
const STALE_RUNNING_MS = 60 * 60 * 1000;

export class SessionRegistry {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly file: string | null;
  private readonly logger: Logger;

  constructor(file: string | null, logger: Logger) {
    this.file = file;
    this.logger = logger;
    this.load();
  }

  private load(): void {
    if (!this.file) return;
    let data: RegistryFile | null = null;
    try {
      data = readJsonFileSync<RegistryFile>(this.file);
    } catch (error) {
      this.logger.warn("failed to read session registry; starting empty", {
        file: this.file,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (data?.version !== 1 || !Array.isArray(data.sessions)) return;
    const cutoff = Date.now() - MAX_SESSION_AGE_MS;
    const staleCutoff = Date.now() - STALE_RUNNING_MS;
    for (const session of data.sessions) {
      if (!session?.id) continue;
      const updated = Date.parse(session.updatedAt ?? session.createdAt ?? "");
      if (Number.isFinite(updated) && updated < cutoff) continue;
      if (session.status === "running" && (!Number.isFinite(updated) || updated < staleCutoff)) {
        // The bridge process that owned this run is gone; do not report a
        // forever-running session.
        session.status = "failed";
        session.lastError = {
          code: "BRIDGE_RESTARTED",
          message: "The bridge restarted before this run reported a result.",
        };
      }
      this.sessions.set(session.id, session);
    }
  }

  /**
   * Persist with a read-merge-write so multiple Claude sessions (each with its
   * own bridge process) sharing one registry file do not clobber each other.
   */
  private persist(): void {
    if (!this.file) return;
    const onDisk = new Map<string, AgentSession>();
    try {
      const data = readJsonFileSync<RegistryFile>(this.file);
      if (data?.version === 1 && Array.isArray(data.sessions)) {
        for (const session of data.sessions) {
          if (session?.id) onDisk.set(session.id, session);
        }
      }
    } catch {
      // start from what we have in memory
    }

    for (const [id, session] of this.sessions) {
      const disk = onDisk.get(id);
      if (!disk || session.updatedAt >= disk.updatedAt) onDisk.set(id, session);
    }

    let merged = [...onDisk.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (merged.length > MAX_SESSIONS) merged = merged.slice(0, MAX_SESSIONS);
    for (const session of merged) this.sessions.set(session.id, session);

    const payload: RegistryFile = { version: 1, sessions: merged };
    try {
      // 0o600: the registry contains agent output summaries and workspace paths.
      writeFileAtomicSync(this.file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      this.logger.warn("failed to persist session registry", {
        file: this.file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  get(id: string): AgentSession | null {
    return this.sessions.get(id) ?? null;
  }

  upsert(session: AgentSession): AgentSession {
    this.sessions.set(session.id, session);
    this.persist();
    return session;
  }

  update(id: string, patch: Partial<AgentSession>): AgentSession | null {
    const existing = this.sessions.get(id);
    if (!existing) return null;
    const updated: AgentSession = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(id, updated);
    this.persist();
    return updated;
  }

  setStatus(id: string, status: SessionStatus): AgentSession | null {
    return this.update(id, { status });
  }

  delete(id: string): boolean {
    const deleted = this.sessions.delete(id);
    if (deleted) this.persist();
    return deleted;
  }

  list(): AgentSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  findByDirectory(cwd: string): AgentSession[] {
    return this.list().filter((session) => session.cwd === cwd);
  }
}

export function createSessionRecord(input: {
  id: string;
  cwd: string;
  agent: string;
  promptAgent?: string;
  canEdit?: boolean;
  canRunBash?: boolean;
  provider: string | null;
  model: string | null;
  title: string | null;
  baseline?: AgentSession["baseline"];
}): AgentSession {
  const now = new Date().toISOString();
  return {
    id: input.id,
    cwd: input.cwd,
    agent: input.agent,
    ...(input.promptAgent ? { promptAgent: input.promptAgent } : {}),
    ...(input.canEdit !== undefined ? { canEdit: input.canEdit } : {}),
    ...(input.canRunBash !== undefined ? { canRunBash: input.canRunBash } : {}),
    provider: input.provider,
    model: input.model,
    title: input.title,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...(input.baseline ? { baseline: input.baseline } : {}),
  };
}
