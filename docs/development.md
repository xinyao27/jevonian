# Development

Built with [Vite+](https://viteplus.dev). Oxlint, Oxfmt, Vitest, and tsdown come from the `vite-plus` bundle — do not install them directly.

```bash
pnpm dev           # Vite dev server (5173) + proxy (8787), HMR, opens the dashboard
vp check           # format + lint + type check (primary gate, use --fix)
vp test            # unit tests
pnpm smoke         # end-to-end assertions against a mock upstream, no API keys needed
pnpm build         # bundle the CLI and build the web UI
pnpm web:dev       # Vite dev server for the dashboard (proxies /api and /v1 to the local server)
pnpm typecheck:web # type check the dashboard
```

`pnpm dev` starts the dashboard on `5173` and the proxy on `8787`; opening `http://127.0.0.1:8787` redirects to the dev server, so there is nothing to build while developing. File-watch restarts reuse the same browser tab instead of opening a new one each time.

`pnpm build && node dist/cli.mjs` serves the proxy and the built dashboard on a single port, `127.0.0.1:8787`.

## Source layout

- `src/routing.ts` — phase classification, tier derivation, session store, virtual models
- `src/upstream.ts` — request forwarding, streaming passthrough, usage capture, decision headers
- `src/oauth.ts` — Claude Code / Codex credential import, refresh, and cache
- `src/responses.ts` — Responses protocol translation, streaming bridge, usage mapping
- `src/gemini.ts` — Gemini/Cloud Code Assist translation (Antigravity), streaming bridge, usage mapping
- `src/models.ts` — canonical model ids, cross-provider variants, user aliases
- `src/quota.ts` — live usage endpoints, response-header capture, ledger fallback
- `src/admin.ts` — admin API behind the web UI (`/api/*`)
- `src/keys.ts` — Jevonian API keys (`sk-jev-…`), hashed at `~/.local/share/jevonian/keys.json`
- `src/stats.ts` — ledger aggregation for reports and the dashboard
- `src/catalog.ts` — provider model discovery and cache
- `src/modelsdev.ts` — models.dev price table fetch, mapping, and snapshot cache
- `src/providers.ts` — built-in provider presets and protocol-type mapping
- `src/credentials.ts` — owner-only key store at `~/.config/jevonian/credentials.json`
- `src/prompt.ts` — interactive prompts (masked key entry, choices)
- `src/config.ts` — config load/validation, provider resolution
- `src/ledger.ts` — append-only JSONL ledger at `~/.local/share/jevonian/ledger.jsonl`
- `src/bodies.ts` — captured request/brain payloads for the log detail view (`~/.local/share/jevonian/bodies/`, 0600, newest 1000 kept)
- `src/pricing/` — price lookup, cost math, DeepSeek peak rules, offline fallback table
- `src/session.ts` — conversation fingerprint (cache affinity key)
- `web/` — React + Tailwind + shadcn/ui on Base UI components (Vite+, built to `dist/web`)

## Release process

Releases publish to npm via a version tag.

```bash
pnpm build
vp check
vp test
pnpm smoke
```

Bump `package.json` version, commit it, and push a matching tag such as `v0.1.0`. `.github/workflows/publish-npm.yml` runs the full check/test/build gate, requires the tag and package version to match, and publishes with npm provenance. It expects an `NPM_TOKEN` repository secret.

Once a release is published, `jevonian serve` checks the registry in the background at most once every 24 hours (on open, then hourly while the process stays up); short CLI commands also surface a previously cached update notice. When a newer version is available, run `jevonian update` or use **Update and restart** on the dashboard. The update is installed through the original npm/pnpm channel, then Jevonian stops accepting new inference requests, lets active streams finish, and starts the new process on the same port. Source checkouts never self-update.
