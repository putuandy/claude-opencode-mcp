import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "../errors.js";
import { isPathInside } from "../security/paths.js";
import { findGitRoot } from "../util/git.js";

export interface ValidateWorkspaceOptions {
  /** Requested path (absolute or relative to process.cwd()). */
  requestedPath: string;
  /** When non-empty, the canonical workspace must live inside one of these roots. */
  allowedRoots?: string[];
}

export interface ValidatedWorkspace {
  cwd: string;
  requestedPath: string;
  gitRoot?: string;
  warnings: string[];
}

async function canonicalizeRoots(
  roots: string[],
): Promise<{ roots: string[]; warnings: string[] }> {
  const canonical: string[] = [];
  const warnings: string[] = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    try {
      const real = await fs.promises.realpath(resolved);
      const stat = await fs.promises.stat(real);
      if (!stat.isDirectory()) {
        warnings.push(`allowed root is not a directory and was ignored: ${root}`);
        continue;
      }
      canonical.push(real);
    } catch {
      warnings.push(`allowed root does not exist and was ignored: ${root}`);
    }
  }
  return { roots: canonical, warnings };
}

export async function validateWorkspace(
  options: ValidateWorkspaceOptions,
): Promise<ValidatedWorkspace> {
  const warnings: string[] = [];
  const requestedPath = options.requestedPath;
  if (!requestedPath?.trim()) {
    throw new BridgeError(
      "WORKSPACE_NOT_FOUND",
      "Unable to determine project workspace. Provide cwd explicitly.",
    );
  }

  const absolute = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(process.cwd(), requestedPath);

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absolute);
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      throw new BridgeError("WORKSPACE_NOT_FOUND", `Workspace does not exist: ${absolute}`, {
        details: { cwd: absolute },
        cause: error,
      });
    }
    if (errno === "EACCES" || errno === "EPERM") {
      throw new BridgeError("WORKSPACE_NOT_READABLE", `Workspace is not readable: ${absolute}`, {
        details: { cwd: absolute },
        cause: error,
      });
    }
    throw new BridgeError("WORKSPACE_NOT_FOUND", `Workspace cannot be accessed: ${absolute}`, {
      details: { cwd: absolute, reason: errno },
      cause: error,
    });
  }

  if (!stat.isDirectory()) {
    throw new BridgeError("INVALID_PATH", `Workspace is not a directory: ${absolute}`, {
      details: { cwd: absolute },
    });
  }

  let canonical: string;
  try {
    canonical = await fs.promises.realpath(absolute);
  } catch (error) {
    throw new BridgeError("WORKSPACE_NOT_READABLE", `Workspace cannot be resolved: ${absolute}`, {
      details: { cwd: absolute },
      cause: error,
    });
  }

  try {
    await fs.promises.access(canonical, fs.constants.R_OK | fs.constants.X_OK);
  } catch (error) {
    throw new BridgeError("WORKSPACE_NOT_READABLE", `Workspace is not readable: ${canonical}`, {
      details: { cwd: canonical },
      cause: error,
    });
  }

  const allowedRoots = options.allowedRoots ?? [];
  if (allowedRoots.length > 0) {
    const { roots, warnings: rootWarnings } = await canonicalizeRoots(allowedRoots);
    warnings.push(...rootWarnings);
    if (roots.length === 0) {
      throw new BridgeError(
        "WORKSPACE_NOT_ALLOWED",
        "No configured workspace.allowedRoots entry exists; refusing to delegate.",
        { details: { allowedRoots } },
      );
    }
    const inside = roots.some((root) => isPathInside(root, canonical));
    if (!inside) {
      throw new BridgeError(
        "WORKSPACE_NOT_ALLOWED",
        `Workspace is outside the configured allowed roots: ${canonical}`,
        { details: { cwd: canonical, allowedRoots: roots } },
      );
    }
  }

  const gitRoot = await findGitRoot(canonical);

  return {
    cwd: canonical,
    requestedPath,
    ...(gitRoot ? { gitRoot } : {}),
    warnings,
  };
}
