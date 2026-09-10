# Task 13 — Canary & Antigravity Registration Correctness (Delta Design)

**Date:** 2026-09-10
**Input:** `docs/audits/2026-09-10-independent-task13-final-protocol-edge-reaudit-814a699.md` (verdict FAIL)
**START_HEAD:** `6341e0fc6f36d2933429d524f60d601f5c1deb7a`
**Scope:** narrow corrective pass on the acceptance boundary. The multi-step
provider architecture, DeferredToolBroker and provider-facing MCP topology are
closed and are not reopened.

## 0. Goal and non-goals

Eliminate every defect the newest independent audit identified, and leave live
canaries genuinely capable of proving the real Qoder subscription-backed tool
round-trip. No live provider inference runs in this pass.

Non-goals: redesigning the provider loops, the broker, or the MCP topology;
running any provider model turn; pushing/merging.

## 1. D1 — Antigravity registration truth (audit F6/F7)

**Problem.** `agy mcp list` never prints env, so `isCanonical()` cannot prove the
persisted entry is secret-free. A persisted entry with a hidden `OLD_SESSION_SECRET`
that is otherwise visible-canonical returns `noop`, so the stale secret survives.

**Design.** Canonical **rewrite by construction**, once per Router process:

```
list -> inspect managed registration
     -> (per-process first time only, or any visible mismatch)
        re-issue `agy mcp add` WITHOUT --env
     -> list again -> verify visible canonical state
```

- A module-scoped process marker keyed by `serverName + command + args` records a
  **successful** canonicalization. Later calls in the same process may `noop` only
  when the visible state is canonical; any visible mismatch always repairs.
  Every new Router process canonicalizes at least once (the marker is empty).
- `isCanonical()` additionally requires `entry.type === "stdio"` (audit F7).
- Only the managed name is ever mutated; unrelated registrations are untouched.
- A new action value `canonicalized` distinguishes the process-first rewrite from
  `repaired`/`added`/`reconciled`/`noop`.

## 2. D2 — Bound `agy mcp` CLI operations (audit F10)

`execFileAgyRunner` uses `execFileSync` with no timeout/maxBuffer. Wrap every
CMM-owned `agy mcp list|add|remove` call with a finite `timeout` and `maxBuffer`,
never a shell, overridable only from code (tests). Timeout, maxBuffer overflow,
unexpected signal and nonzero exit all map to a fail-closed `provider_unavailable`
provider/setup error; the diagnostic is bounded and never exposes secrets.

```text
AGY_MCP_CLI_TIMEOUT_MS        = 10_000
AGY_MCP_CLI_MAX_BUFFER_BYTES  = 1 MiB
AGY_MCP_CLI_DIAGNOSTIC_CHARS  = 200
```

## 3. D3 — UTF-8 byte-true agy limits (audit F8)

`MAX_AGY_STDOUT_DIAGNOSTIC_BYTES`, `MAX_AGY_STDERR_DIAGNOSTIC_BYTES` and
`MAX_AGY_NDJSON_LINE_BYTES` are named BYTES but implemented with JS `.length`
(UTF-16 code units). Switch to `Buffer.byteLength(text, "utf8")` and byte-aware
truncation that never splits a UTF-8 sequence into invalid text. The diagnostic
cap keeps a bounded byte head + bounded byte tail. Multibyte adversarial tests.

## 4. D4 — Atomic session descriptor publication (audit F9)

`BridgeSessionRegistry.register` writes `agy-<pid>.json` in place. Publish
atomically instead: create a unique temp file in the same directory with mode
0600, write the complete JSON, `rename` it over the final path. Clean up
abandoned temp files from crashed writers when safe; never overwrite a verified
live descriptor belonging to another run. A reader/reconciler running during
publication must never observe partial JSON.

## 5. D5 — Live canary authenticates as Qoder (audit F1)

The canaries currently use `CMM_ROUTER_TOKEN` (CMMChat, always CHAT_ONLY). Tool
acceptance must authenticate as Qoder: read the provisioned Qoder bearer from
`CMM_QODER_TOKEN`, or retrieve it securely from the same local Keychain contract
production provisioning uses (`CMM_QODER_KEYCHAIN_SERVICE` /
`CMM_QODER_KEYCHAIN_ACCOUNT`). Never fall back to `CMM_ROUTER_TOKEN`; never print
the token. Preflight must resolve consumer=QODER and capability=CHAT_AND_TOOLS,
otherwise exit 2.

## 6. D6 — Provider-specific canary tool policy (audit F2)

The common payload sends `tool_choice:auto` + `parallel_tool_calls:false`, which
production policy rejects for Claude/Google and cannot represent for Codex.
Generate a per-provider policy body:

| Provider | tool_choice | parallel_tool_calls |
| --- | --- | --- |
| claude | absent | **absent** |
| google | absent | **absent** |
| chatgpt (Codex) | absent/default only | **absent** |
| command-code | `required` | absent (OpenAI semantics) |

The canary proves its body passes Router policy deterministically before any
provider turn.

## 7. D7 — Live canary proves the real round-trip (audit F3)

Replace the single-request canary with the full deterministic chain:

```
request 1 (declare canary_echo, force/strongly-require one call)
  -> REQUIRE exactly one canary_echo call (unknown/missing/extra = FAIL)
  -> parse+validate args against the declared schema
  -> synthesise RESULT=<derived sentinel> in memory only
request 2 (full history + role:tool result, exact tool_call_id)
  -> same provider logical run resumes
  -> final response text must contain the derived sentinel
```

`canary_echo` does no shell, no filesystem write, no repo mutation, no network.

