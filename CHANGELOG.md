# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- **Attempt history for every routed turn.** A turn is now traced while it runs, from the first routing decision to the last byte. When a turn needed more than one attempt, its ledger row carries `tries` (every upstream attempt with its `cause` — `initial`, `retry`, or `failover` — plus `status`, `ms`, `startedAt`, `ttftMs`, and, on failure, `fail`), `failovers`, and `ttftMs` (time to first streamed content). A turn served on its first attempt carries none of these fields, so a healthy row stays as small as before, and a row written before this existed reads as "not recorded" rather than "0 attempts". The request detail page draws the attempts as a waterfall, the Logs list shows a dot per attempt plus the first-token time, and searching the Logs for `failover` or `retry` finds the turns that struggled.
- **`x-jevonian-request-id` response header.** Every response names the id this turn was recorded under — the ledger row, the captured body, and the trace — so a client's own log can be joined to `/logs/:id` without a second lookup.

## [0.5.1] - 2026-10-02

### Changed

- **New Magpie-parity presets discover models live instead of shipping a hardcoded list.** Mistral, Groq, Ollama, LM Studio, OpenCode Go/Zen, Command Code, and WorkBuddy AI turn on `syncModels` (or inherit the OAuth default for WorkBuddy). `jevonian add` and the dashboard skip the models.dev snapshot for OAuth and keyless locals; an empty model list triggers live discovery. Ollama and LM Studio use `noKey` so discovery and requests work without a Bearer token.
- **Provider logos come from `@lobehub/icons`.** Dashboard marks for OpenAI, Claude, DeepSeek, Groq, Mistral, Ollama, LM Studio, OpenCode, Cursor, Devin, Antigravity, WorkBuddy/CodeBuddy, and the other built-in presets now use Lobe's official brand SVGs (color when available). OrcaRouter keeps its local mark until Lobe ships one.

### Fixed

- **WorkBuddy AI model catalog follows live `/v3/config`.** Discovery no longer falls back to a stale baked-in id list; it reads the CLI agent's models (or the top-level product catalog when that block is missing), so ids like `deepseek-v4.1-flash` appear as soon as WorkBuddy publishes them.
- **WorkBuddy Discover / Save no longer deadlocks before browser sign-in.** Discover opens the sign-in flow when no session exists, and Save is allowed with an empty model list so login can complete first.
- **Providers form no longer jumps the page on every click.** Opening Add/Edit still scrolls to the form once; later Discover / model toggles no longer re-fire `scrollIntoView`.
- **`jevonian update` restarts the macOS background service.** The CLI used to install the new package and only print "Restart Jevonian…", so a LaunchAgent kept serving the old build until a manual stop/start. It now probes the running serve version and kickstarts the LaunchAgent onto the installed build when one is loaded.

## [0.5.0] - 2026-10-02

### Added

- **WorkBuddy AI subscription** (`workbuddy-ai-subscription`). Magpie-parity for the international WorkBuddy / CodeBuddy plan: OpenAI Chat Completions at `https://www.workbuddy.ai/v2`, browser sign-in via `/v2/plugin/auth/*` (tokens stored under `~/.config/jevonian/workbuddy-ai.json`), plaintext desktop-session fallback, forced streaming with SSE folding for non-stream clients, WorkBuddy request headers, system-prompt injection when missing, model discovery from `GET /v3/config`, and live credits from `/billing/meter/get-user-resource-summary`. Encrypted desktop tokens (`$wbEncrypted`) are not readable — sign in through Jevonian instead. `JEVONIAN_WORKBUDDY_AI_AUTH` points at a session file.
- **Mistral, Groq, Ollama, LM Studio, and OpenCode Zen presets.** Common Magpie vendors Jevonian was missing: API-key Mistral/Groq, keyless local Ollama (`127.0.0.1:11434`) and LM Studio (`127.0.0.1:1234`), and the full OpenCode Zen endpoint beside the existing Go plan.
- **Clef and Clef-flash brain models on the Cloudflare channel.** The Cloudflare Workers AI brain can now run Cloudflare's open-source decision models — `@cf/cloudflare/clef` (27B, 64k context, vision) and `@cf/cloudflare/clef-flash` (latency-tuned) — alongside `typesafe/jev`. A model picker in the Providers brain form lists all three, and any other Workers AI id can still be typed into the advanced **Model (override)** field. Clef speaks the Jev API, so the existing confidence handling and compact/full state apply unchanged; catalog-model ids post to the documented `.../ai/run/@cf/...` path with a `model`/`state`/`questions` body while the Jev alias keeps the `input:{state,questions}` envelope.

### Changed

- **Dashboard sidebar no longer draws borders.** The outer divider, header/footer rules, and logo ring are gone so the sidebar reads as one continuous surface.

### Fixed

