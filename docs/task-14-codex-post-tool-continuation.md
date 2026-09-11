# Task 14 — Codex Post-Tool Continuation Compatibility

## Status

OPEN

## Goal

Make ChatGPT/Codex complete a real Qoder-owned external tool round-trip with a visible post-tool final assistant answer through a supported Codex path, without weakening any Router security or subscription-only guarantees.

## Starting point

Base commit:

`6b772f039197b030f90c906ec75b1f31cbef2207`

Known live behavior on `codex app-server 0.153.4`:

1. real provider tool request succeeds;
2. Qoder-owned result is correlated successfully;
3. continuation remains on the same provider, same thread and same turn;
4. Codex reports output/reasoning tokens;
5. final `agentMessage` is empty;
6. the same empty post-tool final answer is reproducible directly against `codex app-server`, with no CMM Router in the loop.

Therefore the Router is not currently proven defective.

## Investigation order

1. Check newer supported Codex CLI/app-server versions.
2. Compare authoritative generated app-server schemas/protocol options.
3. Test candidate protocol/configuration changes directly against `codex app-server` before changing Router code.
4. Vary one causal variable at a time.
5. Only adapt the Router if a direct upstream experiment proves a supported path that returns visible final text.
6. Use TDD for every Router change.
7. Re-run only the ChatGPT/Codex live canary after a genuinely promising fix.

## Hard constraints

Do not replace true external-tool continuation with fake assistant/tool history merely to make the canary green.

Preserve:

- same-provider continuation;
- Qoder execution ownership;
- no provider-native repo mutation;
- no PAYG;
- no cross-provider fallback;
- no unknown-model fallback;
- request isolation;
- correlation integrity;
- no secret logging;
- no push unless separately authorized.

## Success criteria

Task 14 is complete when one of the following is rigorously proven:

### Preferred

ChatGPT/Codex live canary PASS:

- tool call received;
- Qoder executes;
- result-only nonce correlated;
- same-provider continuation;
- visible non-empty final answer causally derived from the tool result;
- no fallback / PAYG / fake-history workaround.

### Upstream-limitation closure

If exhaustive direct app-server testing establishes that no currently supported Codex version/protocol mode can emit the post-tool visible final answer, close Task 14 with a reproducible upstream limitation report and exact affected versions/protocol evidence.
