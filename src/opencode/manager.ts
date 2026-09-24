import { type ChildProcess, spawn } from "node:child_process";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { deepMerge, type ResolvedConfig } from "../config/config.js";
import { BridgeError } from "../errors.js";
import type { Logger } from "../util/logger.js";
import { BinaryResolver, type ResolveBinaryOptions } from "./binary.js";
import {
  type AuthCredentials,
  createWorkspaceClient,
  fetchHealth,
  normalizeBaseUrl,
} from "./client.js";
import { PermissionWatcher } from "./permission-watcher.js";

export interface ServerStatus {
  key: string;
  url: string;
  cwd: string;
  external: boolean;
  version: string | null;
  activeRuns: number;
  lastUsedAt: number;
}

interface ServerRecord {
  key: string;
  baseUrl: string;
  cwd: string;
  external: boolean;
  process: ChildProcess | null;
  version: string | null;
  auth: AuthCredentials | null;
  lastUsedAt: number;
  activeRuns: number;
  configHash: string;
  clients: Map<string, OpencodeClient>;
  watcher: PermissionWatcher | null;
  dead: boolean;
  stderr: string[];
}

export interface EnsureServerInput {
  cwd: string;
  config: ResolvedConfig;
  agentConfig: Record<string, unknown>;
}

export interface OpenCodeManagerOptions {
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  binaryOptions?: ResolveBinaryOptions;
}

interface SpawnOutcome {
  url: string;
  process: ChildProcess;
}

function buildConfigHash(config: ResolvedConfig, agentConfig: Record<string, unknown>): string {
  return JSON.stringify({
    agents: agentConfig,
    hostname: config.opencode.hostname,
    port: config.opencode.port,
    logLevel: config.opencode.logLevel,
    binary: config.opencode.binary,
    defaults: config.defaults,
    security: config.security,
  });
}

function mergeInlineConfig(
  existing: string | undefined,
  agentConfig: Record<string, unknown>,
): string {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // ignore malformed inherited config content
    }
  }
  return JSON.stringify(deepMerge(base, { agent: agentConfig }));
}

export class OpenCodeManager {
  private readonly servers = new Map<string, ServerRecord>();
  /** Every spawned child, tracked from creation so shutdown can always kill it. */
  private readonly children = new Set<ChildProcess>();
  private readonly logger: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly resolver: BinaryResolver;
  private stopping = false;

  constructor(options: OpenCodeManagerOptions) {
    this.logger = options.logger;
    this.env = options.env ?? process.env;
    this.resolver = new BinaryResolver(options.binaryOptions ?? {});
  }

  resolveAuth(config: ResolvedConfig): AuthCredentials | null {
    const password = config.opencode.password ?? this.env.OPENCODE_SERVER_PASSWORD ?? null;
    if (!password) return null;
    const username = config.opencode.username ?? this.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return { username, password };
  }

  /** Ensure an OpenCode server exists for the workspace and return its record key. */
  async ensure(input: EnsureServerInput): Promise<string> {
    if (this.stopping) {
      throw new BridgeError("OPENCODE_UNAVAILABLE", "The bridge is shutting down.");
    }
    if (input.config.opencode.url) {
      return this.ensureExternal(input);
    }
    return this.ensureLocal(input);
  }

  async clientFor(input: EnsureServerInput): Promise<OpencodeClient> {
    const key = await this.ensure(input);
    const record = this.servers.get(key);
    if (!record) {
      throw new BridgeError("OPENCODE_UNAVAILABLE", "OpenCode server disappeared unexpectedly.");
    }
    record.lastUsedAt = Date.now();
    let client = record.clients.get(input.cwd);
    if (!client) {
      client = createWorkspaceClient({
        baseUrl: record.baseUrl,
        directory: input.cwd,
        auth: record.auth,
      });
      record.clients.set(input.cwd, client);
    }
    return client;
  }

