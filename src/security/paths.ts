import path from "node:path";
import { BridgeError } from "../errors.js";

/** Convert an OpenCode-style wildcard pattern (`*`, `?`) to a RegExp. */
export function wildcardToRegExp(pattern: string): RegExp {
  let output = "^";
  for (const char of pattern) {
    if (char === "*") output += ".*";
    else if (char === "?") output += ".";
    else output += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  output += "$";
  return new RegExp(output);
}

export function matchesPattern(target: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const regex = wildcardToRegExp(pattern);
  if (regex.test(target)) return true;
  return regex.test(path.basename(target));
}

export function matchesAnyPattern(target: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(target, pattern));
}

/** Patterns for sensitive files that should not be read or written by agents. */
export const DEFAULT_SENSITIVE_PATTERNS = [
  "*.env",
  "*.env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  "credentials",
  "credentials.*",
  ".ssh/*",
  "*.npmrc",
] as const;

/** Patterns that stay readable even when sensitive-file protection is on. */
export const SENSITIVE_ALLOWLIST = ["*.env.example", "*.env.sample", "*.env.template"] as const;

export function isSensitivePath(target: string, extraPatterns: string[] = []): boolean {
  if (matchesAnyPattern(target, [...SENSITIVE_ALLOWLIST])) return false;
  return matchesAnyPattern(target, [...DEFAULT_SENSITIVE_PATTERNS, ...extraPatterns]);
}

/** Canonicalize a path to its real path. Throws INVALID_PATH when it does not exist. */
export async function canonicalize(target: string): Promise<string> {
  const fs = await import("node:fs");
  try {
    return await fs.promises.realpath(target);
  } catch (error) {
    throw new BridgeError("INVALID_PATH", `Path does not exist or cannot be resolved: ${target}`, {
      details: { path: target },
      cause: error,
    });
  }
}

/** True when `child` is the same as, or inside, `parent` (both canonical). */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === "") return true;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function assertNoNullBytes(value: string, label: string): void {
  if (value.includes("\u0000")) {
    throw new BridgeError("INVALID_PATH", `${label} contains a null byte`, {
      details: { [label]: value },
    });
  }
}

/**
 * Resolve a task path hint relative to the workspace and make sure it stays
 * inside the workspace. Hints are advisory for exploration, but they must not
 * point outside the delegated workspace.
 */
export function resolvePathHint(cwd: string, hint: string): string {
  assertNoNullBytes(hint, "path hint");
  const absolute = path.isAbsolute(hint) ? path.resolve(hint) : path.resolve(cwd, hint);
  if (!isPathInside(cwd, absolute)) {
    throw new BridgeError("INVALID_PATH", `Path hint escapes the workspace: ${hint}`, {
      details: { hint, cwd, resolved: absolute },
    });
  }
  return absolute;
}
