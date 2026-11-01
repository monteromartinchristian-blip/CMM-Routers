import { RouterError } from "./errors.js";
import type { RouterFunctionTool } from "./model.js";

/**
 * Side-effect class of a scoped action.
 *
 * The Router does not execute actions; this metadata exists so a policy layer
 * (or a future confirmation UI in CMMChat) can reason about what the client is
 * being asked to run. It is never used as a substitute for an explicit grant.
 */
export type ScopedActionSideEffect = "none" | "read" | "write";

/**
 * A Router-registered action that CHAT may use ONLY when the same id is also
 * explicitly granted by server-side policy.
 *
 * Registration is not authorization. A client that sends this tool in a
 * request does not thereby obtain it: the effective grant is the intersection
 * of the CHAT profile, this registry, the configured grant set, provider/model
 * tool capability and protocol representability.
 */
export interface ScopedActionDefinition {
  /** Canonical public action id, also the provider-visible function name. */
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /** JSON Schema for the action arguments. Immutable after registration. */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly sideEffect: ScopedActionSideEffect;
}

const ACTION_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function assertDefinition(definition: ScopedActionDefinition): void {
  if (!ACTION_ID.test(definition.id) || definition.id.length > 128) {
    throw new RouterError(
      "router_internal_error",
      `Invalid scoped action id: ${JSON.stringify(definition.id)}`,
    );
  }
  if (definition.displayName.length === 0) {
    throw new RouterError(
      "router_internal_error",
      `Scoped action ${definition.id} requires a displayName`,
    );
  }
  if (
    typeof definition.parameters !== "object" ||
    definition.parameters === null ||
    Array.isArray(definition.parameters)
  ) {
    throw new RouterError(
      "router_internal_error",
      `Scoped action ${definition.id} parameters must be a JSON object schema`,
    );
  }
  if (
    definition.sideEffect !== "none" &&
    definition.sideEffect !== "read" &&
    definition.sideEffect !== "write"
  ) {
    throw new RouterError(
      "router_internal_error",
      `Scoped action ${definition.id} has an invalid sideEffect`,
    );
  }
}

/**
 * Validate and freeze one definition. Validation happens at construction
 * time, never on the request path: a malformed definition must fail the
 * process that registered it, not a user's CHAT request.
 */
export function defineScopedAction(
  definition: ScopedActionDefinition,
): ScopedActionDefinition {
  assertDefinition(definition);
  return Object.freeze({
    ...definition,
    parameters: Object.freeze({ ...definition.parameters }),
  });
}

/**
 * The complete set of actions the Router is willing to expose to CHAT.
 *
 * An empty registry is the default: CHAT has no routable actions until a
 * connector deliberately registers one. Registration never grants anything.
 */
export class ScopedActionRegistry {
  private readonly actions = new Map<string, ScopedActionDefinition>();

  constructor(definitions: readonly ScopedActionDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ScopedActionDefinition): void {
    assertDefinition(definition);
    if (this.actions.has(definition.id)) {
      throw new RouterError(
        "router_internal_error",
        `Duplicate scoped action: ${definition.id}`,
      );
    }
    this.actions.set(
      definition.id,
      Object.freeze({
        ...definition,
        parameters: Object.freeze({ ...definition.parameters }),
      }),
    );
  }

  has(id: string): boolean {
    return this.actions.has(id);
  }

  get(id: string): ScopedActionDefinition | undefined {
    return this.actions.get(id);
  }

  list(): readonly ScopedActionDefinition[] {
    return [...this.actions.values()];
  }

  get size(): number {
    return this.actions.size;
  }

  /**
   * Canonical provider-visible tool for a registered action. The Router's
   * definition wins over anything the caller supplied under the same name, so
   * a request cannot re-describe an action it was granted.
   */
  toRouterTool(id: string): RouterFunctionTool | undefined {
    const action = this.actions.get(id);
    if (action === undefined) return undefined;
    return {
      kind: "function",
      type: "function",
      function: {
        name: action.id,
        description: action.description,
        parameters: { ...action.parameters },
      },
    };
  }
}
