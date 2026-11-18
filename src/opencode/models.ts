import { execFile } from "node:child_process";

/** Group `opencode models` output ("provider/model" per line) by provider. */
export function groupModels(output: string): Record<string, string[]> {
  const providers: Record<string, string[]> = {};
  for (const line of output.split("\n")) {
    const id = line.trim();
    const slash = id.indexOf("/");
    if (slash <= 0 || /\s/.test(id)) continue;
    const provider = id.slice(0, slash);
    providers[provider] ??= [];
    providers[provider].push(id);
  }
  return providers;
}

/** Run `opencode models [provider]` in the workspace so project providers are included. */
export function listOpenCodeModels(
  command: string,
  cwd: string,
  provider?: string,
): Promise<Record<string, string[]>> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      ["models", ...(provider ? [provider] : [])],
      { cwd, timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(groupModels(stdout))),
    );
  });
}
