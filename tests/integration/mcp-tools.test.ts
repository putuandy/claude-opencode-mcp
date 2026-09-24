import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeConfigSchema, type ResolvedConfig } from "../../src/config/config.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { OpenCodeManager } from "../../src/opencode/manager.js";
import { SessionRegistry } from "../../src/opencode/sessions.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeOpenCode, type FakeOpenCodeOptions } from "../helpers/fake-opencode.js";

let fake: FakeOpenCode;
let client: Client;
let server: McpServer;
let manager: OpenCodeManager;
let stateDir: string;
const tempDirs: string[] = [];

async function tempDir(prefix = "co-int-"): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function setupApp(options: {
  fakeOptions?: FakeOpenCodeOptions;
  configOverrides?: Record<string, unknown>;
}): Promise<{ config: ResolvedConfig }> {
  fake = new FakeOpenCode(options.fakeOptions);
  const baseUrl = await fake.listen();
  stateDir = await tempDir();
  const config = BridgeConfigSchema.parse({
    opencode: { url: baseUrl, autoStart: false },
    ...(options.configOverrides ?? {}),
  });
  const logger = createLogger({ level: "silent" });
  const registry = new SessionRegistry(path.join(stateDir, "sessions.json"), logger);
  manager = new OpenCodeManager({ logger });
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
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { config };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const first = content[0];
  if (first && first.type === "text") return first.text;
  return "";
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>): any {
  return JSON.parse(textOf(result));
}

beforeEach(() => {
  // each test sets up its own app
});

afterEach(async () => {
  try {
    await client?.close();
  } catch {
    // ignore
  }
  try {
    await server?.close();
  } catch {
    // ignore
  }
  try {
    await fake?.close();
  } catch {
    // ignore
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

describe("MCP tool surface", () => {
  it("registers the seven PRD tools", async () => {
    await setupApp({});
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "abort_session",
      "create_session",
      "delegate_task",
      "get_diff",
      "get_session",
      "list_agents",
      "send_message",
    ]);
  });

  it("lists agents with capabilities", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const result = parse(
      await client.callTool({ name: "list_agents", arguments: { cwd: workspace } }),
    );
    expect(result.default_agent).toBe("deepseek-researcher");
    const names = result.agents.map((agent: { name: string }) => agent.name);
    expect(names).toContain("deepseek-coder");
    const coder = result.agents.find((agent: { name: string }) => agent.name === "deepseek-coder");
    expect(coder.can_edit).toBe(true);
    const researcher = result.agents.find(
      (agent: { name: string }) => agent.name === "deepseek-researcher",
    );
    expect(researcher.read_only).toBe(true);
  });
});

describe("delegate_task", () => {
  it("runs a task end-to-end and returns a structured result", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const result = parse(
      await client.callTool({
        name: "delegate_task",
        arguments: {
          cwd: workspace,
          agent: "deepseek-reviewer",
          task: "Review the auth module",
          paths: ["src/auth"],
        },
      }),
    );
    expect(result.status).toBe("completed");
    expect(result.session_id).toMatch(/^ses_fake_/);
    expect(result.agent).toBe("deepseek-reviewer");
    expect(result.model).toBe("deepseek/deepseek-v4-pro");
    expect(result.summary).toContain("FAKE DONE");
    expect(result.cwd).toBe(await fs.promises.realpath(workspace));

    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]?.agent).toBe("deepseek-reviewer");
    expect(fake.prompts[0]?.text).toContain(workspace);
    expect(fake.prompts[0]?.text).toContain("Review the auth module");
  });

  it("parses findings from the agent output", async () => {
    await setupApp({
      fakeOptions: {
        onPrompt: () => ({
          text: [
            "## Summary",
            "Found issues.",
            "",
            "## Findings",
            "- [severity: high] Missing CSRF protection (src/web/form.ts:12) — forms are unprotected",
            "",
            "## Verdict",
            "Request changes.",
          ].join("\n"),
        }),
      },
    });
    const workspace = await tempDir();
    const result = parse(
      await client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, agent: "deepseek-reviewer", task: "Review forms" },
      }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("high");
    expect(result.findings[0].file).toBe("src/web/form.ts");
  });

  it("rejects unknown agents with AGENT_NOT_FOUND", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, agent: "does-not-exist", task: "x" },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("AGENT_NOT_FOUND");
  });

  it("rejects bad workspace with WORKSPACE_NOT_FOUND", async () => {
    await setupApp({});
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: path.join(os.tmpdir(), "missing-workspace-xyz"), task: "x" },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("rejects path hints that escape the workspace", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "x", paths: ["../../etc"] },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("INVALID_PATH");
  });

  it("honours allow_edits=false by disabling edit tools", async () => {
    await setupApp({});
    const workspace = await tempDir();
    await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, agent: "deepseek-coder", task: "Edit", allow_edits: false },
    });
    expect(fake.prompts[0]?.tools).toEqual({ edit: false, write: false, apply_patch: false });
  });

  it("reports timeouts as AGENT_TIMEOUT without hanging", async () => {
    await setupApp({
      fakeOptions: { onPrompt: () => ({ text: "late", delayMs: 1000 }) },
    });
    const workspace = await tempDir();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "slow work", timeout: 300 },
    });
    expect(result.isError).toBe(true);
    const body = parse(result);
    expect(body.status).toBe("timeout");
    expect(body.error.code).toBe("AGENT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });

  it("surfaces provider errors from OpenCode", async () => {
    await setupApp({
      fakeOptions: {
        onPrompt: () => ({
          text: "",
          error: {
            name: "ProviderAuthError",
            data: { providerID: "deepseek", message: "bad key" },
          },
        }),
      },
    });
    const workspace = await tempDir();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "x" },
    });
    const body = parse(result);
    expect(result.isError).toBe(true);
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("OPENCODE_ERROR");
    expect(body.error.message).toContain("deepseek");
  });

  it("fails when an external server lacks the required agents", async () => {
    await setupApp({
      fakeOptions: { agents: [{ name: "build", mode: "primary", builtIn: true }] },
    });
    const workspace = await tempDir();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "x" },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("AGENT_NOT_FOUND");
  });

  it("returns OPENCODE_UNAVAILABLE instead of hanging when the server is gone", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const baseUrl = fake.server.address();
    expect(baseUrl).toBeTruthy();
    await fake.close();

    const started = Date.now();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "x", timeout: 5000 },
    });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("OPENCODE_UNAVAILABLE");
  });

  it("rejects oversized inputs instead of forwarding them", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const tooManyPaths = Array.from({ length: 201 }, (_, index) => `src/p${index}`);
    let rejected = false;
    let isError = false;
    try {
      const result = await client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, task: "x", paths: tooManyPaths },
      });
      isError = Boolean(result.isError);
    } catch {
      rejected = true;
    }
    expect(rejected || isError).toBe(true);
    expect(fake.prompts).toHaveLength(0);
  });

  it("refuses to delegate when OpenCode reports a different directory", async () => {
    await setupApp({ fakeOptions: { reportedDirectory: "/somewhere/else" } });
    const workspace = await tempDir();
    const result = await client.callTool({
      name: "delegate_task",
      arguments: { cwd: workspace, task: "x" },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("WORKSPACE_MISMATCH");
  });
});

