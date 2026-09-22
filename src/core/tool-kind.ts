/**
 * Tool declaration capability classes.
 *
 * A downstream client may declare tools the Router cannot faithfully represent
 * as client-owned functions. The Router classifies every declaration into a
 * capability class and applies an explicit policy, so an unsupported class is
 * refused by name instead of being silently converted or dropped.
 *
 * Two rules keep this safe:
 *
 *   1. Classification is about REPRESENTABILITY, never about which product is
 *      asking. Adding a new client can never change this table.
 *   2. Representation is not permission. A class being SUPPORTED means the
 *      Router can carry it without loss, not that any provider may execute it.
 *      Provider-native execution remains forbidden independently of this table.
 */

import { RouterError } from "./errors.js";

/** Capability classes for a downstream tool declaration. */
export type ToolDeclarationKind = "function" | "namespace" | "hosted" | "unknown";

export const TOOL_DECLARATION_KINDS: readonly ToolDeclarationKind[] = [
  "function",
  "namespace",
  "hosted",
  "unknown",
] as const;

/**
 * How the Router treats a class:
 *   - SUPPORTED: representable without loss as a client-owned function;
 *   - EXPLICIT_UNSUPPORTED: a known class the Router refuses by name;
 *   - FAIL_CLOSED: an unrecognized class, refused without guessing.
 */
export type ToolKindSupport = "SUPPORTED" | "EXPLICIT_UNSUPPORTED" | "FAIL_CLOSED";

/**
 * Provider-side (hosted) tool declaration types. These are declared for the
 * provider to execute, which this Router forbids: execution is client-owned.
 */
const HOSTED_TOOL_TYPES: ReadonlySet<string> = new Set<string>([
  "web_search",
  "web_search_preview",
  "web_search_preview_2025_03_11",
  "file_search",
  "code_interpreter",
  "computer_use_preview",
  "image_generation",
  "mcp",
  "local_shell",
  "custom",
]);

export const TOOL_KIND_POLICY: Readonly<Record<ToolDeclarationKind, ToolKindSupport>> = {
  function: "SUPPORTED",
  namespace: "EXPLICIT_UNSUPPORTED",
  hosted: "EXPLICIT_UNSUPPORTED",
  unknown: "FAIL_CLOSED",
};

export function toolKindPolicyFor(kind: ToolDeclarationKind): ToolKindSupport {
  return TOOL_KIND_POLICY[kind];
}

/**
 * Classify a declaration's wire `type`. Anything unrecognized — including a
 * missing or non-string type — is `unknown` and therefore fails closed.
 */
export function classifyToolDeclarationType(type: unknown): ToolDeclarationKind {
  if (type === "function") return "function";
  if (type === "namespace") return "namespace";
  if (typeof type === "string" && HOSTED_TOOL_TYPES.has(type)) return "hosted";
  return "unknown";
}

/**
 * The fail-closed error for a class the Router cannot represent. The message
 * names the class so a client author can act on it, and never names a product.
 */
export function unsupportedToolKindError(
  kind: ToolDeclarationKind,
  declaredWireType?: unknown,
): RouterError {
  const wire =
    typeof declaredWireType === "string" && declaredWireType.length > 0
      ? ` (wire type '${declaredWireType}')`
      : "";
  if (kind === "unknown") {
    return new RouterError(
      "unsupported_capability",
      `The request declares a tool whose type is not recognized${wire}; refusing to guess instead of dropping it silently`,
    );
  }
  return new RouterError(
    "unsupported_capability",
    `The Router cannot faithfully represent a tool of class '${kind}'${wire}; refusing to drop it silently`,
  );
}
