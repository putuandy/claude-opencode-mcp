import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { globalConfigPath, loadConfig, projectConfigDir } from "../config/config.js";
import { BridgeError } from "../errors.js";
import { loadBuiltinAgentDefinitions, packageRoot } from "../opencode/agents.js";
import { resolveOpenCodeBinary } from "../opencode/binary.js";
import { createLogger } from "../util/logger.js";
import { validateWorkspace } from "../workspace/validator.js";

export interface InitOptions {
  dir?: string;
  force?: boolean;
  writeMcp?: boolean;
}

const CONFIG_TEMPLATE = {
  defaults: {
    agent: "deepseek-researcher",
    provider: "deepseek",
    model: null,
  },
  workspace: {
    allowedRoots: [],
    defaultCwd: null,
  },
  security: {
    protectEnvFiles: true,
    denyGitPush: true,
    denyGitCommit: true,
  },
  timeouts: {
    execution: 600000,
  },
};

function line(marker: "ok" | "warn" | "fail", text: string, detail?: string): void {
  const symbol = marker === "ok" ? "✓" : marker === "warn" ? "!" : "✗";
  process.stdout.write(`${symbol} ${text}${detail ? `: ${detail}` : ""}\n`);
}

function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? 1 : 0,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

export async function runInit(options: InitOptions): Promise<number> {
  const cwd = path.resolve(options.dir ?? process.cwd());
  const logger = createLogger({ level: "warn" });
  let failures = 0;

  process.stdout.write(`claude-opencode init\n\n`);

  let stat: fs.Stats | null = null;
  try {
    stat = await fs.promises.stat(cwd);
  } catch {
    stat = null;
  }
  if (!stat?.isDirectory()) {
    line("fail", "Project directory not found", cwd);
    return 1;
  }
  const hasPackageJson = await fs.promises
    .access(path.join(cwd, "package.json"))
    .then(() => true)
    .catch(() => false);
  const detectedMarkers = await fs.promises
    .readdir(cwd)
    .then((entries) => entries.filter((entry) => !entry.startsWith(".")).length)
    .catch(() => 0);
  line(
    "ok",
    "Project detected",
    hasPackageJson ? `${cwd} (package.json present)` : `${cwd} (${detectedMarkers} entries)`,
  );

  const { config } = await loadConfig({ cwd });
  let validated: Awaited<ReturnType<typeof validateWorkspace>>;
  try {
    validated = await validateWorkspace({
      requestedPath: cwd,
      allowedRoots: config.workspace.allowedRoots,
    });
  } catch (error) {
    line(
      "fail",
      "Workspace validation failed",
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }

  if (validated.gitRoot) {
    line("ok", "Git repository detected", validated.gitRoot);
  } else {
    line("warn", "No git repository detected", "get_diff will rely on OpenCode session diffs");
  }
  line("ok", "Workspace validated", validated.cwd);

  let binaryPath: string | null = null;
  try {
    const binary = await resolveOpenCodeBinary({
      configured: config.opencode.binary,
      env: process.env,
    });
    binaryPath = binary.command;
    line("ok", "OpenCode detected", `${binary.version} (${binary.command})`);
  } catch (error) {
    failures += 1;
    line(
      "fail",
      "OpenCode not found",
      error instanceof BridgeError ? error.message : String(error),
    );
  }

  if (binaryPath) {
    const models = await run(binaryPath, ["models"], cwd);
    const providerLines = models.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const deepseekModels = providerLines.filter((entry) => entry.startsWith("deepseek/"));
    if (deepseekModels.length > 0) {
      line("ok", "DeepSeek provider detected", deepseekModels.slice(0, 3).join(", "));
    } else {
      line(
        "warn",
        "DeepSeek provider not detected",
        "connect it with `opencode auth login` or set defaults.provider/model in the bridge config",
      );
    }
  }

  const mcpJsonPath = path.join(cwd, ".mcp.json");
  let mcpConfigured = false;
  try {
    const raw = await fs.promises.readFile(mcpJsonPath, "utf8");
    mcpConfigured = raw.includes("claude-opencode-mcp");
  } catch {
    mcpConfigured = false;
  }
  if (mcpConfigured) {
    line("ok", "MCP configuration detected", mcpJsonPath);
  } else if (options.writeMcp) {
    const entry = {
      mcpServers: {
        opencode: {
          command: "npx",
          args: ["-y", "claude-opencode-mcp"],
          type: "stdio",
          timeout: 600000,
        },
      },
    };
    let existing: Record<string, unknown> = entry;
    try {
      const raw = JSON.parse(await fs.promises.readFile(mcpJsonPath, "utf8")) as Record<
        string,
        unknown
      >;
      const servers = (raw.mcpServers ?? {}) as Record<string, unknown>;
      existing = { ...raw, mcpServers: { ...servers, ...entry.mcpServers } };
    } catch {
      // no existing .mcp.json
    }
    await fs.promises.writeFile(mcpJsonPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
    line("ok", "Wrote MCP configuration", mcpJsonPath);
  } else {
    line(
      "warn",
      "MCP configuration not found",
      "run `claude-opencode init --write-mcp` to create .mcp.json",
    );
  }

  const projectDir = projectConfigDir(cwd);
  const created: string[] = [];
  const configFile = path.join(projectDir, "config.json");
  const configExists = await fs.promises
    .access(configFile)
    .then(() => true)
    .catch(() => false);
  if (!configExists || options.force) {
    await fs.promises.mkdir(projectDir, { recursive: true });
    await fs.promises.writeFile(
      configFile,
      `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`,
      "utf8",
    );
    created.push(path.relative(cwd, configFile));
  }

  const agentsDir = path.join(projectDir, "agents");
  await fs.promises.mkdir(agentsDir, { recursive: true });
  const builtinAgents = await loadBuiltinAgentDefinitions();
  for (const definition of builtinAgents) {
    const target = path.join(agentsDir, `${definition.name}.md`);
    const exists = await fs.promises
      .access(target)
      .then(() => true)
      .catch(() => false);
    if (exists && !options.force) continue;
    const source = path.join(packageRoot(), "agents", `${definition.name}.md`);
    await fs.promises.copyFile(source, target);
    created.push(path.relative(cwd, target));
  }

  process.stdout.write("\n");
  if (created.length > 0) {
    process.stdout.write("Created:\n");
    for (const file of created) process.stdout.write(`  ${file}\n`);
  } else {
    process.stdout.write("Project already initialized; nothing to create.\n");
  }

  process.stdout.write(
    [
      "",
      "Next steps:",
      "  1. Add the MCP server to Claude Code (project scope):",
      "       claude mcp add opencode --scope project -- npx -y claude-opencode-mcp",
      "     or commit a .mcp.json entry (see README).",
      "  2. Restart Claude Code and confirm the server is connected with /mcp.",
      '  3. Ask Claude: "Use delegate_task with deepseek-researcher to map this project."',
      "",
      `Global configuration file: ${globalConfigPath()}`,
      "",
    ].join("\n"),
  );

  if (failures > 0) {
    process.stdout.write("Initialization finished with errors; fix them before delegating.\n");
    return 1;
  }
  logger.debug("init complete", { cwd });
  return 0;
}