describe("sessions", () => {
  it("keeps context across create_session + send_message", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const created = parse(
      await client.callTool({
        name: "create_session",
        arguments: { cwd: workspace, agent: "deepseek-researcher", title: "auth investigation" },
      }),
    );
    expect(created.session_id).toMatch(/^ses_fake_/);

    await client.callTool({
      name: "send_message",
      arguments: { session_id: created.session_id, message: "First: inspect src/auth" },
    });
    await client.callTool({
      name: "send_message",
      arguments: {
        session_id: created.session_id,
        message: "Second: now inspect the database layer",
      },
    });

    expect(fake.prompts).toHaveLength(2);
    expect(new Set(fake.prompts.map((prompt) => prompt.sessionId)).size).toBe(1);
    expect(fake.prompts[1]?.text).toContain("now inspect the database layer");
    expect(fake.prompts[1]?.text).toContain("Constraints:");

    const session = parse(
      await client.callTool({ name: "get_session", arguments: { session_id: created.session_id } }),
    );
    expect(session.status).toBe("completed");
    expect(session.last_summary).toContain("FAKE DONE");

    const aborted = parse(
      await client.callTool({
        name: "abort_session",
        arguments: { session_id: created.session_id },
      }),
    );
    expect(aborted.aborted).toBe(true);
  });

  it("returns OPENCODE_SESSION_NOT_FOUND for unknown sessions", async () => {
    await setupApp({});
    const result = await client.callTool({
      name: "get_session",
      arguments: { session_id: "ses_missing" },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("OPENCODE_SESSION_NOT_FOUND");
  });
});

describe("get_diff", () => {
  it("returns git changes made during the session", async () => {
    const workspace = await tempDir("co-diff-");
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    await fs.promises.writeFile(path.join(workspace, "app.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: workspace,
    });

    await setupApp({
      fakeOptions: {
        onPrompt: (request) => ({
          text: "Edited files.",
          onBeforeRespond: async () => {
            await fs.promises.writeFile(
              path.join(request.directory, "app.ts"),
              "export const a = 2;\n",
            );
            await fs.promises.writeFile(
              path.join(request.directory, "new-file.ts"),
              "export {};\n",
            );
          },
        }),
      },
    });

    const delegated = parse(
      await client.callTool({
        name: "delegate_task",
        arguments: { cwd: workspace, agent: "deepseek-coder", task: "Bump a" },
      }),
    );
    expect(delegated.status).toBe("completed");
    expect(delegated.files_changed).toBe(2);

    const diff = parse(
      await client.callTool({ name: "get_diff", arguments: { session_id: delegated.session_id } }),
    );
    expect(diff.source).toBe("git");
    const files = diff.files.map((entry: { file: string }) => entry.file).sort();
    expect(files).toEqual(["app.ts", "new-file.ts"]);
    expect(diff.diff).toContain("+export const a = 2;");
  });

  it("reports DIFF_UNAVAILABLE when the workspace is not a git repo", async () => {
    await setupApp({});
    const workspace = await tempDir();
    const created = parse(
      await client.callTool({
        name: "create_session",
        arguments: { cwd: workspace, agent: "deepseek-coder" },
      }),
    );
    const result = await client.callTool({
      name: "get_diff",
      arguments: { session_id: created.session_id },
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.code).toBe("DIFF_UNAVAILABLE");
  });
});
