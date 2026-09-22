# CLI

Every command works against the same `~/.config/jevonian/config.json` the dashboard edits.

- `jevonian` / `jevonian serve` — start the local proxy (default). On macOS this installs a LaunchAgent, keeps it running in the background, and returns; on other platforms it serves in the foreground. Use `--foreground` for an attached process on macOS
- `jevonian stop [--uninstall]` — stop the macOS background service (`--uninstall` also removes the LaunchAgent)
- `jevonian status` — LaunchAgent state, pid, and recent serve log (macOS)
- `jevonian init` — setup wizard for the first provider (non-interactive: writes an example config)
- `jevonian add [provider]` — add or update a provider; interactive picker, live model discovery, auto tiers
- `jevonian providers` — list configured providers with key source and model count
- `jevonian remove <provider> [--keep-key]` — remove a provider and its stored key
- `jevonian report` — spend, cache hit rate, brain-decided turns, and savings vs the baseline model
- `jevonian doctor [--network]` — config, providers, tiers, ledger, catalog, pricing health
- `jevonian models [--refresh]` — discovered models per provider (hits each provider's `/models`)
- `jevonian pricing [--refresh]` — price table source and size; `--refresh` pulls from models.dev
- `jevonian quota [--refresh]` — per-provider quota windows, reset times, and 30-day spend
- `jevonian update [--check]` — check for or install the latest release through the detected package manager
- `jevonian launch claude [--model M] [--] [args…]` — run Claude Code through Jevonian (Ollama-style env remap)

`serve` also accepts `--tunnel` and `--no-tunnel` to force the public endpoint on or off for that run (these imply foreground on macOS); see [tunnel.md](tunnel.md). Background serve logs to `~/.local/share/jevonian/serve.log`.

### Claude Code

Same approach as `ollama launch claude`: point Claude Code at the local Anthropic-compatible endpoint and remap Opus / Sonnet / Haiku onto Jevonian models.

```bash
# one-shot (does not change ~/.claude/settings.json)
jevonian launch claude
jevonian launch claude --model jevonian/auto -- -p "summarize this repo"

# or Connect Claude on the Clients page — writes Desktop + ~/.claude/settings.json
# so both the app and a plain `claude` keep using Jevonian until you Restore
```

In `/model` you should see **Jevonian Auto** (and Haiku labeled **Jevonian Utility** when that routing exists). The built-in Sonnet/Opus/Haiku aliases resolve to those same models.

Running from a source checkout, prefix these with `node dist/cli.mjs`:

```bash
node dist/cli.mjs
node dist/cli.mjs report
```

## Dashboard routes

The local server ships a React + Tailwind dashboard:

- `/` — overview: agent endpoint, savings, cache hit rate, tier summary, provider limits
- `/providers` — add/edit/remove providers, live model discovery, key entry, auth and billing mode, usage & limits, and the routing brain
- `/routing` — pick the models behind plan / execute / utility / chat, mode, baseline, quota guard and per-provider health
- `/clients` — connect ChatGPT or Claude (Desktop + Claude Code together) to this machine's Jevonian
- `/keys` — generate and revoke Jevonian API keys (`sk-jev-…`, shown once, stored hashed)
- `/logs` — every proxied request with phase, model, tokens, cache reads, cost, latency, reason; click a row for a detail page with the captured prompt and the routing-brain calls (state + verdict)
