# API keys, spend limits, and activity

Jevonian issues its own access keys (`sk-jev-…`) so agents can call the local proxy.
Those keys are separate from upstream provider credentials: provider secrets stay in
`credentials.json`, while Jevonian keys live hashed in `~/.local/share/jevonian/keys.json`.

## Credit limits

Each key can carry an optional **total** credit limit in USD:

- Set when creating a key, or click the limit cell on the **API keys** page.
- Leave blank / `null` for unlimited.
- Enforcement counts **pay-as-you-go API spend** attributed to that key. Subscription
  value (Claude Max, ChatGPT, etc.) is tracked for visibility but does **not** consume
  the credit limit — flat-rate traffic is not real money spent at the meter.
- When estimated API spend reaches the limit, further requests with that key return
  `429` with `type: "credit_limit_exceeded"`.

Limits are total lifetime caps for the key, not monthly windows. Clear the limit to
resume traffic without rotating the secret.

## Attribution

Every proxied request is written to the ledger with the authorizing key's `keyId` and
a snapshot of its `name`. Local desktop clients that authenticate without a Jevonian
key are tagged `local`; unauthenticated first-run traffic is tagged `unauthenticated`.
Per-key usage and credit limits only count records that carry a `keyId`.

## Activity page

The **Activity** dashboard (`/activity`) aggregates the ledger like a usage console:

| Control / panel    | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| Time range         | `24h`, `7d`, `30d`, or all retained ledger history             |
| Key filter         | One key, or all keys                                           |
| Total spend        | API estimate + subscription equivalent value, shown separately |
| Charts             | Spend, tokens, and request volume over time                    |
| Model / key tables | Ranked breakdowns for the selected window                      |

API spend is a pricing estimate from token counts; subscription value is the same
estimate for flat-rate providers and is never mixed into credit-limit math.

## Related

- [CLI](cli.md) — `jevonian report` for a text spend summary
- [Providers](providers.md) — upstream billing (`api` vs `subscription`)
- [Troubleshooting](troubleshooting.md) — auth and ledger questions
