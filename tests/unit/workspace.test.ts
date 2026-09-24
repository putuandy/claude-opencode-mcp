import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { BridgeError } from "../../src/errors.js";
import { candidateWorkspacePaths, resolveWorkspace } from "../../src/workspace/resolver.js";
import { validateWorkspace } from "../../src/workspace/validator.js";

const tempDirs: string[] = [];

async function tempDir(prefix = "co-ws-"): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fs.promises.realpath(dir);
  tempDirs.push(real);
  return real;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

async function expectBridgeError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected BridgeError to be thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).code).toBe(code);
  }
}

describe("validateWorkspace", () => {
  it("accepts an existing directory and canonicalizes it", async () => {
    const dir = await tempDir();
    const result = await validateWorkspace({ requestedPath: dir });
    expect(result.cwd).toBe(dir);
  });

  it("fails for missing paths", async () => {
    const dir = await tempDir();
    await expectBridgeError(
      validateWorkspace({ requestedPath: path.join(dir, "missing") }),
      "WORKSPACE_NOT_FOUND",
    );
  });

  it("fails for files", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "file.txt");
    await fs.promises.writeFile(file, "x");
    await expectBridgeError(validateWorkspace({ requestedPath: file }), "INVALID_PATH");
  });

  it("enforces allowed roots", async () => {
    const root = await tempDir("co-root-");
    const inside = path.join(root, "inside");
    const outside = await tempDir("co-out-");
    await fs.promises.mkdir(inside);

    const ok = await validateWorkspace({ requestedPath: inside, allowedRoots: [root] });
    expect(ok.cwd).toBe(path.join(await fs.promises.realpath(root), "inside"));

    await expectBridgeError(
      validateWorkspace({ requestedPath: outside, allowedRoots: [root] }),
      "WORKSPACE_NOT_ALLOWED",
    );
  });

  it("rejects when allowed roots are configured but none exist", async () => {
    const dir = await tempDir();
    await expectBridgeError(
      validateWorkspace({ requestedPath: dir, allowedRoots: [path.join(dir, "nope")] }),
      "WORKSPACE_NOT_ALLOWED",
    );
  });

  it("detects git roots", async () => {
    const dir = await tempDir();
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const result = await validateWorkspace({ requestedPath: dir });
    expect(result.gitRoot).toBe(dir);
  });
});

describe("candidateWorkspacePaths / resolveWorkspace", () => {
  it("prioritizes explicit cwd over env and process cwd", async () => {
    const explicit = await tempDir("co-explicit-");
    const envDir = await tempDir("co-env-");
    const candidates = candidateWorkspacePaths({
      cwd: explicit,
      env: { ...process.env, CLAUDE_PROJECT_DIR: envDir },
    });
    expect(candidates[0]?.path).toBe(explicit);
    expect(candidates[0]?.required).toBe(true);
    expect(candidates[1]?.origin).toBe("CLAUDE_PROJECT_DIR");
  });

  it("resolves using CLAUDE_PROJECT_DIR", async () => {
    const envDir = await tempDir("co-claudeproj-");
    const resolution = await resolveWorkspace({
      env: { ...process.env, CLAUDE_PROJECT_DIR: envDir },
      globalConfig: DEFAULT_CONFIG,
    });
    expect(resolution.workspace.cwd).toBe(envDir);
  });

  it("throws when an explicit cwd is invalid even if the process cwd is valid", async () => {
    const explicit = path.join(os.tmpdir(), `definitely-missing-${Date.now()}`);
    await expectBridgeError(
      resolveWorkspace({ cwd: explicit, env: process.env, globalConfig: DEFAULT_CONFIG }),
      "WORKSPACE_NOT_FOUND",
    );
  });

  it("loads project-local config", async () => {
    const dir = await tempDir();
    await fs.promises.mkdir(path.join(dir, ".claude-opencode"), { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, ".claude-opencode", "config.json"),
      JSON.stringify({ defaults: { agent: "deepseek-coder" } }),
    );
    const resolution = await resolveWorkspace({
      cwd: dir,
      env: process.env,
      globalConfig: DEFAULT_CONFIG,
    });
    expect(resolution.config.defaults.agent).toBe("deepseek-coder");
    expect(resolution.configSources.some((source) => source.includes(".claude-opencode"))).toBe(
      true,
    );
  });
});
