import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../../src/errors.js";
import { groupModels, listOpenCodeModels } from "../../src/opencode/models.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

async function fakeBinary(script: string): Promise<{ command: string; dir: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-models-"));
  tempDirs.push(dir);
  const command = path.join(dir, "fake-opencode");
  await fs.promises.writeFile(command, `#!/bin/sh\n${script}\n`, "utf8");
  await fs.promises.chmod(command, 0o755);
  return { command, dir };
}

describe("groupModels", () => {
  it("groups provider/model lines and skips noise", () => {
    const out =
      "deepseek/deepseek-flash\nanthropic/claude-sonnet-4-5\n\ndeepseek/deepseek-v4-pro\nWarning: something\n";
    expect(groupModels(out)).toEqual({
      deepseek: ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"],
      anthropic: ["anthropic/claude-sonnet-4-5"],
    });
  });

  it("strips ANSI color codes", () => {
    expect(groupModels("\u001b[32mdeepseek/deepseek-flash\u001b[0m\n")).toEqual({
      deepseek: ["deepseek/deepseek-flash"],
    });
  });
});

describe("listOpenCodeModels", () => {
  it("passes the provider argument and groups output", async () => {
    const { command, dir } = await fakeBinary(
      'if [ "$1" = "models" ] && [ "$2" = "deepseek" ]; then echo deepseek/deepseek-flash; else echo other/x; fi',
    );
    expect(await listOpenCodeModels(command, dir, "deepseek")).toEqual({
      deepseek: ["deepseek/deepseek-flash"],
    });
  });

  it("rejects flag-like provider ids before spawning", async () => {
    const { command, dir } = await fakeBinary("echo should-not-run");
    await expect(listOpenCodeModels(command, dir, "--help")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("maps an unknown provider to INVALID_ARGUMENT", async () => {
    const { command, dir } = await fakeBinary('echo "Error: Provider not found: nope" >&2; exit 1');
    await expect(listOpenCodeModels(command, dir, "nope")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("maps other failures to OPENCODE_ERROR with stderr", async () => {
    const { command, dir } = await fakeBinary('echo "Error: boom" >&2; exit 2');
    const error = await listOpenCodeModels(command, dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).code).toBe("OPENCODE_ERROR");
    expect((error as BridgeError).message).toContain("boom");
  });
});