- **Update checks wait for a public npm tarball.** Registry `/latest` can advertise a version before the `.tgz` is fetchable; Jevonian now HEAD-probes the tarball before offering an upgrade, so the dashboard no longer prompts install into an ETARGET/E404 window.

## [0.4.1] - 2026-10-01

### Fixed

- **Virtual model ids beat provider catalog names.** When a provider (for example Cursor) catalogs a model named `auto`, requesting `jevonian/auto` used to pin onto that provider model and return HTTP 500. Virtual ids (`jevonian/auto`, routing phases) now always take priority over a bare catalog name with the same spelling; a real provider model still works when requested as `provider/auto`.
- **HTTP/1.1 protocol mismatch is treated as transient.** An undici `HTTPParserError` (`Response does not match the HTTP/1.1 protocol`) — usually a flaky MITM briefly speaking HTTP/2 on a connection pinned to HTTP/1.1 — no longer dumps a `TypeError` stack via `unhandledRejection`. The CLI logs a compact `proxy: transient network error (...)` line instead.

## [0.4.0] - 2026-10-01

### Added

- **Cursor subscription provider** (`cursor-subscription`). A Cursor account has no plain REST endpoint: the `cursor-agent` CLI talks a bidirectional Connect stream (`AgentService/Run`), sending the conversation as content-addressed blobs the server asks back for and reaching your tools through Cursor's `CallDynamicTool`. Jevonian now speaks that wire itself, reading the sign-in `cursor-agent` already stored (the macOS keychain item `cursor-access-token`, or `~/.cursor/auth.json`), renewing a stale token through `cursor-agent status`, and discovering models from `cursor-agent models`. `JEVONIAN_CURSOR_AUTH` points at a specific `auth.json`.
- **Reset-aware routing.** What a subscription account has left is lost when its window resets, while one renewing later keeps its quota — so the account that refills soonest is now spent first. `quotaGuard.resetAware` (on by default) orders the brain's offer pools, a pinned routing's tier, and a pinned model's providers by soonest renewal, with the longest window deciding what "soonest" means; times within the same hour are treated as alike so a few minutes do not reorder and prompt caches stay warm. Room still comes before low before exhausted, and turning it off restores the configured order exactly.
- **Cache affinity.** A vendor reads its cached prefix again on every request it serves and sends it afresh — paid for in full — on every request it does not, so a conversation now stays where it was answered while the vendor's own numbers say it is worth staying: within a turn always, and across turns while the last answer read at least 1024 tokens from the vendor's cache and not long enough ago that it has been dropped. It is a measurement, not a guess, so code decides it rather than the brain. Modes `auto` / `session` / `turn` / `off` via `x-jevonian-affinity`, with `x-jevonian-cache-keep` reporting why a turn stayed or moved, and the reason recorded in the ledger.
- **Multiple accounts per OAuth source.** A second Claude, Codex, Devin, or Cursor account is now a second provider pointed at that account's own local sign-in, so each gets its own quota window, fallback place, and ledger rows without touching the router. Add one with `--login-home` / `--login-file` / `--login-keychain` / `--login-label` on `jevonian add`, or the **Second account** fieldset in the dashboard; `jevonian list` shows `account=`. Tokens are cached per account, so two accounts of one source never share a cached token.
- **LAN access.** One instance can now route through another: turn on **LAN access** (the Overview card, or `jevonian serve --lan`) and the machine that holds the credentials exposes its key-protected `/v1` surface to the local network for another machine — or another Jevonian — to use as a provider. Deliberately narrow: only `/v1` is bound (the dashboard and admin API stay on loopback), every request needs a real Jevonian key, the loopback-only desktop sentinel is rejected, and enabling it requires at least one key to exist. The setting persists to config so the macOS LaunchAgent restart cannot silently drop it.

### Changed

- **Connecting a client no longer reformats its config.** Claude Code's `settings.json`, Claude Desktop's configs, and the third-party profile are JSONC, and people keep them tidy by hand — but a connect used to read with `JSON.parse` and write back with `JSON.stringify`, dropping comments, reordering keys, and losing custom spacing. Edits are now surgical: only the managed keys' value spans change, leaving every other byte intact. Disconnect removes only the keys Jevonian manages.

### Fixed

