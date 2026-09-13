# ChatGPT subscription usage source notes

Verified on 2026-09-13 against the installed Codex CLI
`codex-cli 0.153.4` (native bundle at
`/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`).

## Mechanism

The Codex CLI reads ChatGPT plan rate-limit state from:

```text
GET https://chatgpt.com/backend-api/codex/api/codex/usage
Authorization: Bearer *** ChatGPT OAuth access token>
ChatGPT-Account-Id: <workspace account id>
```

Evidence from the CLI binary: the base `https://chatgpt.com/backend-api/codex`,
the paths `/api/codex/usage` and `/backend-api/api/codex`, the auth header
construction `auth: set ChatGPT-Account-Id header`, and the response structs:

- `RateLimitSnapshot`: `limit_name`, `primary`, `secondary`, `credits`,
  `individual_limits`, `spend_control_reached`, `plan_type`,
  `rate_limit_reached_type`.
- `RateLimitWindow` / `RateLimitWindowSnapshot`: `used_percent`,
  `window_minutes` / `limit_window_seconds`, `resets_at` / `reset_after_seconds`.
- `CreditsSnapshot`: `has_credits`, `unlimited`, `balance`.

`/status` renders exactly these two plan windows (primary 5-hour session,
secondary weekly) plus credits state, which confirms this is the subscription
quota surface the CLI itself uses. This is a pure metadata `GET`: it triggers no
inference and spends no quota. No live account call was performed for this
implementation; the contract comes from the official CLI, and parsing fails
conservatively as a protocol error if the shape changes.

## Adapter mapping

- Primary and secondary windows are independent `percentage` buckets with
  independent resets (`rolling_duration` from the reported window seconds;
  `resets_at` preferred, otherwise `now + reset_after_seconds` computed once at
  observation time). Percentages-only data is preserved as fractions — no
  absolute message limits are invented.
- `spend_control_reached` and `rate_limit_reached_type` values mark the
  affected window `exhausted` conservatively; otherwise status derives from the
  used percentage with the standard thresholds.
- A present `credits` snapshot becomes its own provider-defined `credits`
  bucket (balance preserved as reported); it is never merged into the plan
  windows.
- The subscription namespace is fully separate from the OpenAI API billing
  adapter (`provider:openai-api`): distinct provider, account, product, route,
  bucket, and id namespaces, so the same model can have independent AccessRoutes
  with independent quota graphs through API vs subscription.
- The OAuth token and account id are supplied via injected credential/identity
  references (`resolve()` / plain id string) and are used only in request
  headers; neither value appears in normalized output or persistence.
- Windows with unknown/absent keys produce no buckets; unknown capability state
  stays conservative (`unknown`), never guessed.
