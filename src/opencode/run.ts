import type { OpencodeClient, Part } from "@opencode-ai/sdk";
import type { ResolvedConfig } from "../config/config.js";
import { BridgeError } from "../errors.js";
import type { RunProgress, RunResult } from "../types/index.js";
import type { Logger } from "../util/logger.js";
import { extractFindings, stripAnsi } from "../util/text.js";

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export function parseModelRef(model: string, defaultProvider: string): ModelRef {
  const trimmed = model.trim();
  if (!trimmed) {
    throw new BridgeError("INVALID_ARGUMENT", "model must not be empty");
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
  }
  return { providerID: defaultProvider, modelID: trimmed };
}

export function formatModelRef(ref: ModelRef | null): string | null {
  return ref ? `${ref.providerID}/${ref.modelID}` : null;
}

/**
 * Resolve which model a delegated run should use.
 *
 * Priority: explicit request > bridge configuration > provider default from
 * the running OpenCode instance. Nothing is hard-coded to DeepSeek: the
 * provider comes from `defaults.provider`.
 */
export async function resolveModel(
  client: OpencodeClient,
  config: ResolvedConfig,
  requested?: string | null,
): Promise<ModelRef | null> {
  const raw = requested?.trim() ? requested.trim() : config.defaults.model;
  if (raw) return parseModelRef(raw, config.defaults.provider);

  let defaults: Record<string, string> = {};
  try {
    const result = await client.config.providers();
    defaults = result.data?.default ?? {};
  } catch {
    defaults = {};
  }
  const modelID = defaults[config.defaults.provider];
  if (modelID) {
    return { providerID: config.defaults.provider, modelID };
  }
  throw new BridgeError(
    "MODEL_NOT_AVAILABLE",
    [
      `No default model is available for provider "${config.defaults.provider}".`,
      'Set `defaults.model` (for example "deepseek/deepseek-v4-pro") in the bridge config,',
      "or configure a default model in OpenCode, or pass `model` to delegate_task.",
    ].join(" "),
    { details: { provider: config.defaults.provider, availableDefaults: defaults } },
  );
}

