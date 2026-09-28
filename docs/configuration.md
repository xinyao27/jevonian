# Configuration

Config lives at `~/.config/jevonian/config.json`. Everything in it is editable from the dashboard; the file is the source of truth.

```json
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "defaultProvider": "deepseek",
  "providers": [
    {
      "name": "deepseek",
      "type": "openai",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "models": ["deepseek-v4.1-flash", "deepseek-v4-pro"]
    }
  ],
  "routing": {
    "mode": "auto",
    "tiers": {
      "plan": ["deepseek-v4-pro"],
      "execute": ["deepseek-v4.1-flash"],
      "utility": ["deepseek-v4.1-flash"],
      "chat": ["deepseek-v4.1-flash"]
    },
    "sessionTtlMinutes": 720,
    "baselineModel": "deepseek-v4-pro",
    "brainPicksEffort": true,
    "defaultEffort": "medium",
    "capacities": {
      "deepseek-v4.1-flash": {
        "contextWindow": 128000,
        "maxOutput": 8192,
        "efforts": ["low", "medium", "high"]
      }
    },
    "brains": [{ "channel": "typesafe", "apiKeyEnv": "TYPESAFE_API_KEY", "minConfidence": 0.6 }]
  }
}
```

`capacities` overrides what the models.dev catalog states for a model — useful when your own provider's window or accepted thinking levels differ from the shared listing. Anything you leave out still comes from the catalog.

## Routing fields

| Field               | Default  | Meaning                                                                                 |
| ------------------- | -------- | --------------------------------------------------------------------------------------- |
| `mode`              | `"auto"` | `"auto"` routes virtual models; `"off"` is pure pass-through                            |
| `routings`          | builtins | ordered route categories, each with `id`, `label`, `description`, `models`, `providers` |
| `tiers`             | derived  | model lists for the four builtins, mirrored from `routings` for older configs           |
| `sessionTtlMinutes` | `720`    | how long a session keeps its route                                                      |
| `baselineModel`     | derived  | what savings are measured against; defaults to the priciest available model             |
| `quotaGuard`        | on       | `{ enabled, lowPercent }`                                                               |
| `brains`            | `[]`     | ordered brain channels; see [brain.md](brain.md)                                        |
| `capacities`        | —        | per-model overrides for context window, max output, and supported efforts               |
| `defaultEffort`     | —        | thinking level used when the brain does not pick one                                    |
| `brainPicksEffort`  | `true`   | whether the brain is asked to choose a thinking level                                   |

Prefer editing `routings`; `tiers` is kept in sync for older callers.

`models` is a fallback chain: the first model with a healthy provider serves the turn; later
entries are tried only when earlier ones are unavailable. The Routing page reorders this list
when you drag model rows.

Each routing may also carry `providers`, a per-model allow-list of provider names in preference
order:

```json
{
  "id": "execute",
  "label": "Execute",
  "description": "implementation, debugging, tool loops",
  "models": ["claude-sonnet-4.6"],
  "providers": { "claude-sonnet-4.6": ["anthropic", "openrouter"] }
}
```

A model with no entry uses every configured provider that serves it, in config order. Naming
providers restricts the model to exactly those — so removing one from the list stops the router
using it. An explicit empty list (`[]`) withholds the model entirely. The Routing page writes
this field as you add and remove provider chips, and a list that matches discovery in order is
dropped rather than stored. The older name for this field, `providerOrder`, still loads.

## Model auto-sync

While `serve` is running, Jevonian periodically discovers each provider's live model list and
**appends** newly released ids to `providers[].models`. It never removes, reorders, or rewrites
an existing entry (including per-model wire pins). Declared routings stay as you set them.
A pass runs only when the last one (recorded in `model-sync.json`) is older than the interval, so
restarting `serve` does not re-probe every provider. An unpriced new id can fill an empty `plan`
routing as a last resort, but never a cheap one (`execute`, `utility`, …).

