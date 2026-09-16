import { buildModelIdentityId, buildRouteId } from "./ids.js";
import type { ModelIdentityStore } from "./model-identities.js";
import type {
  DiscoveredProviderModel,
  ProviderConnectionService,
} from "./provider-connections.js";
import type { RouteCatalog } from "./route-catalog.js";
import type { RouteVisibilityResolver } from "./route-visibility-policy.js";
import type {
  ProviderConnection,
  RouteCapabilities,
  RouteVisibility,
} from "./types.js";

export interface CatalogRoutePolicyResult {
  canonicalName: string;
  executionProfile: string;
  capabilities: RouteCapabilities;
  billingClass: string;
  routable: boolean;
  visibility: RouteVisibility | RouteVisibilityResolver;
}

export type CatalogRoutePolicy = (
  connection: Readonly<ProviderConnection>,
  model: Readonly<DiscoveredProviderModel>,
) => CatalogRoutePolicyResult;

export interface CatalogReconcilerOptions {
  connections: ProviderConnectionService;
  modelIdentities: ModelIdentityStore;
  routeCatalog: RouteCatalog;
  routePolicy: CatalogRoutePolicy;
  minRefreshIntervalMs?: number;
}

export interface ReconcileOptions {
  force?: boolean;
}

export interface ConnectionReconcileResult {
  connectionId: string;
  failed: boolean;
  skipped: boolean;
  discoveredCount: number;
  upsertedRouteIds: string[];
  unavailableRouteIds: string[];
}

export class CatalogReconciler {
  private readonly connections: ProviderConnectionService;
  private readonly modelIdentities: ModelIdentityStore;
  private readonly routeCatalog: RouteCatalog;
  private readonly routePolicy: CatalogRoutePolicy;
  private readonly minRefreshIntervalMs: number;
  private readonly lastAttemptAt = new Map<string, number>();

  constructor(options: CatalogReconcilerOptions) {
    this.connections = options.connections;
    this.modelIdentities = options.modelIdentities;
    this.routeCatalog = options.routeCatalog;
    this.routePolicy = options.routePolicy;
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? 30_000;
  }

  async reconcileAll(options: ReconcileOptions = {}): Promise<ConnectionReconcileResult[]> {
    const results: ConnectionReconcileResult[] = [];
    for (const connection of this.connections.list()) {
      results.push(await this.reconcileConnection(connection.connectionId, options));
    }
    return results;
  }

  async reconcileConnection(
    connectionId: string,
    options: ReconcileOptions = {},
  ): Promise<ConnectionReconcileResult> {
    const currentConnection = this.connections.get(connectionId);
    if (currentConnection === undefined) {
      throw new Error(`Unknown connection during reconciliation: ${connectionId}`);
    }
    if (currentConnection.status === "disabled") {
      return {
        connectionId,
        failed: false,
        skipped: true,
        discoveredCount: 0,
        upsertedRouteIds: [],
        unavailableRouteIds: [],
      };
    }

    const now = Date.now();
    const lastAttemptAt = this.lastAttemptAt.get(connectionId);
    if (
      options.force !== true &&
      lastAttemptAt !== undefined &&
      now - lastAttemptAt < this.minRefreshIntervalMs
    ) {
      return {
        connectionId,
        failed: false,
        skipped: true,
        discoveredCount: 0,
        upsertedRouteIds: [],
        unavailableRouteIds: [],
      };
    }
    this.lastAttemptAt.set(connectionId, now);

    const existingRoutes = this.routeCatalog
      .list()
      .filter((route) => route.connectionId === connectionId);

    let discovered: DiscoveredProviderModel[];
    try {
      discovered = await this.connections.discoverModels(connectionId);
    } catch {
      const unavailableRouteIds: string[] = [];
      for (const route of existingRoutes) {
        this.routeCatalog.markUnavailable(connectionId, route.providerModelId);
        unavailableRouteIds.push(route.routeId);
      }
      return {
        connectionId,
        failed: true,
        skipped: false,
        discoveredCount: 0,
        upsertedRouteIds: [],
        unavailableRouteIds,
      };
    }

    const connection = this.connections.get(connectionId);
    if (connection === undefined) {
      throw new Error(`Connection disappeared during reconciliation: ${connectionId}`);
    }

    const discoveredModelIds = new Set<string>();
    const upsertedRouteIds: string[] = [];
    for (const model of discovered) {
      const policy = this.routePolicy(connection, model);
      const modelIdentityId = buildModelIdentityId({ canonicalName: policy.canonicalName });
      this.modelIdentities.upsertExplicit({
        modelIdentityId,
        canonicalName: policy.canonicalName,
        aliases: [model.providerModelId],
      });
      this.modelIdentities.bindProviderModel({
        providerId: model.providerId,
        connectionId: model.connectionId,
        providerModelId: model.providerModelId,
        modelIdentityId,
      });

      let routeId: string;
      try {
        routeId = buildRouteId({
          providerId: model.providerId,
          connectionId: model.connectionId,
          providerModelId: model.providerModelId,
          executionProfile: policy.executionProfile,
        });
      } catch {
        continue;
      }

      this.routeCatalog.upsert({
        routeId,
        modelIdentityId,
        connectionId: model.connectionId,
        providerId: model.providerId,
        providerModelId: model.providerModelId,
        executionProfile: policy.executionProfile,
        capabilities: policy.capabilities,
        billingClass: policy.billingClass,
        routable: policy.routable,
        visibility:
          typeof policy.visibility === "function"
            ? policy.visibility(routeId)
            : policy.visibility,
      });
      discoveredModelIds.add(model.providerModelId);
      upsertedRouteIds.push(routeId);
    }

    const unavailableRouteIds: string[] = [];
    for (const route of existingRoutes) {
      if (!discoveredModelIds.has(route.providerModelId)) {
        this.routeCatalog.markUnavailable(connectionId, route.providerModelId);
        unavailableRouteIds.push(route.routeId);
      }
    }

    return {
      connectionId,
      failed: false,
      skipped: false,
      discoveredCount: discovered.length,
      upsertedRouteIds,
      unavailableRouteIds,
    };
  }
}
