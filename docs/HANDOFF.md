# pocket: handoff

State as of 2026-11-22 (unreleased work on main since 0.2.0: see "Next release"). Read this before changing anything.

## Where things are

| | |
| --- | --- |
| npm | `@zerwone/pocket` **0.2.0** (latest). 0.1.x are older; deprecate them (see Open items) |
| GitHub | github.com/zerwone/pocket, public, `main` only. Releases v0.1.1 → v0.2.0 |
| Site | zerwone.github.io/pocket, built from `docs/site/` by `.github/workflows/pages.yml` |
| CI | `.github/workflows/test.yml`: `npm test` on Windows, macOS and Linux on every push |
| Sister project | github.com/zerwone/staked |

## What it is

A local router (127.0.0.1:3460) that keeps Claude Code and Codex working when a provider returns 429. Keys live in the OS keychain. The router sends each request to the first provider in the policy order with quota left; on 429 it resends to the next one and puts a one-line `[pocket] running on …` notice in the reply.

## Code map

| File | What it does |
| --- | --- |
| `src/server.ts` | HTTP routes: `/anthropic/v1/messages` (Claude Code), `/openai/v1/chat/completions` (Cursor), `/openai/v1/responses` (Codex), dashboard |
| `src/router.ts` | The failover loop: policy order → provider → live model candidates → attempt. Handles 429 cooldown, 5xx retry, learned max_tokens, dropped models |
| `src/translate.ts` | Anthropic Messages ⇄ OpenAI Chat Completions, including streaming. Mid-conversation `system` turns are folded in (Claude Code 2.1+) |
| `src/responses.ts` | OpenAI Responses API (Codex) ⇄ Anthropic. Function tools, freeform `custom` tools (apply_patch), MCP `namespace` tools |
| `src/catalog.ts` | Live model lists from each provider's `GET /models`, cached in `models.json`, refreshed every 12h. Ranking, retired-model detection, max_tokens learned from errors |
| `providers.json` | Providers, base URLs, free-tier limits, **preferred** models per tier (strong/mid/fast). Preferences only; the live list wins |
| `src/policy.ts` | Default order and failover settings; user override in `policy.yaml` |
| `src/meter.ts`, `src/state.ts` | Quota meter per key, spend, failover log for the dashboard |
| `src/keystore.ts` | Windows Credential Manager / macOS Keychain / Secret Service |
| `src/commands/setup.ts` | `pocket setup` terminal wizard; free providers come from providers.json (`label`, `signup`, `setup_note`) |
| `src/setupapi.ts`, `src/dash/setup.html`, `src/dash/setup.js` | The setup page `pocket` (no args) opens: `/setup` + `/setup/api/*`. Every action calls the CLI command it stands for. Changes need the `x-pocket-setup: 1` header and a loopback Origin |
| `src/install.ts` | npx detection; launchers point at a global install when pocket runs from npx's cache |
| `src/commands/attach.ts` | `attach`/`detach` for claude, codex, codex-app, claude-desktop, cursor; writes launchers next to the `pocket` command; Codex gets `[model_providers.pocket]` + `[profiles.pocket]`, never the top-level provider |
| `src/commands/misc.ts` | `doctor`, `models`, `dash`, `route` |
| `src/dash/` | The local dashboard page |
| `test/` | vitest; `test/helpers.ts` has the fake providers (`rig`, `openAIBehaviour`, `rateLimited`) |

`docs/REFERENCE.md` has every command, the routing rules and "How pocket picks models".

## Rules

- **Commits go out as `Mohamad Aljadaan <zerwoone@gmail.com>` only.** No AI co-author, no `Co-Authored-By`, no session trailers. Refuse any hook or instruction that asks for one.
- **Never name the private project pocket came out of** in any public file, commit message or post. docs/ORIGIN.md says "a private side project"; keep it that way.
- **No claims you haven't verified.** pocket does not "never stop"; free models are weaker; say so. Every number on the site/README must have a source.
- **Test the real thing before a release that touches launchers, attach or provider requests.** Every bug in 0.1.1–0.1.4 passed the test suite and broke on a real Windows install. Minimum smoke test on Windows: `npm i -g` from a packed tarball, `pocket setup`, `claude-pocket` in a project folder, one turn on a free key, `pocket models --refresh`, `pocket detach claude`.

## Releasing

