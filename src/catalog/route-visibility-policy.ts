import type {
  LegacyRouteVisibilityRule,
  SharedConfig,
} from "../config/schema.js";
import type { RouteSurface, RouteVisibility } from "./types.js";

export interface RouteVisibilityPolicyInput {
  routeId: string;
  providerId: string;
  providerModelId: string;
  toolCapable: boolean;
  exactRouteExecutable: boolean;
}

type DeferredRouteVisibilityPolicyInput = Omit<RouteVisibilityPolicyInput, "routeId">;

export type RouteVisibilityResolver = (routeId: string) => RouteVisibility;

function legacyRuleKey(providerId: string, providerModelId: string): string {
  return `${providerId}\u0000${providerModelId}`;
}

/**
 * Router-owned product visibility state. It is intentionally independent of
 * connection health, route activation/routability, billing and Usage
 * collection. Exact-execution capability is only a safety ceiling: a route
 * that cannot honor an exact binding cannot be exposed on an executable
 * consumer surface even if a stale operator rule asks for it.
 */
export class RouteVisibilityPolicy {
  private readonly exactRules = new Map<string, readonly RouteSurface[]>();
  private readonly legacyMigrationRules = new Map<string, readonly RouteSurface[]>();

  constructor(
    rules: SharedConfig["routeVisibility"] = [],
    legacyMigrationInput: readonly LegacyRouteVisibilityRule[] = [],
  ) {
    for (const rule of rules) {
      this.exactRules.set(rule.routeId, [...rule.visibleOn]);
    }
    for (const rule of legacyMigrationInput) {
      this.legacyMigrationRules.set(
        legacyRuleKey(rule.providerId, rule.providerModelId),
        [...rule.visibleOn],
      );
    }
  }

  resolve(input: RouteVisibilityPolicyInput): RouteVisibility;
  resolve(input: DeferredRouteVisibilityPolicyInput): RouteVisibilityResolver;
  resolve(
    input: RouteVisibilityPolicyInput | DeferredRouteVisibilityPolicyInput,
  ): RouteVisibility | RouteVisibilityResolver {
    if (!("routeId" in input)) {
      return (routeId) => this.resolve({ ...input, routeId });
    }

    const exactConfigured = this.exactRules.get(input.routeId);
    const legacyConfigured = this.legacyMigrationRules.get(
      legacyRuleKey(input.providerId, input.providerModelId),
    );
    const defaultVisibleOn: RouteSurface[] = input.toolCapable
      ? ["cmmchat_model_picker", "cmmcode_model_picker", "admin_console"]
      : ["cmmchat_model_picker", "admin_console"];
    const requested =
      exactConfigured !== undefined
        ? [...exactConfigured]
        : legacyConfigured !== undefined
          ? [...legacyConfigured]
          : defaultVisibleOn;

    if (input.exactRouteExecutable) return { visibleOn: requested };
    return {
      visibleOn: requested.filter((surface) => surface === "admin_console"),
    };
  }
}