  /**
   * Return a client for a workspace only when a live server already serves it.
   * Used by read-only tools (get_session, get_diff, abort_session) that must
   * not start an OpenCode process as a side effect.
   */
  existingClient(cwd: string): OpencodeClient | null {
    for (const record of this.servers.values()) {
      if (record.dead) continue;
      if (!record.external && record.cwd !== cwd) continue;
      let client = record.clients.get(cwd);
      if (!client) {
        client = createWorkspaceClient({
          baseUrl: record.baseUrl,
          directory: cwd,
          auth: record.auth,
        });
        record.clients.set(cwd, client);
      }
      record.lastUsedAt = Date.now();
      return client;
    }
    return null;
  }

  getExistingServerVersion(cwd: string): string | null {
    for (const record of this.servers.values()) {
      if (record.dead) continue;
      if (!record.external && record.cwd !== cwd) continue;
      return record.version;
    }
    return null;
  }

  private externalKey(url: string): string {
    return `external:${normalizeBaseUrl(url)}`;
  }

  private async ensureExternal(input: EnsureServerInput): Promise<string> {
    const rawUrl = input.config.opencode.url;
    if (!rawUrl) {
      throw new BridgeError("OPENCODE_UNAVAILABLE", "opencode.url is not configured.");
    }
    const parsed = new URL(rawUrl);
    let auth = this.resolveAuth(input.config);
    if (parsed.username || parsed.password) {
      auth = {
        username: decodeURIComponent(parsed.username || "opencode"),
        password: decodeURIComponent(parsed.password),
      };
      parsed.username = "";
      parsed.password = "";
    }
    const baseUrl = normalizeBaseUrl(parsed.toString());
    const key = this.externalKey(baseUrl);

    let record = this.servers.get(key);
    if (record && !record.dead) {
      record.lastUsedAt = Date.now();
      await this.assertAgentsAvailable(record, input.agentConfig, input.cwd);
      return key;
    }

    const client = createWorkspaceClient({ baseUrl, directory: input.cwd, auth });
    const health = await this.tryHealth(baseUrl, auth);
    if (!health) {
      throw new BridgeError(
        "OPENCODE_UNAVAILABLE",
        `Could not reach the configured OpenCode server at ${baseUrl}.`,
        { details: { url: baseUrl } },
      );
    }

    record = {
      key,
      baseUrl,
      cwd: input.cwd,
      external: true,
      process: null,
      version: health.version,
      auth,
      lastUsedAt: Date.now(),
      activeRuns: 0,
      configHash: "external",
      clients: new Map([[input.cwd, client]]),
      watcher: new PermissionWatcher(baseUrl, auth, this.logger),
      dead: false,
      stderr: [],
    };
    this.servers.set(key, record);
    await this.assertAgentsAvailable(record, input.agentConfig, input.cwd);
    this.logger.info("connected to external OpenCode server", {
      url: baseUrl,
      version: health.version,
    });
    return key;
  }

