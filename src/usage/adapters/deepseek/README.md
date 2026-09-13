# DeepSeek API balance source notes

Verified on 2026-09-13 against the official DeepSeek API documentation
(https://api-docs.deepseek.com/api/get-user-balance).

## Mechanism

```text
GET https://api.deepseek.com/user/balance
Authorization: Bearer *** DeepSeek API key>
```

Response schema (official):

```json
{
  "is_available": true,
  "balance_infos": [
    { "currency": "CNY", "total_balance": "110.00",
      "granted_balance": "10.00", "topped_up_balance": "100.00" }
  ]
}
```

- `is_available` is a funding signal for API calls (not uptime, not quota).
- Amounts are decimal **strings** (CNY or USD) to avoid float error; the
  adapter parses them exactly and keeps each currency as its own bucket.
- There is no expiration or reset field in this endpoint. The adapter therefore
  creates balance buckets with `windowPolicy: none` and never attaches a
  `resetAt` — a balance is not a windowed quota.
- `401 authentication_error` on bad keys; `500/503` server errors are
  normalized as unavailable. No inference model is called for this metadata.

Model inventory for the API comes from the generic OpenAI-compatible
`GET /models` discovery path (documented admin listing, also non-inference);
this adapter reuses that mechanism and keeps model ids exactly as listed.

## Provenance rule

`total_balance`/`granted_balance`/`topped_up_balance` snapshots carry
`source: provider_official_api`. Router-measured token counts remain
`router_measured` UsageEvents owned by the ingestion pipeline. The two are
never merged: a balance is remaining money, a UsageEvent is observed token
consumption, and this adapter emits no UsageEvents at all from balance data.
