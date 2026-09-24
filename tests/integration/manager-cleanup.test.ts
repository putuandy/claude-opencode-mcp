import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeConfigSchema } from "../../src/config/config.js";
import { OpenCodeManager } from "../../src/opencode/manager.js";
import { createLogger } from "../../src/util/logger.js";
import { FakeOpenCode } from "../helpers/fake-opencode.js";

const tempDirs: string[] = [];

async function tempDir(prefix = "co-cleanup-"): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fs.promises.realpath(dir);
  tempDirs.push(real);
  return real;
}

async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !(await isAlive(pid));
}

async function makeFakeBinary(dir: string, url: string, pidFile: string): Promise<string> {
  const script = path.join(dir, "fake-opencode");
  await fs.promises.writeFile(
    script,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "fake-9.9.9"; exit 0; fi',
      `echo $$ > "${pidFile}"`,
      `echo "opencode server listening on ${url}"`,
      "exec sleep 300",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.promises.chmod(script, 0o755);
  return script;
}

async function readPid(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const raw = await fs.promises.readFile(pidFile, "utf8");
      const pid = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(pid)) return pid;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fake opencode never wrote ${pidFile}`);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

describe("OpenCodeManager child-process cleanup", () => {
  it("stopAll kills the spawned OpenCode process", async () => {
    const fake = new FakeOpenCode();
    const url = await fake.listen();
    try {
      const dir = await tempDir();
      const pidFile = path.join(dir, "fake.pid");
      const binary = await makeFakeBinary(dir, url, pidFile);
      const config = BridgeConfigSchema.parse({
        opencode: { binary, autoStart: true, startupTimeout: 8000 },
      });
      const manager = new OpenCodeManager({
        logger: createLogger({ level: "silent" }),
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: undefined },
      });

      await manager.ensure({ cwd: dir, config, agentConfig: {} });
      const pid = await readPid(pidFile);
      expect(await isAlive(pid)).toBe(true);

      await manager.stopAll();
      expect(await waitForDeath(pid)).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("killAllSync kills a spawned process that was never registered in stopAll", async () => {
    const fake = new FakeOpenCode();
    const url = await fake.listen();
    try {
      const dir = await tempDir();
      const pidFile = path.join(dir, "fake.pid");
      const binary = await makeFakeBinary(dir, url, pidFile);
      const config = BridgeConfigSchema.parse({
        opencode: { binary, autoStart: true, startupTimeout: 8000 },
      });
      const manager = new OpenCodeManager({
        logger: createLogger({ level: "silent" }),
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: undefined },
      });

      await manager.ensure({ cwd: dir, config, agentConfig: {} });
      const pid = await readPid(pidFile);
      expect(await isAlive(pid)).toBe(true);

      manager.killAllSync();
      expect(await waitForDeath(pid)).toBe(true);

      await manager.stopAll();
    } finally {
      await fake.close();
    }
  });
});
