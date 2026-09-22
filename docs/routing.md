# Routing

Code narrows the candidate list; Jev makes the choice. Every routed turn is **one** brain call.

| Signal                                           | Decision                                               |
| ------------------------------------------------ | ------------------------------------------------------ |
| Any `jevonian/auto` request                      | one Jev call picks the model from the candidates       |
| Provider out of quota                            | removed from the candidate list before Jev is asked    |
| Provider quota low                               | still offered; no candidate is dropped for being low   |
| Conversation too large for a model's window      | withheld, with the reason in `x-jevonian-skipped`      |
| No model can think as deeply as demanded         | withheld, with the reason in `x-jevonian-skipped`      |
| Nothing fits the context                         | the history is compacted, then routing runs again      |
| `x-jevonian-effort: low\|medium\|high\|…`        | floor for the thinking level; shallower models skipped |
| No healthy provider anywhere                     | the full list stands — a turn is still served          |
| `x-jevonian-phase: plan\|execute\|utility\|chat` | explicit override, Jev is not consulted                |
| Real model ID in `model`                         | pinned, never routed                                   |
| `routing.mode: "off"`                            | pure pass-through, virtual models rejected             |
| No brain configured                              | `jevonian/auto` errors; it does not fall back          |
| Every brain unreachable                          | the request errors with `502`                          |
| `routing.mode: "auto"`                           | Jev picks the model; no brain means no routing         |

Every routed turn is **one** brain call, and that call answers **two** questions: which model, and how deeply it should think. Both refer to the same narrowed candidate list, so the thinking level costs no extra round trip.

## Virtual models

Point any OpenAI-compatible, Anthropic-compatible, or Responses-compatible client at `http://127.0.0.1:8787` and use a virtual model:

- `jevonian/auto` — route by conversation phase (default)
- `jevonian/plan` / `jevonian/execute` / `jevonian/utility` / `jevonian/chat` — force a tier
- a real model ID — pinned, never routed

