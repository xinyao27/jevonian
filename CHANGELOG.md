# Changelog

All notable changes to this project are documented in this file.

## [0.1.7] - 2026-09-23

### Fixed

- When every routing-brain channel fails at once, Jevonian repeats the whole brain round with the same transient backoff instead of immediately returning `502 brain unavailable`. After retries are exhausted, the turn soft-falls back to `classifyPhase` heuristic routing (`brain-fallback:…`) rather than 502ing the agent — Cursor used to freeze behind a misleading "User Provided API Key Rate Limit Exceeded" toast. Watch `serve.log` for `brain unavailable retry …` / `brain retry …` / heuristic fallback lines.
- Shell tool arguments sent to the brain are redacted — raw `; curl …` snippets trip TypeSafe's Cloudflare WAF (403 HTML) and were collapsing both brain channels even when the key itself was fine.
- A live `$0` OpenRouter/DeepSeek balance is treated as exhausted (and persisted), so routing and the OpenRouter brain channel stop calling a spent key; a brain `402` also marks the matching provider spent for the rest of the turn.
- When the package on disk is already newest but the running process is behind, the dashboard shows the process version and offers restart-only instead of a no-op update.

## [0.1.6] - 2026-09-23

### Added

- Transient upstream failures are retried instead of failing the turn: a dropped socket, a DNS blip, or a gateway `500`/`502`/`503`/`504` during the model call is repeated up to twice (`250ms`→`500ms` with jitter). The routing brain call and OAuth token refreshes retry the same way, so one flaky link no longer costs a whole turn before a model is even asked. A recovered turn records `retries` in the ledger, returns `x-jevonian-retries`, and shows **network retries** in the log detail. Tune with `JEVONIAN_UPSTREAM_RETRIES` (`0` disables, capped at `5`). A `429` still goes to quota failover rather than being repeated against the same host, and a `4xx` is never retried.
- Claude live quota now surfaces model-scoped weekly limits (for example a Fable-only window) alongside the shared 5h/7d pools. Scoped windows are labeled in the dashboard for visibility but never gate routing on their own — a spent scoped pool does not drop the rest of the Claude account.

## [0.1.5] - 2026-09-23

### Added

- Provider model auto-sync: while `serve` runs, Jevonian periodically discovers each provider's live model list and appends new ids to config (never removes or reorders). On by default for Codex, Claude Code, and Antigravity subscriptions; API-key and reseller providers opt in with `syncModels: true` (or opt any provider out with `false`). Deliberate removals stick via `excludeModels`, from the dashboard and from re-running `jevonian add`. Dashboard **Sync now**, `jevonian models --sync`, and `POST /api/model-sync/run` trigger a pass immediately. An empty auto-derived `plan` routing may fall back to an unpriced configured model so a brand-new flagship is reachable before models.dev prices it; cheap routings never pick an unpriced model.
- Responses clients (Codex CLI, ChatGPT Desktop) can route to Anthropic-only hosts such as a Claude Pro/Max subscription, bridged through Chat Completions → Anthropic Messages and back (streaming included).
- Chat Completions clients can route to Anthropic-only hosts. When a model is available both on its official host and a reseller, the official host now wins routing.

### Fixed

