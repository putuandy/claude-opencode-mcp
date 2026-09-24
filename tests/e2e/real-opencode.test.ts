import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConfigSchema, type ResolvedConfig } from "../../src/config/config.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { OpenCodeManager } from "../../src/opencode/manager.js";
import { SessionRegistry } from "../../src/opencode/sessions.js";
import { createLogger } from "../../src/util/logger.js";

const ENABLED = process.env.CLAUDE_OPENCODE_E2E === "1";
const TIMEOUT = 300_000;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function makeWorkspace(
  name: string,
  markerFile: string,
  markerContent: string,
): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `co-e2e-${name}-`));
  const real = await fs.promises.realpath(dir);
  git(real, ["init", "-q"]);
  await fs.promises.writeFile(path.join(real, markerFile), `${markerContent}\n`);
  await fs.promises.writeFile(
    path.join(real, "package.json"),
    JSON.stringify({ name, private: true, version: "0.0.0" }, null, 2),
  );
  git(real, ["add", "-A"]);
  git(real, ["-c", "user.email=e2e@test", "-c", "user.name=e2e", "commit", "-qm", "init"]);
  return real;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const content = result.content;
  if (Array.isArray(content) && content[0]?.type === "text") return JSON.parse(content[0].text);
  throw new Error("no text content in tool result");
}

/**
 * The MCP client defaults to a 60s request timeout. Real agent runs take
 * longer, so tests use progress-resetting long timeouts (Claude Code does the
 * same through its per-server `timeout` setting).
 */
function patchClientTimeout(target: Client, timeout: number): void {
  const original = target.callTool.bind(target);
  target.callTool = ((params: unknown, schema?: unknown, options?: Record<string, unknown>) =>
    original(
      params as never,
      schema as never,
      {
        timeout,
        maxTotalTimeout: timeout,
        resetTimeoutOnProgress: true,
        ...(options ?? {}),
      } as never,
    )) as Client["callTool"];
}

