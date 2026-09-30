import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/config.js";
import {
  agentCapabilities,
  buildAgentDefinitions,
  expandAgentVariants,
  isVariantAgentName,
  loadBuiltinAgentDefinitions,
  loadProjectAgentDefinitions,
  normalizeModel,
  parseAgentMarkdown,
  resolveAgentVariant,
  toOpenCodeAgentConfig,
} from "../../src/opencode/agents.js";

const tempDirs: string[] = [];

async function tempDir(prefix = "co-agents-"): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

describe("parseAgentMarkdown", () => {
  it("parses YAML frontmatter and body", () => {
    const parsed = parseAgentMarkdown(
      [
        "---",
        "description: Test agent",
        "mode: all",
        "temperature: 0.2",
        "---",
        "",
        "You help.",
      ].join("\n"),
      "test.md",
    );
    expect(parsed.frontmatter.description).toBe("Test agent");
    expect(parsed.frontmatter.temperature).toBe(0.2);
    expect(parsed.body).toBe("You help.");
  });

  it("tolerates files without frontmatter", () => {
    const parsed = parseAgentMarkdown("Just a prompt.", "test.md");
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("Just a prompt.");
  });
});

describe("builtin agent definitions", () => {
  it("loads the four PRD agents with prompts", async () => {
    const definitions = await loadBuiltinAgentDefinitions();
    expect(definitions.map((entry) => entry.name).sort()).toEqual([
      "deepseek-coder",
      "deepseek-researcher",
      "deepseek-reviewer",
      "deepseek-tester",
    ]);
    for (const definition of definitions) {
      expect(definition.prompt.length).toBeGreaterThan(100);
      expect(definition.description.length).toBeGreaterThan(10);
      expect(definition.mode).toBe("all");
    }
  });

  it("maps agent capabilities from profiles", async () => {
    const definitions = await loadBuiltinAgentDefinitions();
    const byName = new Map(definitions.map((entry) => [entry.name, entry]));
    expect(agentCapabilities(byName.get("deepseek-researcher")!).readOnly).toBe(true);
    expect(agentCapabilities(byName.get("deepseek-reviewer")!).canEdit).toBe(false);
    expect(agentCapabilities(byName.get("deepseek-coder")!).canEdit).toBe(true);
    expect(agentCapabilities(byName.get("deepseek-tester")!).canRunBash).toBe(true);
    expect(agentCapabilities(byName.get("deepseek-tester")!).canEdit).toBe(false);
  });
});

describe("project and config overrides", () => {
  it("lets project files override builtin prompts", async () => {
    const dir = await tempDir();
    await fs.promises.mkdir(path.join(dir, ".claude-opencode", "agents"), { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, ".claude-opencode", "agents", "deepseek-coder.md"),
      ["---", "description: Custom coder", "---", "CUSTOM PROMPT"].join("\n"),
    );

    const builtin = await loadBuiltinAgentDefinitions();
    const project = await loadProjectAgentDefinitions(dir);
    const definitions = buildAgentDefinitions({ builtin, project, config: DEFAULT_CONFIG });
    const coder = definitions.find((entry) => entry.name === "deepseek-coder");
    expect(coder?.prompt).toBe("CUSTOM PROMPT");
    expect(coder?.description).toBe("Custom coder");
    expect(coder?.source).toBe("project");
  });

  it("applies config agents overrides and disables agents", async () => {
    const builtin = await loadBuiltinAgentDefinitions();
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        "deepseek-researcher": { model: "deepseek/deepseek-v4-pro", temperature: 0.3 },
        "deepseek-tester": { enabled: false },
      },
    };
    const definitions = buildAgentDefinitions({
      builtin,
      project: [],
      config: config as typeof DEFAULT_CONFIG,
    });
    const researcher = definitions.find((entry) => entry.name === "deepseek-researcher");
    expect(researcher?.model).toBe("deepseek/deepseek-v4-pro");
    expect(researcher?.temperature).toBe(0.3);
    expect(definitions.find((entry) => entry.name === "deepseek-tester")).toBeUndefined();
  });

  it("builds OpenCode agent config with permissions and model", async () => {
    const builtin = await loadBuiltinAgentDefinitions();
    const definitions = buildAgentDefinitions({ builtin, project: [], config: DEFAULT_CONFIG });
    const config = toOpenCodeAgentConfig(definitions, DEFAULT_CONFIG);
    expect(Object.keys(config)).toHaveLength(4);
    expect(config["deepseek-coder"]?.permission.edit).toEqual(
      expect.objectContaining({ "*": "allow" }),
    );
    expect(config["deepseek-researcher"]?.permission.edit).toBe("deny");
    expect(config["deepseek-researcher"]?.permission.bash).toBe("deny");
    expect(config["deepseek-coder"]?.mode).toBe("all");
  });

  it("normalizes bare model ids with the default provider", () => {
    expect(normalizeModel("deepseek-v4-pro", DEFAULT_CONFIG)).toBe("deepseek/deepseek-v4-pro");
    expect(normalizeModel("deepseek/deepseek-v4-pro", DEFAULT_CONFIG)).toBe(
      "deepseek/deepseek-v4-pro",
    );
  });
});

