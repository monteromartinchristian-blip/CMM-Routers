# CMM Code Router — Phase 7 Evidence (Real-Client Gates)

**Date:** 2026-09-22
**Nature:** Truthful real-client evidence and classification. Historical audits
are not rewritten. No secret value appears in this document.

## Method

Read-only investigation of the installed clients, plus real client invocations
**against local deterministic providers**. All model traffic in this phase went
to a locally started CMM Code Router running the test-only `scripted-tools`
double, so no subscription quota was consumed, no external provider was called,
and no PAYG path exists.

## 7A — Qoder: `BLOCKED_MANUAL_UI`

Verified locally:

- `$HOME/.qoder/settings.json` contains five user-added custom providers; the
  documented `qoder-custom-cmm-router` provider **does not exist**, and no
  provider `baseUrl` points at `http://127.0.0.1:8790/v1`.
- The installed `qodercli` exposes only `login` and `mcp` as subcommands, so
  there is **no CLI path** to register a custom provider — it requires the Qoder
  UI (or a direct settings edit plus a full quit/relaunch).
- No CMM backup directory and no `*.bak` exist, so the reconciler scripts would
  abort with `PROVIDER_NOT_FOUND` against the current settings.

Consequence: the Qoder real gate cannot be completed without a human UI action.
The Router-side contract is proven deterministically (legacy and canonical
bearer). No Qoder settings file was modified and no unmanaged model was touched.

## 7B — Hermes: `MANUAL_PENDING`

Verified locally from the installed client (v0.21.3) and its Python source:

- Custom OpenAI-compatible providers are a first-class `providers:` map with
  `base_url`, `api_mode` (`chat_completions`), `key_env` (an env var **name**)
  and `discover_models`.
- Wire is Chat Completions with the standard OpenAI `tools` shape; streaming is
  on by default; discovery is `GET {base_url}/models`.

Not performed: the live client turn. No config-path override (`HERMES_HOME` /
equivalent) could be verified, and the alternative was editing the user's live
19 KB agent configuration unsupervised. That edit is not worth the risk for a
gate that the Router-side contract already covers deterministically, so it is
left as a precise manual step:

```yaml
providers:
  cmm-router:
    name: CMM Code Router
    base_url: http://<router-host>:8790/v1
    api_mode: chat_completions
    key_env: HERMES_CUSTOM_CMM_ROUTER_API_KEY
    discover_models: true
```

then `hermes --provider cmm-router -m <model-id> -z "<prompt>"` (additive; no
existing provider or default is modified).

## 7C — Codex CLI: `BLOCKED_CLIENT_LIMITATION`

This is the significant real-client finding of the run.

A real `codex exec` (0.147.0) was pointed at the locally running CMM Code Router
with a custom `model_providers` entry (`wire_api = "responses"`), using only `-c`
overrides — no user config file was edited.

Observed:

1. Codex **does** call `GET /v1/models` on the custom provider and expects a
   `models` field, not the OpenAI `data` array; it logged a decode error and
   continued with fallback metadata.
2. Its Responses request was rejected by the Router with
   `400 tools must be an array`.

Root cause, captured with a local probe from the **actual** Codex request:

- The request is well-formed (`POST /v1/responses`, `stream: true`,
  `tool_choice: "auto"`, `parallel_tool_calls: false`, `store`, `include`,
  `reasoning`, `prompt_cache_key`, `client_metadata`, `instructions`).
- `input` contains `role: "developer"` items.
- `tools` is a **list of 31 entries** in three shapes: 19 `type:"function"`,
  **18 `type:"namespace"`** (grouped tools with a nested `tools` array), and
  1 `type:"web_search"` (a provider-hosted tool).

The Router's Responses parser accepted only client-owned `function` tools and
collapsed every other failure into a misleading `tools must be an array`.

Router-side change made (committed `ae0ab9e`):

- `role: "developer"` is normalized to the internal `system` role (a genuine
  wire difference; it carries instructions and no tools).
- Any other tool declaration is now refused **precisely by type**
  (`unsupported_capability: cannot faithfully represent a tool of type
  'namespace'`), still failing closed without invoking the provider. Silently
  dropping part of what the caller declared is explicitly not acceptable.

Remaining blocker: 18 of Codex's 31 declared tools are namespaces and one is a
provider-hosted web search. Representing them would require either flattening
namespace groups into distinct function names (a design decision with naming and
collision consequences) or accepting-and-dropping (forbidden by the project's
no-silent-drop rule). This is therefore a **client limitation of the Router**,
not a configuration problem, and it is recorded rather than hacked around.

## 7D — Pre-stable provider items: `BLOCKED_*`

| Item | Classification | Reason |
|---|---|---|
| Google/GPT-OSS tool compatibility | `BLOCKED_QUOTA` / not attempted | Requires a live Antigravity/Google turn; `agy` is not resolvable on this machine and no quota authorization was exercised |
| Sonnet real tool behaviour | `BLOCKED_QUOTA` | Requires a live Claude turn |
| ChatGPT/Codex revalidation | `BLOCKED_QUOTA` | Requires subscription quota |
| Command Code live completion | `BLOCKED_DISABLED` | Provider is disabled by default and needs an explicit human spend decision |

No billing policy was changed and no provider account was enabled to obtain a
pass.

## 7E — Task 16B / multi-Mac: `BLOCKED`

Task 16B depends on a capability manifest derived from the richer
`x_cmm`/`runtimeCapabilities` schema, which is **not implemented**. Closing that
would mean implementing Task 16 and the Dynamic Provider Catalog work, which is
explicitly out of scope for this run. Recorded, not smuggled in.

## Live requests actually performed

| Client | Invocation | Destination | Quota consumed |
|---|---|---|---|
| Codex CLI 0.147.0 | `codex exec ... "Reply with the single word: ping"` | Local CMM Router (18892) running `scripted-tools` | None |
| Codex CLI 0.147.0 | `codex exec ...` | Local capture probe (18893), no model backend | None |
| Codex CLI 0.147.0 | `codex exec --help` | n/a | None |

No Hermes and no Qoder model turn was executed. No external provider was
contacted for inference. No PAYG was used. No secret value was printed; the
captured request headers were redacted before inspection.

## Cleanup

The template Router, the capture probe and the live-gate Router were all stopped;
ports 18892 and 18893 are free. The pre-existing Router process on port 8790 that
belonged to the user was left untouched.

---

## Addendum — corrective note on the Codex tool counts (added 2026-09-22)

The direct harness-agnostic audit flagged that the tool arithmetic in section 7C
did not reconcile: it reported 31 entries but "19 function + 18 namespace +
1 web_search", which sums to 38 rather than 31.

The raw redacted structural capture was re-read and recounted. The correct,
verified breakdown is:

```json
{"total": 31, "by_type": {"function": 12, "namespace": 18, "web_search": 1}}
```

12 + 18 + 1 = 31. The earlier "19 function" figure was wrong; the total of 31 and
the namespace count of 18 were correct.

Only one architectural conclusion is carried forward from that capture, and it is
the one the code changes address: **non-function tool declaration classes were
observed on the wire**. The exact counts are evidence of proportion, not of
compatibility, and no Router behavior depends on them.

This note corrects the record; the original text of section 7C is left intact.