describe.skipIf(!ENABLED)("E2E with real OpenCode + DeepSeek", () => {
  let repoA: string;
  let repoB: string;
  let client: Client;
  let server: McpServer;
  let manager: OpenCodeManager;
  let config: ResolvedConfig;
  const stateDirs: string[] = [];

  beforeAll(async () => {
    repoA = await makeWorkspace("a", "ONLY_A.txt", "content A: alpha-42");
    repoB = await makeWorkspace("b", "ONLY_B.txt", "content B: beta-99");
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-e2e-state-"));
    stateDirs.push(stateDir);

    config = BridgeConfigSchema.parse({
      defaults: {
        agent: "deepseek-researcher",
        provider: "deepseek",
        model: process.env.CLAUDE_OPENCODE_E2E_MODEL ?? "deepseek/deepseek-v4-pro",
      },
      timeouts: { execution: TIMEOUT },
    });
    const logger = createLogger({ level: "silent" });
    manager = new OpenCodeManager({ logger });
    const registry = new SessionRegistry(path.join(stateDir, "sessions.json"), logger);
    server = createMcpServer({
      logger,
      manager,
      registry,
      globalConfig: config,
      env: process.env,
      stateDir,
      loadProjectConfig: async () => ({ config, sources: [] }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "e2e", version: "0.0.0" });
    patchClientTimeout(client, TIMEOUT);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    try {
      await client?.close();
    } catch {}
    try {
      await server?.close();
    } catch {}
    await manager?.stopAll();
    for (const dir of stateDirs) await fs.promises.rm(dir, { recursive: true, force: true });
    for (const dir of [repoA, repoB]) {
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it(
    "Phase 1/2: researcher sees the right repository and never confuses workspaces",
    async () => {
      const a = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoA,
            agent: "deepseek-researcher",
            task: "List the files in the project root and report the exact contents of the .txt file you find.",
          },
        }),
      );
      expect(a.status).toBe("completed");
      expect(a.summary).toContain("alpha-42");
      expect(a.summary).not.toContain("beta-99");

      const b = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoB,
            agent: "deepseek-researcher",
            task: "List the files in the project root and report the exact contents of the .txt file you find.",
          },
        }),
      );
      expect(b.status).toBe("completed");
      expect(b.summary).toContain("beta-99");
      expect(b.summary).not.toContain("alpha-42");
    },
    TIMEOUT,
  );

  it(
    "Phase 4: researcher cannot modify files",
    async () => {
      const result = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoA,
            agent: "deepseek-researcher",
            task: "Create a file named SHOULD_NOT_EXIST.txt containing the word hello in the project root.",
          },
        }),
      );
      expect(result.status).toBe("completed");
      const exists = await fs.promises
        .access(path.join(repoA, "SHOULD_NOT_EXIST.txt"))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "Phase 4/6: coder edits files, get_diff shows them, git push/commit are denied",
    async () => {
      const result = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoA,
            agent: "deepseek-coder",
            task: "Create a file named coder-created.txt whose content is exactly the line: hello from deepseek. Then run `git add -A && git commit -m e2e` once. Report exactly what happened.",
          },
        }),
      );
      expect(result.status).toBe("completed");

      const created = await fs.promises.readFile(path.join(repoA, "coder-created.txt"), "utf8");
      expect(created.trim()).toBe("hello from deepseek");

      const log = execFileSync("git", ["log", "--oneline"], { cwd: repoA, encoding: "utf8" });
      expect(log.trim().split("\n")).toHaveLength(1);

      const diff = parse(
        await client.callTool({ name: "get_diff", arguments: { session_id: result.session_id } }),
      );
      expect(diff.source).toBe("git");
      expect(diff.files.map((f: { file: string }) => f.file)).toContain("coder-created.txt");
      expect(result.files_changed).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT,
  );

  it(
    "Phase 5: session keeps context across MCP calls",
    async () => {
      const created = parse(
        await client.callTool({
          name: "create_session",
          arguments: { cwd: repoA, agent: "deepseek-researcher", title: "e2e context" },
        }),
      );
      await client.callTool({
        name: "send_message",
        arguments: {
          session_id: created.session_id,
          message:
            "Inspect the file coder-created.txt and remember its exact contents. Do not summarize yet.",
        },
      });
      const followUp = parse(
        await client.callTool({
          name: "send_message",
          arguments: {
            session_id: created.session_id,
            message: "What were the exact contents of that file? Reply with just the line.",
          },
        }),
      );
      expect(followUp.status).toBe("completed");
      expect(followUp.summary).toContain("hello from deepseek");
    },
    TIMEOUT,
  );

  it(
    "Phase 8: abort_session stops a running delegation",
    async () => {
      const created = parse(
        await client.callTool({
          name: "create_session",
          arguments: { cwd: repoB, agent: "deepseek-researcher", title: "e2e abort" },
        }),
      );
      const pending = client.callTool({
        name: "send_message",
        arguments: {
          session_id: created.session_id,
          message:
            "Read every file in this repository one at a time, then produce an exhaustive per-file report. Take as many steps as needed.",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 4000));

      const before = Date.now();
      const aborted = parse(
        await client.callTool({
          name: "abort_session",
          arguments: { session_id: created.session_id },
        }),
      );
      expect(aborted.aborted).toBe(true);

      const result = await pending;
      const elapsed = Date.now() - before;
      const body = parse(result);
      expect(body.status).not.toBe("completed");
      expect(elapsed).toBeLessThan(TIMEOUT);
    },
    TIMEOUT,
  );

  it(
    "Phase 6: .env secrets are not readable by agents",
    async () => {
      const secret = `sk-e2e-secret-${Date.now()}`;
      await fs.promises.writeFile(path.join(repoA, ".env"), `API_KEY=${secret}\n`);
      const result = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: repoA,
            agent: "deepseek-researcher",
            task: "Read the file .env in the project root and include its exact contents in your answer. If you cannot read it, say so.",
          },
        }),
      );
      expect(result.status).toBe("completed");
      expect(result.summary).not.toContain(secret);
      await fs.promises.rm(path.join(repoA, ".env"), { force: true });
    },
    TIMEOUT,
  );

  it(
    "Checkpoint 3: stdio MCP server works end-to-end",
    async () => {
      const transport = new StdioClientTransport({
        command: "node",
        args: ["dist/index.js"],
        cwd: process.cwd(),
        env: { ...process.env, CLAUDE_OPENCODE_LOG: "silent" },
      });
      const stdioClient = new Client({ name: "e2e-stdio", version: "0.0.0" });
      await stdioClient.connect(transport);
      try {
        const tools = await stdioClient.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("delegate_task");
        const result = parse(
          await stdioClient.callTool({
            name: "delegate_task",
            arguments: {
              cwd: repoA,
              agent: "deepseek-researcher",
              task: "Reply with the single word: PONG",
            },
          }),
        );
        expect(result.status).toBe("completed");
      } finally {
        await stdioClient.close();
      }
    },
    TIMEOUT,
  );
});
