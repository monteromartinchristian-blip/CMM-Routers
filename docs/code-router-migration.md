# CMM Code Router — Migration and Compatibility Window

This document describes how a CMM Routers installation moves from the legacy
Qoder-named Code Router credential to the canonical Code Router credential, and
what is deliberately **not** renamed.

## Two profiles, one authorization subject

| Credential | Profile | Capability |
|---|---|---|
| `CMM_ROUTER_TOKEN` (CMMChat) | `cmmchat` | `CHAT_ONLY`, permanently |
| `CMM_CODE_ROUTER_TOKEN` (canonical) | `code` | `CHAT_AND_TOOLS`, subject to truthful provider/model capability |
| `CMM_QODER_TOKEN` (legacy alias) | `code` | same as canonical |

The canonical and legacy Code Router credentials authenticate the **same**
profile. There is no precedence rule between them because there is nothing to
prefer: either one yields `profile=code`. Neither can ever authenticate CMMChat.

## Deterministic behavior

| Configuration | Result |
|---|---|
| Only canonical bearer | Code Router profile works |
| Only legacy bearer | Code Router profile works (existing installs keep working) |
| Both, distinct values | Either authenticates the Code Router profile |
| Both, same value | Accepted: two names for one credential, one profile |
| Neither | No Code Router profile; every authenticated request is CMMChat |
| CMMChat bearer equals either Code Router bearer | **Startup refuses to run** (`router_misconfigured`) |

The collision rule replaces the previous behavior, in which an ambiguous
configuration silently resolved to CMMChat. A collision is a configuration
error, not a downgrade.

## What is not renamed

These persisted or externally referenced identifiers are deliberately unchanged,
because renaming them would orphan stored credentials, detach a running
LaunchAgent, or break an already-registered client:

```text
CMM_QODER_TOKEN
qoder-bearer
cmm-qoder-tools
mcp(cmm-qoder-tools/*)
cmm_qoder
mcp__cmm_qoder__
qoder-custom-cmm-router
QODER_SMOKE_OK
com.cmm.subscription-router
cmm-subscription-router
```

They are legacy **compatibility identifiers**. In particular
`mcp(cmm-qoder-tools/*)` is both a legacy name and an active security scope, so
it must never be widened; and `com.cmm.subscription-router` /
`cmm-subscription-router` remain the LaunchAgent label and Keychain service.

## Closing the compatibility window

The legacy alias may be removed only after **all** of the following hold, and
removal is always a separate, explicitly reviewed change:

1. every Mac has provisioned `code-router-bearer`;
2. every client has been re-pointed at the canonical bearer;
3. no authentication via the legacy bearer has been observed in usage
   diagnostics for a documented deprecation period.

Until then, `CMM_QODER_TOKEN` must keep working. Do not delete legacy
identifiers in the same change that introduces new ones.
