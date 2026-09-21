# Troubleshooting

Start with `jevonian doctor`. It checks config, providers, tiers, ledger, catalog, and pricing; add `--network` to include outbound reachability. Most symptoms below name what doctor cannot see.

## The agent connects but every turn fails

- **No brain configured.** `jevonian/auto` returns an error rather than guessing. Add a brain on the **Providers** page, or request a route explicitly with `jevonian/plan`.
- **Every brain unreachable.** The request fails with `502`. Check the brain's key and press **Test channel**. Later brains are only tried when an earlier channel fails; a low-confidence verdict from a working channel is used as-is and marked `x-jevonian-brain: jev-low-confidence`.
- **No key sent.** Once a Jevonian key exists, all `/v1/*` traffic must carry it as `authorization: Bearer …` or `x-api-key`.
- **Credit limit reached.** A key with a total USD limit returns `429` / `credit_limit_exceeded` once estimated API spend hits the ceiling. Raise or clear the limit on the **API keys** page; subscription value does not count toward it.

## The turn fails with `context_length_exceeded`

No candidate's window can hold the conversation, and compaction could not reduce it enough to be worth the churn. Either raise `capacities.<model>.contextWindow` if the catalog understates your provider's window, or start a fresh session — the ledger notes `contextOverflow` on the decision that triggered it.

## A model you expected never runs

Check `x-jevonian-skipped` on the response, and the `skipped` field in the ledger. Withheld models always carry a reason:

- `context-skip` — the window cannot hold the conversation.
- `effort-skip` — the model cannot think as deeply as the requested floor.
- `quota-skip` — the provider's window is spent, or its remaining budget is smaller than one average request.

A model whose capability is **unknown** is never withheld, so a missing skip reason means it was a candidate and simply was not chosen.

## Quota meters show nothing

Quota comes from three sources in order: live vendor endpoints, response headers, and the ledger. A provider with no usage API and no declared `quota.fiveHourUsd` / `weeklyUsd` / `monthlyUsd` has nothing to display — that is expected, not a failure. `jevonian quota --refresh` forces a live fetch (Claude is cached 5 minutes, everything else 1 minute).

## A `fetch failed` error reaches the agent

On macOS the system proxy lives in network settings, which Node's `fetch` ignores. Jevonian reads it via `scutil --proxy` and routes egress through it, exempting loopback. If a host your browser reaches still fails from Jevonian, set `JEVONIAN_SYSTEM_PROXY=off` to bypass detection, or export `HTTPS_PROXY` yourself — an existing environment variable always wins.

Transient socket resets from a local proxy (Clash and friends) are detected and surfaced as request failures rather than crashing the server.

## The ChatGPT subscription provider fails first

`chatgpt.com` is exactly the kind of host a proxy rule exists for, so it is the provider that breaks first when proxying is wrong. Verify system-proxy detection above before suspecting the credential. If discovery lists no models, run the `codex` CLI once so it populates `~/.codex/models_cache.json`.

## Live quota fetch is rejected

Some vendors reject the usage endpoints even when normal inference works, especially when the request arrives without the expected client identity. This is not a routing failure — the ledger-based fallback still applies sense to spend when the provider declares caps.

## Updating from a source checkout does nothing

`jevonian update` is registry-based. Source checkouts never self-update: pull and rebuild instead.

## Where to look first

| Question                                  | Command / place                                       |
| ----------------------------------------- | ----------------------------------------------------- |
| Is config, catalog, pricing healthy?      | `jevonian doctor`                                     |
| What exactly did this turn decide?        | `x-jevonian-reason`, `x-jevonian-skipped` headers     |
| Which models are discovered per provider? | `jevonian models`                                     |
| Where is the money going?                 | `jevonian report`, **Activity**, or **Logs**          |
| What quota is left?                       | `jevonian quota`, or the Overview meters              |
| Why did a key start returning 429?        | Credit limit on **API keys** — see [keys.md](keys.md) |
