# Claude subscription usage source notes

Verified on 2026-09-13 against the installed Claude Code CLI package
`@anthropic-ai/claude-code@2.1.220` (arm64 bundle at
`/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`) and
its local state in `~/.claude.json`.

## Mechanism

The CLI's `/usage` surface ("fetchUtilization") issues a single authenticated
metadata call:

```text
GET https://claude.ai/api/oauth/usage
Authorization: Bearer *** Claude OAuth access token>
```

Evidence recovered from the CLI bundle strings:
`fetchUtilization: GET /api/oauth/usage (attempt ...`,
`fetchUtilization: 200 after ...`, the literal path `"/api/oauth/usage"`, and
the doc string "Plan rate-limit utilization windows from the claude.ai usage
endpoint, or null when unavailable."

This is a non-inference `GET` on the account surface; it spends no model quota
and never invokes generation. The adapter preserves that property: it performs
exactly one metadata `GET` and has no code path that can call an inference
endpoint.

The response shape was verified against the CLI's own durable cache key
`cachedUsageUtilization` in `~/.claude.json` (real account data redacted from
this README). The `utilization` object contains:

- `five_hour` / `seven_day`: `{ utilization: percent-used, resets_at: ISO-8601,
  limit_dollars, used_dollars, remaining_dollars }` — plan-wide windows.
  `utilization` is a percent (0–100+, may exceed 100); dollar fields are usually
  `null` for subscription plans.
- `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`, ...: same shape
  or `null` when the account does not have that model-scoped pool.
- `limits[]`: a redundant view of the same session/weekly windows (kind/group/
  percent/resets_at). Not represented again to avoid duplicating one constraint
  as two buckets.
- `extra_usage` / `spend`: optional usage-credit (PAYG top-up) state for the
  consumer account — `is_enabled`, `monthly_limit`/`used_credits` in minor
  units, or a `spend` node with `{ used, limit }` as
  `{ amount_minor, currency, exponent }` plus `percent`. This is separate from
  the subscription windows: it only exists when the account enables credits.
- The response carries no absolute message/token limits — windows are
  percentage-only for subscription plans.

## Adapter mapping

- Percent-only windows become `percentage`-metric buckets whose snapshots carry
  only `usedFraction`/`remainingFraction` and the provider-reported `resetAt`.
  The adapter never converts a percentage into an invented absolute
  `usedValue`/`limitValue` (the same rule Command Code proves).
- Five-hour and seven-day windows are independent buckets with independent
  resets, both bound to every route of the plan product.
- Model-scoped pools (`seven_day_opus`, `seven_day_sonnet`) bind only to
  configured routes whose provider model id contains the family token
  (`opus`/`sonnet`); `seven_day_oauth_apps` binds to all routes. Unknown or
  `null` pool keys produce no buckets.
- The enabled extra-usage credit state becomes its own currency bucket in major
  units (`amount_minor / 10^exponent`), distinct from subscription windows,
  with no invented reset (the source exposes none). `spend` is preferred over
  `extra_usage` when both exist because it is the normalized node; they are
  never represented twice.
- Authentication uses an injected credential `reference` + `resolve()` so the
  durable OAuth token stays in native secret storage (Keychain/CLI state). The
  token value, the reference, and `accountUuid` never appear in normalized
  output, and the adapter stores nothing about the credential.
- The CLI also caches this response; that local cache is *not* used as a source
  here (it is a snapshot owned by the harness). If the endpoint contract
  changes, parsing fails conservatively as a protocol error; the adapter never
  falls back to inference to discover quota state.

`/api/oauth/usage` is an implementation detail of the Claude subscription
surface observed in the official CLI, not a promised public billing API, so the
source is recorded as `provider_official_api` with the observed contract noted
in discovery metadata.
