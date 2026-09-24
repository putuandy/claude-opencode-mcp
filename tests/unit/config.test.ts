import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BridgeConfigSchema,
  DEFAULT_CONFIG,
  deepMerge,
  loadConfig,
  resolveExecutionTimeout,
} from "../../src/config/config.js";
import { BridgeError } from "../../src/errors.js";

const tempDirs: string[] = [];

async function tempDir(prefix = "co-config-"): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

async function write(file: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
}

describe("config defaults", () => {
  it("produces PRD defaults from an empty config", () => {
    const config = BridgeConfigSchema.parse({});
    expect(config.opencode.autoStart).toBe(true);
    expect(config.opencode.startupTimeout).toBe(30_000);
    expect(config.defaults.agent).toBe("deepseek-researcher");
    expect(config.defaults.model).toBeNull();
    expect(config.timeouts.execution).toBe(600_000);
    expect(config.security.protectEnvFiles).toBe(true);
    expect(config.security.denyGitPush).toBe(true);
    expect(config.security.denyGitCommit).toBe(true);
    expect(DEFAULT_CONFIG.workspace.allowedRoots).toEqual([]);
  });

  it("merges nested objects deeply", () => {
    const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1] }, { a: { c: 3 }, list: [2] });
    expect(merged).toEqual({ a: { b: 1, c: 3 }, list: [2] });
  });
});

describe("loadConfig", () => {
  it("loads global then project config with project precedence", async () => {
    const xdg = await tempDir();
    const project = await tempDir();
    const globalPath = path.join(xdg, "claude-opencode-mcp", "config.json");
    await write(globalPath, {
      defaults: { agent: "deepseek-researcher", model: "deepseek/deepseek-v4-pro" },
      timeouts: { execution: 1000 },
    });
    await write(path.join(project, ".claude-opencode", "config.json"), {
      timeouts: { execution: 2000 },
      security: { denyGitPush: false },
    });

    const { config, sources } = await loadConfig({
      cwd: project,
      env: { ...process.env, XDG_CONFIG_HOME: xdg, CLAUDE_OPENCODE_CONFIG: "" },
    });
    expect(config.defaults.model).toBe("deepseek/deepseek-v4-pro");
    expect(config.timeouts.execution).toBe(2000);
    expect(config.security.denyGitPush).toBe(false);
    expect(config.security.denyGitCommit).toBe(true);
    expect(sources).toHaveLength(2);
  });

  it("fails with CONFIG_INVALID for malformed JSON", async () => {
    const dir = await tempDir();
    await write(path.join(dir, "config.json"), "{ not json");
    await expect(
      loadConfig({
        env: { ...process.env, CLAUDE_OPENCODE_CONFIG: path.join(dir, "config.json") },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("fails with CONFIG_INVALID for wrong types", async () => {
    const dir = await tempDir();
    await write(path.join(dir, "config.json"), { timeouts: { execution: "soon" } });
    await expect(
      loadConfig({
        env: { ...process.env, CLAUDE_OPENCODE_CONFIG: path.join(dir, "config.json") },
      }),
    ).rejects.toBeInstanceOf(BridgeError);
  });
});

describe("resolveExecutionTimeout", () => {
  it("uses the override when provided", () => {
    expect(resolveExecutionTimeout(DEFAULT_CONFIG, 500)).toBe(500);
  });

  it("falls back to config and rejects invalid overrides", () => {
    expect(resolveExecutionTimeout(DEFAULT_CONFIG)).toBe(600_000);
    expect(() => resolveExecutionTimeout(DEFAULT_CONFIG, -1)).toThrowError(BridgeError);
  });
});
