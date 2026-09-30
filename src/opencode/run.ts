import type { AssistantMessage, Message, OpencodeClient, Part } from "@opencode-ai/sdk";
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
    case "NotFoundError":
    case "notFound":
      return {
        code: "OPENCODE_SESSION_NOT_FOUND",
        message: String(data.message ?? "The OpenCode session no longer exists."),
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
  onProgress?: (progress: RunProgress) => void | Promise<void>;
  signal?: AbortSignal;
  logger: Logger;
}

const POLL_INTERVAL_MS = 1000;
/** How long to wait for OpenCode to acknowledge an async prompt before giving up. */
const ACCEPTANCE_GRACE_MS = 20_000;
/** How long an idle session may stay between tool calls before we call it stalled. */
const IDLE_STALL_MS = 20_000;

interface CompletedAssistant {
  info: AssistantMessage;
  parts: Part[];
}

type SessionMessages = Array<{ info: Message; parts: Part[] }>;

function messagesAfterBaseline(
  messages: SessionMessages,
  baselineId: string | null,
): SessionMessages {
  if (!baselineId) return messages;
  const index = messages.findIndex((message) => message.info.id === baselineId);
  return index >= 0 ? messages.slice(index + 1) : messages;
}

/**
 * OpenCode writes one assistant message per step: a tool-call step completes
 * with `finish: "tool-calls"` while the run continues in a new assistant
 * message. Only a message whose `finish` is anything else (or that carries an
 * error) marks the end of the whole run.
 */
function isTerminalAssistant(message: { info: AssistantMessage }): boolean {
  if (message.info.error) return true;
  if (typeof message.info.time.completed !== "number") return false;
  return message.info.finish !== "tool-calls";
}

function lastAssistant(
  messages: SessionMessages,
): { info: AssistantMessage; parts: Part[] } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.info.role !== "assistant") continue;
    return { info: message.info, parts: message.parts ?? [] };
  }
  return null;
}

/**
 * Run a prompt to completion.
 *
 * The prompt is sent with `prompt_async` and the session is polled, instead of
 * holding a synchronous HTTP request open for the whole run. Node's fetch
 * (undici) aborts requests that take longer than five minutes to produce
 * response headers, which made every long delegation fail with
 * `fetch failed`; async + polling removes that ceiling entirely and keeps
 * cancellation and progress reporting responsive.
 */