- **A local run can no longer take over the production service.** A checkout or a temporary config could previously rewrite, stop, or hijack the installed LaunchAgent, leaving the real instance pointing at scratch config and data directories. Jevonian now refuses to install, stop, start, or restart when the service plist path is redirected, refuses to overwrite a LaunchAgent that points at a different binary, strips the config/data/ledger overrides from the service environment, and checks the listen port before a foreground run binds it.
- The Cursor provider had no logo and fell back to a two-letter initials box, and its second-account fieldset hardcoded "Claude Code" and a `~/.claude-work` example for every OAuth source but Codex, Antigravity, and Devin. The official mark is now used, and the sign-in copy and example config directory follow the selected source.
- The `jevonian-remote` preset pointed at port 8788, which is the loopback-only tunnel surface a peer cannot reach. It now matches the LAN default (`listen.port` + 2, i.e. 8789) that the docs already describe.
- Cursor renewed a stale token through a single process-wide promise, so two Cursor accounts renewing at once shared one `cursor-agent status`. Because the CLI renews whichever account it is signed into, the second account was handed the first account's token. Renewals are now keyed per sign-in, as the OAuth token cache already is.
- Anthropic's `rejectsDisabled` check now covers the Sonnet family at version ≥ 5.5, not just Opus, so an explicit `disabled` thinking level is not sent to a model that rejects it.

## [0.3.4] - 2026-09-30

### Changed

- The Providers and Routing pages open in about a third of a second instead of 20+ seconds. Both pages already fetched their data in parallel, so the wait was server-side: `GET /api/quota` probed every configured provider's billing endpoint inline, and with eight providers the page waited on the slowest one — 7–21s for a single reseller — paying it again on most reloads because the live cache only lasts 60s. The dashboard now answers from the last snapshot and refreshes in the background, and each probe has a timeout so one hanging service cannot hold the page open. Routing is unaffected: failover decisions still probe inline, `jevonian quota` still blocks, and the Refresh button still blocks on live probes.
- The Routing page's model list no longer rebuilds on every request. Building the canonical list re-scanned all ~780 provider models once per id, about a second each time the page opened; the result depends only on the config, so it is now computed once per config.

### Fixed

- Devin's free-model rate limit now cools down only the affected model. `Reached free model rate limit` was treated like an account-wide quota failure, which parked the whole `devin-subscription` provider for hours even though the paid models on the same account still worked.
- Devin reset hints written as prose (`Your limit will reset in 2 hours 37 minutes`) are now parsed, so the cooldown matches the real reset window instead of falling back to the default.

## [0.3.3] - 2026-09-29

### Added

