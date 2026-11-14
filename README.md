<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/reveal-on-dark.gif">
    <img src="docs/brand/logo-on-light.png" alt="pocket" height="96">
  </picture>
</p>
<p align="center"><b>When your coding agent hits its usage limit, pocket moves it to your next key.</b></p>
<p align="center">Your own keys, in your OS keychain. Runs on your machine. Every switch names the model now answering.</p>

**pocket is a free, open-source command-line tool that keeps Claude Code and Codex working when they hit a usage limit or rate limit (HTTP 429).** It runs a small router on your own machine. When your current provider refuses a request for quota, it resends it to the next API key you configured (Groq, NVIDIA, OpenRouter, Cerebras, or your Anthropic or OpenAI key) and tells you which model is now answering.

<p align="center"><img src="docs/brand/demo.gif" alt="pocket demo" width="720"></p>
<p align="center"><sub>Stand-in providers; the limit is simulated. The switch notice and log lines are pocket's real output.</sub></p>

---

## Get started

```sh
npm i -g @zerwone/pocket
pocket setup
claude-pocket
```

`pocket setup` walks you through it, a couple of minutes if your keys are ready:

1. finds Claude Code and Codex on your machine
2. walks you through free keys from Groq, NVIDIA, OpenRouter and Cerebras, with the signup link for each (skip any you don't want)
3. optionally adds your paid key, used first up to $10 a day
4. connects your agents

Then use `claude-pocket` instead of `claude` (or `codex-pocket` instead of `codex`). Until a limit hits, nothing changes.

> Do not run `npx pocket`. That name on npm belongs to someone else. The package is `@zerwone/pocket`.

## What you'll see

Nothing, until your paid model runs out. Then the next reply starts with one line:

```
[pocket] running on groq/qwen/qwen3.8-27b, anthropic quota exhausted (429)
```

and the session carries on, as long as the fallback key has quota left. The fallback model may handle the task differently or worse, so review what it does. Free keys have limits too; when all of them are spent, the agent stops as it would without pocket.

Open `pocket dash` to see how much free quota is left on each key, what you've spent today, and every switch.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/dashboard-dark.png">
  <img src="docs/brand/dashboard.png" alt="pocket dashboard after a switch: anthropic in 429 cooldown, claude-code running on groq, one failover logged" width="720">
</picture>

## How much free do you get

| Provider | Free per key | Get a key |
| --- | --- | --- |
| Groq | 1,000 requests/day | [console.groq.com/keys](https://console.groq.com/keys) |
| NVIDIA | ~40 requests/min | [build.nvidia.com](https://build.nvidia.com) |
| OpenRouter | 50 requests/day (1,000 after a one-time $10 top-up) | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| Cerebras | 1M tokens/day, 5 requests/min | [cloud.cerebras.ai](https://cloud.cerebras.ai) |

Checked against each provider's docs on 2026-11-08. Mistral (1B tokens/month) is supported but off by default, because its free plan may use your requests for training.

## Commands you'll actually use

| | |
| --- | --- |
| `pocket setup` | first run, or add more keys later |
| `pocket dash` | quota, spend, switches |
| `pocket doctor` | something's off? start here |
| `pocket detach claude` | undo; your config goes back exactly as it was |

Full list, routing rules and provider details: [docs/REFERENCE.md](docs/REFERENCE.md)

## How it handles your keys

- **Your keys only.** Each provider only ever sees the key you gave it for that provider. Nothing is pooled or shared. Your requests go to the provider you configured.
- **No pocket account, no telemetry.** You still need an account with each provider.
- **OS keychain, not pocket's config files.** Windows Credential Manager, macOS Keychain, or Secret Service on Linux.
- **Local only.** Listens on `127.0.0.1` and refuses anything without its local token.

More: [docs/SECURITY.md](docs/SECURITY.md)

## FAQ

**What can I do when Claude Code says "usage limit reached"?**
Four options: wait for the limit to reset; switch Claude Code to a paid Anthropic API key; route Claude Code through one gateway such as OpenRouter; or run it through pocket, which tries your own keys from several providers in order and switches automatically, mid-session, without restarting.

**Does pocket work with a Claude Pro or Max subscription?**
`claude-pocket` runs Claude Code on API keys through pocket, not on your subscription login. Keep using `claude` on your plan. When the plan hits its limit, start `claude-pocket` and keep working on your keys.

**How is pocket different from OpenRouter, LiteLLM or claude-code-fallback?**
OpenRouter is one provider and gateway; pocket can use an OpenRouter key as one step in its order. LiteLLM is a general proxy you configure yourself. claude-code-fallback moves you from a Claude subscription to Anthropic API billing only. pocket is narrower: one `pocket setup`, keys in your OS keychain, a quota meter per key, launchers for Claude Code and Codex, and a notice in the session each time it switches.

**Which model answers after a switch?**
The first provider in your order with quota left (by default Groq, then NVIDIA, OpenRouter and Cerebras), and on it the best model its live model list offers your key right now, matched to what the agent asked for. pocket reads each provider's list itself, so a retired or no-longer-free model is skipped automatically. The reply names the provider and model; `pocket models` shows what it will pick.

**Is it free? Is it allowed?**
pocket is MIT-licensed. The free allowance comes from each provider's own free tier on your own account. pocket never pools or shares keys. Read each provider's terms; Mistral's free plan may train on your requests, so it is off by default.

**Does my code leave my machine?**
Your requests go to the provider you configured, the same as using that provider directly. pocket itself has no server, no account and no telemetry.

**Does it work on Windows?**
Yes, keys go to Windows Credential Manager and the launchers are `.cmd` files. The test suite has so far run on Linux; Windows reports are welcome.

## Works with

**Claude Code** (CLI and VS Code), **Codex CLI**. Cursor partly: chat with your own key only, not Agent or Composer. Windows, macOS, Linux.

---

Built by Mohamad Aljadaan at **ZerwOne**.

MIT · [Contributing](docs/DEVELOPMENT.md) · Sister project: **staked**, gives each coding agent its own part of the repo