## 8. D8 — Machine-truthful exit codes (audit F4)

```text
0 = PASS
1 = FAIL
2 = BLOCKED / prerequisite unavailable
```

`canary_blocked()` exits 2. Missing bearer, Router down, wrong consumer, missing
or ambiguous route, auth rejected, quota unavailable, no/wrong/multiple tool
call, malformed args, rejected tool result, provider non-continuation, and a
final unrelated to the result are all nonzero.

## 9. D9 — Exact model selection (audit F5)

Support `CMM_LIVE_CANARY_MODEL=<exact router model id>`. Preflight `GET /v1/models`
and require the exact model exists, its provider prefix matches the wrapper, and
`owned_by === cmm:<provider>`. Wrappers supply a documented preferred default.
Never silently choose another provider/model: absent explicit model and absent
deterministic default => BLOCKED (exit 2).

## 10. D10 — Spend / safety gate (audit P0 #11)

Keep live inference disabled. Require
`CMM_LIVE_CANARY_CONFIRM=yes-i-accept-subscription-quota-spend`. Poison PAYG
credentials, verify loopback URL, exact Qoder consumer, exact model,
subscription-backed route, no cross-provider fallback, no Command Code on-demand.
Minimum practical request count (exactly two).

## 11. D11 — Capture byte-identity (audit §0 / P1 #13)

Create a capture helper that builds the final Git archive, closes the log,
hashes the FINAL archive and FINAL log, and stores both hashes in a SEPARATE
manifest. Never append a hash to the file being hashed.

```
<bundle>.tar.gz
<verification>.txt
<manifest>.sha256   # shasum -a 256 -c manifest must PASS
```

## 12. Required markers

```text
ANTIGRAVITY_MCP_HIDDEN_ENV_RECONCILIATION=PASS
ANTIGRAVITY_MCP_REGISTRATION_SECRET_FREE_BY_CONSTRUCTION=PASS
ANTIGRAVITY_MCP_NEW_PROCESS_CANONICALIZATION=PASS
ANTIGRAVITY_MCP_CANONICAL_TYPE_STDIO_REQUIRED=PASS
ANTIGRAVITY_MCP_CLI_TIMEOUT_BOUND=PASS
ANTIGRAVITY_MCP_CLI_MAXBUFFER_BOUND=PASS
ANTIGRAVITY_MCP_CLI_FAILURE_FAIL_CLOSED=PASS
ANTIGRAVITY_MCP_CLI_NO_SHELL=PASS

AGY_STDOUT_UTF8_BYTE_BOUND=PASS
AGY_STDERR_UTF8_BYTE_BOUND=PASS
AGY_NDJSON_UTF8_BYTE_BOUND=PASS
AGY_DIAGNOSTIC_MEMORY_REMAINS_BOUNDED=PASS

SESSION_DESCRIPTOR_ATOMIC_PUBLISH=PASS
SESSION_DESCRIPTOR_PARTIAL_JSON_VISIBLE=NO
SESSION_DESCRIPTOR_MODE_0600=PASS

LIVE_CANARY_AUTH_CONSUMER=QODER
LIVE_CANARY_CAPABILITY=CHAT_AND_TOOLS
LIVE_CANARY_CMMCHAT_BEARER_USED=NO
CLAUDE_CANARY_POLICY_ACCEPTED=PASS_DETERMINISTIC
GOOGLE_CANARY_POLICY_ACCEPTED=PASS_DETERMINISTIC
CODEX_CANARY_POLICY_ACCEPTED=PASS_DETERMINISTIC
COMMAND_CODE_CANARY_POLICY_ACCEPTED=PASS_DETERMINISTIC
LIVE_CANARY_TOOL_REQUEST_RECEIVED=YES
LIVE_CANARY_TOOL_NAME=canary_echo
LIVE_CANARY_QODER_SYNTHETIC_EXECUTION=YES
LIVE_CANARY_TOOL_RESULT_SUBMITTED=YES
LIVE_CANARY_SAME_PROVIDER_CONTINUATION=YES
LIVE_CANARY_FINAL_DERIVED_FROM_TOOL_RESULT=YES
LIVE_CANARY_FULL_ROUNDTRIP=PASS
LIVE_CANARY_PASS_EXIT=0
LIVE_CANARY_FAIL_EXIT_NONZERO=PASS
LIVE_CANARY_BLOCKED_EXIT_NONZERO=PASS
LIVE_CANARY_EXACT_MODEL_SELECTION=PASS
LIVE_CANARY_MODEL_FALLBACK=NONE
LIVE_CANARY_PAYG_POISON=PASS
LIVE_CANARY_NO_PROVIDER_NATIVE_TOOL=PASS
LIVE_CANARY_NO_REPO_MUTATION=PASS
LIVE_CANARY_HARNESS_DETERMINISTIC_TESTS=PASS
CAPTURE_BUNDLE_BYTE_IDENTITY=PASS
CAPTURE_LOG_BYTE_IDENTITY=PASS
CAPTURE_SHA256_MANIFEST_VERIFY=PASS
```

## 13. Invariants preserved

CMMCHAT_CHAT_ONLY, QODER_CHAT_AND_TOOLS, PROVIDER_OWNS_REASONING, QODER_OWNS_*,
PROVIDER_NATIVE_*=NO, API_PAYG/CROSS_PROVIDER/UNKNOWN_MODEL fallback=NONE,
COMMAND_CODE_ON_DEMAND/AUTO_TOP_UP=NO, OAUTH_EXTRACTION/COPY/SYNC=NO, no prompt/
completion/tool-arg/tool-result logging, LOOPBACK_ONLY, no tracked secrets.
