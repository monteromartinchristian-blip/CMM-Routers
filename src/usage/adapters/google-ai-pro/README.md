# Google AI Pro / Gemini quota source notes

Verified on 2026-09-13 against the installed Gemini CLI
`@google/gemini-cli@0.51.0` (`/usr/local/lib/node_modules/@google/gemini-cli`)
and its upstream `packages/core/src/code_assist/{server,types}.ts`.

## Mechanism

The CLI obtains account/tier and quota state from two authenticated Code
Assist RPCs on `https://cloudcode-pa.googleapis.com/v1internal`:

```text
POST /v1internal:loadCodeAssist      -> currentTier/paidTier (incl. availableCredits) and cloudaicompanionProject
POST /v1internal:retrieveUserQuota   -> buckets[]: { tokenType, modelId?, remainingFraction?, remainingAmount?, resetTime? }
```

`Authorization: Bearer <Google OAuth access token>` (the CLI's own OAuth flow).
These are pure metadata RPCs: the POST method carries an RPC body (project /
client metadata), and neither endpoint accepts content, generates output, or
spends model quota. The adapter only issues these two RPCs — there is no
`generateContent` path.

`tokenType` values such as `tokenType.googleapis.com/gemini-pro-model` and
`tokenType.googleapis.com/gemini-flash-model` are the first-party model pools;
buckets that carry a `modelId` (for example external OpenAI/Anthropic models
surfaced through the subscription) are model-scoped pools. The CLI renders
`remainingFraction`/`remainingAmount`/`resetTime` directly — there are no
absolute per-plan message limits exposed, so percentages are preserved as
fractions and never converted to invented absolute values. `remainingAmount`
is the provider's own remaining-unit count and stays a provider-reported value.

## Adapter mapping

- One subscription product (`Google AI Pro`, tier name from `paidTier.name`).
- Each quota bucket key is `quota:<tokenType>[:<modelId>]`: model-scoped pools
  bind only to their model's route; pool-wide buckets bind to every route of
  the product — representing split first-party/external pools through ordinary
  QuotaBuckets/Bindings, with **no provider branch in the core resolver**.
- `availableCredits` becomes a separate `credits` bucket (Google One AI
  credits), distinct from model pools.
- Independent `resetTime` values are preserved per bucket.
- The Cloud Code project id used by the RPC body is transient request state
  only: it never appears in normalized output or persistence, matching the
  OAuth token.
- If either RPC changes shape, parsing fails conservatively as a protocol
  error; the adapter never falls back to inference to discover quota state.
