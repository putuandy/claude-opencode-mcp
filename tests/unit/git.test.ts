import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureGitBaseline,
  diffSinceBaseline,
  findGitRoot,
  isGitRepository,
  parseUnifiedDiff,
  runGit,
} from "../../src/util/git.js";

const tempDirs: string[] = [];

async function tempRepo(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-git-"));
  const real = await fs.promises.realpath(dir);
  tempDirs.push(real);
  execFileSync("git", ["init", "-q"], { cwd: real });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"],
    {
      cwd: real,
    },
  );
  return real;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
  );
});

describe("git helpers", () => {
  it("detects repositories and roots", async () => {
    const repo = await tempRepo();
    const nested = path.join(repo, "src", "deep");
    await fs.promises.mkdir(nested, { recursive: true });
    expect(await isGitRepository(repo)).toBe(true);
    expect(await findGitRoot(nested)).toBe(repo);
  });

  it("returns null baseline outside git", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-nogit-"));
    tempDirs.push(dir);
    expect(await captureGitBaseline(dir)).toBeNull();
  });

  it("reports only changes made after the baseline", async () => {
    const repo = await tempRepo();
    await fs.promises.writeFile(path.join(repo, "tracked.txt"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], {
      cwd: repo,
    });

    const baseline = await captureGitBaseline(repo);
    expect(baseline).not.toBeNull();

    // changes made "after the session started"
    await fs.promises.writeFile(path.join(repo, "tracked.txt"), "one\ntwo\n");
    await fs.promises.writeFile(path.join(repo, "added.txt"), "new file\n");

    const diff = await diffSinceBaseline(repo, baseline!, { maxPatchChars: 100_000 });
    const files = diff.files.map((entry) => entry.file).sort();
    expect(files).toContain("tracked.txt");
    expect(files).toContain("added.txt");
    expect(diff.patch).toContain("+two");
    expect(diff.patch).toContain("+new file");
  });

  it("isolates agent changes from pre-existing uncommitted work", async () => {
    const repo = await tempRepo();
    await fs.promises.writeFile(path.join(repo, "user.txt"), "clean\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], {
      cwd: repo,
    });

    // user had already modified a file plus an untracked file before the session
    await fs.promises.writeFile(path.join(repo, "user.txt"), "user edit\n");
    await fs.promises.writeFile(path.join(repo, "pre-existing-untracked.txt"), "mine\n");

    const baseline = await captureGitBaseline(repo);
    expect(baseline?.stashRef).toBeTruthy();

    // agent changes
    await fs.promises.writeFile(path.join(repo, "agent.txt"), "agent\n");

    const diff = await diffSinceBaseline(repo, baseline!);
    const files = diff.files.map((entry) => entry.file);
    expect(files).toContain("agent.txt");
    expect(files).not.toContain("user.txt");
    expect(files).not.toContain("pre-existing-untracked.txt");
  });

  it("handles repositories without commits", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "co-unborn-"));
    const real = await fs.promises.realpath(dir);
    tempDirs.push(real);
    execFileSync("git", ["init", "-q"], { cwd: real });
    await fs.promises.writeFile(path.join(real, "first.txt"), "hello\n");
    const baseline = await captureGitBaseline(real);
    expect(baseline?.unborn).toBe(true);
    const diff = await diffSinceBaseline(real, baseline!);
    expect(diff.files.map((entry) => entry.file)).toContain("first.txt");
  });

  it("parses unified diffs", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1,2 @@",
      " one",
      "+two",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+new",
    ].join("\n");
    const parsed = parseUnifiedDiff(patch);
    expect(parsed).toEqual([
      { file: "a.txt", additions: 1, deletions: 0, status: "modified" },
      { file: "new.txt", additions: 1, deletions: 0, status: "added" },
    ]);
  });

  it("surfaces git failures", async () => {
    const repo = await tempRepo();
    const result = await runGit(repo, ["definitely-not-a-command"]);
    expect(result.failed).toBe(true);
  });
});
