import type { SharedConfig } from "../config/schema.js";
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

/**
 * Router-owned product visibility state. It is intentionally independent of
 * connection health, route activation/routability, billing and Usage
 * collection. Exact-execution capability is only a safety ceiling: a route
 * that cannot honor an exact binding cannot be exposed on an executable
 * consumer surface even if a stale operator rule asks for it.
 */
export class RouteVisibilityPolicy {
  private readonly exactRules = new Map<string, readonly RouteSurface[]>();

  constructor(rules: SharedConfig["routeVisibility"] = []) {
    for (const rule of rules) {
      if ("routeId" in rule) {
        this.exactRules.set(rule.routeId, [...rule.visibleOn]);
      }
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

    const configured = this.exactRules.get(input.routeId);
    const defaultVisibleOn: RouteSurface[] = input.toolCapable
      ? ["cmmchat_model_picker", "cmmcode_model_picker", "admin_console"]
      : ["cmmchat_model_picker", "admin_console"];
    const requested = configured === undefined ? defaultVisibleOn : [...configured];

    if (input.exactRouteExecutable) return { visibleOn: requested };
    return {
      visibleOn: requested.filter((surface) => surface === "admin_console"),
    };
  }
}
