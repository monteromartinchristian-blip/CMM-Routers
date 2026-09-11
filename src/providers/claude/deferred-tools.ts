import type {
  HookCallbackMatcher,
  Options,
  PreToolUseHookSpecificOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { RouterRequest } from "../../core/model.js";
import type { DeferredToolUse } from "./mcp-bridge.js";

/**
 * Deferred Qoder-owned tool wiring for the installed Claude Agent SDK.
 *
 * When a Qoder request carries tool definitions, the adapter registers a
 * PreToolUse hook returning permissionDecision:"defer" so the SDK yields
 * deferred_tool_use {id,name,input} with NO side effect. The host surfaces
 * that request to Qoder and later resumes the SAME session; the parked MCP
 * bridge handler returns Qoder's already-produced result.
 */

/** Build the PreToolUse defer matcher for Qoder-owned bridge tools. */
export function buildDeferMatcher(): HookCallbackMatcher {
  return {
    hooks: [
      async () => ({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "defer",
          permissionDecisionReason: "Qoder owns execution; Router bridges the result",
        } satisfies PreToolUseHookSpecificOutput,
      }),
    ],
  };
}

/** Bridge tool names exposed to Claude for one Qoder request. */
export function bridgeToolNames(tools: RouterRequest["tools"]): string[] {
  return tools.map((tool) => `mcp__cmm_qoder__${tool.function.name}`);
}

/** Attach the defer hooks to base SDK options (tools present only). */
export function withDeferHooks(base: Options, tools: RouterRequest["tools"]): Options {
  if (tools.length === 0) return base;
  return { ...base, hooks: { PreToolUse: [buildDeferMatcher()] } };
}

/** Map a deferred tool use into a Router tool-call delta payload. */
export function deferredToToolCall(deferred: DeferredToolUse): {
  index: number;
  id: string;
  name: string;
  argsJson: string;
} {
  const shortName = deferred.name.startsWith("mcp__cmm_qoder__")
    ? deferred.name.slice("mcp__cmm_qoder__".length)
    : deferred.name;
  return {
    index: 0,
    id: deferred.id,
    name: shortName,
    argsJson: JSON.stringify(deferred.input ?? {}),
  };
}
