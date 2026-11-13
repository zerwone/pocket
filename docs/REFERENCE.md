# pocket reference

Everything the README leaves out.

## Providers

| id | base URL | format | free limits (verified 2026-11-08; see `providers.json`) | default models (strong / mid / fast) |
| --- | --- | --- | --- | --- |
| groq | `https://api.groq.com/openai/v1` | OpenAI | 30 req/min, 1,000 req/day, 200K tokens/day | gpt-oss-120b / qwen3.8-27b / gpt-oss-20b |
| nvidia | `https://integrate.api.nvidia.com/v1` | OpenAI | ~40 req/min shared by every model on the key; no published daily cap | llama-3.3-70b-instruct (ids unverified) |
| openrouter | `https://openrouter.ai/api/v1` | OpenAI | 20 req/min, 50 req/day (1,000 after a $10 lifetime credit purchase) | gpt-oss-120b:free / llama-3.3-70b-instruct:free |
| cerebras | `https://api.cerebras.ai/v1` | OpenAI | **5 req/min**, 1M tokens/day, 65k context | gpt-oss-120b / qwen-3.8-27b |
| mistral | `https://api.mistral.ai/v1` | OpenAI | 1 req/s, 500K tokens/min, 1B tokens/month; **free-plan requests may train Mistral's models**; off by default | mistral-large / medium / small |
| anthropic | `https://api.anthropic.com` | Anthropic | paid; capped by `daily_cap_usd` |
| openai | `https://api.openai.com/v1` | OpenAI | paid; capped by `daily_cap_usd` |
| custom | yours | either | yours |

Limits, model names per tier (`strong`, `mid`, `fast`) and prices live in `providers.json`. Copy it to your config dir (`~/.config/pocket/`, `%APPDATA%\pocket\`, or `~/Library/Application Support/pocket/`) to edit or add a custom provider. A live 429 always wins over the numbers in the file. Agents ask for `claude-opus-*`, `claude-sonnet-*`, `gpt-*`: pocket maps those to each provider's tier (`opus` → strong, `sonnet` → mid, `haiku`/`mini` → fast; unknown → mid). Limits were checked against each provider's own docs on 2026-11-08 (NVIDIA publishes none; its figure is community-verified). `pocket doctor` warns once they are 30 days old.

## Routing policy (`pocket.yml` in the config dir)

```yaml
order:                 # tried top to bottom until one has headroom
  - anthropic          # paid, until daily_cap_usd
  - groq
  - nvidia
  - openrouter
  - cerebras           # 5 rpm: last-resort reserve
  # - mistral          # free plan may train on your requests; uncomment to accept
caps:
  anthropic: { daily_cap_usd: 10 }
  openai:    { daily_cap_usd: 0 }     # 0 = never use
failover:
  on: [429, 5xx, timeout, connection]
  retry_same_provider: 1              # for 5xx / timeout / connection; a 429 is never retried
  cooldown_seconds: 60                # after a 429 skip that provider this long (or its retry-after)
  timeout_seconds: 60
degraded_banner: true
agents:                               # optional per-agent overrides (x-pocket-agent header)
  reviewer: { order: [groq, nvidia, cerebras] }
```

Streaming works end to end. A failure **before** the first token fails over; once tokens are flowing, the reply finishes on the same provider (switching mid-answer would corrupt it).

## Commands

| Command | What it does |
| --- | --- |
| `pocket setup [--no-verify]` | Guided first run: detect agents, add free keys (with signup links), optional paid key, start the daemon, attach. Safe to rerun |
| `pocket daemon start\|stop\|status\|logs` | One process on 127.0.0.1:3460. Refuses any other address without `--i-know-this-is-exposed`. `/healthz` lists providers and whether each has a key, never the key |
| `pocket keys add <provider>` / `keys list` / `keys rm` | Prompt with echo off (or read stdin), store in the OS keychain, verify with one cheap request |
| `pocket route ["prompt"]` | Send one test request through the daemon and print which provider answered |
| `pocket attach claude [--vscode]` | Write the `claude-pocket` launcher (starts the daemon if needed, sets `ANTHROPIC_BASE_URL`, a local token, the agent header). `--vscode` adds the same to `claudeCode.environmentVariables` |
| `pocket attach codex` | Add `[model_providers.pocket]` (`wire_api = "responses"`) and a `[profiles.pocket]` to `~/.codex/config.toml`, with a backup. Plain `codex` is not changed; the `codex-pocket` launcher runs `codex --profile pocket` with `POCKET_TOKEN` set |
| `pocket attach cursor` | Print the base URL and key to paste into Cursor |
| `pocket detach claude\|codex\|cursor` | Undo attach. Config files come back byte-identical |
| `pocket dash` | Open the dashboard |
| `pocket doctor` | Keychain available, port free, every key still valid, limits never verified or older than 30 days, agents attached while the daemon is down |
| `pocket staked sync` | Read `provider_policy` from a staked `agents/roles.yml` (`pocket lanes sync` still works) and route each agent by it |

## Agents

- **Claude Code**: fully supported through `claude-pocket` or the VS Code extension settings.
- **Codex CLI** (pocket 0.1.2+): a `pocket` provider and profile, speaking the Responses API at `/openai/v1/responses`. Function tools, Codex's freeform tools (`apply_patch`) and MCP namespaces are passed through; hosted tools (web search) and earlier reasoning items are dropped, because other providers can't run them. Checked against Codex's source; live reports welcome.
- **Upgrading from 0.1.1**: Codex removed `wire_api = "chat"`, so a 0.1.1 attach stops Codex from starting. Run `pocket detach codex`, update, then `pocket attach codex` again. `pocket doctor` flags the old config.
- **Cursor**: only the "own OpenAI key" chat path can be pointed at a custom base URL; Agent/Composer and Cursor's own models may not route through pocket at all, and Cursor may call custom URLs from its servers, where `127.0.0.1` is unreachable.
