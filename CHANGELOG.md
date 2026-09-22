# Changelog

All notable changes to this project are documented in this file.

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
