# Codex upstream tool-neutral profile

CMM Code Router keeps tool execution client-owned.

The upstream `codex app-server` runs from a dedicated `CODEX_HOME` whose model
catalog disables native shell, web search, apply-patch, and multi-agent tooling.
Client tools remain dynamic external tools owned by the downstream client.

Default macOS profile:

```text
~/Library/Application Support/CMM Routers/codex-upstream
```

Provision it with:

```bash
scripts/macos/provision-codex-upstream-profile.sh
```

The provisioner requires `codex-cli 0.147.0`, copies ChatGPT subscription auth
from `~/.codex/auth.json`, strips API-key fields from the copy, never mutates
`~/.codex`, pins the exact `rust-v0.147.0` OpenAI Codex catalog, converts every
upstream model to `tool_mode=direct` and `shell_type=disabled`, and disables
search, apply-patch, plugins, and agents.

An explicit `providers.chatgpt.codexHome` remains authoritative. Otherwise the
supported macOS wrapper exports `CMM_ROUTER_CODEX_HOME` pointing to the
dedicated profile and fails closed when ChatGPT is enabled but that profile is
absent.

The live ownership gate was closed on 2026-09-25 with a downstream-only
environment secret. The upstream process and prompt could not know the value;
the downstream Codex client executed `exec_command`, and its result returned
through a successful Codex `DynamicToolResponse`.
