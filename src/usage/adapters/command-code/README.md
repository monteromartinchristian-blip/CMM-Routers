# Command Code usage source notes

Verified on 2026-09-13 against the installed Command Code CLI package `command-code@1.50.0`.

The CLI's `/usage` surface loads account/billing metadata without making an inference request. Its bundled implementation uses authenticated `GET` calls to:

- `/alpha/whoami?limits=1`
- `/alpha/billing/credits?orgId=...`
- `/alpha/billing/subscriptions?orgId=...`
- `/alpha/usage/summary?orgId=...&since=...`

The same bundle builds `Authorization: Bearer <Command Code auth key>` for Command API calls. The credits response is the source for `monthlyCredits`, `purchasedCredits`, `freeCredits`, and `windowLimits` (`fiveHour`, `weekly`). The whoami response exposes organization spend limits, including model-scoped limits where present. Subscription metadata supplies the current billing-period start/end.

These `/alpha/*` routes are an implementation detail observed in the official CLI rather than a promised public billing API. The adapter therefore treats the CLI contract as its provenance (`provider_official_cli`), validates response shapes conservatively, and fails as usage metadata if the contract changes. It never falls back to model inference to discover quota state.

The adapter intentionally does not convert the cumulative `/alpha/usage/summary` totals into discrete `UsageEvent` or `CostEvent` records: those domain objects represent durable events, while the endpoint returns a period summary. Summary totals remain safe discovery metadata only.
