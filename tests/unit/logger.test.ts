import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/util/logger.js";

function captureStderr(run: () => void): string {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return writes.join("");
}

describe("logger redaction", () => {
  it("redacts credential-looking field names", () => {
    const output = captureStderr(() => {
      const logger = createLogger({ level: "info" });
      logger.info("auth", {
        password: "hunter2",
        OPENCODE_SERVER_PASSWORD: "secret-value",
        apiKey: "sk-live-123",
        authorization: "Basic abc",
        token: "tok_123",
        private_key: "pem",
        normal: "visible",
      });
    });
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("sk-live-123");
    expect(output).not.toContain("tok_123");
    expect(output).toContain("[redacted]");
    expect(output).toContain("normal=visible");
  });

  it("applies to child bindings and messages", () => {
    const output = captureStderr(() => {
      const logger = createLogger({ level: "debug" }).child({ api_key: "abc123" });
      logger.debug("started");
    });
    expect(output).not.toContain("abc123");
    expect(output).toContain("[redacted]");
  });

  it("respects the silent level", () => {
    const output = captureStderr(() => {
      const logger = createLogger({ level: "silent" });
      logger.error("should not appear");
    });
    expect(output).toBe("");
  });
});