export async function runPrompt(input: RunPromptInput): Promise<RunResult> {
  const startedAt = Date.now();
  let abortedByCaller = false;
  let settled = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let sawActivity = false;
  let idleSince: number | null = null;
  let resolveOutcome: ((outcome: RunOutcome) => void) | null = null;

  const abortSession = async (): Promise<void> => {
    try {
      await input.client.session.abort({ path: { id: input.sessionId } });
    } catch {
      // best effort
    }
  };

  const settle = (outcome: RunOutcome) => {
    if (settled) return;
    settled = true;
    resolveOutcome?.(outcome);
  };

  const onSignalAbort = () => {
    abortedByCaller = true;
    void abortSession();
    settle({ kind: "aborted" });
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

  const cleanup = () => {
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
  };

  // Remember where the conversation was so completion detection ignores older
  // assistant messages.
  let baselineMessageId: string | null = null;
  try {
    const before = await input.client.session.messages({
      path: { id: input.sessionId },
      query: { limit: 5 },
    });
    baselineMessageId = before.data?.at(-1)?.info.id ?? null;
  } catch {
    baselineMessageId = null;
  }

  try {
    const sent = await input.client.session.promptAsync({
      path: { id: input.sessionId },
      body,
    });
    if (sent.error) {
      const mapped = describeError(sent.error);
      cleanup();
      return failedResult(mapped, Date.now() - startedAt);
    }
  } catch (error) {
    cleanup();
    if (input.signal?.aborted) {
      throw new BridgeError("AGENT_ABORTED", "Delegated run was cancelled by the caller.");
    }
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(
      "OPENCODE_UNAVAILABLE",
      `OpenCode request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, retryable: true },
    );
  }

  const outcome = await new Promise<RunOutcome>((resolve) => {
    resolveOutcome = resolve;

    timeoutTimer = setTimeout(() => {
      void abortSession();
      settle({ kind: "timeout" });
    }, input.timeoutMs);
    timeoutTimer.unref?.();

    const tick = async () => {
      if (settled) return;
      const elapsed = Date.now() - startedAt;

      let statusType: string | null = null;
      try {
        const statusResult = await input.client.session.status();
        statusType = statusResult.data?.[input.sessionId]?.type ?? null;
        if (statusType === "busy" || statusType === "retry") sawActivity = true;
      } catch {
        // keep polling; a transient failure should not kill the run
      }

      let message = statusType === "retry" ? "retrying after provider error" : "working…";
      try {
        const activity = await latestActivity(input.client, input.sessionId);
        if (activity) {
          sawActivity = true;
          message = activity;
        }
      } catch {
        // ignore
      }
      await emit({ progress: Math.min(90, 5 + Math.floor(elapsed / 1000)), message });
      if (settled) return;

      let messages: SessionMessages = [];
      try {
        const result = await input.client.session.messages({
          path: { id: input.sessionId },
          query: { limit: 20 },
        });
        messages = (result.data ?? []) as SessionMessages;
      } catch {
        return;
      }

      const fresh = messagesAfterBaseline(messages, baselineMessageId);
      if (fresh.length > 0) sawActivity = true;
      const newest = lastAssistant(fresh);

      if (newest && isTerminalAssistant(newest)) {
        settle({ kind: "done", message: newest });
        return;
      }

      // A session that stays idle between tool calls has stalled: OpenCode was
      // interrupted or crashed without producing a final message.
      if (newest?.info.finish === "tool-calls" && statusType === null) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince > IDLE_STALL_MS) {
          settle({ kind: "stalled" });
          return;
        }
      } else {
        idleSince = null;
      }

      const nothingNew = baselineMessageId === null ? messages.length === 0 : fresh.length === 0;
      if (!sawActivity && nothingNew && elapsed > ACCEPTANCE_GRACE_MS) {
        settle({ kind: "not-accepted" });
      }
    };

    pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    pollTimer.unref?.();
    void tick();
  });

  cleanup();
  const durationMs = Date.now() - startedAt;

  if (outcome.kind === "aborted" || abortedByCaller) {
    throw new BridgeError("AGENT_ABORTED", "Delegated run was cancelled by the caller.");
  }

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

  if (outcome.kind === "not-accepted") {
    return failedResult(
      {
        code: "AGENT_EXECUTION_FAILED",
        message: `OpenCode did not start the delegated run within ${ACCEPTANCE_GRACE_MS}ms.`,
        details: { session_id: input.sessionId },
      },
      durationMs,
    );
  }

  if (outcome.kind === "stalled") {
    return failedResult(
      {
        code: "AGENT_EXECUTION_FAILED",
        message: `The delegated run stalled for ${IDLE_STALL_MS}ms between steps and was abandoned.`,
        details: { session_id: input.sessionId },
      },
      durationMs,
    );
  }

  const { info, parts } = outcome.message;
  if (info.error) {
    const mapped = describeError(info.error);
    if (mapped.code === "AGENT_ABORTED" && abortedByCaller) {
      throw new BridgeError("AGENT_ABORTED", "Delegated run was cancelled by the caller.");
    }
    return {
      ...failedResult(mapped, durationMs),
      ...(info.id ? { messageID: info.id } : {}),
    };
  }

  let summary = stripAnsi(assistantText(parts));
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

type RunOutcome =
  | { kind: "done"; message: CompletedAssistant }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "not-accepted" }
  | { kind: "stalled" };

function failedResult(mapped: RunErrorInfo, durationMs: number): RunResult {
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
