import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../../src/errors.js";
import {
  isPathInside,
  isSensitivePath,
  matchesAnyPattern,
  matchesPattern,
  resolvePathHint,
  wildcardToRegExp,
} from "../../src/security/paths.js";

const tempDirs: string[] = [];

async function tempDir(prefix = "co-paths-"): Promise<string> {
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

describe("wildcard matching", () => {
  it("matches star patterns", () => {
    expect(wildcardToRegExp("*.env").test(".env")).toBe(true);
    expect(wildcardToRegExp("git push*").test("git push origin main")).toBe(true);
    expect(wildcardToRegExp("git push*").test("git pull")).toBe(false);
    expect(matchesPattern("/a/b/.env", "*.env")).toBe(true);
    expect(matchesPattern("/a/b/.env.local", "*.env.*")).toBe(true);
    expect(matchesAnyPattern("/x/credentials", ["credentials", "credentials.*"])).toBe(true);
    expect(matchesAnyPattern("/x/notes.md", ["*.env", "credentials"])).toBe(false);
  });
});

describe("sensitive paths", () => {
  it("flags env files and keys but allows examples", () => {
    expect(isSensitivePath("/repo/.env")).toBe(true);
    expect(isSensitivePath("/repo/.env.production")).toBe(true);
    expect(isSensitivePath("/repo/.env.example")).toBe(false);
    expect(isSensitivePath("/repo/deploy.pem")).toBe(true);
    expect(isSensitivePath("/repo/.ssh/id_rsa")).toBe(true);
    expect(isSensitivePath("/repo/src/index.ts")).toBe(false);
  });
});

describe("path containment", () => {
  it("detects inside and outside paths", () => {
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
    expect(isPathInside("/a/b", "/a/b/c")).toBe(true);
    expect(isPathInside("/a/b", "/a/bc")).toBe(false);
    expect(isPathInside("/a/b", "/a")).toBe(false);
    expect(isPathInside("/a/b", "/a/b/../c")).toBe(false);
  });
});

describe("resolvePathHint", () => {
  it("resolves relative hints inside the workspace", async () => {
    const cwd = await tempDir();
    await fs.promises.mkdir(path.join(cwd, "src"));
    expect(resolvePathHint(cwd, "src")).toBe(path.join(cwd, "src"));
  });

  it("rejects traversal and absolute escapes", async () => {
    const cwd = await tempDir();
    expect(() => resolvePathHint(cwd, "../outside")).toThrowError(BridgeError);
    expect(() => resolvePathHint(cwd, "/etc/passwd")).toThrowError(BridgeError);
    try {
      resolvePathHint(cwd, "../outside");
    } catch (error) {
      expect((error as BridgeError).code).toBe("INVALID_PATH");
    }
  });

  it("rejects null bytes", async () => {
    const cwd = await tempDir();
    expect(() => resolvePathHint(cwd, "src\u0000evil")).toThrowError(BridgeError);
  });
});
