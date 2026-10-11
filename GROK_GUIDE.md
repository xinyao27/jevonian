# Jevonian Integration Guide for Grok & xAI Models

This guide documents the implementation, feasibility, and configuration for using **Jevonian** with **xAI / Grok models** and the **Grok CLI**.

---

## 1. Feasibility Analysis: Can we set context and effort using Jevonian?

**YES, 100% possible and natively supported.**

### A. Context Window Control (`contextWindow`)
- **How Jevonian handles context**:
  - Jevonian maintains model capacities with a `ContextWindow` attribute (in tokens).
  - During request routing, Jevonian evaluates turn complexity and prompt length via `FitsContext(window, estimatedTokens)`. It applies a 90% threshold limit (`tokens <= int(0.9 * window)`) leaving 10% headroom for output and token estimation divergence.
  - When a conversation approaches or exceeds a smaller model's limit (e.g. `grok-build-0.1` at 256k), Jevonian automatically narrows candidate models to larger context models (e.g. `grok-4.5` at 500k, or `grok-4.3` at 1M), preventing context-length overflow errors before they happen.
- **Where it is configured**:
  - **Native built-in catalog**: Built directly into Jevonian via `xaiCapabilities` in `internal/catalogsync/capabilities.go`.
  - **Custom per-model override**: Declared under `"routing.capacities"` in `config.json`.

### B. Reasoning Effort Control (`effort`)
- **How Jevonian handles effort**:
  - Jevonian has an effort hierarchy: `none` (0), `minimal` (1), `low` (2), `medium` (3), `high` (4), `xhigh` (5), `max` (6), `ultra` (8).
  - xAI's official reasoning efforts (`none`, `low`, `medium`, `high`, `xhigh`) map 1:1 into Jevonian's scale.
  - **Effort Clamping (`ClampEffort`)**: If a client or category requests an effort level that a model does not support (for instance, `grok-build-0.1` only supports up to `high`, or `grok-4.20-non-reasoning` only supports `none`), Jevonian clamps the effort to the closest supported level.
  - **Dynamic Effort Selection (`brainPicksEffort: true`)**: Jevonian's auto-router can analyze prompt difficulty and dynamically assign shallow reasoning (`low`) to simple tasks and deep reasoning (`high` / `xhigh`) to difficult tasks.
  - **Wire Level Injection**: When dispatching the request to xAI (`https://api.x.ai/v1/chat/completions`), Jevonian's upstream adapter automatically injects `"reasoning_effort": "<effort>"` into the request payload.

---

## 2. Official xAI Models & Specifications (from docs.x.ai/developers/pricing)

| Model | Context Window | Max Output | Reasoning | Supported Efforts | Prompt Price (/1M) | Cached Prompt (/1M) | Completion Price (/1M) |
|---|---|---|---|---|---|---|---|
| **`grok-4.5`** | 500,000 | 65,536 | Yes | `low`, `medium`, `high`, `xhigh` (default: high) | $2.00 | $0.30 | $6.00 |
| **`grok-4.7`** | 500,000 | 65,536 | Yes | `low`, `medium`, `high`, `xhigh` (default: high) | $2.00 | — | $6.00 |
| **`grok-4.6`** | 500,000 | 65,536 | Yes | `low`, `medium`, `high`, `xhigh` (default: high) | $2.00 | $0.50 | $6.00 |
| **`grok-4.3`** | 1,000,000 | 65,536 | Yes | `none`, `low`, `medium`, `high`, `xhigh` (default: low) | $1.25 | $0.20 | $2.50 |
| **`grok-build-0.1`** | 256,000 | 65,536 | Yes | `low`, `medium`, `high` | $1.00 | $0.20 | $2.00 |
| **`grok-4.20-0309-reasoning`** | 1,000,000 | 65,536 | Yes | `low`, `medium`, `high` | $1.25 | — | $2.50 |
| **`grok-4.20-0309-non-reasoning`** | 1,000,000 | 65,536 | No | `none` | $1.25 | — | $2.50 |
| **`grok-4.20-multi-agent-0309`** | 1,000,000 | 65,536 | Yes | `low`, `medium`, `high` | $1.25 | — | $2.50 |

---

## 3. Implementation Details in Jevonian Codebase

The following modules in the cloned repo have been upgraded:

1. **`internal/catalogsync/capabilities.go`**:
   - Added `xaiCapabilities(model string)` providing built-in context window sizes (256k, 500k, 1M) and effort levels (`none`, `low`, `medium`, `high`, `xhigh`) for all official models and aliases.
   - Wired `xaiCapabilities` into `ModelCapabilities(model)`.

2. **`internal/cli/pricing.go`**:
   - Registered all official xAI Grok models and pricing rates into `fallbackPrices`.

3. **`internal/config/types.go` & `internal/config/defaults.go`**:
   - Added `OAuthGrok OAuthSource = "grok"` so Jevonian can read the local Grok CLI sign-in (`~/.grok/auth.json`).

4. **`internal/oauth/credentials.go` & `internal/oauth/oauth.go`**:
   - Added `GrokAuthPath` and `resolveGrok`, allowing zero-configuration authentication from the existing Grok CLI OAuth session.

5. **`internal/clients/grok.go` & `internal/clients/clients.go`**:
   - Added native client management for Grok CLI (`ClientID = "grok"`).
   - Supports `grokStatus(port)`, `applyGrok(opts)`, and `restoreGrok()`, automating `~/.grok/config.toml` updates.

6. **`internal/cli/lifecycle.go` & `internal/cli/cli.go`**:
   - Extended the `launch` command to support Grok CLI:
     ```bash
     jevonian launch grok [--model M] [--] [grok args...]
     ```

---

## 4. How to Use & Configuration

### Option A: Use API Key (`config.grok.json`)
```bash
set XAI_API_KEY=xai-your-api-key
jevonian serve --foreground
```

### Option B: Use Local Grok OAuth (`config.grok.oauth.json`)
If you have already signed into Grok CLI, Jevonian reads your token from `~/.grok/auth.json` directly:
```json
{
  "name": "xai-oauth",
  "type": "openai",
  "baseUrl": "https://api.x.ai/v1",
  "auth": "oauth",
  "oauthSource": "grok"
}
```

### Routing Tiers with Grok
```json
{
  "routing": {
    "mode": "auto",
    "baselineModel": "grok-4.5",
    "defaultEffort": "medium",
    "brainPicksEffort": true,
    "routings": [
      {
        "id": "plan",
        "effort": "high",
        "models": ["grok-4.7", "grok-4.5"]
      },
      {
        "id": "execute",
        "effort": "medium",
        "models": ["grok-4.5", "grok-build-0.1"]
      },
      {
        "id": "utility",
        "effort": "low",
        "models": ["grok-build-0.1", "grok-4.3"]
      },
      {
        "id": "chat",
        "effort": "none",
        "models": ["grok-4.3", "grok-4.20-non-reasoning"]
      }
    ]
  }
}
```

### Connecting Grok CLI to Jevonian
1. **Direct command-line launch**:
   ```bash
   jevonian launch grok --model jevonian/auto
   ```
2. **Or run Grok CLI directly with `-u`**:
   ```bash
   grok -u http://127.0.0.1:8787/v1 -m jevonian/auto
   ```
3. **Or set endpoints in `~/.grok/config.toml`**:
   ```toml
   [endpoints]
   xai_api_base_url = "http://127.0.0.1:8787/v1"
   models_base_url = "http://127.0.0.1:8787/v1"

   [models]
   default = "jevonian/auto"
   ```
