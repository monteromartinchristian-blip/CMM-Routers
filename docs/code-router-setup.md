# CMM Code Router — Generic Client Setup

CMM Code Router is the `CHAT_AND_TOOLS` profile of CMM Routers. It is
**client-agnostic**: any harness that speaks the OpenAI-compatible HTTP contract
can consume it. Qoder, Hermes, Codex and generic OpenAI-compatible clients are
compatibility targets — none of them is the identity of the profile, and none of
them is required to obtain tools.

The provider/model reasons and emits structured tool intent. The Router relays
that intent. **The client/harness owns and executes the tool.** The result
returns through the Router to the same provider/model turn.

The Router never executes a provider-native tool, and it never mutates a
filesystem, shell or repository on the model's behalf.

## Endpoint

```text
Base URL: http://127.0.0.1:8790/v1
Authorization: Bearer <Code Router bearer>
```

The Router binds loopback only.

## Authentication

| Credential | Profile | Notes |
|---|---|---|
| `CMM_CODE_ROUTER_TOKEN` | Code Router (`CHAT_AND_TOOLS`) | Canonical. Use this for new installs and clients. |
| `CMM_QODER_TOKEN` | Code Router (`CHAT_AND_TOOLS`) | Legacy compatibility alias for the SAME profile. Retained so existing installations keep working. |
| `CMM_ROUTER_TOKEN` (CMMChat) | CMMChat (`CHAT_ONLY`) | Never grants tools. No request metadata can elevate it. |

If neither Code Router credential is configured, there is no Code Router
profile: every authenticated request is CMMChat and stays `CHAT_ONLY`.

Configuration collisions fail closed at startup: if the CMMChat bearer equals
either Code Router bearer, the Router refuses to start rather than silently
resolving an ambiguous profile.

## Model discovery

```bash
curl -s -H "Authorization: Bearer $CMM_CODE_ROUTER_TOKEN" \
  http://127.0.0.1:8790/v1/models
```

The standard OpenAI model shape is preserved. When the Router knows a model's
Code Router capability it also publishes it in a namespaced extension:

```json
{
  "id": "command-code/some-model",
  "object": "model",
  "owned_by": "cmm:command-code",
  "x_cmm": { "code_router": "CHAT_AND_TOOLS" }
}
```

- `x_cmm.code_router` is `"CHAT_AND_TOOLS"` or `"CHAT_ONLY"`.
- The field is **absent** when the capability has not been verified — a
  discovered model is not automatically tool-capable.
- Clients that ignore unknown fields remain compatible.
- Publication is a statement about the model, never an authorization grant:
  requesting tools on a `CHAT_ONLY` model fails closed even though the
  capability was published.

Select the exact model id returned by `/v1/models`. There is no model or
provider substitution: an unknown model is rejected, and a request is never
served by a different provider.

## Tool round trip (Chat Completions)

1. Declare function tools in the request (`tools`), optionally constraining
   selection with `tool_choice` (`"auto"`, `"none"`, `"required"`, or
   `{"type":"function","function":{"name":...}}`) and `parallel_tool_calls`.
   A constraint the selected provider cannot represent is rejected with
   `400 unsupported_capability` rather than silently dropped.
2. The response carries the provider's structured call:

   ```json
   {
     "choices": [{
       "finish_reason": "tool_calls",
       "message": {
         "role": "assistant",
         "content": null,
         "tool_calls": [{
           "id": "cmm_claude_…",
           "type": "function",
           "function": { "name": "cmm_echo", "arguments": "{\"text\":\"hi\"}" }
         }]
       }
     }]
   }
   ```

3. **Execute the tool in your harness.** The Router does not execute it.
4. Submit the result in a follow-up request containing the assistant
   `tool_calls` history and a `role: "tool"` message that echoes the call id:

   ```json
   {
     "model": "command-code/some-model",
     "messages": [
       { "role": "user", "content": "…" },
       { "role": "assistant", "content": null, "tool_calls": [ … ] },
       { "role": "tool", "tool_call_id": "cmm_claude_…", "content": "…" }
     ],
     "tools": [ … ]
   }
   ```

5. The same provider/model continues to a terminal answer. Tool-call ids,
   names and arguments round-trip byte-exact; no Router-private field has to be
   echoed.

Multi-step loops are supported: repeat steps 2–4 for as many sequential tool
rounds as the harness needs, re-sending the accumulated history each time.

Tool results are bounded (1 MiB per result). An oversized result is rejected
before it reaches the provider.

For Codex-, Claude- and Antigravity-backed models the provider turn stays parked
while the client executes the tool, so a continuation must return to the **same
live Router process**.

## Responses API

`POST /v1/responses` exposes the same semantics with the Responses wire shape:

- declare tools as `{"type":"function","name":…,"parameters":…}`;
- the emitted call is an `output` item of `type: "function_call"` with both an
  item `id` (`fc_…`) and the continuation `call_id`;
- submit the result as a `function_call_output` item carrying that `call_id`.

## Streaming

Both surfaces stream Server-Sent Events.

- Chat Completions emits `chat.completion.chunk` frames, including structured
  `tool_calls` deltas (index, id, name, argument fragments), then a terminal
  `finish_reason`, then `data: [DONE]`.
- Responses emits the canonical item lifecycle
  (`response.output_item.added` → `response.function_call_arguments.delta` →
  `response.function_call_arguments.done` → `response.output_item.done` →
  `response.completed`).

Tool calls are never flattened into assistant text, so no client-specific
parsing is required.

## Cancellation

Destroying the request (client abort, socket close) aborts the provider run and
cleans pending Router state. A tool result that arrives after cancellation or
after a parked session has been released fails closed — it cannot resume a
cancelled request, and it never resolves another request's pending call.

## Fail-closed guarantees

```text
NO_UNKNOWN_MODEL_FALLBACK=YES
NO_CROSS_PROVIDER_FALLBACK=YES
NO_PAYG_FALLBACK=YES
CMMCHAT_CHAT_ONLY=PASS
```

A request is served by the exact model it named. There is no lower-cost fallback
route, no cross-provider substitution, and no unknown-model substitution.

## Optional client identifier

A client may send `X-CMM-Client: <id>` for diagnostics. It is normalized onto a
bounded set (`cmmchat`, `qoder`, `hermes`, `codex-client`, `generic-openai`;
anything unrecognized becomes `other`). Absence means `generic-openai`.

This header is metadata only. It cannot grant tools, elevate the CMMChat
profile, select a provider or model, or weaken any fallback guard.

## Compatibility status

The deterministic Router-side contract above is proven by the test suite. Real
client verification (model discovery, tool schema, continuation and streaming
behaviour of an actual installed Hermes or Codex client) requires those clients
and is tracked separately — do not treat this document as a claim that a
specific real client has been verified.
