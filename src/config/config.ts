import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { BridgeError } from "../errors.js";
import { readJsonFile } from "../util/fs.js";

const PermissionActionSchema = z.enum(["allow", "ask", "deny"]);

export const SecurityConfigSchema = z
  .object({
    /** Protect `.env` files and common credential material from read/edit tools. */
    protectEnvFiles: z.boolean().default(true),
    denyGitPush: z.boolean().default(true),
    denyGitCommit: z.boolean().default(true),
    /** Policy for paths outside the workspace (headless bridge defaults to deny). */
    externalDirectory: PermissionActionSchema.default("deny"),
    /** Extra wildcard patterns to protect, e.g. `secrets/*`. */
    extraProtectedPatterns: z.array(z.string()).default([]),
  })
  .prefault({});

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

export const AgentOverrideSchema = z.object({
  description: z.string().optional(),
  model: z.string().nullable().optional(),
  provider: z.string().optional(),
  temperature: z.number().optional(),
  prompt: z.string().optional(),
  profile: z.enum(["read", "review", "edit", "code", "test"]).optional(),
  enabled: z.boolean().optional(),
});

export type AgentOverride = z.infer<typeof AgentOverrideSchema>;

export const BridgeConfigSchema = z.object({
  opencode: z
    .object({
      /** Connect to an already-running OpenCode server instead of starting one. */
      url: z.string().nullable().default(null),
      autoStart: z.boolean().default(true),
      hostname: z.string().default("127.0.0.1"),
      port: z.number().int().min(0).max(65535).default(0),
      startupTimeout: z.number().int().positive().default(30_000),
      /** Explicit path to the OpenCode executable. */
      binary: z.string().nullable().default(null),
      username: z.string().nullable().default(null),
      password: z.string().nullable().default(null),
      logLevel: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).nullable().default(null),
      /** Maximum number of lazily started OpenCode servers kept alive. */
      maxServers: z.number().int().positive().default(4),
    })
    .prefault({}),
  workspace: z
    .object({
      /** When non-empty, workspaces must resolve inside one of these roots. */
      allowedRoots: z.array(z.string()).default([]),
      defaultCwd: z.string().nullable().default(null),
    })
    .prefault({}),
  defaults: z
    .object({
      agent: z.string().default("deepseek-researcher"),
      provider: z.string().default("deepseek"),
      /** `provider/model` or bare model id. When null the provider default is used. */
      model: z.string().nullable().default(null),
    })
    .prefault({}),
  timeouts: z
    .object({
      execution: z.number().int().positive().default(600_000),
    })
    .prefault({}),
  security: SecurityConfigSchema,
  limits: z
    .object({
      summaryChars: z.number().int().positive().default(6_000),
      sessionChars: z.number().int().positive().default(20_000),
      diffChars: z.number().int().positive().default(60_000),
    })
    .prefault({}),
  /** Per-agent overrides keyed by agent name. */
  agents: z.record(z.string(), AgentOverrideSchema).prefault({}),
});

export type BridgeConfigInput = z.input<typeof BridgeConfigSchema>;
export type ResolvedConfig = z.output<typeof BridgeConfigSchema>;

export const DEFAULT_CONFIG: ResolvedConfig = BridgeConfigSchema.parse({});

export function globalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg?.trim() ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "claude-opencode-mcp");
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(globalConfigDir(env), "config.json");
}

export function projectConfigDir(cwd: string): string {
  return path.join(cwd, ".claude-opencode");
}

export function projectConfigPath(cwd: string): string {
  return path.join(projectConfigDir(cwd), "config.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T)) as T;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = result[key];
    result[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result as T;
}

function parseConfigFile(file: string, raw: unknown): BridgeConfigInput {
  const result = BridgeConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new BridgeError("CONFIG_INVALID", `Invalid configuration in ${file}`, {
      details: { file, issues: result.error.issues.slice(0, 10) },
    });
  }
  // Merge the raw (validated) values rather than result.data: applying schema
  // defaults per file would let a default in a later file clobber an explicit
  // value from an earlier one. Defaults are applied once, after merging.
  return raw as BridgeConfigInput;
}

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Extra config file loaded last (highest precedence). */
  explicitPath?: string | null;
}

export interface LoadedConfig {
  config: ResolvedConfig;
  sources: string[];
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ? path.resolve(options.cwd) : null;
  const sources: string[] = [];
  let merged: BridgeConfigInput = {};

  const files: string[] = [globalConfigPath(env)];
  if (cwd) files.push(projectConfigPath(cwd));
  const explicit = options.explicitPath ?? env.CLAUDE_OPENCODE_CONFIG ?? null;
  if (explicit?.trim()) files.push(path.resolve(explicit));

  for (const file of files) {
    let raw: unknown;
    try {
      raw = await readJsonFile<unknown>(file);
    } catch (error) {
      throw new BridgeError("CONFIG_INVALID", `Could not read configuration file ${file}`, {
        details: { file, reason: error instanceof Error ? error.message : String(error) },
        cause: error,
      });
    }
    if (raw === null || raw === undefined) continue;
    const parsed = parseConfigFile(file, raw);
    merged = deepMerge(merged, parsed);
    sources.push(file);
  }

  const config = BridgeConfigSchema.parse(merged);
  return { config, sources };
}

export function resolveExecutionTimeout(config: ResolvedConfig, override?: number): number {
  if (override !== undefined) {
    if (!Number.isFinite(override) || override <= 0) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "timeout must be a positive number of milliseconds",
        {
          details: { timeout: override },
        },
      );
    }
    return Math.floor(override);
  }
  return config.timeouts.execution;
}
