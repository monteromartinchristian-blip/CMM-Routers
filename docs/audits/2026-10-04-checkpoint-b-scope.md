# Checkpoint B scope (locked)

Status at the time of writing:

```
LIVE_ARTIFACT_REPRODUCED=YES
HISTORICAL_SOURCE_PROVEN=NO
LIVE_BEHAVIOR_CHECKPOINT_COMMIT=ABSENT
LIVE_BASE_REPRODUCED=PENDING_A_COMMIT
```

## Why B exists

Checkpoint A is a Git state proven to emit the live `dist` byte for byte. It is
not a statement of intended behaviour: reproducing the artifact required carrying
forward one change that was never intended to survive, described under item 3
below. B carries the post-live work that A deliberately excludes.

## Production changes — exactly three

### 1. `src/http/server.ts` — observation-based `/ready`

The live artifact answers `/ready` from a live `getProviderHealth()` probe. The
post-live code answers it from cached discovery observations instead.

**This change is known to be unsafe as a traffic gate and must not be deployed.**
Discovery freshness is not request-serving readiness, and the audit is recorded
in the mission log. `/ready` can report `ready` for roughly a TTL window
(30s plus discovery latency) after credentials or a provider runtime have become
invalid, during which every request fails. The redesign that fixes this — a
separate serving-health observation — is C2 and is explicitly not part of B.

### 2. `src/providers/claude/adapter.ts` — display-name guard

```ts
const concreteDisplayName = /^claude-/.test(baseModel) ? claudeConcreteDisplayName(baseModel) : undefined;
```

The live artifact calls `claudeConcreteDisplayName` unguarded. Pinned by
`claude-model-discovery.test.ts` on the assertion
`preserves display labels from SDK`, which expects `Claude Sonnet 5` and
receives `Sonnet` on A.

### 3. `src/providers/claude/adapter.ts` — restore `if (!isAlias) continue;`

```ts
if (!isAlias) continue;
```

This line is **committed** at `31e48d7` and present in `ff88129`. The live
artifact does not contain it, so A reverts it — A carries a deliberate
regression of committed behaviour purely to reproduce the artifact.

B must restore it. Omitting it here would let the branch silently drop a
committed line forever, with no failing test to notice. `claude-model-discovery`
catches this too (`deduplicates by upstream model value`: expected 2, received 4
on A), but the restoration is a required production change in its own right, not
merely a test-satisfying one.

## Tests — exactly three

| test | on A | on B |
|---|---|---|
| `tests/http/readiness-observation.test.ts` | 9 failures | pass |
| `tests/providers/claude-model-discovery.test.ts` | 3 failures | pass |
| `tests/providers/claude-observation-cleanup.test.ts` | 1 failure | pass |

Each was run in an isolated vitest process against a constructed A state and a
constructed B state. Those two states differ in exactly two files —
`src/http/server.ts` and `src/providers/claude/adapter.ts` — which is what makes
a pass/fail difference attributable.

## Explicitly not in B

- `tests/providers/antigravity-discovery-nonblocking.test.ts` — formally
  unassigned, pending the clean checkpoint-A acceptance run
- `RealAgyRunner` / `AgyRunResult` diagnostic enrichment — a separate scoped
  commit after A is accepted, for example
  `test/diag(antigravity): preserve spawn error details`
- C1 — adapter `AbortSignal` compliance in `health()`
- C2 — serving-health readiness redesign
- Claude default propagation
- SDK / runtime migration (0.3.288 / 2.1.288)

## Constraints

- A must never be rewritten to make B easier. If B conflicts with A, B adapts.
- Neither A nor B may be deployed. B lands readiness code that is known to be
  unsafe as a traffic gate (item 1); deploying B would ship that regression
  under cover of it being "newer work".
- Order: A, then B, then C1, then C2.