import { RouterError } from "./errors.js";
import type {
  ProviderCapability,
  ProviderId,
  RouterMessage,
  RouterFunctionTool,
} from "./model.js";
import type { RouterProfile } from "./router-profile.js";
import type { ScopedActionRegistry } from "./scoped-actions.js";
import {
  enforceProviderToolPolicy,
  type NormalizedToolChoice,
} from "./tool-policy.js";

/**
 * Effective tool-access mode for one authenticated request.
 *
 * The mode is decided BEFORE any tool enters the shared provider pipeline:
 *   none   — ordinary conversation; the request carries no tool semantics.
 *   scoped — CHAT with an explicit, registered and granted action set.
 *   agent  — AGENT, which may transport the harness-supplied tool set.
 *
 * The mode never changes what a provider is allowed to execute: the Router
 * never executes tools and the client always owns execution.
 */
export type ToolAccessMode = "none" | "scoped" | "agent";

export interface ToolAccessRequest {
  readonly profile: RouterProfile;
  readonly provider: ProviderId;
  readonly providerCapability: ProviderCapability | undefined;
  readonly tools: readonly RouterFunctionTool[];
  readonly toolChoice?: NormalizedToolChoice;
  readonly parallelToolCalls?: boolean;
  readonly messages: readonly RouterMessage[];
  readonly scopedActions?: ScopedActionRegistry;
  readonly grantedActions?: readonly string[];
}

export interface EffectiveToolAccess {
  readonly mode: ToolAccessMode;
  /** Canonical tools to forward. Never a silently filtered client list. */
  readonly tools: readonly RouterFunctionTool[];
  readonly allowedToolNames: ReadonlySet<string>;
  /** CHAT grant set actually considered (empty for AGENT). */
  readonly grantedActions: ReadonlySet<string>;
}

/**
 * Server-side configuration for tool access. Supplied by the composition layer,
 * never by a request: `grantedActions` is the CHAT session/server grant set,
 * and `scopedActions` is the Router-owned registry eligible for CHAT.
 */
export interface ToolAccessConfig {
  readonly scopedActions?: ScopedActionRegistry;
  readonly grantedActions?: readonly string[];
}

export type ToolAccessDecision =
  | { readonly allowed: true; readonly access: EffectiveToolAccess }
  | { readonly allowed: false; readonly error: RouterError };

/**
 * Fail-closed rule for DIRECT adapter invocation.
 *
 * The HTTP surfaces resolve and enforce an authenticated profile before any
 * adapter runs (`resolveToolAccess` above). A direct `adapter.run()` call has
 * no such decision, so the adapter boundary itself must refuse to carry tool
 * semantics without a propagated profile: debug/test/harness calls that omit
 * `profile` while declaring tools or a tool-result continuation are rejected
 * instead of being silently parked under AGENT.
 *
 *   MISSING_PROFILE_WITH_TOOLS        → REJECTED
 *   MISSING_PROFILE_WITH_TOOL_RESULT  → REJECTED
 *
 * A tool-semantics-free direct call may still omit `profile`: no broker entry,
 * no tool transport and no authorization consequence exists for it.
 */
export function assertProfileForToolSemantics(
  profile: RouterProfile | undefined,
  request: {
    readonly tools: readonly RouterFunctionTool[];
    readonly messages: readonly RouterMessage[];
  },
): asserts profile is RouterProfile {
  if (profile !== undefined) return;
  if (request.tools.length > 0) {
    throw new RouterError(
      "invalid_request",
      "Tool declarations require an authenticated router profile; refusing to assume AGENT",
    );
  }
  const hasToolContinuation = request.messages.some(
    (message) =>
      message.role === "tool" ||
      (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0),
  );
  if (hasToolContinuation) {
    throw new RouterError(
      "invalid_request",
      "Tool-result continuation requires an authenticated router profile; refusing to assume AGENT",
    );
  }
}

interface ToolHistory {
  readonly hasAssistantCalls: boolean;
  readonly hasToolResults: boolean;
  readonly assistantCallNames: readonly string[];
  /** Every tool result has an id and matches an assistant call in this request. */
  readonly correlated: boolean;
}

function inspectToolHistory(messages: readonly RouterMessage[]): ToolHistory {
  const callNames: string[] = [];
  const callIds = new Set<string>();
  const resultIds: string[] = [];
  let hasAssistantCalls = false;
  let hasToolResults = false;
  let everyResultHasId = true;

  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      hasAssistantCalls = true;
      for (const call of message.toolCalls) {
        callNames.push(call.function.name);
        callIds.add(call.id);
      }
    }
    if (message.role === "tool") {
      hasToolResults = true;
      if (message.toolCallId === undefined || message.toolCallId.length === 0) {
        everyResultHasId = false;
      } else {
        resultIds.push(message.toolCallId);
      }
    }
  }

  const correlated =
    everyResultHasId &&
    (resultIds.length === 0 || hasAssistantCalls) &&
    resultIds.every((id) => callIds.has(id));

  return {
    hasAssistantCalls,
    hasToolResults,
    assistantCallNames: callNames,
    correlated,
  };
}

function allow(access: EffectiveToolAccess): ToolAccessDecision {
  return { allowed: true, access };
}

function deny(error: RouterError): ToolAccessDecision {
  return { allowed: false, error };
}

