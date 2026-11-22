# pocket reference

Everything the README leaves out.

## Providers

| id | base URL | format | free limits (verified 2026-11-08; see `providers.json`) | default models (strong / mid / fast) |
| --- | --- | --- | --- | --- |
| groq | `https://api.groq.com/openai/v1` | OpenAI | 30 req/min, 1,000 req/day, 200K tokens/day | gpt-oss-120b / qwen3.8-27b / gpt-oss-20b |
| nvidia | `https://integrate.api.nvidia.com/v1` | OpenAI | ~40 req/min shared by every model on the key; no published daily cap | kimi-k2.6 / deepseek-v4.1-flash / gpt-oss-20b (checked 2026-11-14) |
| openrouter | `https://openrouter.ai/api/v1` | OpenAI | 20 req/min, 50 req/day (1,000 after a $10 lifetime credit purchase) | `openrouter/free` (OpenRouter picks a currently free model) |
| cerebras | `https://api.cerebras.ai/v1` | OpenAI | **5 req/min**, 1M tokens/day, 65k context | gpt-oss-120b / qwen-3.8-27b |
| mistral | `https://api.mistral.ai/v1` | OpenAI | 1 req/s, 500K tokens/min, 1B tokens/month; **free-plan requests may train Mistral's models**; off by default | mistral-large / medium / small |
| gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | OpenAI | per-model free quota, published only in AI Studio; models with no free quota answer 429 `limit: 0` and pocket skips them for 24h; **free-tier prompts may be used to improve Google's products**; off by default | live list (`models/` prefix stripped) |
| zai | `https://api.z.ai/api/paas/v4` | OpenAI | GLM-4.7-Flash and GLM-4.5-Flash free (checked 2026-11-22); no published rate limits; `free_models: "-flash$"` keeps pocket off paid GLM models; off by default | glm-4.7-flash / glm-4.7-flash / glm-4.5-flash |
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
  cooldown_seconds: 60                # after a 429 skip that provider this long; doubles on each 429 in a row
                                      # (max 1h) unless the provider says how long (retry-after, x-ratelimit-reset-*)
  timeout_seconds: 60
degraded_banner: true
agents:                               # optional per-agent overrides (x-pocket-agent header)
  reviewer: { order: [groq, nvidia, cerebras] }
```

**Quota the provider reports.** Every response's `x-ratelimit-remaining/limit/reset-*` headers (OpenAI and Groq style, Cerebras `-day`/`-minute`, OpenRouter's bare names) are recorded and shown on the dashboard. When one says 0 requests or tokens remain, pocket skips that provider until its reset instead of waiting for the 429.

Streaming works end to end. A failure **before** the first token fails over; once tokens are flowing, the reply finishes on the same provider (switching mid-answer would corrupt it).

## Commands

| Command | What it does |
| --- | --- |
| `pocket` (no arguments) | Start the daemon and open the setup page: keys, apps, a test request. Same code as the commands below |
| `pocket setup [--no-verify]` | Guided first run: detect agents, add free keys (with signup links), optional paid key, start the daemon, attach. Safe to rerun |
| `pocket daemon start\|stop\|status\|logs` | One process on 127.0.0.1:3460. Refuses any other address without `--i-know-this-is-exposed`. `/healthz` lists providers and whether each has a key, never the key |
| `pocket keys add <provider>` / `keys list` / `keys rm` | Prompt with echo off (or read stdin), store in the OS keychain, verify with one cheap request |
| `pocket route ["prompt"]` | Send one test request through the daemon and print which provider answered |
| `pocket attach claude [--vscode]` | Write the `claude-pocket` launcher (starts the daemon if needed, sets `ANTHROPIC_BASE_URL`, a local token, the agent header). `--vscode` adds the same to `claudeCode.environmentVariables` |
| `pocket attach codex` | Add `[model_providers.pocket]` (`wire_api = "responses"`) and a `[profiles.pocket]` to `~/.codex/config.toml`, with a backup. Plain `codex` is not changed; the `codex-pocket` launcher runs `codex --profile pocket` with `POCKET_TOKEN` set |
| `pocket attach codex-app` | For the Codex desktop app: puts `model_provider = "pocket_app"` on the first line of `~/.codex/config.toml` and a `[model_providers.pocket_app]` block with the local token in `experimental_bearer_token` (the app never sees shell variables). This switches all of Codex, terminal included. Refuses if you already set a top-level `model_provider` |
| `pocket attach claude-desktop` | Writes `claude-desktop-pocket.json` (`inferenceProvider: gateway`, base URL `http://127.0.0.1:3460/desktop`, the local token, Claude model ids) to import in Claude Desktop → Developer → Configure Third-Party Inference |
| `pocket attach cursor` | Print the base URL and key to paste into Cursor |
| `pocket detach <app>` | Undo attach. Config files come back byte-identical |
| `pocket dash` | Open the dashboard |
| `pocket doctor` | Keychain available, port free, every key still valid, limits never verified or older than 30 days, agents attached while the daemon is down |
| `pocket models [--refresh]` | Which model each provider will use for each tier, and whether that comes from its live list or from providers.json |
| `pocket staked sync` | Read `provider_policy` from a staked `agents/roles.yml` (`pocket lanes sync` still works) and route each agent by it |

