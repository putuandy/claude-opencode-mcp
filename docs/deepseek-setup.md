# DeepSeek setup

DeepSeek is the default provider, but the bridge is provider-agnostic: the
provider is just `defaults.provider` in the configuration. Anything OpenCode
can run works — DeepSeek is only the initial default.

## Authenticate with OpenCode

```bash
opencode auth login
# select DeepSeek, paste the API key
```

This stores the credential in OpenCode's auth store
(`~/.local/share/opencode/auth.json` by default). The key is never copied into
the bridge configuration or logs.

## Or use an environment variable

The DeepSeek provider reads `DEEPSEEK_API_KEY`:

```bash
export DEEPSEEK_API_KEY=sk-...
```

Export it before starting Claude Code so the spawned OpenCode server inherits
it.

## Pick a model

```bash
opencode models | grep deepseek
# deepseek/deepseek-flash
# deepseek/deepseek-v4-pro
```

The bridge resolves models in this order:

1. the `model` argument of `delegate_task` / `create_session`,
2. the agent's configured model (project agent file or `agents.<name>.model`),
3. `defaults.model`,
4. the provider's default model reported by OpenCode
   (`GET /config/providers`).

To pin one:

```json
{
  "defaults": { "provider": "deepseek", "model": "deepseek/deepseek-v4-pro" }
}
```

or per agent:

```json
{
  "agents": {
    "deepseek-researcher": { "model": "deepseek/deepseek-flash" },
    "deepseek-coder": { "model": "deepseek/deepseek-v4-pro" }
  }
}
```

## Using another provider

Set `defaults.provider` and, optionally, `defaults.model`:

```json
{
  "defaults": { "provider": "anthropic", "model": "anthropic/claude-sonnet-4-5" }
}
```

Agent names keep the `deepseek-` prefix because they describe the role, not the
provider; rename them with project-local agent files if you prefer.

## Troubleshooting DeepSeek

| Error | Fix |
| --- | --- |
| `ProviderAuthError` | `opencode auth login` again, or export `DEEPSEEK_API_KEY`. |
| `MODEL_NOT_AVAILABLE` | Set `defaults.model`; the provider has no default configured. |
| Empty/garbled output | Lower `temperature` via an agent override; some models are more literal at `0`. |
| Rate limits | They surface as `APIError` with `statusCode: 429` and `isRetryable: true`; retry with `send_message` on the same session. |