function capabilityDenial(what: "tools" | "selection" | "continuation" | "history"): RouterError {
  switch (what) {
    case "tools":
      return new RouterError(
        "unsupported_capability",
        "Model supports chat only; tools are not supported on this route",
      );
    case "selection":
      return new RouterError(
        "unsupported_capability",
        "Model supports chat only; tool selection is not supported on this route",
      );
    case "continuation":
      return new RouterError(
        "unsupported_capability",
        "Model supports chat only; tool-result continuation is not supported on this route",
      );
    case "history":
      return new RouterError(
        "unsupported_capability",
        "Model supports chat only; assistant tool-call history is not supported on this route",
      );
  }
}

/**
 * Compute the effective tool grant for one authenticated request.
 *
 *   effective = profile policy
 *             ∩ (CHAT: scoped-action registry ∩ request/session grants)
 *             ∩ provider/model structured-tool capability
 *             ∩ protocol representability
 *
 * AGENT carries the harness-supplied set subject to the last two conditions;
 * CHAT carries only registered actions explicitly granted by server-side
 * policy. Client-supplied definitions are never a grant, and an unallowed tool
 * is rejected rather than stripped.
 */
export function resolveToolAccess(request: ToolAccessRequest): ToolAccessDecision {
  const { tools, messages, providerCapability } = request;
  const toolSelection =
    request.toolChoice !== undefined || request.parallelToolCalls !== undefined;
  const history = inspectToolHistory(messages);

  if (tools.length > 0 && providerCapability !== "CHAT_AND_TOOLS") {
    return deny(capabilityDenial("tools"));
  }
  if (toolSelection && providerCapability !== "CHAT_AND_TOOLS") {
    return deny(capabilityDenial("selection"));
  }
  if (history.hasToolResults && providerCapability !== "CHAT_AND_TOOLS") {
    return deny(capabilityDenial("continuation"));
  }
  if (history.hasAssistantCalls && providerCapability !== "CHAT_AND_TOOLS") {
    return deny(capabilityDenial("history"));
  }

  const names = tools.map((tool) => tool.function.name);

  const represents = enforceProviderToolPolicy(
    request.provider,
    request.toolChoice,
    request.parallelToolCalls,
  );
  if (represents !== null) return deny(represents);

  if (request.profile === "AGENT") {
    const allowed = new Set(names);
    if (request.toolChoice?.kind === "named" && !allowed.has(request.toolChoice.name)) {
      return deny(
        new RouterError(
          "invalid_request",
          "tool_choice names a function that is not declared in this request",
        ),
      );
    }
    return allow({
      mode: "agent",
      tools: [...tools],
      allowedToolNames: allowed,
      grantedActions: new Set<string>(),
    });
  }

  // ------------------------------------------------------------------ CHAT
  const registry = request.scopedActions;
  const grants = new Set(request.grantedActions ?? []);

  if (tools.length > 0) {
    if (names.some((name) => name.length === 0) || new Set(names).size !== names.length) {
      return deny(
        new RouterError(
          "invalid_request",
          "CHAT scoped-action declarations must have unique, non-empty function names",
        ),
      );
    }
    if (registry === undefined || grants.size === 0) {
      return deny(
        new RouterError(
          "unsupported_capability",
          "CHAT profile has no scoped actions granted; tools are not available on this route",
        ),
      );
    }

    for (const name of names) {
      if (!registry.has(name)) {
        return deny(
          new RouterError(
            "unsupported_capability",
            `Scoped action ${name} is not registered by the Router`,
          ),
        );
      }
      if (!grants.has(name)) {
        return deny(
          new RouterError(
            "unsupported_capability",
            `Scoped action ${name} is not granted to this CHAT session`,
          ),
        );
      }
    }

    // Canonical definitions win over caller-supplied descriptions/schemas.
    const canonicalTools: RouterFunctionTool[] = [];
    for (const name of names) {
      const tool = registry.toRouterTool(name);
      if (tool === undefined) {
        return deny(
          new RouterError(
            "unsupported_capability",
            `Scoped action ${name} disappeared from the Router registry`,
          ),
        );
      }
      canonicalTools.push(tool);
    }
    const allowed = new Set(names);

    for (const name of history.assistantCallNames) {
      if (!allowed.has(name)) {
        return deny(
          new RouterError(
            "unsupported_capability",
            `Assistant tool-call history names ${name}, which is not a granted scoped action`,
          ),
        );
      }
    }
    if ((history.hasToolResults || history.hasAssistantCalls) && !history.correlated) {
      return deny(
        new RouterError(
          "invalid_request",
          "CHAT tool-result continuation must reference an assistant tool call in this request",
        ),
      );
    }
    if (request.toolChoice?.kind === "named" && !allowed.has(request.toolChoice.name)) {
      return deny(
        new RouterError(
          "invalid_request",
          "tool_choice names a function that is not a granted scoped action",
        ),
      );
    }

    return allow({
      mode: "scoped",
      tools: canonicalTools,
      allowedToolNames: allowed,
      grantedActions: grants,
    });
  }

  if (toolSelection || history.hasAssistantCalls || history.hasToolResults) {
    return deny(
      new RouterError(
        "unsupported_capability",
        "CHAT profile has no scoped action grant for the requested tool semantics",
      ),
    );
  }

  return allow({
    mode: "none",
    tools: [],
    allowedToolNames: new Set<string>(),
    grantedActions: grants,
  });
}
