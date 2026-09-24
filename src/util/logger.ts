import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized in LEVELS) return normalized as LogLevel;
  return fallback;
}

const SENSITIVE_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|authorization|api[-_]?key|credential|private[-_]?key)/i;

/** Never let credentials reach stderr or the log file, even by accident. */
function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
  return value;
}

function formatFields(fields: LogFields | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  const parts: string[] = [];
  for (const [key, rawValue] of Object.entries(fields)) {
    if (rawValue === undefined) continue;
    const value = redactValue(key, rawValue);
    let rendered: string;
    if (typeof value === "string") rendered = value;
    else {
      try {
        rendered = JSON.stringify(value);
      } catch {
        rendered = String(value);
      }
    }
    if (rendered.length > 2000) rendered = `${rendered.slice(0, 2000)}…`;
    parts.push(`${key}=${rendered}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

class StderrLogger implements Logger {
  readonly level: LogLevel;
  private readonly bindings: LogFields;
  private readonly file: string | null;

  constructor(level: LogLevel, bindings: LogFields = {}, file: string | null = null) {
    this.level = level;
    this.bindings = bindings;
    this.file = file;
  }

  child(bindings: LogFields): Logger {
    return new StderrLogger(this.level, { ...this.bindings, ...bindings }, this.file);
  }

  private write(level: Exclude<LogLevel, "silent">, message: string, fields?: LogFields): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${formatFields({
      ...this.bindings,
      ...fields,
    })}\n`;
    try {
      process.stderr.write(line);
    } catch {
      // stderr can be closed during shutdown; ignore.
    }
    if (this.file) this.writeFile(line);
  }

  private writeFile(line: string): void {
    const file = this.file;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_LOG_BYTES) {
          fs.renameSync(file, `${file}.1`);
        }
      } catch {
        // file does not exist yet
      }
      // 0o600 on creation: logs contain workspace paths and agent output.
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // logging must never break the bridge
    }
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  file?: string | null;
  bindings?: LogFields;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? parseLogLevel(process.env.CLAUDE_OPENCODE_LOG, "info");
  return new StderrLogger(level, options.bindings ?? {}, options.file ?? null);
}

export function defaultLogFile(): string {
  return path.join(stateDirectory(), "bridge.log");
}

export function stateDirectory(): string {
  const override = process.env.CLAUDE_OPENCODE_STATE_DIR;
  if (override?.trim()) return path.resolve(override);
  return path.join(os.homedir(), ".local", "state", "claude-opencode-mcp");
}
