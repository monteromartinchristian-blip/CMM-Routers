/**
 * Protocol-centric capability descriptor.
 *
 * A client must be able to learn what the selected route can actually represent
 * before it relies on it. The descriptor therefore describes DOWNSTREAM PROTOCOL
 * and TOOL-CLASS truth, never a product: no harness name appears here, and
 * adding a new client can never change this file.
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

/**
 * Which downstream protocol surfaces exist. This is a Router-level fact (the
 * surface is registered), not a per-model claim.
 */
export const ROUTER_PROTOCOL_SUPPORT: Readonly<Record<DownstreamProtocol, boolean>> = {
  openai_chat: true,
  openai_responses: true,
  anthropic_messages: true,
};

export interface ProtocolCapabilities {
  protocols: Record<DownstreamProtocol, boolean>;
  tools: {
    /** Client-owned function tools: representable for a tool-capable route. */
    function: boolean;
    /** Grouped/namespace declarations: explicit known gap. */
    namespace: boolean;
    /** Provider-hosted tools: forbidden while execution stays client-owned. */
    hosted: boolean;
    /** How completely the selected provider represents a tool-choice constraint. */
    tool_choice: "full" | "auto_only";
    /** Whether the selected provider represents an explicit parallel constraint. */
    parallel_tool_calls: boolean;
  };
  streaming: boolean;
  cancellation: boolean;
  /** Whether `developer` (system-level) input messages are accepted. */
  developer_role: boolean;
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
  const policy =
    provider !== undefined
      ? providerToolPolicySupport(provider)
      : { tool_choice: "full" as const, parallel_tool_calls: true };

  return {
    protocols: { ...ROUTER_PROTOCOL_SUPPORT },
    tools: {
      function: toolCapable && TOOL_KIND_POLICY.function === "SUPPORTED",
      namespace: toolCapable && TOOL_KIND_POLICY.namespace === "SUPPORTED",
      hosted: toolCapable && TOOL_KIND_POLICY.hosted === "SUPPORTED",
      tool_choice: policy.tool_choice,
      parallel_tool_calls: policy.parallel_tool_calls,
    },
    // Both implemented surfaces stream and propagate cancellation, and both
    // normalize the system-level developer role.
    streaming: true,
    cancellation: true,
    developer_role: true,
  };
}
