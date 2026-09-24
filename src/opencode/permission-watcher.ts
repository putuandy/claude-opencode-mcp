import type { Permission } from "@opencode-ai/sdk";
import type { Logger } from "../util/logger.js";
import { type AuthCredentials, basicAuthHeader } from "./client.js";

interface PermissionEvent {
  type: string;
  properties?: Permission;
}

/**
 * Listens to the OpenCode event stream and rejects permission requests that
 * would otherwise wait forever (the bridge is headless: there is no human to
 * answer an `ask` rule). The bridge's own agents never emit `ask` rules, but a
 * user's global OpenCode configuration might.
 */
export class PermissionWatcher {
  private readonly active = new Set<string>();
  private controller: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly baseUrl: string,
    private readonly auth: AuthCredentials | null,
    private readonly logger: Logger,
  ) {}

  activate(sessionId: string): void {
    this.active.add(sessionId);
    this.ensureStarted();
  }

  deactivate(sessionId: string): void {
    this.active.delete(sessionId);
  }

  private ensureStarted(): void {
    if (this.stopped || this.loopPromise) return;
    this.controller = new AbortController();
    this.loopPromise = this.loop(this.controller.signal).finally(() => {
      this.loopPromise = null;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    try {
      await this.loopPromise;
    } catch {
      // ignore
    }
    this.loopPromise = null;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let delay = 1000;
    while (!signal.aborted) {
      try {
        await this.consume(signal);
        delay = 1000;
      } catch (error) {
        if (signal.aborted) return;
        this.logger.debug("permission watcher stream disconnected; retrying", {
          delayMs: delay,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(delay, signal);
        delay = Math.min(delay * 2, 10_000);
      }
    }
  }

  private async consume(signal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (this.auth) headers.Authorization = basicAuthHeader(this.auth);
    const response = await fetch(`${this.baseUrl}/event`, { headers, signal });
    if (!response.ok || !response.body) {
      throw new Error(`event stream responded with ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        this.handleLine(line);
        index = buffer.indexOf("\n");
      }
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") return;
    let event: PermissionEvent;
    try {
      event = JSON.parse(payload) as PermissionEvent;
    } catch {
      return;
    }
    if (event.type !== "permission.updated") return;
    const permission = event.properties;
    if (!permission?.id || !permission.sessionID) return;
    if (!this.active.has(permission.sessionID)) return;
    void this.reject(permission);
  }

  private async reject(permission: Permission): Promise<void> {
    this.logger.warn("auto-rejecting OpenCode permission request (headless bridge)", {
      sessionID: permission.sessionID,
      permissionID: permission.id,
      type: permission.type,
      title: permission.title,
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.auth) headers.Authorization = basicAuthHeader(this.auth);
    try {
      await fetch(
        `${this.baseUrl}/session/${encodeURIComponent(permission.sessionID)}/permissions/${encodeURIComponent(permission.id)}`,
        { method: "POST", headers, body: JSON.stringify({ response: "reject" }) },
      );
    } catch (error) {
      this.logger.warn("failed to reject permission request", {
        permissionID: permission.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
