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

## Environment

| Variable                       | Overrides                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `JEVONIAN_CONFIG`              | config path                                                                       |
| `JEVONIAN_CREDENTIALS`         | credentials path                                                                  |
| `JEVONIAN_DATA_DIR`            | data directory (ledger, catalog, pricing, quota)                                  |
| `JEVONIAN_LEDGER`              | ledger path                                                                       |
| `JEVONIAN_UPDATE_STATE`        | update-check cache path                                                           |
| `JEVONIAN_INSTALL_CHANNEL`     | force `npm`, `pnpm`, `source`, or `unknown` for update handling                   |
| `JEVONIAN_NPM_REGISTRY`        | package metadata URL used by update checks                                        |
| `JEVONIAN_CAPTURE_BODIES`      | set to `0` to stop storing request/brain payloads                                 |
| `JEVONIAN_NO_OPEN`             | set to `1` to skip launching the browser                                          |
| `JEVONIAN_SYSTEM_PROXY`        | set to `off` to ignore the macOS system proxy                                     |
| `JEVONIAN_CLAUDE_CREDENTIALS`  | Claude Code credentials file (disables the keychain fallback)                     |
| `JEVONIAN_CODEX_AUTH`          | Codex `auth.json` path                                                            |
| `JEVONIAN_CODEX_USAGE_URL`     | Codex usage endpoint                                                              |
| `JEVONIAN_ANTIGRAVITY_TOKEN`   | Antigravity credential file (keyring payload JSON or `go-keyring-base64:` string) |
| `JEVONIAN_ANTIGRAVITY_PROJECT` | Cloud Code Assist project id                                                      |

## Data locations

| Path                                   | Contents                                              |
| -------------------------------------- | ----------------------------------------------------- |
| `~/.config/jevonian/config.json`       | routing, providers, tiers, brains                     |
| `~/.config/jevonian/credentials.json`  | provider and brain keys (`0600`)                      |
| `~/.local/share/jevonian/ledger.jsonl` | append-only request and brain-call ledger             |
| `~/.local/share/jevonian/keys.json`    | Jevonian API keys (`sk-jev-…`), hashed                |
| `~/.local/share/jevonian/pricing.json` | models.dev price snapshot                             |
| `~/.local/share/jevonian/quota.json`   | quota windows captured from headers and endpoints     |
| `~/.local/share/jevonian/bodies/`      | captured request/brain payloads (`0600`, newest 1000) |
| `~/.local/share/jevonian/clients/`     | pre-Jevonian client state, for **Restore**            |
