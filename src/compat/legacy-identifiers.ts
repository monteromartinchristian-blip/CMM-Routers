/**
 * Persisted legacy wire identifiers — explicit compatibility layer.
 *
 * These strings appear in durable external places: macOS Keychain items, the
 * rendered LaunchAgent, the persisted `agy` MCP registration and its permission
 * ACL, live provider configuration, and operator documentation. They must NOT be
 * renamed, because doing so would orphan credentials, detach a running
 * LaunchAgent, or invalidate a persisted registration.
 *
 * Production logic refers to them through these semantic names so the historical
 * product name is confined to one compatibility module instead of being sprinkled
 * through the codebase. The VALUES are frozen; the NAMES are ours.
 *
 * Removal is a separate, explicitly planned migration.
 */

/** Legacy Code Router bearer environment variable name. */
export const LEGACY_CODE_ROUTER_BEARER_ENV = "CMM_QODER_TOKEN";

/** Keychain account holding the legacy Code Router bearer. */
export const LEGACY_CODE_ROUTER_KEYCHAIN_ACCOUNT = "qoder-bearer";

/** Keychain service shared by every local secret (legacy product name). */
export const LEGACY_KEYCHAIN_SERVICE = "cmm-subscription-router";

/** LaunchAgent label. */
export const LEGACY_LAUNCHAGENT_LABEL = "com.cmm.subscription-router";

/** Persisted `agy` MCP server registration name. */
export const LEGACY_ANTIGRAVITY_MCP_SERVER_NAME = "cmm-qoder-tools";

/**
 * Persisted `agy` permission rule that scopes `call_mcp_tool` to the CMM bridge.
 * This is BOTH a legacy name and an active security scope: it must never be
 * widened to `mcp(*)`.
 */
export const LEGACY_ANTIGRAVITY_MCP_PERMISSION_RULE = "mcp(cmm-qoder-tools/*)";

/** Default MCP bridge server name advertised by the stdio bridge process. */
export const LEGACY_BRIDGE_SERVER_NAME = "cmm_qoder";

/** Claude SDK MCP namespace prefix derived from the bridge server config key. */
export const LEGACY_CLAUDE_BRIDGE_TOOL_PREFIX = "mcp__cmm_qoder__";

/** Qoder-side provider id used by the local reconciliation scripts. */
export const LEGACY_QODER_PROVIDER_ID = "qoder-custom-cmm-router";

/** Operator-facing smoke marker. */
export const LEGACY_SMOKE_OK_MARKER = "QODER_SMOKE_OK";

/**
 * Boundary default labels. These are diagnostic observations recorded for
 * compatibility, not a taxonomy the core depends on: the core only ever sees an
 * opaque string, and any harness may override it with its own label.
 */
export const LEGACY_CODE_ROUTER_CLIENT_LABEL = "qoder";
export const CMMCHAT_CLIENT_LABEL = "cmmchat";
