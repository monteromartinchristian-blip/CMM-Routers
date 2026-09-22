/**
 * Protocol-centric capability descriptor.
 *
 * A client must be able to learn what a given downstream protocol surface can
 * actually carry before relying on it. The descriptor therefore scopes truth
 * PER PROTOCOL rather than publishing global flags that cannot express real
 * differences (for example: OpenAI surfaces accept a system-level `developer`
 * role, while an Anthropic-compatible surface carries system instructions in a
 * dedicated field instead).
 *
 * It describes truth only. Publishing a capability never grants authorization:
 * the tool gate remains `profile ∩ provider/model capability`, decided
 * independently at the HTTP boundary.
 *
 * The five concepts stay distinct:
 *   1. discovered model          (registry discovery)
 *   2. verified upstream capability   (`code_router`, from the provider adapter)
 *   3. downstream representability    (this descriptor)
 *   4. local billing/entitlement      (not modelled here)
 *   5. client publication state       (not modelled here)
 */

import type { ProviderCapability, ProviderId } from "./model.js";
import { TOOL_KIND_POLICY } from "./tool-kind.js";
import { providerToolPolicySupport } from "./tool-policy.js";

/** Downstream protocol families this Router can expose. */
export const DOWNSTREAM_PROTOCOLS = [
  "openai_chat",
  "openai_responses",
  "anthropic_messages",
] as const;

export type DownstreamProtocol = (typeof DOWNSTREAM_PROTOCOLS)[number];

export interface SurfaceTools {
  function: boolean;
  namespace: boolean;
  hosted: boolean;
  parallel_tool_calls: boolean;
  tool_choice: "full" | "auto_only";
}

/** Truth about one downstream protocol surface. */
export interface SurfaceCapabilities {
  /** The surface exists and accepts requests. */
  available: boolean;
  streaming: boolean;
  cancellation: boolean;
  /** Whether a system-level `developer` input role is accepted. */
  developer_role: boolean;
  /** Whether system instructions use a dedicated field instead of a role. */
  system_field: boolean;
  tools: SurfaceTools;
  /** Wire authentication forms accepted; all map to the one existing profile. */
  auth: {
    authorization_bearer: boolean;
    api_key_header: boolean;
  };
  /**
   * Per-control truth: `supported` when the control changes behavior end to end,
   * `explicit_unsupported` when a non-default use is refused by name.
   */
  request_controls: Record<string, "supported" | "explicit_unsupported">;
}

/**
 * Protocol-INDEPENDENT truth about the canonical tool algebra: which declaration
 * classes the Router can execute at all.
 */
export interface CanonicalToolCapabilities {
  function: boolean;
  namespace: boolean;
  hosted: boolean;
}

export interface ProtocolCapabilities {
  canonical_tools: CanonicalToolCapabilities;
  protocols: Record<DownstreamProtocol, SurfaceCapabilities>;
}

/**
 * Whether each downstream surface is registered. A Router-level fact, not a
 * per-model claim.
 */
export const ROUTER_PROTOCOL_SUPPORT: Readonly<Record<DownstreamProtocol, boolean>> = {
  openai_chat: true,
  openai_responses: true,
  anthropic_messages: true,
};

type ToolPolicy = { tool_choice: "full" | "auto_only"; parallel_tool_calls: boolean };

function toolTruth(toolCapable: boolean, policy: ToolPolicy): SurfaceTools {
  return {
    function: toolCapable && TOOL_KIND_POLICY.function === "SUPPORTED",
    namespace: toolCapable && TOOL_KIND_POLICY.namespace === "SUPPORTED",
    hosted: toolCapable && TOOL_KIND_POLICY.hosted === "SUPPORTED",
    tool_choice: policy.tool_choice,
    parallel_tool_calls: policy.parallel_tool_calls,
  };
}

/** OpenAI-family surfaces: role-based instructions, bearer auth only. */
function openAiSurface(toolCapable: boolean, policy: ToolPolicy): SurfaceCapabilities {
  return {
    available: true,
    streaming: true,
    cancellation: true,
    developer_role: true,
    system_field: false,
    tools: toolTruth(toolCapable, policy),
    auth: { authorization_bearer: true, api_key_header: false },
    request_controls: { max_tokens: "supported", temperature: "explicit_unsupported" },
  };
}

/** Anthropic-compatible surface: dedicated system field, explicit controls. */
function anthropicSurface(toolCapable: boolean, policy: ToolPolicy): SurfaceCapabilities {
  return {
    available: true,
    streaming: true,
    cancellation: true,
    // Anthropic carries system instructions in a dedicated field, not a role.
    developer_role: false,
    system_field: true,
    tools: toolTruth(toolCapable, policy),
    auth: { authorization_bearer: true, api_key_header: true },
    request_controls: {
      max_tokens: "supported",
      temperature: "explicit_unsupported",
      top_p: "explicit_unsupported",
      top_k: "explicit_unsupported",
      stop_sequences: "explicit_unsupported",
    },
  };
}

/**
 * Build the truthful descriptor for one route. Unknown capability never
 * promotes: everything tool-related stays false.
 */
export function protocolCapabilitiesFor(
  modelCapability: ProviderCapability | undefined,
  provider?: ProviderId,
): ProtocolCapabilities {
  const toolCapable = modelCapability === "CHAT_AND_TOOLS";
  const policy: ToolPolicy =
    provider !== undefined
      ? providerToolPolicySupport(provider)
      : { tool_choice: "full", parallel_tool_calls: true };

  return {
    canonical_tools: {
      function: TOOL_KIND_POLICY.function === "SUPPORTED",
      namespace: TOOL_KIND_POLICY.namespace === "SUPPORTED",
      hosted: TOOL_KIND_POLICY.hosted === "SUPPORTED",
    },
    protocols: {
      openai_chat: openAiSurface(toolCapable, policy),
      openai_responses: openAiSurface(toolCapable, policy),
      anthropic_messages: anthropicSurface(toolCapable, policy),
    },
  };
}
