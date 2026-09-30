import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BUILTIN_AGENT_NAMES, VARIANT_SEPARATOR } from "../../src/opencode/agents.js";

export interface FakeAgent {
  name: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
  builtIn?: boolean;
}

export interface FakePromptRequest {
  sessionId: string;
  directory: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  text: string;
  tools?: Record<string, boolean>;
}

export interface FakePromptResponse {
  text: string;
  delayMs?: number;
  error?: { name: string; data: Record<string, unknown> };
  finish?: string;
  /** Emit a completed tool-call step before the final message (real OpenCode behavior). */
  toolStep?: boolean;
  onBeforeRespond?: () => Promise<void> | void;
}

export interface FakeOpenCodeOptions {
  version?: string;
  agents?: FakeAgent[];
  prompts?: Map<string, string[]>;
  /** When set, /path reports this directory instead of the requested one. */
  reportedDirectory?: string;
  onPrompt?: (request: FakePromptRequest) => FakePromptResponse | Promise<FakePromptResponse>;
}

interface FakeSession {
  id: string;
  directory: string;
  title: string;
  messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
  busy: boolean;
  aborted: boolean;
}

const VARIANT_SUFFIXES = ["ro", "edit", "bash", "rw"] as const;

// Bases plus every permission variant the bridge can generate, so external-mode
// agent validation passes for override calls.
const DEFAULT_AGENTS: FakeAgent[] = BUILTIN_AGENT_NAMES.flatMap((base) => [
  { name: base, description: `fake ${base}`, mode: "all" as const },
  ...VARIANT_SUFFIXES.map((suffix) => ({
    name: `${base}${VARIANT_SEPARATOR}${suffix}`,
    description: `fake ${base} ${suffix}`,
    mode: "all" as const,
  })),
]);

export class FakeOpenCode {
  readonly server: http.Server;
  readonly prompts: FakePromptRequest[] = [];
  /** Counts legacy synchronous prompt calls; the bridge must never use them. */
  syncPromptCalls = 0;
  readonly sessions = new Map<string, FakeSession>();
  readonly agents: FakeAgent[];
  readonly version: string;
  private readonly onPrompt: FakeOpenCodeOptions["onPrompt"];
  private readonly reportedDirectory: string | undefined;
  private readonly streams = new Set<http.ServerResponse>();

