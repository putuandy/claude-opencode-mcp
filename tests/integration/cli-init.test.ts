import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/init.js";
import { loadConfig } from "../../src/config/config.js";
import { resolveOpenCodeBinary } from "../../src/opencode/binary.js";

const tempDirs: string[] = [];

async function tempProject(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-init-"));
  const real = await fs.promises.realpath(dir);
  tempDirs.push(real);
  execFileSync("git", ["init", "-q"], { cwd: real });
  await fs.promises.writeFile(
    path.join(real, "package.json"),
    JSON.stringify({ name: "init-test", private: true, version: "0.0.0" }),
  );
  return real;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

describe("claude-opencode init", () => {
  it("creates project config, agent files and .mcp.json without touching source", async () => {
    const project = await tempProject();
    const sourceBefore = await fs.promises.readFile(path.join(project, "package.json"), "utf8");

    // Environments without OpenCode (`npm install --omit=optional`, bare CI
    // runners) are valid: init must still scaffold the project and only report
    // failure for the missing binary.
    let opencodeAvailable = true;
    try {
      await resolveOpenCodeBinary({ env: process.env });
    } catch {
      opencodeAvailable = false;
    }

    const code = await runInit({ dir: project, writeMcp: true });
    expect(code).toBe(opencodeAvailable ? 0 : 1);

    const configPath = path.join(project, ".claude-opencode", "config.json");
    const projectConfig = JSON.parse(await fs.promises.readFile(configPath, "utf8"));
    expect(projectConfig.defaults.agent).toBe("deepseek-researcher");

    const agentsDir = path.join(project, ".claude-opencode", "agents");
    const agents = (await fs.promises.readdir(agentsDir)).sort();
    expect(agents).toEqual([
      "deepseek-coder.md",
      "deepseek-researcher.md",
      "deepseek-reviewer.md",
      "deepseek-tester.md",
    ]);

    const mcp = JSON.parse(await fs.promises.readFile(path.join(project, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.opencode.command).toBe("npx");
    expect(mcp.mcpServers.opencode.timeout).toBe(600000);

    const sourceAfter = await fs.promises.readFile(path.join(project, "package.json"), "utf8");
    expect(sourceAfter).toBe(sourceBefore);

    const { config } = await loadConfig({ cwd: project });
    expect(config.defaults.agent).toBe("deepseek-researcher");

    // Second run must not overwrite user edits.
    await fs.promises.writeFile(path.join(agentsDir, "deepseek-coder.md"), "custom prompt", "utf8");
    const secondCode = await runInit({ dir: project });
    expect(secondCode).toBe(opencodeAvailable ? 0 : 1);
    expect(await fs.promises.readFile(path.join(agentsDir, "deepseek-coder.md"), "utf8")).toBe(
      "custom prompt",
    );
  }, 120_000);
});