describe("permission overrides", () => {
  async function researcher() {
    const builtin = await loadBuiltinAgentDefinitions();
    const definitions = buildAgentDefinitions({ builtin, project: [], config: DEFAULT_CONFIG });
    return definitions.find((entry) => entry.name === "deepseek-researcher")!;
  }

  it("keeps the base name when no override is given", async () => {
    const variant = resolveAgentVariant(await researcher());
    expect(variant.name).toBe("deepseek-researcher");
    expect(variant.capabilities).toEqual({ readOnly: true, canEdit: false, canRunBash: false });
  });

  it("grants edits through the safe edit profile", async () => {
    const variant = resolveAgentVariant(await researcher(), { allowEdits: true });
    expect(variant.name).toBe("deepseek-researcher__edit");
    expect(variant.profile).toBe("edit");
    expect(variant.capabilities).toEqual({ readOnly: false, canEdit: true, canRunBash: false });
  });

  it("grants edits and shell through the code profile", async () => {
    const variant = resolveAgentVariant(await researcher(), {
      allowEdits: true,
      allowBash: true,
    });
    expect(variant.name).toBe("deepseek-researcher__rw");
    expect(variant.profile).toBe("code");
  });

  it("grants shell only through the test profile", async () => {
    const variant = resolveAgentVariant(await researcher(), { allowBash: true });
    expect(variant.name).toBe("deepseek-researcher__bash");
    expect(variant.profile).toBe("test");
  });

  it("revokes shell from coder while keeping edits", async () => {
    const builtin = await loadBuiltinAgentDefinitions();
    const definitions = buildAgentDefinitions({ builtin, project: [], config: DEFAULT_CONFIG });
    const coder = definitions.find((entry) => entry.name === "deepseek-coder")!;
    const variant = resolveAgentVariant(coder, { allowBash: false });
    expect(variant.name).toBe("deepseek-coder__edit");
    expect(variant.capabilities).toEqual({ readOnly: false, canEdit: true, canRunBash: false });
  });

  it("expands every agent into four capability variants with safe permissions", async () => {
    const builtin = await loadBuiltinAgentDefinitions();
    const definitions = buildAgentDefinitions({ builtin, project: [], config: DEFAULT_CONFIG });
    const expanded = expandAgentVariants(definitions);
    expect(expanded).toHaveLength(definitions.length * 4);

    const names = expanded.map((entry) => entry.name);
    expect(names).toContain("deepseek-researcher");
    expect(names).toContain("deepseek-researcher__edit");
    expect(names).toContain("deepseek-researcher__bash");
    expect(names).toContain("deepseek-researcher__rw");

    const config = toOpenCodeAgentConfig(expanded, DEFAULT_CONFIG);
    const rw = config["deepseek-researcher__rw"]!;
    expect(rw.permission.edit).toEqual(expect.objectContaining({ "*": "allow", "*.env": "deny" }));
    const editor = config["deepseek-researcher__edit"]!;
    expect(editor.permission.bash).toBe("deny");
    expect(editor.permission.edit).toEqual(expect.objectContaining({ "*.env": "deny" }));
  });

  it("rejects agent names that use the reserved variant separator", async () => {
    const builtin = await loadBuiltinAgentDefinitions();
    const definitions = buildAgentDefinitions({ builtin, project: [], config: DEFAULT_CONFIG });
    expect(() => expandAgentVariants([{ ...definitions[0]!, name: "bad__name" }])).toThrowError();
    expect(isVariantAgentName("deepseek-coder__rw")).toBe(true);
  });
});
