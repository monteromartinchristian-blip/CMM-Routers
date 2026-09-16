import type { SharedConfig } from "../config/schema.js";
import type { RouteSurface, RouteVisibility } from "./types.js";

export interface RouteVisibilityPolicyInput {
  providerId: string;
  providerModelId: string;
  toolCapable: boolean;
  exactRouteExecutable: boolean;
}

function ruleKey(providerId: string, providerModelId: string): string {
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
  private readonly rules = new Map<string, readonly RouteSurface[]>();

  constructor(rules: SharedConfig["routeVisibility"] = []) {
    for (const rule of rules) {
      this.rules.set(ruleKey(rule.providerId, rule.providerModelId), [...rule.visibleOn]);
    }
  }

  resolve(input: RouteVisibilityPolicyInput): RouteVisibility {
    const configured = this.rules.get(ruleKey(input.providerId, input.providerModelId));
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
