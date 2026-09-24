import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";

export interface AuthCredentials {
  username: string;
  password: string;
}

export function basicAuthHeader(credentials: AuthCredentials): string {
  const raw = `${credentials.username}:${credentials.password}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

export interface WorkspaceClientOptions {
  baseUrl: string;
  directory?: string;
  auth?: AuthCredentials | null;
}

/**
 * Build an OpenCode SDK client bound to a workspace directory.
 *
 * `directory` is sent as the `x-opencode-directory` header on every request
 * (and as a query parameter on GET/HEAD) so the server routes the request to
 * the correct project instance.
 */
export function createWorkspaceClient(options: WorkspaceClientOptions): OpencodeClient {
  const headers: Record<string, string> = {};
  if (options.auth) headers.Authorization = basicAuthHeader(options.auth);

  const config: Parameters<typeof createOpencodeClient>[0] = {
    baseUrl: options.baseUrl,
    headers,
  };
  if (options.directory) config.directory = options.directory;
  return createOpencodeClient(config);
}

export function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export interface HealthResult {
  healthy: boolean;
  version: string;
}

/**
 * Check `/global/health` directly.
 *
 * The v1 client bundled with @opencode-ai/sdk 1.x does not expose a health
 * method (only the v2 namespace does), but the endpoint exists on every
 * 1.x server, so the bridge talks to it over plain HTTP.
 */
export async function fetchHealth(
  baseUrl: string,
  auth?: AuthCredentials | null,
): Promise<HealthResult | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (auth) headers.Authorization = basicAuthHeader(auth);
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/global/health`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { healthy?: boolean; version?: string };
    if (body?.healthy !== true) return null;
    return { healthy: true, version: body.version ?? "unknown" };
  } catch {
    return null;
  }
}
