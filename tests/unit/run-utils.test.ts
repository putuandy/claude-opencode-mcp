import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import { BridgeError, serializeError } from "../../src/errors.js";
import { describeError, parseModelRef, resolveModel } from "../../src/opencode/run.js";
import { createSessionRecord, SessionRegistry } from "../../src/opencode/sessions.js";
import { createLogger } from "../../src/util/logger.js";

describe("parseModelRef", () => {
  it("splits provider/model", () => {
    expect(parseModelRef("deepseek/deepseek-v4-pro", "deepseek")).toEqual({
      providerID: "deepseek",
      modelID: "deepseek-v4-pro",
    });
  });

  it("prefixes bare model ids", () => {
    expect(parseModelRef("deepseek-v4-pro", "deepseek")).toEqual({
      providerID: "deepseek",
      modelID: "deepseek-v4-pro",
    });
  });

  it("rejects empty values", () => {
    expect(() => parseModelRef("  ", "deepseek")).toThrowError(BridgeError);
  });
});

describe("resolveModel", () => {
  const fakeClient = (defaults: Record<string, string>) =>
    ({
      config: {
        providers: vi.fn(async () => ({ data: { providers: [], default: defaults } })),
      },
    }) as never;

  it("uses the explicit request first", async () => {
    const model = await resolveModel(fakeClient({}), DEFAULT_CONFIG, "deepseek/deepseek-v4-pro");
    expect(model).toEqual({ providerID: "deepseek", modelID: "deepseek-v4-pro" });
  });

  it("uses config defaults.model second", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      defaults: { ...DEFAULT_CONFIG.defaults, model: "deepseek/deepseek-flash" },
    };
    const model = await resolveModel(fakeClient({}), config);
    expect(model).toEqual({ providerID: "deepseek", modelID: "deepseek-flash" });
  });

  it("falls back to the provider default from OpenCode", async () => {
    const model = await resolveModel(fakeClient({ deepseek: "deepseek-v4-pro" }), DEFAULT_CONFIG);
    expect(model).toEqual({ providerID: "deepseek", modelID: "deepseek-v4-pro" });
  });

  it("errors when nothing is available", async () => {
    await expect(resolveModel(fakeClient({}), DEFAULT_CONFIG)).rejects.toMatchObject({
      code: "MODEL_NOT_AVAILABLE",
    });
  });
});

describe("describeError", () => {
  it("maps provider auth errors", () => {
    const mapped = describeError({
      name: "ProviderAuthError",
      data: { providerID: "deepseek", message: "bad key" },
    });
    expect(mapped.code).toBe("OPENCODE_ERROR");
    expect(mapped.message).toContain("deepseek");
  });

  it("maps aborted messages", () => {
    expect(describeError({ name: "MessageAbortedError", data: {} }).code).toBe("AGENT_ABORTED");
  });

  it("maps API errors with status details", () => {
    const mapped = describeError({
      name: "APIError",
      data: { message: "rate limited", statusCode: 429, isRetryable: true },
    });
    expect(mapped.code).toBe("AGENT_EXECUTION_FAILED");
    expect(mapped.details?.statusCode).toBe(429);
  });
});

describe("SessionRegistry", () => {
  it("persists and reloads sessions", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-reg-"));
    const file = path.join(dir, "sessions.json");
    const logger = createLogger({ level: "silent" });
    const registry = new SessionRegistry(file, logger);
    registry.upsert(
      createSessionRecord({
        id: "ses_1",
        cwd: "/tmp",
        agent: "deepseek-coder",
        provider: "deepseek",
        model: "deepseek/deepseek-v4-pro",
        title: "test",
      }),
    );

    const reloaded = new SessionRegistry(file, logger);
    expect(reloaded.get("ses_1")?.agent).toBe("deepseek-coder");
    expect(reloaded.update("ses_1", { status: "completed" })?.status).toBe("completed");
    expect(reloaded.list()).toHaveLength(1);

    const mode = (await fs.promises.stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("prunes sessions older than the retention window", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-reg-"));
    const file = path.join(dir, "sessions.json");
    const old = createSessionRecord({
      id: "ses_old",
      cwd: "/tmp",
      agent: "deepseek-coder",
      provider: "deepseek",
      model: null,
      title: null,
    });
    old.updatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await fs.promises.writeFile(file, JSON.stringify({ version: 1, sessions: [old] }));
    const registry = new SessionRegistry(file, createLogger({ level: "silent" }));
    expect(registry.get("ses_old")).toBeNull();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("merges sessions written by another bridge process (no clobbering)", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-reg-"));
    const file = path.join(dir, "sessions.json");
    const logger = createLogger({ level: "silent" });
    const processA = new SessionRegistry(file, logger);
    const processB = new SessionRegistry(file, logger);

    processA.upsert(
      createSessionRecord({
        id: "ses_a",
        cwd: "/tmp",
        agent: "deepseek-coder",
        provider: "deepseek",
        model: null,
        title: null,
      }),
    );
    processB.upsert(
      createSessionRecord({
        id: "ses_b",
        cwd: "/tmp",
        agent: "deepseek-reviewer",
        provider: "deepseek",
        model: null,
        title: null,
      }),
    );

    const reloaded = new SessionRegistry(file, logger);
    expect(reloaded.get("ses_a")).not.toBeNull();
    expect(reloaded.get("ses_b")).not.toBeNull();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("marks stale running sessions as failed on load", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-reg-"));
    const file = path.join(dir, "sessions.json");
    const stale = createSessionRecord({
      id: "ses_stale",
      cwd: "/tmp",
      agent: "deepseek-coder",
      provider: "deepseek",
      model: null,
      title: null,
    });
    stale.status = "running";
    stale.updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await fs.promises.writeFile(file, JSON.stringify({ version: 1, sessions: [stale] }));

    const registry = new SessionRegistry(file, createLogger({ level: "silent" }));
    const session = registry.get("ses_stale");
    expect(session?.status).toBe("failed");
    expect(session?.lastError?.code).toBe("BRIDGE_RESTARTED");
    await fs.promises.rm(dir, { recursive: true, force: true });
  });
});

describe("serializeError", () => {
  it("serializes BridgeError with code", () => {
    const serialized = serializeError(
      new BridgeError("INVALID_PATH", "nope", { details: { x: 1 } }),
      "req_1",
    );
    expect(serialized).toEqual({
      code: "INVALID_PATH",
      message: "nope",
      details: { x: 1 },
      retryable: false,
      request_id: "req_1",
    });
  });

  it("wraps unknown errors", () => {
    expect(serializeError(new Error("boom")).code).toBe("INTERNAL_ERROR");
  });
});
