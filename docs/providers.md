# Providers

Everything — providers, keys, routing, logs — is configured in the browser, or from the CLI with `jevonian add`.

## Provider fields

| Field         | Values                                     | Notes                                                                        |
| ------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| `type`        | `openai`, `anthropic`, `responses`, `both` | the wire protocol; `both` serves OpenAI and Anthropic from one entry         |
| `auth`        | `api-key` (default), `oauth`               | `oauth` adds bearer/beta headers and reads the credential from `oauthSource` |
| `oauthSource` | `claude-code`, `codex`, `static`           | `static` uses the stored key as a bearer token                               |
| `billing`     | `api` (default), `subscription`            | subscription spend is recorded as quota value, not real money                |
| `quota`       | `{ fiveHourUsd, weeklyUsd, monthlyUsd }`   | optional caps for ledger-based quota meters                                  |

A top-level `modelAliases` map pins irregular cross-provider names to a canonical id (see [routing.md](routing.md#canonical-models)).

## Presets

Built-in presets cover DeepSeek, Anthropic (Claude), OpenAI, Moonshot (Kimi), Z.ai (GLM), MiniMax, Alibaba Qwen, xAI (Grok), Google Gemini, OpenRouter, OrcaRouter, OpenCode Go, Command Code, Claude Pro/Max, ChatGPT (Codex), and Antigravity. Each preset carries its base URL, protocol type, key variable, and a hint for where to create a key.

`jevonian init` (or `jevonian add`) walks through everything:

1. Pick a provider from the built-in list, or add a custom endpoint.
2. Paste the API key. Keys are stored in `~/.config/jevonian/credentials.json` with `0600` permissions; set `--env NAME` to reference an environment variable instead.
3. Models are discovered live from the provider's `/models` endpoint (falling back to the models.dev catalog), and `plan`/`execute`/`utility` tiers are derived automatically from the price table.

Non-interactive, for scripts and agents:

```bash
jevonian add deepseek --key sk-...
jevonian add moonshotai --env MOONSHOT_API_KEY --models kimi-k3,kimi-k2.7-code
jevonian add my-gateway --base-url https://gateway.internal/v1 --type openai --key ...
jevonian add opencode-go --key sk-... --models opencode-go/kimi-k3,opencode-go/deepseek-v4.1-flash
jevonian add claude-subscription            # reads your Claude Code login
jevonian add chatgpt-subscription --models gpt-5.6-codex   # adds a responses provider
```

## Subscriptions

Besides classic API providers, Jevonian speaks to the subscriptions you already pay for. Providers carry two flags:

- `auth: "api-key" | "oauth"` — how the credential is obtained
- `billing: "api" | "subscription"` — pay-per-token or flat-rate quota

Two families are supported:

**API-key subscriptions** — endpoints that issue a key and speak OpenAI/Anthropic protocols. Presets: `opencode-go`, `commandcode`. Both serve two wires from one base URL, so they use `type: "both"`: one provider entry answers OpenAI (`/chat/completions`) clients and Anthropic (`/messages`) clients, and the endpoint is picked from the incoming request. Everything else works like a normal provider; `billing: "subscription"` marks ledger entries as quota value rather than real spend.

**OAuth subscriptions** — the credential lives with the agent you already signed into:

| Provider         | Preset                 | Credential source                                                                   | Wire                                                                                 |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Claude Pro/Max   | `claude-subscription`  | `~/.claude/.credentials.json`, or the macOS keychain item `Claude Code-credentials` | Anthropic Messages (Bearer + `oauth-2025-04-20`, Claude Code system prompt injected) |
| ChatGPT Plus/Pro | `chatgpt-subscription` | `~/.codex/auth.json`                                                                | OpenAI Responses (`store: false`, account + originator headers)                      |

- Tokens are read on demand, cached in memory, and refreshed with the vendor's refresh-token endpoint when they are about to expire; rotated tokens are written back to the source file so Claude Code / Codex keep working. Set `oauthSource: "static"` to use a stored long-lived token instead.
- Model discovery works for subscriptions too: Claude reads Anthropic's `/v1/models` with the OAuth token, ChatGPT reads the model list Codex caches at `~/.codex/models_cache.json` (run `codex` once if it is missing), and Antigravity calls `v1internal:fetchAvailableModels` with the local token. The protocol field follows the credential source — Claude Code pins `anthropic`, Codex pins `responses`, Antigravity pins `gemini` — so one entry gets the right wire automatically.
- Background auto-sync (see [configuration.md](configuration.md#model-auto-sync)) appends newly listed ids while `serve` runs. Removals are sticky via `excludeModels`. Fixed routings are never rewritten; only empty auto-derived routings can pick an unpriced new id as a last-resort candidate.
- `/v1/responses` is proxied for clients that speak the Responses API (Codex CLI). A chat-completions request that routes to a Responses provider is translated on the fly (streaming chunks included), so any OpenAI-compatible agent can use the ChatGPT subscription. The reverse also works: a Responses client that routes to an Anthropic-only host (Claude Pro/Max) folds through Chat Completions → Anthropic Messages and back.
- Subscription access through third-party clients is outside the vendors' official clients. Expect the usual caveats: it can break when upstream headers change, and use is at your own risk.

A subscription provider in `~/.config/jevonian/config.json`:

```json
{
  "name": "claude-subscription",
  "type": "anthropic",
  "baseUrl": "https://api.anthropic.com/v1",
  "auth": "oauth",
  "oauthSource": "claude-code",
  "billing": "subscription",
  "models": ["claude-sonnet-4-6", "claude-opus-4-6"]
}
```

## Usage and limits

The Overview and Providers pages show, per provider, the rolling windows, remaining quota, reset times, and local spend. Sources, in order:

1. **Live** — vendor usage endpoints: OpenCode Go (`GET {baseUrl}/usage`), Claude (`GET https://api.anthropic.com/api/oauth/usage`), Codex (`GET https://chatgpt.com/backend-api/wham/usage`). Fetches are cached (Claude for 5 minutes, everything else for 1 minute) and refreshed with `jevonian quota --refresh` or the dashboard button.
2. **Response headers** — `anthropic-ratelimit-unified-*` and `x-codex-*` headers captured passively from every proxied response, persisted at `~/.local/share/jevonian/quota.json`.
3. **Ledger** — dollar windows computed from the local ledger when a provider declares caps (`quota.fiveHourUsd` / `weeklyUsd` / `monthlyUsd`). Useful for Command Code and any subscription without a usage API.

## Pricing

Prices come from [models.dev](https://models.dev) (`https://models.dev/api.json`), cached at `~/.local/share/jevonian/pricing.json`. Refresh with `jevonian pricing --refresh`; `serve`, `report`, and `doctor` load the snapshot automatically.

- Lookups prefer the provider-qualified rate (`deepseek/deepseek-v4-pro`) and fall back to the bare model id. Reseller-prefixed ids live under their own key (`reseller/vendor/model`), so they never shadow the owner's rate.
- `src/pricing/models.json` is an offline fallback for ids models.dev does not carry; it also holds the DeepSeek peak/off-peak rules, which models.dev does not express.
- models.dev rates win when both sources know a model. Note that models.dev's own `deepseek` entry differs from DeepSeek's pricing page, so estimates follow models.dev.
- Context-tiered rates (`cost.tiers`) are not modeled yet; the base rate is used.