| Field / flag                | Default            | Meaning                                                                                      |
| --------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `modelSync.enabled`         | `true`             | Master switch for background discovery                                                       |
| `modelSync.intervalMinutes` | `720`              | Minimum minutes between discovery passes (clamped ≥ 15)                                      |
| `providers[].syncModels`    | OAuth on / API off | Explicit `true`/`false` overrides. Absent → only Codex, Claude Code, Antigravity, Devin sync |
| `providers[].excludeModels` | —                  | Ids discovery must not re-add; a dashboard/CLI removal is recorded here                      |

Trigger a pass immediately with `jevonian models --sync`, the Providers page **Sync now** button, or
`POST /api/model-sync/run`. ChatGPT subscription discovery reads `~/.codex/models_cache.json`
(run `codex` once if that cache is missing).

## Prompt policy

Some upstreams refuse a request outright when the system prompt carries verbatim wording from a
rival coding agent's prompt. Devin's content policy is the observed case: against `swe-2-max`,
each of Cursor's identity line (`You operate in Cursor.`), its `tool_calling` paragraph, the
`## METHOD 2: MARKDOWN CODE BLOCKS … NOT already in Codebase` heading, and the
`There is one text file for each terminal the user has running.` sentence blocked a request on its
own — while a paraphrase of the same instruction passed. Jevonian rewrites those signatures to
neutral wording on the way out, so the turn reaches the model and the client's instructions keep
their meaning.

| Field                   | Default | Meaning                                                                         |
| ----------------------- | ------- | ------------------------------------------------------------------------------- |
| `promptPolicy.builtins` | `true`  | Apply the built-in rival-prompt signature rewrites (Devin wire)                 |
| `promptPolicy.rewrites` | `[]`    | Your own `{ match, flags?, replace }` rules; run after the built-ins, all wires |

A rule is a regular expression applied to every prompt field of the outgoing body — Chat
Completions `messages`, Anthropic `system`, and Responses `instructions` — whether the field is a
string or a list of text blocks. Only `system`/`developer` messages are touched, and a body that
matches nothing is sent byte-identical. `replace` takes `$1` group references; leave it empty to
delete the match. A rule whose `match` is not a valid pattern is ignored rather than failing the
turn.

```json
{
  "promptPolicy": {
    "builtins": true,
    "rewrites": [
      { "match": "internal-hostname\\.corp", "replace": "the staging host" },
      { "match": "\\s*<scratchpad>[\\s\\S]*?</scratchpad>", "replace": "" }
    ]
  }
}
```

This is a compatibility shim for upstream filters, not a secret scanner: it rewrites prompt text in
flight and nothing else. If a client ships brand-new blocked wording, the Devin wire also retries
once with the whole client system prompt dropped, so the turn does not fail with the client's own
prompt text.

## Token saver

