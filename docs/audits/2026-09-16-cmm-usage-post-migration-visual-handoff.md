# CMM Usage — Post-Migration Visual / Product Handoff

**Branch:** `feature/cmm-usage`
**Migration:** Router Authority Migration (13 tasks)
**Final HEAD:** documented in `2026-09-16-cmm-usage-router-authority-migration-ledger.md`
**Date:** 2026-09-16 (audit series), completed 2026-09-17

---

## Purpose

This note is the visual/product counterpart to the closure ledger. The migration
moved **authority** from CMM Usage to CMM Routers. It was explicitly **not** a
visual redesign. This document records, item by item, that every user-facing
surface survived the change and that no surface was replaced, removed, or
fabricated.

---

## 1. Architectural migration, not visual redesign

No layout, navigation, typography, color, or component change was made in the
macOS app beyond what decoding the new payload strictly required. The single
class of app change was **model adaptation**:

- `CatalogRouteEntry.visibility` changed from a `visible`/`hidden` enum to
  Router's `visibleOn` surface set; call sites now use
  `isVisibleInModelCatalog` (route is on `cmmchat_model_picker` or
  `cmmcode_model_picker`).
- The old `availability` field (removed from the payload) was remapped to
  `usageStatus`, which is the *historical Usage observation* — never Router
  routability. A route that is hidden or unobserved must never be presented as
  disconnected.

Everything else — spacing, badges, grouping, menu-bar text — is unchanged.

---

## 2. No debug dashboard / admin console

No new surface was introduced for internal state. Router's administration API
(`/v1/cmm/catalog/**`) is a privileged, credential-gated machine interface; it
was **not** surfaced in the macOS UI. The app continues to use the product-facing
`/v1/cmm/usage/catalog/*` reads and the compatibility mutation endpoints.

---

## 3. No replacement of polished UI with raw JSON or internal-ID tables

Every user-facing list continues to render **friendly, resolved** values:

| Surface | Shown to user | Not shown |
|---|---|---|
| Providers | `displayName`, category, state | canonical `providerId`, `provider:demo:*` |
| Products | friendly label (e.g. `GOAT`, `OpenRouter credits`) | `product:*` ids |
| Models | `canonicalName`, family, aliases | `modelIdentityId`, `providerModelId` |
| Quotas | `displayName`, remaining/limit, window | `bucketId`, `quotaBucketId` |
| Visibility | "Visible in model catalog" / "Hidden from model picker" | `visibleOn` array |

Internal identifiers remain in the payload for the client to key on but are never
rendered as user-visible text.

---

## 4. No removed user-facing sections

All pre-existing sections remain:

- **Providers** (primary surface) — connected / degraded / available grouping.
- **Accounts / Subscriptions / API Keys / Custom Endpoints** — kept as distinct,
  separately navigable surfaces; not merged into a single list.
- **Models** — searchable by friendly model, provider, and product name
  (`testSearchMatchesFriendlyModelProviderAndProductNames`).
- **Quotas** — per-route and shared-pool views, supplemental balances, resets.
- **Promotions / Free capacity** — FREE / PROMO / TRIAL offers with expiries.
- **Menu bar** — free-capacity count, deep-link destinations.
- **Model visibility controls** — per-route show/hide, still user-controllable.

---

## 5. Exact-route visibility remains user-controllable

Hiding a route is scoped to the **exact `AccessRoute`**, never to a provider,
product, or model identity. Verified by
`route visibility must stay provider-route scoped` and
`testHidingOpenRouterClaudeKeepsSiblingClaudeRoutesVisible`: hiding one route
leaves its sibling routes visible and does **not** change routability,
disconnect anything, stop collection, or erase history.

Legacy `workspace:`-scoped and `inherit` preferences fail closed (they are
reported as ambiguous) rather than being promoted to a global Router rule.

---

## 6. Usage surfaces preserved

All usage intelligence surfaces continue to be populated from real observations:

- **Quotas** — remaining, limit, used fraction, window policy, reset time.
- **Resets / windows** — rolling, billing-cycle, fixed-calendar, provider-reported.
- **Balances** — including supplemental (non-constraining) balances such as
  purchased and free credits, which remain observable but non-constraining.
- **Tokens / requests / costs** — per-route usage and cost events.
- **Promotions** — FREE / PROMO / TRIAL with `validUntil`; expired promos stop
  being advertised (`stops advertising expired promotional access`).
- **Freshness** — `observedAt` + `stale` flag per route.
- **Forecasts / alerts** — quota forecasts and critical/warning/exhausted alerts.

No placeholder or invented metric was added anywhere.

---

## 7. Unmistakable real-vs-demo separation

Demo mode (`CMM_USAGE_DEMO_FIXTURE=1`) remains visually and functionally
isolated:

- It serves only synthetic `*:demo:*` identities from an in-memory store.
- The public demo management bearer **cannot** reach real Router
  administration: canonical administration mutations return **403**, and the
  compatibility mutation surface returns **503** (fail-closed).
- Real mode never receives demo identities, and the production composition
  supplies real Router connections.
- A client and server that disagree about demo mode fail closed.

---

## 8. Native macOS feel preserved

- No cross-platform or web-derived UI was introduced.
- SF Symbols, standard `Menu`/`Label`/`Button` patterns, and existing view
  hierarchies were retained.
- The menu-bar extra, deep-link handling, and overview/provider/model navigation
  are unchanged.

---

## 9. Verification evidence

| Check | Result |
|---|---|
| `swift test --package-path apps/cmm-usage-macos` | 20 tests, 0 failures |
| `swift run ... CMMUsageContractTests` | PASS |
| `swift build ... -c release` | Build complete |
| Boundary-focused Node suite (`tests/catalog`, `catalog-usage-boundary`, `tests/usage`, `management-catalog`, `router-administration`, `production-composition`) | 402 passed |
| Native client decodes the new payload end-to-end | contract tests PASS against `visibleOn` + `usageStatus` |
| Secret safety (`ProviderPresentationTests`) | no `credentialRef` / keychain reference in payload |

---

## 10. Known intentional behaviour changes

1. **`instanceIds` are now canonical Router connection ids.** This is a fix, not
   a regression: the client passes them to enable/disable/disconnect, which
   delegate to Router administration and expect Router ids.
2. **A route with no resolvable product** is omitted from the Usage product
   catalog while remaining on the Router catalog endpoint — unchanged
   pre-existing behaviour, and preferable to fabricating a product.
3. **Custom OpenAI-compatible endpoints** no longer collect until the
   composition supplies a `UsageCollectorBinding`. This is the intended
   consequence of "Usage must not fabricate operational identities"; the
   mechanism is complete and tested, and wiring it is a follow-up.

---

## Sign-off

The migration is **architectural**. Every product surface enumerated in the
preservation contract is present, real-state-driven, and visually unchanged.
