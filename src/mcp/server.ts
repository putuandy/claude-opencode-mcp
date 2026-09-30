import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoadedConfig, ResolvedConfig } from "../config/config.js";
import type { OpenCodeManager } from "../opencode/manager.js";
import type { SessionRegistry } from "../opencode/sessions.js";
import type { Logger } from "../util/logger.js";
import type { AppContext } from "./execute.js";
import { registerAbortSession } from "./tools/abort-session.js";
import { registerCreateSession } from "./tools/create-session.js";
import { registerDelegateTask } from "./tools/delegate-task.js";
import { registerGetDiff } from "./tools/get-diff.js";
import { registerGetSession } from "./tools/get-session.js";
import { registerListAgents } from "./tools/list-agents.js";
import { registerSendMessage } from "./tools/send-message.js";

export const SERVER_NAME = "claude-opencode-mcp";

/** Read the version from the packaged package.json so it never drifts. */
function resolveServerVersion(): string {
  try {
    const file = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_VERSION = resolveServerVersion();

export const SERVER_INSTRUCTIONS = [
  "Claude Code is the orchestrator; this server delegates focused tasks to OpenCode agents that run in the same workspace.",
  "Use delegate_task for one-shot work, or create_session + send_message for multi-step work that must keep context.",
  "Read-only agents: deepseek-researcher, deepseek-reviewer. Editing agent: deepseek-coder. Test-running agent: deepseek-tester.",
  "After a coder session, call get_diff to inspect exactly what changed before reporting back to the user.",
  "Paths supplied to delegate_task are exploration hints, not boundaries.",
].join(" ");

export interface CreateMcpServerOptions {
  logger: Logger;
  manager: OpenCodeManager;
  registry: SessionRegistry;
  globalConfig: ResolvedConfig;
  env?: NodeJS.ProcessEnv;
  stateDir: string;
  /** Override per-workspace config loading (tests/embedding). */
  loadProjectConfig?: (cwd: string) => Promise<LoadedConfig>;
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const ctx: AppContext = {
    logger: options.logger,
    manager: options.manager,
    registry: options.registry,
    globalConfig: options.globalConfig,
    env: options.env ?? process.env,
    stateDir: options.stateDir,
    ...(options.loadProjectConfig ? { loadProjectConfig: options.loadProjectConfig } : {}),
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerDelegateTask(server, ctx);
  registerCreateSession(server, ctx);
  registerSendMessage(server, ctx);
  registerGetSession(server, ctx);
  registerGetDiff(server, ctx);
  registerAbortSession(server, ctx);
  registerListAgents(server, ctx);

  return server;
}