  private async assertAgentsAvailable(
    record: ServerRecord,
    agentConfig: Record<string, unknown>,
    cwd: string,
  ): Promise<void> {
    const required = Object.keys(agentConfig);
    if (required.length === 0) return;
    const client =
      record.clients.get(cwd) ??
      createWorkspaceClient({ baseUrl: record.baseUrl, directory: cwd, auth: record.auth });
    record.clients.set(cwd, client);
    let available: Set<string>;
    try {
      const result = await client.app.agents();
      available = new Set((result.data ?? []).map((agent) => agent.name));
    } catch (error) {
      throw new BridgeError(
        "OPENCODE_UNAVAILABLE",
        `Could not list agents from the external OpenCode server: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    const missing = required.filter((name) => !available.has(name));
    if (missing.length > 0) {
      throw new BridgeError(
        "AGENT_NOT_FOUND",
        [
          `The external OpenCode server is missing required agent(s): ${missing.join(", ")}.`,
          "Add them to the server's OpenCode configuration (for example .opencode/agents/)",
          "or run `claude-opencode init` to materialize the agent definitions,",
          "or let the bridge start its own server by unsetting opencode.url.",
        ].join(" "),
        { details: { missing, url: record.baseUrl } },
      );
    }
  }

  private async ensureLocal(input: EnsureServerInput): Promise<string> {
    const key = `local:${input.cwd}`;
    const hash = buildConfigHash(input.config, input.agentConfig);
    let record = this.servers.get(key);

    if (record && !record.dead) {
      if (record.configHash === hash) {
        record.lastUsedAt = Date.now();
        return key;
      }
      if (record.activeRuns > 0) {
        this.logger.warn(
          "agent configuration changed while a delegated run is active; keeping the existing OpenCode server",
          { cwd: input.cwd },
        );
        record.lastUsedAt = Date.now();
        return key;
      }
      await this.stop(key);
      record = undefined;
    }

    const binary = await this.resolver.resolve(input.config.opencode.binary);
    const auth = this.resolveAuth(input.config);
    const stderr: string[] = [];
    const { url, process: child } = await this.spawnServer(input, binary.command, auth, stderr);

    if (this.stopping) {
      child.kill("SIGKILL");
      throw new BridgeError("OPENCODE_UNAVAILABLE", "The bridge is shutting down.");
    }

    const client = createWorkspaceClient({ baseUrl: url, directory: input.cwd, auth });
    const health = await this.waitForHealth(url, auth);
    if (!health) {
      child.kill("SIGKILL");
      if (this.stopping) {
        throw new BridgeError("OPENCODE_UNAVAILABLE", "The bridge is shutting down.");
      }
      throw new BridgeError(
        "OPENCODE_UNAVAILABLE",
        `OpenCode server started at ${url} but never became healthy.`,
        { details: { url, stderr: stderr.join("").slice(-2000) } },
      );
    }

    if (this.stopping) {
      child.kill("SIGKILL");
      throw new BridgeError("OPENCODE_UNAVAILABLE", "The bridge is shutting down.");
    }

    record = {
      key,
      baseUrl: url,
      cwd: input.cwd,
      external: false,
      process: child,
      version: health.version,
      auth,
      lastUsedAt: Date.now(),
      activeRuns: 0,
      configHash: hash,
      clients: new Map([[input.cwd, client]]),
      watcher: new PermissionWatcher(url, auth, this.logger),
      dead: false,
      stderr,
    };
    this.servers.set(key, record);

    child.on("exit", (code, signal) => {
      record!.dead = true;
      record!.clients.clear();
      void record!.watcher?.stop();
      if (!this.stopping) {
        this.logger.error("OpenCode server exited", {
          cwd: input.cwd,
          code,
          signal,
          activeRuns: record!.activeRuns,
          stderr: stderr.join("").slice(-1000),
        });
      }
    });
    child.unref?.();

    this.logger.info("started OpenCode server", {
      cwd: input.cwd,
      url,
      version: health.version,
      binary: binary.command,
      source: binary.source,
    });
    await this.evictIfNeeded(input.config.opencode.maxServers);
    return key;
  }

  private spawnServer(
    input: EnsureServerInput,
    command: string,
    auth: AuthCredentials | null,
    stderr: string[],
  ): Promise<SpawnOutcome> {
    const { config } = input;
    const args = [
      "serve",
      `--hostname=${config.opencode.hostname}`,
      `--port=${config.opencode.port}`,
    ];
    if (config.opencode.logLevel) args.push(`--log-level=${config.opencode.logLevel}`);

    const childEnv: NodeJS.ProcessEnv = { ...this.env };
    delete childEnv.OPENCODE_CLIENT;
    childEnv.OPENCODE_CONFIG_CONTENT = mergeInlineConfig(
      this.env.OPENCODE_CONFIG_CONTENT,
      input.agentConfig,
    );
    if (auth) {
      childEnv.OPENCODE_SERVER_USERNAME = auth.username;
      childEnv.OPENCODE_SERVER_PASSWORD = auth.password;
    }

    const child = spawn(command, args, {
      cwd: input.cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    // Track the child from the instant it exists: shutdown may race with
    // startup, and anything spawned must be killable even before ensureLocal
    // registers a server record.
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));

    return new Promise<SpawnOutcome>((resolve, reject) => {
      let settled = false;
      let output = "";
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(
          new BridgeError(
            "OPENCODE_START_TIMEOUT",
            `OpenCode did not start within ${config.opencode.startupTimeout}ms.`,
            { details: { stderr: stderr.join("").slice(-2000) }, retryable: true },
          ),
        );
      }, config.opencode.startupTimeout);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      // Ensure a rejected startup never leaves a process behind.
      const fail = (error: BridgeError) => {
        finish(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          reject(error);
        });
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (this.stopping) {
          fail(new BridgeError("OPENCODE_UNAVAILABLE", "The bridge is shutting down."));
          return;
        }
        output += chunk.toString("utf8");
        const lines = output.split("\n");
        for (const line of lines) {
          if (line.startsWith("opencode server listening")) {
            const match = line.match(/on\s+(https?:\/\/\S+)/);
            if (match?.[1]) {
              const url = normalizeBaseUrl(match[1]);
              finish(() => resolve({ url, process: child }));
              return;
            }
            fail(new BridgeError("OPENCODE_ERROR", `Could not parse server URL from: ${line}`));
            return;
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr.push(text);
        if (stderr.length > 200) stderr.splice(0, stderr.length - 200);
      });

      child.on("error", (error) => {
        fail(
          new BridgeError("OPENCODE_NOT_AVAILABLE", `Failed to launch OpenCode: ${error.message}`, {
            cause: error,
          }),
        );
      });

      child.on("exit", (code) => {
        finish(() =>
          reject(
            new BridgeError(
              "OPENCODE_UNAVAILABLE",
              `OpenCode exited during startup with code ${code}.`,
              { details: { stderr: stderr.join("").slice(-2000) } },
            ),
          ),
        );
      });
    });
  }

  private async tryHealth(
    baseUrl: string,
    auth: AuthCredentials | null,
  ): Promise<{ healthy: boolean; version: string } | null> {
    return fetchHealth(baseUrl, auth);
  }

  private async waitForHealth(
    baseUrl: string,
    auth: AuthCredentials | null,
  ): Promise<{ healthy: boolean; version: string } | null> {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (this.stopping) return null;
      const health = await this.tryHealth(baseUrl, auth);
      if (health) return health;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return null;
  }

  beginRun(key: string, sessionId?: string): void {
    const record = this.servers.get(key);
    if (!record) return;
    record.activeRuns += 1;
    record.lastUsedAt = Date.now();
    if (sessionId) record.watcher?.activate(sessionId);
  }

  endRun(key: string, sessionId?: string): void {
    const record = this.servers.get(key);
    if (!record) return;
    record.activeRuns = Math.max(0, record.activeRuns - 1);
    if (sessionId) record.watcher?.deactivate(sessionId);
  }

  isDead(key: string): boolean {
    const record = this.servers.get(key);
    return !record || record.dead;
  }

  getStatus(): ServerStatus[] {
    return [...this.servers.values()].map((record) => ({
      key: record.key,
      url: record.baseUrl,
      cwd: record.cwd,
      external: record.external,
      version: record.version,
      activeRuns: record.activeRuns,
      lastUsedAt: record.lastUsedAt,
    }));
  }

  getRunningServerKeys(): string[] {
    return [...this.servers.values()].filter((record) => !record.dead).map((record) => record.key);
  }

  private async evictIfNeeded(maxServers: number): Promise<void> {
    if (this.servers.size <= maxServers) return;
    const candidates = [...this.servers.values()]
      .filter((record) => !record.external && record.activeRuns === 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (this.servers.size > maxServers && candidates.length > 0) {
      const candidate = candidates.shift();
      if (!candidate) break;
      this.logger.info("evicting idle OpenCode server", { cwd: candidate.cwd });
      await this.stop(candidate.key);
    }
  }

  async stop(key: string): Promise<void> {
    const record = this.servers.get(key);
    if (!record) return;
    this.servers.delete(key);
    record.clients.clear();
    await record.watcher?.stop();
    const child = record.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      let done = false;
      const finalize = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once("exit", finalize);
      try {
        child.kill("SIGTERM");
      } catch {
        finalize();
        return;
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finalize();
      }, 5000);
      killTimer.unref?.();
    });
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    const keys = [...this.servers.keys()];
    await Promise.allSettled(keys.map((key) => this.stop(key)));
  }

  /**
   * Synchronous last-resort cleanup for `process.on("exit")`: kills any child
   * that was spawned but not yet registered (shutdown races) so no OpenCode
   * process is orphaned when the bridge exits.
   */
  killAllSync(): void {
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    this.children.clear();
  }
}