## Agents

- **Claude Code**: fully supported through `claude-pocket` or the VS Code extension settings.
- **Codex CLI** (pocket 0.1.2+): a `pocket` provider and profile, speaking the Responses API at `/openai/v1/responses`. Function tools, Codex's freeform tools (`apply_patch`) and MCP namespaces are passed through; hosted tools (web search) and earlier reasoning items are dropped, because other providers can't run them. Checked against Codex's source; live reports welcome.
- **Upgrading from 0.1.1**: Codex removed `wire_api = "chat"`, so a 0.1.1 attach stops Codex from starting. Run `pocket detach codex`, update, then `pocket attach codex` again. `pocket doctor` flags the old config.
- **Codex app**: `attach codex-app`. Same Responses API as the CLI. Not yet tried against a real Codex app install.
- **Claude Desktop**: third-party mode with pocket as the gateway ([Anthropic's gateway docs](https://claude.com/docs/third-party/claude-desktop/gateway)). `/desktop` accepts whatever path the app appends (`/v1/messages`, `/messages`, `/v1/models`), with the key as a bearer token or `x-api-key`. `/v1/models` lists the Claude ids in providers.json with `anthropic_family_tier`. Prompt caching only carries through to Anthropic; free providers don't get `cache_control`. Desktop assumes a 200K context for these ids, more than most free models take, so long sessions compact on the provider's too-long error. Not yet tried in a real install.
- **Claude Code** launchers set `CLAUDE_CODE_AUTO_MODE_SERVER=0`: pocket can't run Anthropic's server-side auto-mode checks, and without it Claude Code holds the first auto-mode action behind a notice ([docs](https://code.claude.com/docs/en/auto-mode-classifier-billing)).
- **Cursor**: only the "own OpenAI key" chat path can be pointed at a custom base URL; Agent/Composer and Cursor's own models may not route through pocket at all, and Cursor may call custom URLs from its servers, where `127.0.0.1` is unreachable.

## How pocket picks models

Nothing about models is fixed. On start and every 12 hours the daemon asks each provider you have a key for which models that key can use (`GET /models`), and caches the answer in `models.json` in pocket's config folder.

- **Choosing:** the `tiers` in providers.json are preferences. A preferred model is used only if the live list still has it; otherwise pocket ranks the live list (current coding-capable families and size for `strong`/`mid`, small and fast models for `fast`), leaving out embedding, guard, speech and other non-chat models, models without tool calling, and on OpenRouter anything that isn't free.
- **Self-healing:** if a provider answers that a model is retired, unknown or no longer free (410, or 404/400 naming the model), pocket drops that model for 24 hours, refreshes the list and tries the next model in the same request.
- **Limits:** if a provider says `max_tokens` must be at most N, pocket remembers N for that model and resends the request once. Models whose list states a maximum output are capped up front.
- **No list?** If a provider has no models endpoint or it fails, pocket uses providers.json as before.
