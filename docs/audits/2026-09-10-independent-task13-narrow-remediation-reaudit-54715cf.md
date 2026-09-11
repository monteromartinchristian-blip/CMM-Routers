# Independent Task 13 Narrow-Remediation Re-audit — 54715cf

Date: 2026-09-10
Repository: `CMM-Subscription-Router`
Branch: `main`
Audited HEAD: `54715cf039c6d419ec54f81cd3a3873ee813c81c`
Baseline before remediation: `cac3c0096cc4d700b7dcc2c35c7f21fd27f3f53d`
Exact-head bundle SHA-256: `9191bb69b8436758a63c95d305b8de4d364cef16d0d662744b73f9e48f99a7c2`

## Independent verdict

**PASS**

The narrow remediation for the four findings carried by the previous independent Task 13 canary-registration re-audit is accepted.

- BLOCKERS: 0
- MAJORS: 0
- MINORS: 0
- NOTES: 1 non-blocking live-only follow-up

No live provider inference was run during this re-audit. No provider subscription quota was intentionally spent. No push or merge was performed.

## Scope and method

This re-audit evaluated the exact archived state at `54715cf039c6d419ec54f81cd3a3873ee813c81c`, not merely the remediation narrative.

The audit combined:

1. exact-head archive identity and integrity verification;
2. adversarial inspection of the Task 13 canary driver and policy propagation;
3. focused review of the four previously open findings F1–F4;
4. deterministic negative controls for canary causality and terminal-response handling;
5. focused Command Code wire-policy verification;
6. full local regression, typecheck, build, post-build regression, and security gate.

The submitted local gate revalidated the same exact HEAD and the same bundle SHA.

## Artifact integrity

Verified:

- `EXPECTED_HEAD == ACTUAL_HEAD`
- branch is `main`
- bundle SHA-256 matches the expected SHA-256
- gzip integrity passes
- git archive commit id is exactly the audited HEAD
- tracked worktree remained clean
- index remained clean
- no push occurred
- no live provider inference occurred

Result: **PASS**

## F1 — Command Code continuation policy

Previous issue: Command Code was forcing a tool on the continuation request, which made a truly terminal second response impossible under the intended canary contract.

Verified remediation:

- first request uses `tool_choice: "required"`;
- continuation request uses `tool_choice: "none"`;
- Command Code OpenAI wire preserves the declared tool-choice policy;
- shared wire normalization keeps chat-completions and responses policy semantics aligned;
- the deterministic fake Router follows the request policy rather than returning the desired shape unconditionally;
- an extra tool call on the second response is rejected.

Fresh deterministic evidence:

- `COMMAND_CODE_CANARY_REQUEST1_POLICY=REQUIRED`
- `COMMAND_CODE_CANARY_REQUEST2_POLICY=NONE`
- `COMMAND_CODE_OPENAI_TOOL_CHOICE_HTTP_BODY=PASS`
- `CHAT_RESPONSES_WIRE_NORMALIZATION=IDENTICAL`
- `SILENT_TOOL_CHOICE_DROP=NONE`

**F1_COMMAND_CODE_CONTINUATION_POLICY=PASS**

## F2 — Causal result proof

Previous issue: the canary could be satisfied by fabricating an answer from prompt-visible sentinel material, so the result did not prove that the provider had actually consumed the Qoder-produced tool result.

Verified remediation:

- the initial tool-call sentinel and post-tool result nonce are separate values;
- the result nonce is created only after a valid tool call has been accepted;
- the final continuation proof depends on the result-only nonce;
- the first tool-call argument still proves the expected call sentinel was used;
- an adversarial continuation that ignores the tool result and fabricates from prompt-visible sentinel data is rejected.

Fresh deterministic evidence:

- `LIVE_CANARY_FINAL_CAUSALITY_PROOF=PASS`
- full Qoder tool round-trip deterministic canary passes
- model fallback remains `NONE`

**F2_CAUSAL_RESULT_PROOF=PASS**

## F3 — Terminal second-response validation

Previous issue: the continuation response was not sufficiently constrained to prove it was terminal.

Verified remediation:

- residual `tool_calls` on response 2 are rejected;
- a terminal finish state is required;
- the normal deterministic continuation passes;
- malformed or non-terminal continuation forms are covered by negative controls;
- validation occurs in the real canary driver path.

Fresh deterministic evidence:

- `LIVE_CANARY_SECOND_RESPONSE_REJECTS_EXTRA_TOOL_CALLS=YES`
- targeted canary suite passes 24/24

**F3_TERMINAL_SECOND_RESPONSE=PASS**

## F4 — PAYG proof semantics

Previous issue: a client-local PAYG poison marker overstated what had actually been proven about remote Router PAYG behavior.

Verified remediation:

- marker semantics are scoped to the client-local poison mechanism;
- the client-side guard no longer claims remote Router PAYG proof;
- Router PAYG protections remain separately covered by the repository security/preflight gates;
- no API PAYG fallback path was introduced.

