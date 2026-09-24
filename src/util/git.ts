import { execFile } from "node:child_process";
import path from "node:path";
import { BridgeError } from "../errors.js";

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
  failed: boolean;
  missing: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export async function runGit(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
      },
      (error, stdout, stderr) => {
        const stdoutText = typeof stdout === "string" ? stdout : String(stdout ?? "");
        const stderrText = typeof stderr === "string" ? stderr : String(stderr ?? "");
        if (error) {
          const errno = (error as NodeJS.ErrnoException).code;
          const missing = errno === "ENOENT";
          const code =
            typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code?: number }).code ?? 1)
              : 1;
          resolve({ code, stdout: stdoutText, stderr: stderrText, failed: true, missing });
          return;
        }
        resolve({ code: 0, stdout: stdoutText, stderr: stderrText, failed: false, missing: false });
      },
    );
  });
}

export async function isGitAvailable(): Promise<boolean> {
  const result = await runGit(process.cwd(), ["--version"], { timeoutMs: 5_000 });
  return !result.missing && !result.failed;
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], { timeoutMs: 5_000 });
  return !result.failed && result.stdout.trim() === "true";
}

export async function findGitRoot(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel"], { timeoutMs: 5_000 });
  if (result.failed) return null;
  const root = result.stdout.trim();
  if (!root) return null;
  return path.resolve(root);
}

export interface GitBaseline {
  /** Commit the workspace was at when the session started (may be null for unborn HEAD). */
  head: string | null;
  /** Commit created by `git stash create` capturing dirty state (null when clean). */
  stashRef: string | null;
  /** Untracked files present at baseline time. */
  untracked: string[];
  /** Whether HEAD exists. */
  unborn: boolean;
  /** Whether the working tree had tracked changes at baseline time. */
  dirty: boolean;
}

/** Capture a non-invasive baseline of the git working tree. */
export async function captureGitBaseline(cwd: string): Promise<GitBaseline | null> {
  const inside = await isGitRepository(cwd);
  if (!inside) return null;

  const headResult = await runGit(cwd, ["rev-parse", "HEAD"], { timeoutMs: 5_000 });
  const head = headResult.failed ? null : headResult.stdout.trim() || null;

  let stashRef: string | null = null;
  const stashResult = await runGit(cwd, ["stash", "create"], { timeoutMs: 10_000 });
  if (!stashResult.failed && stashResult.stdout.trim()) {
    stashRef = stashResult.stdout.trim();
  }

  const untrackedResult = await runGit(cwd, ["ls-files", "--others", "--exclude-standard"], {
    timeoutMs: 10_000,
  });
  const untracked = untrackedResult.failed
    ? []
    : untrackedResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

  return {
    head,
    stashRef,
    untracked,
    unborn: head === null,
    dirty: stashRef !== null,
  };
}

export interface GitDiffResult {
  patch: string;
  files: Array<{
    file: string;
    additions: number;
    deletions: number;
    status: "modified" | "added" | "deleted" | "renamed" | "unknown";
  }>;
  truncated: boolean;
  note?: string;
}

interface ParsedFile {
  file: string;
  additions: number;
  deletions: number;
  status: "modified" | "added" | "deleted" | "renamed" | "unknown";
}

export function parseUnifiedDiff(patch: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let current: ParsedFile | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const parts = line.slice("diff --git ".length).trim().split(" ");
      const bPath = parts.length >= 2 ? parts[parts.length - 1] : undefined;
      const cleaned = bPath?.replace(/^b\//, "") ?? "unknown";
      current = { file: cleaned, additions: 0, deletions: 0, status: "modified" };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.file = line.slice("rename to ".length).trim();
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      current.additions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.deletions += 1;
    }
  }
  if (current) files.push(current);
  return files;
}

async function newFilePatch(cwd: string, file: string): Promise<string> {
  const result = await runGit(
    cwd,
    ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file],
    {
      timeoutMs: 15_000,
    },
  );
  // `git diff --no-index` exits with code 1 when differences are found.
  if (result.missing) return "";
  return result.stdout;
}

export interface DiffOptions {
  maxPatchChars?: number;
  maxNewFiles?: number;
}

/** Compute the workspace diff between the recorded baseline and the current state. */
export async function diffSinceBaseline(
  cwd: string,
  baseline: GitBaseline,
  options: DiffOptions = {},
): Promise<GitDiffResult> {
  const maxPatchChars = options.maxPatchChars ?? 60_000;
  const maxNewFiles = options.maxNewFiles ?? 40;
  const notes: string[] = [];
  const chunks: string[] = [];

  const ref = baseline.stashRef ?? baseline.head;
  if (ref) {
    const result = await runGit(cwd, ["diff", "--no-color", "--no-ext-diff", ref, "--"], {
      timeoutMs: 20_000,
    });
    if (result.failed) {
      throw new BridgeError(
        "OPENCODE_ERROR",
        `git diff failed: ${result.stderr.trim() || "unknown error"}`,
      );
    }
    if (result.stdout.trim()) chunks.push(result.stdout);
  } else if (baseline.unborn) {
    const tracked = await runGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard"], {
      timeoutMs: 15_000,
    });
    if (!tracked.failed) {
      const files = tracked.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, maxNewFiles);
      for (const file of files) {
        const patch = await newFilePatch(cwd, file);
        if (patch.trim()) chunks.push(patch);
      }
    }
    notes.push("Repository has no commits yet; every tracked file is reported as added.");
  }

  const untrackedNow = await runGit(cwd, ["ls-files", "--others", "--exclude-standard"], {
    timeoutMs: 10_000,
  });
  if (!untrackedNow.failed) {
    const baselineSet = new Set(baseline.untracked);
    const newFiles = untrackedNow.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !baselineSet.has(line));
    if (newFiles.length > maxNewFiles) {
      notes.push(`Only the first ${maxNewFiles} new untracked files are shown.`);
    }
    for (const file of newFiles.slice(0, maxNewFiles)) {
      const patch = await newFilePatch(cwd, file);
      if (patch.trim()) chunks.push(patch);
    }
  }

  let patch = chunks.join("\n");
  let truncated = false;
  if (patch.length > maxPatchChars) {
    patch = `${patch.slice(0, maxPatchChars)}\n… [diff truncated at ${maxPatchChars} characters] …\n`;
    truncated = true;
  }

  return {
    patch,
    files: parseUnifiedDiff(patch),
    truncated,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

export async function currentHead(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ["rev-parse", "HEAD"], { timeoutMs: 5_000 });
  if (result.failed) return null;
  return result.stdout.trim() || null;
}
