# OpenAI API usage/cost source notes

Verified on 2026-09-13 against the official OpenAI API reference
(developers.openai.com, "Usage API" and "Costs" sections under the Admin
organization resource) and the official `openai-node` SDK source
(`src/resources/admin/organization/usage.ts`).

These are documented, authenticated `GET` billing endpoints under
`https://api.openai.com/v1` and require an organization **admin key**
(`Authorization: Bearer ***`):

- `GET /v1/organization/usage/completions?start_time=&bucket_width=1d&group_by[]=model&page=`
  returns a page object `{ object: "page", has_more, next_page, data: [bucket] }`
  where each bucket is `{ object: "bucket", start_time, end_time, results: [
  { object: "organization.usage.completions.result", input_tokens,
  output_tokens, num_model_requests, model, ... } ] }` (Unix seconds).
- `GET /v1/organization/costs?start_time=&bucket_width=1d&page=` returns the
  same bucket shape with `results: [{ object:
  "organization.costs.result", amount: { value, currency } }]` (lowercase
  ISO-4217).

Both are pure aggregation reads: they trigger no inference and spend no model
quota. The adapter only issues these two GET paths; there is no code path to
`/chat/completions`, `/responses` or any other inference endpoint.

## Adapter mapping

- `discover()` is offline and configuration-driven: the API product is a
  `payg`-style billing product whose routes come from explicitly configured
  model ids. The adapter does not call `/models` or invent a catalog.
- Usage buckets become `UsageEvent` rows (`source: provider_official_api`,
  `confidence: measured`) with provider-reported token/request counts; cost
  buckets become `CostEvent` rows (`kind: "usage"`, provider-reported monetary
  amount).
- PAYG billing has no quota windows, so the adapter declares **no** quota
  capabilities and cannot invent one. If the account configures a spend
  control, it must be represented by a separate integration that observes it;
  this adapter reports only what the endpoints return.
- The `next_page` cursor is returned verbatim for follow-up pages; cursors are
  opaque API tokens, not secret values.
- Credential handling follows the established pattern: an injected
  `reference` plus `resolve()`, with the resolved key used only in the
  request header and never persisted or emitted in normalized output.

Live verification against the account was not performed (not required for
deterministic implementation/tests, and live admin calls were not separately
authorized). Response parsing is conservative: unknown shapes fail as protocol
errors, never guessed values.
