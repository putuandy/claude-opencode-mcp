import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";
import { packageRoot } from "./agents.js";

export interface ResolvedBinary {
  command: string;
  version: string;
  source: string;
}

export interface ResolveBinaryOptions {
  configured?: string | null;
  env?: NodeJS.ProcessEnv;
}

function executableNames(): string[] {
  return process.platform === "win32" ? ["opencode.cmd", "opencode.exe", "opencode"] : ["opencode"];
}

function candidatePaths(configured: string | null | undefined, env: NodeJS.ProcessEnv) {
  const candidates: Array<{ command: string; source: string; mustExist: boolean }> = [];
  const explicit = configured ?? env.OPENCODE_BIN ?? null;
  if (explicit?.trim()) {
    candidates.push({
      command: explicit.trim(),
      source: "config/env OPENCODE_BIN",
      mustExist: true,
    });
  }
  for (const name of executableNames()) {
    candidates.push({ command: name, source: "PATH", mustExist: false });
  }
  // Walk up from the package root so hoisted installs are found too: npm often
  // places `opencode-ai` in a parent node_modules/.bin when this package is a
  // dependency rather than the root project.
  let dir = packageRoot();
  const seen = new Set<string>();
  while (dir && !seen.has(dir)) {
    seen.add(dir);
    for (const name of executableNames()) {
      candidates.push({
        command: path.join(dir, "node_modules", ".bin", name),
        source: `node_modules/.bin (${dir})`,
        mustExist: true,
      });
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const name of executableNames()) {
    candidates.push({
      command: path.join(process.cwd(), "node_modules", ".bin", name),
      source: "project node_modules/.bin",
      mustExist: true,
    });
  }
  for (const name of executableNames()) {
    candidates.push({
      command: path.join(os.homedir(), ".opencode", "bin", name),
      source: "~/.opencode/bin",
      mustExist: true,
    });
    candidates.push({
      command: path.join(os.homedir(), ".local", "bin", name),
      source: "~/.local/bin",
      mustExist: true,
    });
    candidates.push({ command: `/opt/homebrew/bin/${name}`, source: "homebrew", mustExist: true });
    candidates.push({ command: `/usr/local/bin/${name}`, source: "usr-local", mustExist: true });
  }
  return candidates;
}

function probeVersion(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      ["--version"],
      { timeout: 20_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }
        const output = `${stdout}\n${stderr}`.trim();
        const firstLine = output
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)[0];
        resolve(firstLine ?? "unknown");
      },
    );
  });
}

export async function resolveOpenCodeBinary(
  options: ResolveBinaryOptions = {},
): Promise<ResolvedBinary> {
  const env = options.env ?? process.env;
  const candidates = candidatePaths(options.configured, env);
  const failures: string[] = [];
  for (const candidate of candidates) {
    if (candidate.mustExist) {
      try {
        await fs.promises.access(candidate.command, fs.constants.X_OK);
      } catch {
        failures.push(`${candidate.command} (${candidate.source}): not found`);
        continue;
      }
    }
    const version = await probeVersion(candidate.command);
    if (version) {
      return { command: candidate.command, version, source: candidate.source };
    }
    failures.push(`${candidate.command} (${candidate.source}): not executable`);
  }

  throw new BridgeError(
    "OPENCODE_NOT_AVAILABLE",
    [
      "OpenCode executable was not found.",
      "Install it with `npm install -g opencode-ai` (or `brew install sst/tap/opencode`),",
      "or point the bridge at it with the OPENCODE_BIN environment variable",
      "or the opencode.binary configuration option.",
    ].join(" "),
    { details: { candidates: failures }, retryable: false },
  );
}

/** Cached binary resolution so we only probe the filesystem once per process. */
export class BinaryResolver {
  private cached: ResolvedBinary | null = null;
  private cachedKey: string | null = null;

  constructor(private readonly options: ResolveBinaryOptions = {}) {}

  async resolve(configured?: string | null, force = false): Promise<ResolvedBinary> {
    const key = configured ?? this.options.configured ?? null;
    if (this.cached && !force && this.cachedKey === key) return this.cached;
    this.cached = await resolveOpenCodeBinary({ ...this.options, configured: key });
    this.cachedKey = key;
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
    this.cachedKey = null;
  }
}