Fresh deterministic evidence includes:

- `PAYG_GUARD=PASS`
- fail-closed unsafe PAYG preflight tests pass
- Command Code on-demand fallback remains absent
- no cross-provider or unknown-model fallback was introduced

**F4_PAYG_MARKER_SEMANTICS=PASS**

## Focused deterministic gates

### Canary tests

`tests/live-canary/canary-driver.test.ts`

Result:

- test files: 1 passed
- tests: 24 passed
- failures: 0

**CANARY_TESTS=PASS**

### Command Code / wire-policy tests

Focused tests:

- `tests/providers/command-code-openai-body.test.ts`
- `tests/http/tool-choice-wire-normalization.test.ts`
- `tests/providers/tool-policy-matrix.test.ts`

Result:

- test files: 3 passed
- tests: 19 passed
- failures: 0

**WIRE_POLICY_TESTS=PASS**

## Full regression gate

Fresh full-suite result:

- test files: 124 passed, 5 skipped, 129 total
- tests: 659 passed, 25 skipped, 684 total
- exit code: 0

The apparent `error:` lines emitted by specific launchd/preflight tests are expected fail-closed fixtures and are followed by passing assertions. They are not suite failures.

**FULL_TEST_SUITE=PASS**

## Typecheck

Command:

`npm run typecheck`

Result:

- `tsc -p tsconfig.json --noEmit`
- exit code: 0

**TYPECHECK=PASS**

## Build

Command:

`npm run build`

Result:

- `tsc -p tsconfig.build.json`
- exit code: 0

**BUILD=PASS**

## Post-build regression

Fresh post-build full-suite result:

- test files: 124 passed, 5 skipped
- tests: 659 passed, 25 skipped
- exit code: 0

**POST_BUILD_TEST=PASS**

## Security gate and closed architecture

Fresh security gate: **PASS**.

Revalidated protections include:

- no tracked secret values;
- loopback-only Router exposure;
- no unsafe runtime flags;
- PAYG guard present;
- no completion-content logging;
- no tool-argument or tool-result logging;
- bounded provider and bridge pending state;
- declared-tool ACL enforcement;
- no silent tool-policy drop;
- provider abort cleanup;
- no production test-only direct bridge hook;
- Claude SDK remains owner of its provider-facing MCP process;
- no duplicate Claude MCP bridge process;
- no API PAYG fallback;
- no cross-provider fallback;
- no unknown-model fallback;
- no Command Code on-demand or auto-top-up fallback.

Task 13 ownership boundaries remain intact:

- CMMChat remains `CHAT_ONLY`;
- Qoder is the consumer permitted `CHAT_AND_TOOLS` where the model/provider capability supports it;
- provider owns reasoning;
- Qoder owns external tool execution;
- provider-native repository mutation remains absent.

**CLOSED_ARCHITECTURE_REGRESSION=PASS**

## Non-blocking note

The live subscription/provider round-trip is intentionally not re-proven by this deterministic re-audit.

That is not a remediation failure: the audit explicitly prohibited live subscription inference. It remains a separate live acceptance step requiring explicit authorization.

The earlier recommendation to add finite client HTTP timeouts around live-canary health/model/inference calls also remains non-blocking for this narrow remediation acceptance unless later live testing demonstrates a practical hang.

## Final decision

All four remediated findings are independently accepted. Deterministic regression and security gates pass on the exact audited HEAD. No closed Task 13 invariant was found to have regressed.

The implementation is eligible to proceed to the separate live-subscription canary stage after this independent report is preserved in repository history.

```text
INDEPENDENT_TASK13_NARROW_REMEDIATION_REAUDIT=PASS
AUDITED_HEAD=54715cf039c6d419ec54f81cd3a3873ee813c81c
BUNDLE_SHA256=9191bb69b8436758a63c95d305b8de4d364cef16d0d662744b73f9e48f99a7c2
GIT_ARCHIVE_COMMIT_ID=54715cf039c6d419ec54f81cd3a3873ee813c81c
BLOCKERS=0
MAJORS=0
MINORS=0
F1_COMMAND_CODE_CONTINUATION_POLICY=PASS
F2_CAUSAL_RESULT_PROOF=PASS
F3_TERMINAL_SECOND_RESPONSE=PASS
F4_PAYG_MARKER_SEMANTICS=PASS
TARGETED_TESTS=PASS
FULL_TEST_SUITE=PASS
TYPECHECK=PASS
BUILD=PASS
POST_BUILD_TEST=PASS
SECURITY_GATE=PASS
CLOSED_ARCHITECTURE_REGRESSION=PASS
LIVE_PROVIDER_INFERENCE_RUN=NO
CLOSURE_ELIGIBLE=YES
NEXT=COMMIT_INDEPENDENT_TASK13_NARROW_REMEDIATION_REAUDIT
```
