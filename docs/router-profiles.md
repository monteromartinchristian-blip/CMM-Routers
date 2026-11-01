# Router Profiles — CHAT and AGENT

CMM Routers has one engine and two capability policies.

```text
                    CMM Router
                       │
             ┌─────────┴─────────┐
             │                   │
            CHAT               AGENT
```

Both profiles share the same `ProviderRegistry`, HTTP/API surfaces, model
discovery, streaming, sessions, tool transport, tool correlation,
observability, security boundary and provider adapters. The only difference is
the tool policy applied before a tool enters the shared pipeline.

## Authorization pipeline

```text
request
   ↓
authenticate bearer → RouterProfile (server-side only)
   ↓
calculate effective tool grant
   ↓
shared tool transport / correlation engine
   ↓
provider
```

The profile is resolved by `resolveRouterPrincipal` from the `Authorization`
header and configured secrets. Request headers, body fields, model names, tool
names, client names and claimed capabilities are never consulted.

## Profile identity

| Profile | Bearer | Purpose |
|---|---|---|
| `CHAT` | `CMM_ROUTER_TOKEN` | CMMChat's normal conversational profile |
| `AGENT` | `CMM_CODE_ROUTER_TOKEN` (canonical) | harnesses and agents with general tool loops |
| `AGENT` | `CMM_QODER_TOKEN` (legacy Qoder alias) | already-installed Qoder consumers |

Both AGENT credentials resolve to the same profile. If the CHAT bearer is also
configured as an AGENT bearer, CHAT wins: the narrower grant is checked first
and a shared secret can never elevate a request.

`CMM Code Router` is the historical/compatibility name of the AGENT profile. It
is not a third profile and not a security primitive.

## Effective tool grant

For every request:

```text
effective = profile policy
          ∩ (CHAT: scoped-action registry ∩ server/session grants)
          ∩ provider/model structured-tool capability
          ∩ protocol representability
```

Implemented once in `src/core/tool-access-policy.ts` and called by both HTTP
surfaces. A tool list supplied by a client is never a grant.

### CHAT

- **Default tool access is none.** CHAT is not "zero tools forever", but nothing
  is available without an explicit grant.
- A scoped action must be **registered** in `ScopedActionRegistry` **and**
  granted through `ServerOptions.chatScopedActions`.
- If any requested tool is unregistered or ungranted, the whole request is
  rejected. There is no silent stripping and no partial forward.
- Registered definitions win over caller-supplied descriptions and JSON
  schemas, so a caller cannot re-describe an action it was granted.
- Tool-result continuations must name a granted action and match an assistant
  tool call in the same request.
- The client executes the action. The Router never executes it.

The registry ships empty: no Notion, Gmail, Calendar or other connector is
implemented. `cmm.test.echo` and `cmm.test.write` exist only in the deterministic
test harness.

### AGENT

- The harness-supplied tool set is transported as supplied.
- Provider/model capability and protocol representability still apply.
- The Router never executes a tool; the client owns tool execution.
- AGENT is the intended profile for Qoder, Hermes, Codex CLI, generic
  OpenAI-compatible agents and a future CMMChat Cowork.

## Shared tool engine

CHAT scoped actions and AGENT tool loops use the same `DeferredToolBroker` and
the same provider adapters:

```text
provider → structured tool call → Router → client → client executes
        → tool result → Router → same provider/model/session → continuation
```

Pending correlation entries are keyed by profile. A CHAT continuation cannot
claim an AGENT pending call (and vice versa); a mismatched claim is answered
`unknown` and leaves the entry parked for its rightful owner.

## Legacy compatibility

| Legacy identifier | Current meaning |
|---|---|
| `CMM Code Router` | historical name of AGENT |
| `CHAT_ONLY` | provider/model cannot do a structured tool round-trip |
| `CHAT_AND_TOOLS` | provider/model can do a structured tool round-trip |
| `consumer = qoder` | legacy label for an AGENT request; broker maps it to AGENT |
| `qoder-custom-cmm-router` | installed Qoder provider ID; unchanged |
| `cmm-qoder-tools` | installed AGY MCP registration name; unchanged |

The `CHAT_ONLY` / `CHAT_AND_TOOLS` vocabulary remains the provider/model
capability representation because replacing it would widen the refactor beyond
the profile model. It never selects a profile.

No secret is renamed, copied, regenerated or migrated. The launch wrapper reads
`qoder-bearer` and, only if an operator created it, `code-router-bearer`; it
never creates a Keychain item.

## Deferred by design

- Real Notion/Gmail/Calendar connectors.
- CMM Cowork implementation.
- Shell, filesystem, browser or computer-use execution inside the Router.
- Dynamic Provider Catalog and full runtimeCapabilities.
- Any UI confirmation flow; that belongs to CMMChat, not the Router.

## Verification

```bash
npm run build
npm run typecheck
npx vitest run
bash scripts/security-audit.sh
```

The deterministic evidence includes `tests/http/router-profiles.test.ts`,
`tests/core/tool-access-policy.test.ts`, `tests/core/scoped-actions.test.ts`,
`tests/core/deferred-tool-broker-profile.test.ts` and
`tests/integration/router-token-aliases.test.ts`.
