import type { DiscoveredModel, ProviderId, RouterRequest } from "./model.js";
import type { RouterEvent } from "./events.js";

export type { DiscoveredModel, ProviderId, RouterRequest };
export interface ProviderHealth {
  status: "ready" | "degraded" | "unavailable" | "auth_required";
  detail?: string;
}

export interface ProviderExecutionCapabilities {
  /** Adapter can honor an exact catalog-resolved route binding. */
  readonly exactResolvedRoute: boolean;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly executionCapabilities?: ProviderExecutionCapabilities;
  discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]>;
  health(signal?: AbortSignal): Promise<ProviderHealth>;
  run(
    request: RouterRequest,
    signal: AbortSignal,
  ): AsyncIterable<RouterEvent>;
  cancel(requestId: string): Promise<void>;
}
