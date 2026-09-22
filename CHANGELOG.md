# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- Oversized Responses `call_id` values (longer than 64 characters) are clamped to a stable short id before upstream, so OpenAI no longer rejects the request with `string_above_max_length` while call/output pairs stay matched.

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
