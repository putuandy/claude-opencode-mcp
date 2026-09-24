import { describe, expect, it } from "vitest";
import { extractFindings, oneLine, stripAnsi, truncate } from "../../src/util/text.js";

describe("truncate", () => {
  it("returns text unchanged when it fits", () => {
    expect(truncate("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  it("truncates and marks", () => {
    const result = truncate("a".repeat(1000), 100);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[truncated");
    expect(result.text.length).toBeLessThan(400);
  });
});

describe("stripAnsi", () => {
  it("removes ANSI escapes", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
  });
});

describe("oneLine", () => {
  it("collapses whitespace", () => {
    expect(oneLine("a\n\n  b\tc")).toBe("a b c");
  });
});

describe("extractFindings", () => {
  it("parses structured review findings", () => {
    const text = [
      "## Summary",
      "Reviewed auth.",
      "",
      "## Findings",
      "- [severity: high] Token expiry not validated (src/auth/token.ts:42) — tokens live forever",
      "- [medium] Missing rate limit (src/auth/login.ts:10) - brute force possible",
      "- All good elsewhere",
      "",
      "## Verdict",
      "Request changes.",
    ].join("\n");
    const findings = extractFindings(text);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toEqual({
      severity: "high",
      title: "Token expiry not validated",
      detail: "tokens live forever",
      file: "src/auth/token.ts",
      line: 42,
    });
    expect(findings[1]?.severity).toBe("medium");
    expect(findings[1]?.file).toBe("src/auth/login.ts");
  });

  it("handles Critical prefixes without brackets", () => {
    const findings = extractFindings(
      "## Issues\n- Critical: SQL injection in query builder (db.ts:7)\n",
    );
    expect(findings[0]?.severity).toBe("critical");
    expect(findings[0]?.title).toBe("SQL injection in query builder");
  });

  it("returns empty when there is no findings section", () => {
    expect(extractFindings("## Summary\nEverything is fine.\n")).toEqual([]);
  });
});