- Tool call ids from OpenAI / Responses clients are rewritten to Anthropic's `^[a-zA-Z0-9_-]+$` charset (≤ 64 chars) with a hash suffix, so a punctuated id no longer gets a 400 and two ids differing only in punctuation stay distinct.
- Claude subscription requests send a current Claude Code User-Agent (`claude-cli/2.1.280`); older versions hid newer subscription models.
- Newer Claude models (4.6+) get `thinking: { type: "adaptive" }` with `output_config.effort` instead of `disabled` / `budget_tokens`, which those models reject. Always-thinking models map effort `none` to `low`, and a client-sent `thinking` block is translated rather than forwarded invalid.
- Bridged Anthropic requests raise `max_tokens` above the thinking budget (or shrink the budget to the model's output cap), so enabling thinking no longer fails with a 400.
- A client's own reasoning effort (Codex `reasoning.effort`, Chat `reasoning_effort`) now reaches Claude when bridged, instead of being dropped.
- Streaming Responses → Anthropic keeps cache read/write usage in the ledger instead of recording zero.

## [0.1.4] - 2026-09-22

### Added

- Soft routing evidence from models.dev benchmarks (SWE-Bench, Terminal-Bench, and related boards). Scores cache locally for 12 hours, refresh with `jevonian refresh`, and only attach when a model has data — missing benchmarks never bias selection.

### Fixed

- Oversized Responses `call_id` values (longer than 64 characters) are clamped to a stable short id before upstream, so OpenAI no longer rejects the request with `string_above_max_length` while call/output pairs stay matched.
- Codex quota no longer treats `used_percent: 1` (1%) as 100% exhausted.

### Changed

- Dashboard version is baked from `package.json` at build time.

## [0.1.3] - 2026-09-22

### Added

- Routing page: drag models within a routing to set fallback order. The first model with a healthy provider is used; later models wait until earlier ones are unavailable.

## [0.1.2] - 2026-09-22

### Fixed

- Quota meters no longer fail with `SyntaxError: Unexpected token … is not valid JSON` and report healthy providers as spent. undici 8.11.0 stopped forcing HTTP/1.1 for Node's built-in `fetch` when a dispatcher is installed, and over HTTP/2 that combination returns an empty header set and a still-compressed body. Jevonian's dispatcher is now pinned to HTTP/1.1, which is the connection undici 8.10.x handed the built-in fetch on its own.
- A provider recorded as `rejected` from a 429/402 is no longer stuck that way. The rejection snapshot is now cleared as soon as a live quota probe succeeds, so a limit that has since reset stops withholding the provider from routing. A failed probe still leaves the snapshot in place.
- An update that cannot finish draining now restarts anyway instead of leaving the dashboard on 503 until a manual restart.

## [0.1.1] - 2026-09-22

### Added

- Dashboard loading skeletons on every data-backed page, built from the shared shadcn `Skeleton` primitive.

### Fixed

- DeepSeek and Moonshot/Kimi thinking-mode tool loops no longer fail with `reasoning_content must be passed back to the API`. Jevonian caches upstream reasoning and reinjects it when clients (notably Cursor) drop the field after tool calls.

## [0.1.0] - 2026-09-22

### Added

- Dashboard light/dark/system theme switcher, with the preference remembered across reloads.

### Changed

- Dashboard UI primitives now use Base UI instead of Radix.

### Fixed

- LaunchAgent tunnel PATH now includes the user's interactive shell path, so ngrok/cloudflared stay reachable after a reboot.
- LaunchAgent bootstrap no longer races on EIO when the previous agent is still shutting down.

## [0.0.3] - 2026-09-22

### Fixed

- `jevonian update` now installs through the npm next to the running Node binary and pins the fetched version, then verifies the on-disk package. PATH shims (for example vite-plus `vp`) could previously install into a different Node prefix while the CLI still reported success, so a restart kept serving the old build.

## [0.0.2] - 2026-09-22

### Added

- Bare `jevonian` on macOS now installs a LaunchAgent, so the proxy keeps serving through terminal exits and reboots. `jevonian status` and `jevonian stop` inspect and stop it.

### Changed

- Restored keep-alive on idle upstream sockets: the router now holds a pooled connection for two minutes instead of Node's four-second default. The proxy's TLS handshake to an overseas egress takes about a second, and agent turns are spaced further apart than four seconds, so most turns were paying that handshake on the critical path. Routing decisions that followed a pause of four seconds or more dropped from a 1018 ms median to 367 ms.

### Fixed

- Empty `function_call` names are no longer rejected by the OpenAI Responses surface.

## [0.0.1] - 2026-09-21

### Added

- Initial public release of Jevonian, a local-first model router for coding agents
- OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses proxy surfaces on one endpoint
- Automatic phase routing (`jevonian/auto`) via TypeSafe Jev brain channels, plus explicit route aliases
- Provider presets, subscription OAuth refresh (Claude Code / Codex / Antigravity), and live quota awareness
- Local dashboard with providers, routing, keys, activity, logs, and client helpers
- Registry-based update checks, `jevonian update`, and dashboard install-and-restart
- Manual release skill under `.agents/skills/release` (GitHub release first; npm publish is explicit)

### Changed

- Runtime npm dependencies trimmed to what the CLI needs after bundling the dashboard
- Distributed as AGPL-3.0-only with an npm-oriented install path in the README