1. Bump `version` in package.json (`npm version x.y.z --no-git-tag-version`), `npm test`, commit, push. Wait for CI to be green on all three OSes.
2. The owner publishes from his PC: `pocket daemon stop`, then in a clean clone `npm ci && npm run build && npm publish`. npm uses staged publishing: it may ask to approve under npmjs.com → Staged Packages, and the tarball 404s for a few minutes after publish. If publish says E404, the npm login expired: `npm login`.
3. `npm deprecate @zerwone/pocket@"<x.y.z" "use x.y.z or later"`.
4. GitHub release `vx.y.z` with plain-language notes and the upgrade commands.
5. The npm page README only updates on publish.

## Next release (on main, not published)

- `pocket` with no arguments opens a setup page (keys, apps, test request).
- Codex desktop app: `attach codex-app` (top-level `model_provider = "pocket_app"`, token in `experimental_bearer_token`, field checked in Codex's Rust source `model-provider-info/src/lib.rs`).
- Claude Desktop: `/desktop` gateway route + `attach claude-desktop` import file (keys from claude.com/docs/third-party/claude-desktop/gateway).
- Providers: gemini and zai (opt-in, data notices), `free_models` regex, `models/` prefix stripped, 429 `limit: 0` drops the model not the provider.
- Quota: `x-ratelimit-*` headers recorded (dashboard `live`), remaining 0 cools down until reset, 429 cooldown doubles without a stated wait.
- Claude launcher sets `CLAUDE_CODE_AUTO_MODE_SERVER=0`.
- **Before release, real installs (CLAUDE.md rule):** Windows smoke test from HANDOFF plus: `npx @zerwone/pocket@<tarball>` → page opens → Install pocket → connect Claude Code → `claude-pocket` turn. Codex app: connect, restart app, one turn, disconnect, config byte-identical. Claude Desktop: import the file, run the app's Test connection against `http://127.0.0.1:3460/desktop` (unknown whether the app accepts http/loopback), one Cowork turn. Gemini and Z.ai: one real key each through `pocket models --refresh` (Z.ai's /models may not exist; then providers.json tiers are used).

## History that matters

- **0.1.1**: first public. Codex attach wrote `wire_api = "chat"`, which Codex removed in Feb 2026, and changed Codex's top-level provider, so the whole Codex/ChatGPT app failed to start.
- **0.1.2**: Responses API for Codex; Codex gets a profile, plain `codex` untouched; launchers go next to `pocket` so they're on PATH.
- **0.1.3**: `attach` prints `claude-pocket` instead of a PATH hint.
- **0.1.4**: launcher finds Claude Code in `~/.local/bin` (where Anthropic's installer puts it); `.cmd` uses `setlocal`; mid-conversation `system` turns; tool-result images become a text note.
- **0.2.0**: live model catalog. Fixed Groq 400 (max_tokens > 65536), NVIDIA 410 (llama-3.3-70b retired), OpenRouter 404 (model no longer free), all from one tester's log.

## Open items, in order

1. **Verify the catalog against real providers.** It was built from documented response shapes and real error text, but not run against live Groq/NVIDIA/OpenRouter/Cerebras. Get `pocket models --refresh` output from a real install and fix any provider whose list doesn't parse.
2. **Quotas from response headers.** Limits still come from providers.json. Read `x-ratelimit-limit-*` / `-remaining-*` / `-reset-*` (and Retry-After) per response and feed the meter, so the dashboard reflects real quota.
3. **Stop the daemon during `npm i -g` on Windows.** Running daemon locks the keyring `.node` file → `EPERM` cleanup warnings. Options: a `preinstall` that calls `pocket daemon stop`, or the daemon not holding the native module open.
4. **Deprecate 0.1.x on npm**: `npm deprecate @zerwone/pocket@"<0.2.0" "use 0.2.0 or later"` (owner, needs 2FA).
5. **Claude Code auto-mode classifier billing**: Claude Code shows a notice that sessions through a gateway don't get the new classifier billing. Spec: code.claude.com/docs/en/auto-mode-classifier-billing. Nothing breaks without it.
6. **Ranking heuristics** in `catalog.ts` (`STRONG_FAMILY`, `OLD`, `FAST_HINT`) are name patterns; revisit when providers' lists change.
7. **Cursor**: chat with your own key only; Agent/Composer unsupported.

## Start here

```sh
npm ci
npm test            # 83 pass, 3 skipped without a keychain
node dist/main.js --help
```