Agents re-send their whole conversation on every turn, and the bulky part is usually prior tool
results — test logs, `git status`, long file reads. The token saver compresses those tool results
inside the outgoing request body before it leaves for the provider by piping each one through
[`rtk`](https://github.com/rtk-ai/rtk) — the Rust Token Killer coding agents already use to
compact command output. `rtk pipe` reads a result on stdin, auto-detects the output shape
(cargo test, pytest, vitest, grep-like, find-like, mypy, phpunit, ctest, go-test JSON, …) and
prints a smaller version on stdout; when nothing matches, the text passes through byte-identical.
The edits are deterministic — nothing is summarised or rewritten by a model, so an exact error
string or file path survives verbatim — and the turn's ledger row records the estimated prompt
tokens kept back. `jevonian report` and the dashboard's Overview stats show the running total.

Install `rtk` with `brew install rtk` or download a release from
[rtk-ai/rtk](https://github.com/rtk-ai/rtk/releases); the saver ships enabled and quietly leaves
every body untouched when the binary is missing.

| Field                  | Default | Meaning                                                                         |
| ---------------------- | ------- | ------------------------------------------------------------------------------- |
| `tokenSaver.enabled`   | `true`  | Master switch; `false` sends every body untouched                               |
| `tokenSaver.command`   | `rtk`   | Binary name resolved via `PATH`, or an absolute path to a specific install      |
| `tokenSaver.timeoutMs` | `3000`  | Milliseconds a single `rtk pipe` call may take before the original text is kept |

The switch lives on the Routing page ("Token saver" card) and accepts partial updates at
`PUT /api/token-saver`. Compression runs on whichever wire the turn takes — Chat Completions
`messages`, Anthropic `tool_result` blocks, and Responses `function_call_output` items — and only
touches messages that already carry tool output, so a fresh first turn is sent byte-identical.

## Environment

| Variable                        | Overrides                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `JEVONIAN_CONFIG`               | config path                                                                       |
| `JEVONIAN_CREDENTIALS`          | credentials path                                                                  |
| `JEVONIAN_DATA_DIR`             | data directory (ledger, catalog, pricing, quota)                                  |
| `JEVONIAN_LEDGER`               | ledger path                                                                       |
| `JEVONIAN_MODEL_SYNC_STATE`     | last model-discovery sync status                                                  |
| `JEVONIAN_UPDATE_STATE`         | update-check cache path                                                           |
| `JEVONIAN_INSTALL_CHANNEL`      | force `npm`, `pnpm`, `source`, or `unknown` for update handling                   |
| `JEVONIAN_NPM_REGISTRY`         | package metadata URL used by update checks                                        |
| `JEVONIAN_CAPTURE_BODIES`       | set to `0` to stop storing request/brain payloads                                 |
| `JEVONIAN_NO_OPEN`              | set to `1` to skip launching the browser                                          |
| `JEVONIAN_UPSTREAM_RETRIES`     | retries after a transient upstream failure (default `2`, `0` disables, max `5`)   |
| `JEVONIAN_SYSTEM_PROXY`         | set to `off` to ignore the macOS system proxy                                     |
| `JEVONIAN_CLAUDE_CREDENTIALS`   | Claude Code credentials file (disables the keychain fallback)                     |
| `JEVONIAN_CODEX_AUTH`           | Codex `auth.json` path                                                            |
| `JEVONIAN_CODEX_USAGE_URL`      | Codex usage endpoint                                                              |
| `JEVONIAN_ANTIGRAVITY_TOKEN`    | Antigravity credential file (keyring payload JSON or `go-keyring-base64:` string) |
| `JEVONIAN_ANTIGRAVITY_PROJECT`  | Cloud Code Assist project id                                                      |
| `JEVONIAN_DEVIN_CREDENTIALS`    | Devin CLI `credentials.toml` path                                                 |
| `JEVONIAN_DEVIN_CLIENT_VERSION` | Devin client version reported on the Connect-RPC wire                             |

## Data locations

| Path                                       | Contents                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `~/.config/jevonian/config.json`           | routing, providers, tiers, brains                                          |
| `~/.config/jevonian/credentials.json`      | provider and brain keys (`0600`)                                           |
| `~/.local/share/jevonian/ledger.jsonl`     | append-only request and brain-call ledger                                  |
| `~/.local/share/jevonian/keys.json`        | Jevonian API keys (`sk-jev-…`), hashed                                     |
| `~/.local/share/jevonian/pricing.json`     | models.dev price snapshot (refreshed every 12h, or via `jevonian refresh`) |
| `~/.local/share/jevonian/leaderboard.json` | models.dev unified-model benchmark snapshot (`models.json`; 12h TTL)       |
| `~/.local/share/jevonian/model-sync.json`  | last provider model-discovery pass (added ids, errors, opt-outs)           |

| `~/.local/share/jevonian/quota.json` | quota windows captured from headers and endpoints |
| `~/.local/share/jevonian/bodies/` | captured request/brain payloads (`0600`, newest 1000) |
| `~/.local/share/jevonian/clients/` | pre-Jevonian client state, for **Restore** |