The `jevonian/` prefix keeps virtual models from colliding with provider model ids. The bare names (`auto`, `plan`, `execute`, `utility`) still work, unless a configured provider declares that exact model id — then the bare name pins to that real model and only the namespaced form is virtual.

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"jevonian/auto","messages":[{"role":"user","content":"design a cache layer"}]}'
```

## Context and thinking depth

A model that cannot hold the conversation, or cannot think as deeply as the turn needs, is not a real candidate — offering it to the brain would only produce a broken turn. So before Jev is consulted, code applies a second arithmetic filter, and reports everything it withholds:

- **Context.** The conversation is measured with the compactor's token estimator (calibrated against Jev's own counts, and deliberately overshooting) and compared against each model's context window, with 10% headroom for the response. A model whose window is unknown is **never** withheld — silence is not evidence.
- **Effort.** Set a floor with `x-jevonian-effort: high` (or `routing.defaultEffort`). A model whose deepest supported level is shallower than the floor is withheld.
- **Never silent.** Every withheld model appears in `x-jevonian-skipped` as `provider/model=reason(detail)`, in the ledger's `skipped` field, and as `context-skip` / `effort-skip` in `x-jevonian-reason`.

When the brain picks a model that cannot honour the requested level, routing **clamps** to the shallowest supported level at least as deep — under-thinking silently degrades an answer, while over-thinking only costs tokens. The clamp is recorded in `x-jevonian-effort-note`.

## Context overflow

If **no** candidate's window can hold the conversation, routing still returns a decision (the turn is not failed in the router) but sets `contextOverflow`. The proxy then compacts the history and routes again on the smaller body. If compaction cannot help — no brain, nothing to shrink, or too small a reduction to be worth the churn — the request fails with `context_length_exceeded` rather than sending a body the upstream will reject.

Compaction never rewrites prose. It asks Jev two questions per tool call — should the _call_ stay, and should its _result_ stay verbatim — then **deletes** only what Jev says is stale, truncating a dropped result to a bounded head plus a note instead of removing the call it belongs to. Every word the user or assistant wrote stays verbatim and in order, because a summary is lossy (an exact path or error string can vanish) while a deleted tool result is recoverable: the assistant can re-run the tool. Set the policy with `routing.capacities` and `routing.defaultEffort`.

## Quota guard

Routing treats "does this provider have enough quota left to finish the turn?" as a first-class signal (`routing.quotaGuard`, on by default). For each tier candidate the guard asks the quota layer for a health verdict — `ok`, `low` (under `lowPercent` of the window remaining, default 10%), `exhausted`, or `unknown` (no quota data; treated as neutral):

- A provider is considered **exhausted** when the window is spent, or when the remaining dollar budget is smaller than one average request (a three-request margin downgrades `ok` to `low`).
- Candidates with a healthy provider are preferred; `unknown` never blocks a provider, so API-key providers without caps are unaffected.
- If every candidate in the phase is constrained, the guard walks the normal fallback order and takes the first acceptable model there; if nothing is acceptable it uses the best remaining option and says so.
- The decision lands in `x-jevonian-reason` as `quota-skip:<provider>`, `quota-low`, or `quota-exhausted`, and shows up in the ledger's `reason` field.

Windows come from the live usage endpoints, captured response headers, or the ledger, depending on what the provider exposes — the same data behind the dashboard meters.

See [providers.md](providers.md#usage-and-limits) for where each source comes from.

## Canonical models

The same model is spelled differently per provider (`claude-sonnet-4-6` on Anthropic, `anthropic/claude-sonnet-4.6` on OpenRouter, dated snapshot ids like `claude-haiku-4-5-20251001`). Jevonian normalizes these into a canonical id — provider prefix stripped, case folded, dots become dashes, trailing date stamps and `-tiered` removed — so tiers and pinned requests can name the model once and let routing pick the provider:

- A tier entry like `claude-sonnet-4.6` resolves to every configured provider that serves it, in provider order, subject to the quota guard. `x-jevonian-reason` reports `canonical:<id>` when expansion happened. Either spelling works, since the requested id is normalized before matching, so the entry is stored as `claude-sonnet-4-6`.
- A routing's `models` list is a fallback chain: after Jev picks the routing, the first model with a healthy provider is used; later models wait until earlier ones are unavailable. Drag models on the Routing page to change that order.
- A routing can narrow one model to specific providers with `routing.routings[].providers` — a per-model allow-list in preference order. Providers outside the list are not candidates, so deleting one from the Routing page genuinely stops the router using it; an empty list withholds the model. Models with no entry keep every provider that serves them. See [configuration.md](configuration.md#routing-fields).
- Identity also crosses vendors: the catalog label links `deepseek-v4-1-flash` to the official `deepseek-flash`, because resellers serve the same model under their own id.
- Exact model ids still win: if a provider literally lists the id you asked for, it is used as-is.
- `GET /v1/models` lists canonical ids (owned by `jevonian`) whenever they differ from the real ids, together with the declared provider ids.
- The Routing page's model picker shows canonical models first with a `N providers` hint, then provider-specific spellings.
- Irregular names can be pinned in config: `"modelAliases": { "gpt-5.6": ["openrouter/openai/gpt-5.6-custom"] }` — keys are canonical ids, values are model ids or `provider/modelId`.

## Sessions

Phase signals come from the **last** user message, so an environment preamble such as `<user_info>` never hides a greeting or a task. Sessions are sticky: the same conversation keeps its model until the brain moves it or the session TTL expires. Session identity comes from `x-session-id` / `x-opencode-session` / `previous_response_id` / `prompt_cache_key` / `metadata.user_id` / `user`, and falls back to a fingerprint of the conversation prefix — so any agent works with zero changes.

Stickiness is affinity, not a lock: Jev may move the session to a different model at any turn, and the previous model is offered to it as context rather than enforced.

## Decision headers

Every response carries `x-jevonian-model` and `x-jevonian-provider` (who actually served the turn) alongside `x-jevonian-phase`, `x-jevonian-session`, and `x-jevonian-reason`, plus `x-jevonian-effort` (the thinking level actually sent), `x-jevonian-effort-note` when it was clamped, and `x-jevonian-skipped` listing every model code withheld and why. When routing is unconfigured, tiers are derived from the price table: the priciest available model becomes `plan`, the cheapest becomes `execute` and `utility`.

The ledger and the dashboard report the level the model was **actually sent**, read back from the outgoing body rather than from the router's intent — the two differ when the client set its own level. A level the client set in its own field (`reasoning_effort`, `reasoning`, or `thinking.budget_tokens`) is never overridden; when it disagrees with the router's choice, the record notes it as `client set "…"; router chose "…"`. A model that takes no level at all is not a level, so the record stays empty. The `report` command breaks traffic down by thinking level alongside phase.

## Cache-aware routing estimates

Auto routing includes per-model cache evidence in the state sent to Jev: recent measured hit ratio, estimated cached/uncached input tokens, effective input cost, confidence, and input-cost difference versus staying on the previous model (`switchPenaltyUsd`). Successful upstream usage feeds the next turn's estimate; failed responses do not warm the session. Cache evidence cannot override capability or quota filtering.

This first implementation retains only the latest successful observation per session. It discounts reuse linearly over a conservative five-minute estimation horizon (not a provider TTL guarantee). Same-session/provider/model affinity is weak evidence: the actual on-wire prefix is not yet compared, so `prefixMatch` remains `unknown`. Switching providers gets no assumed cache reuse. Unknown prices stay unknown, not zero. Estimates exclude output and cache-write costs and are not billing totals. The selected estimate is stored in the request ledger; `x-jevonian-cache-state` exposes its state. Actual response cache reads remain separate usage fields. No raw prompt is retained by this cache observation.
