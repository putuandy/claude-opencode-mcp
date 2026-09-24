# Installation

## Requirements

- Node.js 20 or newer
- Claude Code (2.x)
- OpenCode 1.18 or newer
- A model provider authenticated in OpenCode (DeepSeek by default)

## Install the bridge

Globally:

```bash
npm install -g claude-opencode-mcp
claude-opencode-mcp --version
```

Or use `npx` in the Claude Code configuration (no global install):

```json
{
  "mcpServers": {
    "opencode": {
      "command": "npx",
      "args": ["-y", "claude-opencode-mcp"],
      "type": "stdio",
      "timeout": 600000
    }
  }
}
```

## Install OpenCode

```bash
npm install -g opencode-ai
# or
brew install sst/tap/opencode
```

Verify:

```bash
opencode --version
```

The bridge searches for the executable in this order:

1. `opencode.binary` in the bridge config
2. the `OPENCODE_BIN` environment variable
3. `opencode` on `PATH`
4. `<package>/node_modules/.bin/opencode` (the `opencode-ai` optional dependency)
5. `~/.opencode/bin/opencode`, `~/.local/bin/opencode`,
   `/opt/homebrew/bin/opencode`, `/usr/local/bin/opencode`

## Authenticate a provider

```bash
opencode auth login
```

Choose DeepSeek and paste an API key. The bridge never stores provider
credentials; they live in OpenCode's own auth store. See
[deepseek-setup.md](deepseek-setup.md).

## Validate the project (optional)

```bash
cd my-project
claude-opencode init
```

The command:

- detects the project, git repository, OpenCode, and the DeepSeek provider;
- validates the workspace against the configured allowed roots;
- creates `.claude-opencode/config.json` and copies the four agent prompts into
  `.claude-opencode/agents/`;
- optionally writes a `.mcp.json` entry with `--write-mcp`.

It never modifies source code and is not required: the bridge works in any
project directory with no initialization.

## Next steps

- [Claude Code setup](claude-code-setup.md)
- [Configuration](configuration.md)
