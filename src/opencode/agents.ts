import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { ResolvedConfig } from "../config/config.js";
import { BridgeError } from "../errors.js";
import {
  type AgentProfile,
  buildPermissions,
  PROFILE_CAPABILITIES,
  type ProfileCapabilities,
  profileForAgent,
} from "../security/policy.js";
import type { AgentDefinition, PermissionConfig } from "../types/index.js";

export const BUILTIN_AGENT_NAMES = [
  "deepseek-researcher",
  "deepseek-reviewer",
  "deepseek-coder",
  "deepseek-tester",
] as const;

export type BuiltinAgentName = (typeof BUILTIN_AGENT_NAMES)[number];

const PROFILE_BY_NAME: Record<string, AgentProfile> = {
  "deepseek-researcher": "read",
  "deepseek-reviewer": "review",
  "deepseek-coder": "code",
  "deepseek-tester": "test",
};

export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/opencode/ -> package root; dist/opencode/ -> package root
  return path.resolve(here, "..", "..");
}

export function builtinAgentsDir(): string {
  return path.join(packageRoot(), "agents");
}

interface AgentFrontmatter {
  description?: string;
  mode?: string;
  model?: string;
  temperature?: number;
  profile?: string;
  [key: string]: unknown;
}

export interface ParsedAgentFile {
  frontmatter: AgentFrontmatter;
  body: string;
  file: string;
}

export function parseAgentMarkdown(contents: string, file: string): ParsedAgentFile {
  const normalized = contents.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim(), file };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: normalized.trim(), file };
  }
  const header = normalized.slice(4, end);
  const body = normalized
    .slice(end + 4)
    .replace(/^\n+/, "")
    .trim();
  let frontmatter: AgentFrontmatter = {};
  try {
    const parsed = parseYaml(header);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as AgentFrontmatter;
    }
  } catch (error) {
    throw new BridgeError("CONFIG_INVALID", `Invalid agent frontmatter in ${file}`, {
      details: { file, reason: error instanceof Error ? error.message : String(error) },
      cause: error,
    });
  }
  return { frontmatter, body, file };
}

function normalizeMode(value: unknown): "primary" | "subagent" | "all" {
  return value === "primary" || value === "subagent" || value === "all" ? value : "all";
}

const VALID_PROFILES: ReadonlySet<string> = new Set(["read", "review", "code", "test"]);

function frontmatterProfile(frontmatter: AgentFrontmatter): AgentProfile | undefined {
  return typeof frontmatter.profile === "string" && VALID_PROFILES.has(frontmatter.profile)
    ? (frontmatter.profile as AgentProfile)
    : undefined;
}

async function readAgentFile(file: string, name: string): Promise<AgentDefinition> {
  const contents = await fs.promises.readFile(file, "utf8");
  const { frontmatter, body } = parseAgentMarkdown(contents, file);
  return {
    name,
    description:
      typeof frontmatter.description === "string" && frontmatter.description.trim()
        ? frontmatter.description.trim()
        : `Delegated agent ${name}`,
    mode: normalizeMode(frontmatter.mode),
    prompt: body,
    permission: {},
    model: typeof frontmatter.model === "string" ? frontmatter.model : null,
    ...(typeof frontmatter.temperature === "number"
      ? { temperature: frontmatter.temperature }
      : {}),
    source: "builtin",
  };
}

export async function loadBuiltinAgentDefinitions(): Promise<AgentDefinition[]> {
  const dir = builtinAgentsDir();
  const definitions: AgentDefinition[] = [];
  for (const name of BUILTIN_AGENT_NAMES) {
    const file = path.join(dir, `${name}.md`);
    try {
      const definition = await readAgentFile(file, name);
      definitions.push(definition);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BridgeError(
          "CONFIG_INVALID",
          `Built-in agent definition is missing: ${file}. Reinstall claude-opencode-mcp.`,
          { details: { file }, cause: error },
        );
      }
      throw error;
    }
  }
  return definitions;
}

export async function loadProjectAgentDefinitions(cwd: string): Promise<AgentDefinition[]> {
  const dir = path.join(cwd, ".claude-opencode", "agents");
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const definitions: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    const file = path.join(dir, entry);
    const contents = await fs.promises.readFile(file, "utf8");
    const { frontmatter, body } = parseAgentMarkdown(contents, file);
    definitions.push({
      name,
      description:
        typeof frontmatter.description === "string" && frontmatter.description.trim()
          ? frontmatter.description.trim()
          : `Project agent ${name}`,
      mode: normalizeMode(frontmatter.mode),
      prompt: body,
      permission: {},
      model: typeof frontmatter.model === "string" ? frontmatter.model : null,
      ...(typeof frontmatter.temperature === "number"
        ? { temperature: frontmatter.temperature }
        : {}),
      ...(frontmatterProfile(frontmatter) ? { profile: frontmatterProfile(frontmatter) } : {}),
      source: "project",
    });
  }
  return definitions;
}

