/**
 * Structured error model for the bridge.
 *
 * Every failure surfaced to Claude Code uses one of these codes so that the
 * orchestrator can react deterministically instead of parsing prose.
 */
export const BRIDGE_ERROR_CODES = [
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_NOT_ALLOWED",
  "WORKSPACE_NOT_READABLE",
  "WORKSPACE_MISMATCH",
  "OPENCODE_NOT_AVAILABLE",
  "OPENCODE_START_TIMEOUT",
  "OPENCODE_UNAVAILABLE",
  "OPENCODE_SESSION_NOT_FOUND",
  "OPENCODE_ERROR",
  "AGENT_NOT_FOUND",
  "AGENT_TIMEOUT",
  "AGENT_ABORTED",
  "AGENT_EXECUTION_FAILED",
  "INVALID_PATH",
  "INVALID_ARGUMENT",
  "PERMISSION_DENIED",
  "MODEL_NOT_AVAILABLE",
  "DIFF_UNAVAILABLE",
  "NOT_GIT_REPOSITORY",
  "CONFIG_INVALID",
  "INTERNAL_ERROR",
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export interface SerializedBridgeError {
  code: BridgeErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
  request_id?: string;
}

export interface BridgeErrorOptions {
  details?: Record<string, unknown>;
  retryable?: boolean;
  cause?: unknown;
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: BridgeErrorCode, message: string, options: BridgeErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BridgeError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  toJSON(): SerializedBridgeError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      retryable: this.retryable,
    };
  }
}

export function isBridgeError(error: unknown): error is BridgeError {
  return error instanceof BridgeError;
}

export function serializeError(error: unknown, requestId?: string): SerializedBridgeError {
  if (isBridgeError(error)) {
    const serialized = error.toJSON();
    return requestId ? { ...serialized, request_id: requestId } : serialized;
  }
  const message = error instanceof Error ? error.message : String(error);
  const serialized: SerializedBridgeError = {
    code: "INTERNAL_ERROR",
    message,
    retryable: false,
  };
  if (requestId) serialized.request_id = requestId;
  return serialized;
}