  constructor(options: FakeOpenCodeOptions = {}) {
    this.version = options.version ?? "fake-1.0.0";
    this.agents = options.agents ?? DEFAULT_AGENTS;
    this.onPrompt = options.onPrompt;
    this.reportedDirectory = options.reportedDirectory;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private directoryFor(req: http.IncomingMessage, url: URL): string {
    const header = req.headers["x-opencode-directory"];
    const value = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("directory");
    return value ? decodeURIComponent(value) : process.cwd();
  }

  private async readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private json(res: http.ServerResponse, value: unknown, status = 200): void {
    const body = JSON.stringify(value);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(body);
  }

  private async interruptibleDelay(session: FakeSession, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (session.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
    }
  }

  private async processPrompt(
    session: FakeSession,
    body: Record<string, unknown>,
  ): Promise<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> {
    const parts = Array.isArray(body.parts) ? (body.parts as Array<Record<string, unknown>>) : [];
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("\n");
    const request: FakePromptRequest = {
      sessionId: session.id,
      directory: session.directory,
      ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
      ...(body.model ? { model: body.model as FakePromptRequest["model"] } : {}),
      text,
      ...(body.tools ? { tools: body.tools as Record<string, boolean> } : {}),
    };
    this.prompts.push(request);

    const userInfo = {
      id: `msg_user_${randomUUID().slice(0, 8)}`,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: request.agent ?? "build",
      model: request.model ?? { providerID: "deepseek", modelID: "deepseek-v4-pro" },
    };
    session.messages.push({
      info: userInfo,
      parts: [{ id: `prt_${randomUUID().slice(0, 8)}`, type: "text", text }],
    });

    const response = (await this.onPrompt?.(request)) ?? {
      text: `FAKE DONE: ${text.slice(0, 80)}`,
    };

    if (response.toolStep && !session.aborted) {
      const stepInfo: Record<string, unknown> = {
        id: `msg_step_${randomUUID().slice(0, 8)}`,
        sessionID: session.id,
        role: "assistant",
        time: { created: Date.now(), completed: Date.now() },
        parentID: userInfo.id,
        modelID: request.model?.modelID ?? "deepseek-v4-pro",
        providerID: request.model?.providerID ?? "deepseek",
        mode: request.agent ?? "build",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "tool-calls",
      };
      session.messages.push({
        info: stepInfo,
        parts: [
          { id: `prt_${randomUUID().slice(0, 8)}`, sessionID: session.id, type: "step-start" },
          {
            id: `prt_${randomUUID().slice(0, 8)}`,
            sessionID: session.id,
            messageID: stepInfo.id,
            type: "tool",
            tool: "read",
            state: { status: "completed", input: { filePath: "README.md" } },
          },
        ],
      });
      await this.interruptibleDelay(session, 100);
    }

    if (response.delayMs) {
      await this.interruptibleDelay(session, response.delayMs);
    }
    if (response.onBeforeRespond) await response.onBeforeRespond();

    const aborted = session.aborted;
    const assistantInfo: Record<string, unknown> = {
      id: `msg_asst_${randomUUID().slice(0, 8)}`,
      sessionID: session.id,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parentID: userInfo.id,
      modelID: request.model?.modelID ?? "deepseek-v4-pro",
      providerID: request.model?.providerID ?? "deepseek",
      mode: request.agent ?? "build",
      path: { cwd: session.directory, root: session.directory },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: aborted ? "error" : (response.finish ?? "stop"),
      ...(aborted
        ? { error: { name: "MessageAbortedError", data: { message: "Aborted" } } }
        : response.error
          ? { error: response.error }
          : {}),
    };
    const assistantParts: Array<Record<string, unknown>> = [];
    if (response.text && !aborted) {
      assistantParts.push({
        id: `prt_${randomUUID().slice(0, 8)}`,
        sessionID: session.id,
        messageID: assistantInfo.id,
        type: "text",
        text: response.text,
      });
    }
    session.messages.push({ info: assistantInfo, parts: assistantParts });
    session.busy = false;
    return { info: assistantInfo, parts: assistantParts };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method = req.method ?? "GET";
    const directory = this.directoryFor(req, url);

    if (pathname === "/global/health" && method === "GET") {
      this.json(res, { healthy: true, version: this.version });
      return;
    }

    if (pathname === "/agent" && method === "GET") {
      this.json(
        res,
        this.agents.map((agent) => ({
          name: agent.name,
          description: agent.description ?? "",
          mode: agent.mode,
          builtIn: agent.builtIn ?? false,
        })),
      );
      return;
    }

    if (pathname === "/config/providers" && method === "GET") {
      this.json(res, {
        providers: [],
        default: { deepseek: "deepseek-v4-pro" },
      });
      return;
    }

    if (pathname === "/path" && method === "GET") {
      this.json(res, {
        home: process.env.HOME ?? "/",
        state: "/tmp/fake-state",
        config: "/tmp/fake-config",
        worktree: directory,
        directory: this.reportedDirectory ?? directory,
      });
      return;
    }

    if (pathname === "/event" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      this.streams.add(res);
      req.on("close", () => this.streams.delete(res));
      return;
    }

    const sessionMatch = pathname.match(/^\/session\/([^/]+)(\/.*)?$/);
    if (pathname === "/session" && method === "POST") {
      const body = await this.readBody(req);
      const id = `ses_fake_${randomUUID().slice(0, 8)}`;
      this.sessions.set(id, {
        id,
        directory,
        title: typeof body.title === "string" ? body.title : "fake session",
        messages: [],
        busy: false,
        aborted: false,
      });
      this.json(res, {
        id,
        projectID: "fake-project",
        directory,
        title: typeof body.title === "string" ? body.title : "fake session",
        version: this.version,
        time: { created: Date.now(), updated: Date.now() },
      });
      return;
    }

    if (pathname === "/session/status" && method === "GET") {
      const statuses: Record<string, unknown> = {};
      for (const session of this.sessions.values()) {
        if (session.busy) statuses[session.id] = { type: "busy" };
      }
      this.json(res, statuses);
      return;
    }

    if (sessionMatch) {
      const sessionId = sessionMatch[1]!;
      const sub = sessionMatch[2] ?? "";
      const session = this.sessions.get(sessionId);
      if (!session) {
        this.json(res, { name: "NotFoundError", data: { message: "session not found" } }, 404);
        return;
      }

      if (sub === "" && method === "GET") {
        this.json(res, {
          id: session.id,
          projectID: "fake-project",
          directory: session.directory,
          title: session.title,
          version: this.version,
          time: { created: Date.now(), updated: Date.now() },
        });
        return;
      }

      if (sub === "/message" && method === "POST") {
        this.syncPromptCalls += 1;
        const body = await this.readBody(req);
        const result = await this.processPrompt(session, body);
        this.json(res, result);
        return;
      }

      if (sub === "/prompt_async" && method === "POST") {
        const body = await this.readBody(req);
        session.busy = true;
        session.aborted = false;
        void this.processPrompt(session, body).catch(() => {
          session.busy = false;
        });
        res.statusCode = 204;
        res.end();
        return;
      }

      if (sub === "/message" && method === "GET") {
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.NaN;
        const messages =
          Number.isFinite(limit) && limit > 0 ? session.messages.slice(-limit) : session.messages;
        this.json(res, messages);
        return;
      }

      if (sub === "/diff" && method === "GET") {
        this.json(res, []);
        return;
      }

      if (sub === "/abort" && method === "POST") {
        session.aborted = true;
        session.busy = false;
        this.json(res, true);
        return;
      }

      if (sub.startsWith("/permissions/") && method === "POST") {
        this.json(res, true);
        return;
      }
    }

    this.json(res, { name: "NotFoundError", data: { message: `${method} ${pathname}` } }, 404);
  }
}
