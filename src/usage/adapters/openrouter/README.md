# OpenRouter usage source notes

Verified on 2026-09-13 against the official OpenRouter API documentation
(openrouter.ai/docs/api/api-reference: "Get current API key", "Get remaining
credits", "Get a single API key", "List all models"; and
docs/api_reference/limits).

## Mechanism

All surfaces are authenticated metadata `GET`s under
`https://openrouter.ai/api/v1` — pure reads that trigger no inference and
spend no credits:

- `GET /key` (current key, any valid API key):
  `data.{ label, limit, limit_reset, limit_remaining, include_byok_in_limit,
  usage, usage_daily, usage_weekly, usage_monthly, byok_usage*, is_free_tier }`.
  `limit`/`limit_remaining` are USD spending caps or `null` when unlimited;
  `limit_reset` is the reset cadence ("daily"/"weekly"/"monthly", `null` =
  never); `usage*` are USD credit counters (all-time / UTC day / UTC week
  Mon-Sun / UTC month). The deprecated `rate_limit` object is ignored.
- `GET /credits` (**Management key required**; 403 otherwise):
  `data.{ total_credits, total_usage }` — the account-wide prepaid USD pool
  (all-time counters).
- `GET /keys?include_disabled=true` (**Management key required**): per-key
  records including stable `hash`, `limit`/`limit_reset`/`limit_remaining`,
  `usage*`, `workspace_id`, `disabled`.
- `GET /models`: model catalog listing (`data[].id`/`name`), authoritative
  discovery, no hardcoded catalog.

## Adapter mapping

- **Organization pool vs key caps stay separate buckets** — never collapsed:
  - `org:credits` — organization prepaid pool (limit = total_credits,
    used/remaining from total_usage), all-time window (`none`).
  - `key:<owner>:limit` — per-key spend cap with `limit_reset` mapped to an
    ordinary `fixed_calendar` UTC day/week/month window; an unrecognized or
    absent cadence (including `null` = never resets) uses
    `windowPolicy: provider_reported` rather than fabricating a window — the
    cap itself is still recorded exactly.
  - `key:<owner>:usage[_daily|_weekly|_monthly]` — usage **counters**: no
    limit, no fraction, no reset invented; status stays `unknown`. These
    describe spend state, not quota ceilings.
- `owner` is the key `hash` for management-listed keys (stable, non-secret
  public identifier returned by the management API) and the key `label` for
  the current-key surface (the only identity `GET /key` exposes).
- The same cap + pool buckets bind to every discovered model route through
  ordinary QuotaBindings — multiple models consuming one credit pool is the
  normal graph shape, no core branch.
- **Key kinds stay isolated**: standard API key resolves `GET /key` +
  `/models`; only an injected `managementCredential` unlocks `/credits` and
  `/keys`. If the management key is rejected, discovery still succeeds with
  the standard surface and simply omits the org pool (proven by test).
- A `null` `limit` yields **no cap bucket** (unlimited is not zero, and a
  counter is never converted into a fabricated ceiling).
- Currency: the provider reports USD amounts natively; buckets use
  `{ kind: "currency", currency: "USD" }`.
- Confidence: caps/pool use `exact` (direct provider fields); counters use
  `measured`. `resetAt` is never fabricated — OpenRouter exposes reset
  *cadence*, not the next absolute reset timestamp for key caps or the pool,
  so snapshots carry none.
- Identity/secret hygiene: key material and credential references appear only
  in request headers. `creator_user_id`, `workspace_id`, and BYOK counter
  fields are never emitted in normalized output; the management API's `hash`
  and the current key's `label` (the only identity `GET /key` exposes) are
  used as bucket owner tokens because they are non-secret listing identifiers.

## Not represented

- `X-RateLimit-*` headers appear only on error responses (request-count
  caps), not on metadata polling; the adapter does not fabricate request
  buckets from them.
- Per-generation usage/cost drill-down (`GET /generation`, `/activity`) is
  analytics rather than quota state; usage events remain owned by
  router-measured ingestion, so this adapter declares
  `collect_usage_events`/`collect_costs` unsupported.