export function assistantText(parts: Part[] | undefined): string {
  if (!parts) return "";
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .filter((part) => !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

interface RunErrorInfo {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function describeError(error: unknown): RunErrorInfo {
  const record = error as { name?: string; data?: Record<string, unknown> } | null;
  const name = record?.name ?? "UnknownError";
  const data = record?.data ?? {};
  switch (name) {
    case "ProviderAuthError":
      return {
        code: "OPENCODE_ERROR",
        message: `Provider authentication failed for ${String(data.providerID ?? "provider")}: ${String(
          data.message ?? "unknown error",
        )}`,
        details: { providerID: data.providerID },
      };
    case "MessageAbortedError":
      return { code: "AGENT_ABORTED", message: "The delegated run was aborted." };
    case "MessageOutputLengthError":
      return {
        code: "AGENT_EXECUTION_FAILED",
        message: "The model hit its output length limit before finishing.",
      };
    case "APIError":
    case "ApiError":
      return {
        code: "AGENT_EXECUTION_FAILED",
        message: String(data.message ?? "The model provider returned an error."),
        details: {
          statusCode: data.statusCode,
          responseBody:
            typeof data.responseBody === "string" ? data.responseBody.slice(0, 2000) : undefined,
          isRetryable: data.isRetryable,
        },
      };
    default:
      return {
        code: "AGENT_EXECUTION_FAILED",
        message: String(data.message ?? "The delegated run failed."),
        details: { name },
      };
  }
}

async function latestActivity(client: OpencodeClient, sessionId: string): Promise<string | null> {
  try {
    const result = await client.session.messages({ path: { id: sessionId }, query: { limit: 5 } });
    const messages = result.data ?? [];
    const last = messages[messages.length - 1];
    if (!last) return null;
    const parts = last.parts ?? [];
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index];
      if (!part) continue;
      if (part.type === "tool") {
        const status = part.state && "status" in part.state ? part.state.status : "running";
        return `${status === "running" ? "running" : status} ${part.tool}`;
      }
      if (part.type === "reasoning") return "reasoning";
      if (part.type === "text") return "writing response";
    }
    return null;
  } catch {
    return null;
  }
}

export interface RunPromptInput {
  client: OpencodeClient;
  sessionId: string;
  agent: string;
  model: ModelRef | null;
  text: string;
  timeoutMs: number;
  disableEdits?: boolean;
  onProgress?: (progress: RunProgress) => void | Promise<void>;
  signal?: AbortSignal;
  logger: Logger;
}

const POLL_INTERVAL_MS = 1500;

export async function runPrompt(input: RunPromptInput): Promise<RunResult> {
  const startedAt = Date.now();
  let abortedByCaller = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  const abortSession = async (): Promise<void> => {
    try {
      await input.client.session.abort({ path: { id: input.sessionId } });
    } catch {
      // best effort
    }
  };

  const onSignalAbort = () => {
    abortedByCaller = true;
    void abortSession();
  };

  if (input.signal) {
    if (input.signal.aborted) {
      throw new BridgeError("AGENT_ABORTED", "Delegated run was cancelled before it started.");
    }
    input.signal.addEventListener("abort", onSignalAbort, { once: true });
  }

  const emit = async (progress: RunProgress) => {
    if (!input.onProgress) return;
    try {
      await input.onProgress(progress);
    } catch {
      // progress reporting must never break the run
    }
  };

  const startPolling = () => {
    if (!input.onProgress) return;
    const tick = async () => {
      const elapsed = Date.now() - startedAt;
      let message = "working…";
      try {
        const statusResult = await input.client.session.status();
        const status = statusResult.data?.[input.sessionId];
        if (status?.type === "retry") {
          message = `retrying after provider error (attempt ${status.attempt})`;
        } else if (status?.type === "busy") {
          message = "working…";
        }
        const activity = await latestActivity(input.client, input.sessionId);
        if (activity) message = activity;
      } catch {
        // keep the previous message
      }
      await emit({ progress: Math.min(90, 5 + Math.floor(elapsed / 1000)), message });
    };
    void tick();
    pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    pollTimer.unref?.();
  };

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = null;
    input.signal?.removeEventListener("abort", onSignalAbort);
  };

  const body = {
    agent: input.agent,
    parts: [{ type: "text" as const, text: input.text }],
    ...(input.model ? { model: input.model } : {}),
    ...(input.disableEdits ? { tools: { edit: false, write: false, apply_patch: false } } : {}),
  };

  startPolling();

  const promptPromise = input.client.session
    .prompt({ path: { id: input.sessionId }, body })
    .then((result) => ({ kind: "result" as const, result }))
    .catch((error: unknown) => ({ kind: "thrown" as const, error }));

  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutTimer = setTimeout(() => {
      void abortSession();
      resolve({ kind: "timeout" });
    }, input.timeoutMs);
    timeoutTimer.unref?.();
  });

  const outcome = await Promise.race([promptPromise, timeoutPromise]);
  stopPolling();
  const durationMs = Date.now() - startedAt;

  if (outcome.kind === "timeout") {
    await emit({ progress: 95, message: "timed out; aborting session" });
    return {
      status: "timeout",
      summary: "",
      findings: [],
      error: {
        code: "AGENT_TIMEOUT",
        message: `Delegated run exceeded ${input.timeoutMs}ms and was aborted.`,
        details: { timeout_ms: input.timeoutMs },
      },
      durationMs,
      truncated: false,
    };
  }

  if (abortedByCaller) {
    throw new BridgeError("AGENT_ABORTED", "Delegated run was cancelled by the caller.");
  }

  if (outcome.kind === "thrown") {
    const error = outcome.error;
    if (error instanceof BridgeError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new BridgeError("OPENCODE_UNAVAILABLE", `OpenCode request failed: ${message}`, {
      cause: error,
      retryable: true,
    });
  }

  const { data, error } = outcome.result;
  if (error) {
    const mapped = describeError(error);
    return {
      status: "failed",
      summary: "",
      findings: [],
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details ? { details: mapped.details } : {}),
      },
      durationMs,
      truncated: false,
    };
  }

  const info = data?.info;
  if (!info) {
    return {
      status: "failed",
      summary: "",
      findings: [],
      error: { code: "OPENCODE_ERROR", message: "OpenCode returned an empty assistant message." },
      durationMs,
      truncated: false,
    };
  }

  if (info.error) {
    const mapped = describeError(info.error);
    if (mapped.code === "AGENT_ABORTED" && abortedByCaller) {
      throw new BridgeError("AGENT_ABORTED", "Delegated run was cancelled by the caller.");
    }
    return {
      status: "failed",
      summary: "",
      findings: [],
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details ? { details: mapped.details } : {}),
      },
      durationMs,
      ...(info.id ? { messageID: info.id } : {}),
      truncated: false,
    };
  }

  let summary = stripAnsi(assistantText(data?.parts));
  if (!summary) {
    summary = await fallbackLatestText(input.client, input.sessionId);
  }

  await emit({ progress: 100, message: "completed" });

  return {
    status: "completed",
    summary,
    findings: extractFindings(summary),
    durationMs,
    ...(info.id ? { messageID: info.id } : {}),
    truncated: false,
  };
}

async function fallbackLatestText(client: OpencodeClient, sessionId: string): Promise<string> {
  try {
    const result = await client.session.messages({ path: { id: sessionId }, query: { limit: 10 } });
    const messages = result.data ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.info.role !== "assistant") continue;
      const text = assistantText(message.parts);
      if (text) return stripAnsi(text);
    }
  } catch {
    // ignored
  }
  return "";
}
