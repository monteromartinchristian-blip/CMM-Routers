# Task 15 — Command Code Live Enablement and Subscription-Safe Canary

## Status

OPEN / DEFERRED UNTIL ENABLEMENT IS DESIRED

## Why this is separate

Command Code does not currently have the same defect as Codex.

Its Router implementation and tool semantics are covered deterministically, but the provider is intentionally disabled in the active runtime.

Task 15 owns future re-enablement and live proof without reopening Task 13.

## Starting state

At Task 13 closure:

- `COMMAND_CODE_ENABLED=false`
- secret absent from active runtime
- provider state: `SKIPPED_DISABLED`
- deterministic OpenAI-wire and Anthropic-wire tool loops: PASS
- declared-tool ACL: PASS
- native body cancellation: PASS
- spend guard: fail-closed
- auto top-up: disabled
- on-demand fallback: none
- no live Command Code canary executed in the closure state

## Goal

Enable Command Code only when subscription/quota/budget conditions make it desirable, and prove a real Qoder-owned live tool round-trip without opening any on-demand/PAYG path.

## Preconditions before enabling

1. User explicitly decides to enable Command Code.
2. Subscription/quota status is checked.
3. Required secret/token exists only in the approved local secret store.
4. Human spend acknowledgement is explicit.
5. `AUTO_TOP_UP_DISABLED=YES`.
6. `ON_DEMAND_FALLBACK=NONE`.
7. No PAYG fallback environment is present.
8. Router remains loopback-only.
9. Qoder remains execution owner.

## Required live canary

Prove:

provider reasoning
→ declared tool request
→ Qoder-owned execution
→ unpredictable result-only nonce
→ correlated tool result
→ provider continuation
→ final answer derived from nonce.

Run the appropriate wire(s) actually used by the enabled Command Code model.

## Hard constraints

- no automatic enabling;
- no auto top-up;
- no on-demand credit fallback;
- no secret in tracked files;
- no cross-provider fallback;
- no unknown-model fallback;
- no provider-native repo mutation;
- no push unless separately authorized.

## Closure

Task 15 can remain deferred indefinitely without affecting Task 13 closure.