function profileForDefinition(definition: AgentDefinition): AgentProfile {
  const byName = PROFILE_BY_NAME[definition.name];
  if (byName) return byName;
  if (definition.profile) return definition.profile;
  if (/coder|editor|implement/i.test(definition.name)) return "code";
  if (/test/i.test(definition.name)) return "test";
  if (/review|audit/i.test(definition.name)) return "review";
  return "read";
}

export interface BuildDefinitionsInput {
  builtin: AgentDefinition[];
  project: AgentDefinition[];
  config: ResolvedConfig;
}

export function buildAgentDefinitions(input: BuildDefinitionsInput): AgentDefinition[] {
  const { builtin, project, config } = input;
  const byName = new Map<string, AgentDefinition>();
  for (const definition of builtin) byName.set(definition.name, { ...definition });

  for (const definition of project) {
    const existing = byName.get(definition.name);
    if (existing) {
      byName.set(definition.name, {
        ...existing,
        description: definition.description,
        prompt: definition.prompt,
        mode: definition.mode,
        model: definition.model ?? existing.model,
        ...(definition.temperature !== undefined ? { temperature: definition.temperature } : {}),
        source: "project",
      });
    } else {
      byName.set(definition.name, { ...definition });
    }
  }

  for (const [name, override] of Object.entries(config.agents)) {
    if (override.enabled === false) {
      byName.delete(name);
      continue;
    }
    const existing = byName.get(name);
    const base: AgentDefinition = existing ?? {
      name,
      description: override.description ?? `Delegated agent ${name}`,
      mode: "all",
      prompt: override.prompt ?? "You are a delegated software engineering agent.",
      permission: {},
      model: null,
      source: "project",
    };
    byName.set(name, {
      ...base,
      ...(override.description !== undefined ? { description: override.description } : {}),
      ...(override.prompt !== undefined ? { prompt: override.prompt } : {}),
      ...(override.model !== undefined ? { model: override.model } : {}),
      ...(override.temperature !== undefined ? { temperature: override.temperature } : {}),
      ...(override.profile !== undefined ? { profile: override.profile } : {}),
    });
  }

  return [...byName.values()];
}

export function agentProfile(definition: AgentDefinition): AgentProfile {
  return definition.profile ?? profileForDefinition(definition);
}

export function agentCapabilities(definition: AgentDefinition): ProfileCapabilities {
  return PROFILE_CAPABILITIES[agentProfile(definition)];
}

export function agentPermissions(
  definition: AgentDefinition,
  config: ResolvedConfig,
): PermissionConfig {
  return buildPermissions(agentProfile(definition), config.security);
}

export interface OpenCodeAgentEntry {
  description: string;
  mode: "primary" | "subagent" | "all";
  prompt: string;
  permission: PermissionConfig;
  model?: string;
  temperature?: number;
}

export function toOpenCodeAgentConfig(
  definitions: AgentDefinition[],
  config: ResolvedConfig,
): Record<string, OpenCodeAgentEntry> {
  const result: Record<string, OpenCodeAgentEntry> = {};
  for (const definition of definitions) {
    const model = definition.model ?? config.defaults.model ?? null;
    result[definition.name] = {
      description: definition.description,
      mode: definition.mode,
      prompt: definition.prompt,
      permission: agentPermissions(definition, config),
      ...(model ? { model: normalizeModel(model, config) } : {}),
      ...(definition.temperature !== undefined ? { temperature: definition.temperature } : {}),
    };
  }
  return result;
}

export function normalizeModel(model: string, config: ResolvedConfig): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes("/")) return trimmed;
  return `${config.defaults.provider}/${trimmed}`;
}

export function findAgentDefinition(
  definitions: AgentDefinition[],
  name: string,
): AgentDefinition | null {
  return definitions.find((definition) => definition.name === name) ?? null;
}

export function isBuiltinAgent(name: string): name is BuiltinAgentName {
  return (BUILTIN_AGENT_NAMES as readonly string[]).includes(name);
}

export function fallbackProfileForUnknownAgent(name: string): AgentProfile | null {
  return profileForAgent(name) ?? PROFILE_BY_NAME[name] ?? null;
}
