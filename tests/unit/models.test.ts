import { describe, expect, it } from "vitest";
import { groupModels } from "../../src/opencode/models.js";

describe("groupModels", () => {
  it("groups provider/model lines and skips noise", () => {
    const out =
      "deepseek/deepseek-flash\naedoxy/claude-opus-5.5\n\ndeepseek/deepseek-v4-pro\nWarning: something\n";
    expect(groupModels(out)).toEqual({
      deepseek: ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"],
      aedoxy: ["aedoxy/claude-opus-5.5"],
    });
  });
});
