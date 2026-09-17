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
  rollbackOnFailure?: boolean;
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

    let discovered: DiscoveredProviderModel[];
    try {
      discovered = await this.connections.discoverModels(connectionId);
    } catch {
      const existingRoutes = this.routeCatalog
        .list()
        .filter((route) => route.connectionId === connectionId);
      const routeJournal = this.routeCatalog.beginMutationJournal();
      // markUnavailable mutates every sibling route sharing this connection and
      // provider model, so every route of this connection must be captured
      // before the first mutation.
      for (const route of existingRoutes) routeJournal.captureRoute(route.routeId);
      const unavailableRouteIds: string[] = [];
      for (const route of existingRoutes) {
        this.routeCatalog.markUnavailable(connectionId, route.providerModelId);
        unavailableRouteIds.push(route.routeId);
      }
      if (options.rollbackOnFailure === true) routeJournal.rollback();
      return {
        connectionId,
        failed: true,
        skipped: false,
        discoveredCount: 0,
        upsertedRouteIds: [],
        unavailableRouteIds,
      };
    }

    return this.reconcileDiscoveredModels(connectionId, discovered);
  }

  reconcileDiscoveredModels(
    connectionId: string,
    discovered: readonly DiscoveredProviderModel[],
    routePolicy: CatalogRoutePolicy = this.routePolicy,
  ): ConnectionReconcileResult {
    const existingRoutes = this.routeCatalog
      .list()
      .filter((route) => route.connectionId === connectionId);

    const connection = this.connections.get(connectionId);
    if (connection === undefined) {
      throw new Error(`Connection disappeared during reconciliation: ${connectionId}`);
    }

    const modelJournal = this.modelIdentities.beginMutationJournal();
    const routeJournal = this.routeCatalog.beginMutationJournal();
    try {
      // Capture every route of this connection up front: markUnavailable
      // mutates all sibling routes sharing a connection and provider model, so
      // capturing lazily inside the mutation loop would journal already-mutated
      // siblings.
      for (const route of existingRoutes) routeJournal.captureRoute(route.routeId);

      const discoveredModelIds = new Set<string>();
      const upsertedRouteIds: string[] = [];
      for (const model of discovered) {
        if (model.connectionId !== connectionId || model.providerId !== connection.providerId) {
          throw new Error("Discovered model does not match the exact provider connection");
        }
        const policy = routePolicy(connection, model);
        const modelIdentityId = buildModelIdentityId({ canonicalName: policy.canonicalName });
        modelJournal.captureIdentity(modelIdentityId);
        modelJournal.captureProviderModelBinding(
          model.providerId,
          model.connectionId,
          model.providerModelId,
        );
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

        routeJournal.captureRoute(routeId);
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
    } catch (error) {
      routeJournal.rollback();
      modelJournal.rollback();
      throw error;
    }
  }
}
