import type { ProviderAdapter } from "../core/provider.js";
import type { ProviderRegistry } from "../registry/provider-registry.js";
import type { ProviderConnectionService } from "./provider-connections.js";
import type { RouteCatalog } from "./route-catalog.js";
import type {
  AccessRoute,
  ProviderConnection,
  RouteSurface,
} from "./types.js";

export interface ResolvedExecutionRoute {
  route: AccessRoute;
  connection: ProviderConnection;
  adapter: ProviderAdapter;
  providerModelId: string;
}

export interface CatalogRuntimeBridgeOptions {
  catalog: RouteCatalog;
  connections: ProviderConnectionService;
  registry: ProviderRegistry;
}

/**
 * Resolves a catalog-selected route into the exact runtime objects needed for
 * execution. Catalog visibility, routability and execution authorization are
 * checked before the provider registry is consulted.
 */
export class CatalogRuntimeBridge {
  private readonly catalog: RouteCatalog;
  private readonly connections: ProviderConnectionService;
  private readonly registry: ProviderRegistry;

  constructor(options: CatalogRuntimeBridgeOptions) {
    this.catalog = options.catalog;
    this.connections = options.connections;
    this.registry = options.registry;
  }

  async resolve(
    routeId: string,
    consumerSurface: RouteSurface,
  ): Promise<ResolvedExecutionRoute> {
    const route = await this.catalog.resolveForConsumer(routeId, consumerSurface);
    const connection = await this.connections.validateExecution(route.connectionId);

    if (
      connection.connectionId !== route.connectionId ||
      connection.providerId !== route.providerId
    ) {
      throw new Error(`Route connection does not match route identity: ${route.routeId}`);
    }

    const adapter = this.registry.getAdapter(route.providerId);
    if (adapter === undefined || adapter.id !== route.providerId) {
      throw new Error(`No exact provider adapter is registered: ${route.providerId}`);
    }

    return {
      route,
      connection,
      adapter,
      providerModelId: route.providerModelId,
    };
  }
}