- `tokenSaver` config for deterministic tool-result compression via [RTK](https://github.com/rtk-ai/rtk) — the Rust Token Killer coding agents already use to compact command output. Agents re-send their whole conversation on every turn, and the bulky part is usually prior tool results — test logs, `git status`, long file reads. The saver pipes each one through `rtk pipe`, which auto-detects the output shape (cargo test, pytest, vitest, grep-like, find-like, mypy, phpunit, ctest, go-test JSON, …) and prints a smaller version on stdout. The rewrite runs inside the outgoing request body on whichever wire the turn takes — Chat Completions `messages`, Anthropic `tool_result` blocks, Responses `function_call_output` items — and a result rtk cannot parse is sent byte-identical. Install `rtk` with `brew install rtk`; the saver ships enabled and quietly does nothing when the binary is missing. Each turn's ledger row records the estimated tokens kept back (`savedTokens`), surfaced by `jevonian report`, the `/api/stats` summary, and a "Tokens saved" card on the Overview. The switch lives on the Routing page and accepts partial updates at `PUT /api/token-saver`; `tokenSaver.enabled: false` sends every body byte-identical.
- OpenCode (v1 & v2) support: an OpenAI message normalizer reshapes OpenCode's request format so multi-agent turns route cleanly, older screenshots are pruned to prevent multimodal gateway timeouts, and Anthropic URL image sources are accepted in `normalizeOpenAIMessages`.
- Kev as a self-hosted local brain channel, so routing decisions can run against a local model instead of a hosted provider.
- Tier effort routing: each routing can pin a reasoning effort (`effort` on the routing entry), applied both when the brain picks the routing and on explicit `jevonian/<id>` routes, clamped to the chosen model's capabilities.

### Changed

- Provider refusals are now routed around until no alternative remains, instead of failing the turn on the first refusal.

### Fixed

- A client disconnect right after the stream opener no longer logs a completed `200` turn: only deltas carrying content, `reasoning_content`, or `tool_calls` count as delivered, and token usage is preserved on cancel instead of a false `499`.
- OpenAI Chat tool-call stream deltas with empty `id`/`name` are sanitized, and empty `tool_calls` arrays are stripped, fixing `HTTP 400` rejections from strict backends.
- Tool messages extracted by the wire normalizer are emitted ahead of the user text/image of the same turn, so a tool result still directly follows the assistant `tool_calls` that produced it instead of being interposed after a user message.
- Long-context compaction now normalizes base64 images in token estimation and sanitizes compaction history.
- Legacy `thinking` budgets written by `withEffort` are preserved for legacy models; only an adaptive thinking shape is stripped.
- Dashboard routing edit is hardened and the dev environment is isolated.

## [0.3.2] - 2026-09-27

### Added

- `promptPolicy` config for outgoing prompt hygiene. Devin's content policy refuses a turn when the system prompt carries verbatim wording from a rival coding agent — Cursor's `You operate in Cursor.` line, its `tool_calling` paragraph, the `## METHOD 2: MARKDOWN CODE BLOCKS … NOT already in Codebase` heading, and the `There is one text file for each terminal the user has running.` sentence each blocked a request on their own, while a paraphrase of the same instruction passed. Jevonian now rewrites those signatures before egress (`promptPolicy.builtins`, on by default), and `promptPolicy.rewrites` takes your own `{ match, flags?, replace }` rules, applied to every wire — Chat Completions `messages`, Anthropic `system`, and Responses `instructions`. An invalid pattern is ignored rather than failing the turn.

### Fixed

- Devin no longer answers `400 content_policy` on a client whose system prompt matches that blocklist. A `content_policy` refusal is also retried once with the client system prompt dropped, so wording a client adds later cannot reintroduce the failure.
- A request that names a configured model (`swe-2-max`, `claude-opus-4-6-thinking`, …) while presenting a Jevonian API key is now routed by Jevonian. It used to be treated as a native ChatGPT/Codex model and forwarded to `api.openai.com` with the Jevonian key, which answered `401 Incorrect API key provided: sk-jev-…`. Native pass-through still applies to desktop clients, which present their own credentials instead of a Jevonian key.

## [0.3.1] - 2026-09-27

### Changed

- Routing-brain requests are about two-thirds smaller. Benchmark evidence sent to Jev on every routing call now carries only board scores — no source URLs, dates, versions, variant descriptions, or per-effort rows that repeat the headline score. Benchmarks had been ~70% of each request; a typical call drops from ~9.5k to ~3k input tokens, cutting TypeSafe / OpenRouter brain spend accordingly. Routing decisions use the same scores as before.

## [0.3.0] - 2026-09-27

### Added

- Devin subscription provider (`jevonian add devin-subscription`, or the **Devin** preset in the dashboard). Jevonian reads the session token that `devin auth login` stores in `~/.local/share/devin/credentials.toml` (`$XDG_DATA_HOME/devin` or `%APPDATA%\devin` when set; override with `JEVONIAN_DEVIN_CREDENTIALS`) and talks to Devin's Connect-RPC API directly (`type: "devin"`, `oauthSource: "devin"`). Models are discovered via `GetCliModelConfigs` — only the models your plan unlocks are listed, so the Free plan offers just `swe-1-6-slow` — and live quota shows Devin's daily and weekly windows from `GetUserStatus`. The token does not expire; if Devin rejects it, run `devin auth login` again and Jevonian picks up the new one on the next request.

### Fixed

- Devin turns that carry tools (every coding-agent turn from Cursor, Claude Code, Codex) no longer fail with `502 Unable to process request due to an MCP configuration issue`. Devin rejects `description` annotations inside tool parameter schemas, so Jevonian strips them from the wire schema and moves each tool's description into the system prompt; parameter names, types, and required fields are unchanged.
- Long-context compaction now counts tool schemas and instructions toward the request size, keeps a safety margin for bridged wires, and retries a provider's hard context rejection once after compacting. When compaction cannot shrink the request, the original is sent instead of being rejected locally.

## [0.2.0] - 2026-09-27

### Changed

- The dashboard has a refreshed layout with grouped navigation, Base Luma styling, neutral light and dark themes, and Inter typography; routing and provider behavior are unchanged.
- Activity now lives on Overview with its filters, charts, and model/key breakdowns. Existing `/activity` links redirect to that section.
- The README now leads with the local gateway, quickstart, and clearer explanations of routing and provider support.

## [0.1.9] - 2026-09-27

### Fixed

- Claude subscription quota now treats live 5h and 7d utilization as percentage points. A reported 1% no longer appears as 100% used or incorrectly marks the provider exhausted.

## [0.1.8] - 2026-09-26

### Fixed

- Bridged Claude streams no longer go silent during thinking: an SSE keepalive comment is emitted every 15s of idle so agents and tunnels stop canceling long Opus turns around the two-minute mark. A client disconnect is recorded as ledger `499` / `client canceled` instead of vanishing with only a brain row.
- Chat Completions → Anthropic bridging now sets prompt-cache breakpoints on the system prompt, the last tool schema, and the last message block, so long agent sessions reuse the conversation prefix instead of re-billing ~80k uncached tokens every turn.
- Claude subscription `429` responses that only carry `type: rate_limit_error` (no spend token) now trigger same-request quota failover when the unified rate-limit headers say the window is spent, so the next model in the phase chain gets the turn instead of hard-failing Opus. The live quota cache is cleared so a rejected header snapshot is not masked for five minutes.

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
