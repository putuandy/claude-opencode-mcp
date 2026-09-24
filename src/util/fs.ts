import fs from "node:fs";
import path from "node:path";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

export function ensureDirSync(dir: string, mode?: number): void {
  fs.mkdirSync(dir, { recursive: true, ...(mode !== undefined ? { mode } : {}) });
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function readJsonFileSync<T>(file: string): T | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Write a file atomically (write temp file in the same dir, then rename). */
export async function writeFileAtomic(
  file: string,
  contents: string,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.promises.writeFile(temp, contents, {
    encoding: "utf8",
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
  });
  await fs.promises.rename(temp, file);
  if (options.mode !== undefined) {
    await fs.promises.chmod(file, options.mode).catch(() => undefined);
  }
}

export function writeFileAtomicSync(
  file: string,
  contents: string,
  options: { mode?: number } = {},
): void {
  const dir = path.dirname(file);
  // Session/log state lives in a directory only the owner can access.
  ensureDirSync(dir, options.mode !== undefined ? 0o700 : undefined);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, contents, {
    encoding: "utf8",
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
  });
  fs.renameSync(temp, file);
  if (options.mode !== undefined) {
    try {
      fs.chmodSync(file, options.mode);
    } catch {
      // best effort; the file is still written
    }
  }
}
