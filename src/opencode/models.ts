import { execFile } from "node:child_process";
import { BridgeError } from "../errors.js";
import { stripAnsi } from "../util/text.js";

/** Provider ids are simple slugs; anything else is rejected before reaching argv. */
export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Group `opencode models` output ("provider/model" per line) by provider. */
export function groupModels(output: string): Record<string, string[]> {
  const providers: Record<string, string[]> = {};
  for (const line of output.split("\n")) {
    const id = stripAnsi(line).trim();
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
  if (provider !== undefined && !PROVIDER_ID_PATTERN.test(provider)) {
    return Promise.reject(
      new BridgeError("INVALID_ARGUMENT", `Invalid provider id: ${provider}`, {
        details: { provider },
      }),
    );
  }
  return new Promise((resolve, reject) => {
    execFile(
      command,
      ["models", ...(provider ? [provider] : [])],
      { cwd, timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(groupModels(String(stdout)));
          return;
        }
        const message = stripAnsi(String(stderr ?? ""))
          .replace(/^Error:\s*/i, "")
          .trim();
        if (provider && /provider not found/i.test(message)) {
          reject(
            new BridgeError("INVALID_ARGUMENT", `Unknown provider: ${provider}`, {
              details: { provider, hint: "Call list_models without provider to see all." },
            }),
          );
          return;
        }
        reject(
          new BridgeError(
            "OPENCODE_ERROR",
            `opencode models failed: ${message || (error instanceof Error ? error.message : String(error))}`,
            { cause: error },
          ),
        );
      },
    );
  });
}
