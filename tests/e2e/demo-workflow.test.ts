import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConfigSchema, type ResolvedConfig } from "../../src/config/config.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { OpenCodeManager } from "../../src/opencode/manager.js";
import { SessionRegistry } from "../../src/opencode/sessions.js";
import { createLogger } from "../../src/util/logger.js";

const ENABLED = process.env.CLAUDE_OPENCODE_E2E_WORKFLOW === "1";
const TIMEOUT = 420_000;

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

async function createDemoProject(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-demo-"));
  const real = await fs.promises.realpath(dir);
  await fs.promises.mkdir(path.join(real, "src", "auth"), { recursive: true });
  await fs.promises.mkdir(path.join(real, "src", "users"), { recursive: true });
  await fs.promises.mkdir(path.join(real, "src", "database"), { recursive: true });
  await fs.promises.mkdir(path.join(real, "tests"), { recursive: true });

  await fs.promises.writeFile(
    path.join(real, "package.json"),
    JSON.stringify(
      {
        name: "demo-project",
        private: true,
        version: "0.0.0",
        scripts: { test: "node --test tests/" },
      },
      null,
      2,
    ),
  );

  // The defect: expiresAt is stored as the raw TTL instead of an absolute time,
  // and a TTL of 0 (session without explicit expiry) is not treated as "no expiry".
  await fs.promises.writeFile(
    path.join(real, "src", "auth", "session.js"),
    [
      "const sessions = new Map();",
      "",
      "function createSession(userId, ttlMs = 0) {",
      "  sessions.set(userId, { userId, expiresAt: ttlMs });",
      "}",
      "",
      "function isValid(userId) {",
      "  const session = sessions.get(userId);",
      "  if (!session) return false;",
      "  return session.expiresAt > Date.now();",
      "}",
      "",
      "module.exports = { createSession, isValid };",
      "",
    ].join("\n"),
  );

  await fs.promises.writeFile(
    path.join(real, "tests", "auth.test.js"),
    [
      "const test = require('node:test');",
      "const assert = require('node:assert');",
      "const { createSession, isValid } = require('../src/auth/session');",
      "",
      "test('session without ttl stays valid', () => {",
      "  createSession('u1');",
      "  assert.strictEqual(isValid('u1'), true);",
      "});",
      "",
      "test('session expires after ttl', async () => {",
      "  createSession('u2', 10);",
      "  await new Promise((resolve) => setTimeout(resolve, 40));",
      "  assert.strictEqual(isValid('u2'), false);",
      "});",
      "",
      "test('session valid before ttl', () => {",
      "  createSession('u3', 60_000);",
      "  assert.strictEqual(isValid('u3'), true);",
      "});",
      "",
    ].join("\n"),
  );

  await fs.promises.writeFile(
    path.join(real, "src", "users", "users.js"),
    [
      "const users = new Map();",
      "function createUser(id, email) { users.set(id, { id, email }); return users.get(id); }",
      "function findUser(id) { return users.get(id) ?? null; }",
      "module.exports = { createUser, findUser };",
      "",
    ].join("\n"),
  );

  await fs.promises.writeFile(
    path.join(real, "src", "database", "db.js"),
    [
      "const store = new Map();",
      "function put(collection, key, value) {",
      "  const bucket = store.get(collection) ?? new Map();",
      "  bucket.set(key, value);",
      "  store.set(collection, bucket);",
      "}",
      "function get(collection, key) {",
      "  return store.get(collection)?.get(key) ?? null;",
      "}",
      "module.exports = { put, get };",
      "",
    ].join("\n"),
  );

  execFileSync("git", ["init", "-q"], { cwd: real });
  execFileSync("git", ["add", "-A"], { cwd: real });
  execFileSync(
    "git",
    ["-c", "user.email=e2e@test", "-c", "user.name=e2e", "commit", "-qm", "init"],
    {
      cwd: real,
    },
  );
  return real;
}

describe.skipIf(!ENABLED)("Phase 7 acceptance: researcher -> coder -> reviewer -> tester", () => {
  let project: string;
  let client: Client;
  let server: McpServer;
  let manager: OpenCodeManager;
  let config: ResolvedConfig;

  beforeAll(async () => {
    project = await createDemoProject();
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-demo-state-"));
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
    client = new Client({ name: "e2e-workflow", version: "0.0.0" });
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
    if (project) await fs.promises.rm(project, { recursive: true, force: true });
  });

  it(
    "fixes the demo project through a full multi-agent workflow",
    async () => {
      const failing = spawnSync("npm", ["test"], { cwd: project, encoding: "utf8" });
      expect(failing.status).not.toBe(0);

      const research = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: project,
            agent: "deepseek-researcher",
            task: "The test suite fails. Inspect src/auth/session.js and tests/auth.test.js and identify the exact defects in src/auth/session.js. Do not modify anything.",
            paths: ["src/auth", "tests"],
          },
        }),
      );
      expect(research.status).toBe("completed");
      expect(research.summary.toLowerCase()).toMatch(/expiresat|expiry|ttl/);

      const implementation = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: project,
            agent: "deepseek-coder",
            task: "Run `npm test`, then fix src/auth/session.js so the whole suite passes. Do not modify the tests. Run `npm test` again and report the result.",
            paths: ["src/auth/session.js", "tests"],
          },
        }),
      );
      expect(implementation.status).toBe("completed");

      const passing = spawnSync("npm", ["test"], { cwd: project, encoding: "utf8" });
      expect(passing.status).toBe(0);

      const session = parse(
        await client.callTool({
          name: "get_session",
          arguments: { session_id: implementation.session_id },
        }),
      );
      expect(session.status).toBe("completed");

      const diff = parse(
        await client.callTool({
          name: "get_diff",
          arguments: { session_id: implementation.session_id },
        }),
      );
      expect(diff.files.map((file: { file: string }) => file.file)).toContain(
        "src/auth/session.js",
      );

      const review = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: project,
            agent: "deepseek-reviewer",
            task: "Review src/auth/session.js, which was just fixed, for correctness and security defects. Report findings using the required format.",
            paths: ["src/auth/session.js"],
          },
        }),
      );
      expect(review.status).toBe("completed");

      const testing = parse(
        await client.callTool({
          name: "delegate_task",
          arguments: {
            cwd: project,
            agent: "deepseek-tester",
            task: "Run the project's test suite with `npm test` and report the results and any root causes.",
            paths: ["tests"],
          },
        }),
      );
      expect(testing.status).toBe("completed");
      expect(testing.summary.toLowerCase()).toMatch(/pass|ok|success/);

      const finalTest = spawnSync("npm", ["test"], { cwd: project, encoding: "utf8" });
      expect(finalTest.status).toBe(0);
    },
    TIMEOUT,
  );
});
