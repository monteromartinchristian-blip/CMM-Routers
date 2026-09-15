import { RouterError } from "../core/errors.js";
import type { RouterEvent } from "../core/events.js";
import type { ProviderAdapter, ProviderHealth, RouterRequest } from "../core/provider.js";
import type { ProviderRegistry } from "../registry/provider-registry.js";
import type { ProviderConnectionService } from "./provider-connections.js";
import type { RouteCatalog } from "./route-catalog.js";
import type { ResolvedSecret } from "./secure-credential-resolver.js";
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

interface ResolvedExecutionAdapter extends ProviderAdapter {
  runWithResolvedExecution(
    request: RouterRequest,
    signal: AbortSignal,
    connection: Readonly<ProviderConnection>,
    executionProfile: string,
    credential: Readonly<ResolvedSecret>,
  ): AsyncIterable<RouterEvent>;
}

function supportsResolvedExecution(
  adapter: ProviderAdapter,
): adapter is ResolvedExecutionAdapter {
  return (
    typeof (adapter as Partial<ResolvedExecutionAdapter>).runWithResolvedExecution ===
    "function"
  );
}

class RouteBoundAdapter implements ProviderAdapter {
  readonly id: ProviderAdapter["id"];

  constructor(
    private readonly route: AccessRoute,
    private readonly connection: ProviderConnection,
    private readonly delegate: ProviderAdapter,
    private readonly connections: ProviderConnectionService,
  ) {
    this.id = delegate.id;
  }

  discoverModels(signal?: AbortSignal) {
    return this.delegate.discoverModels(signal);
  }

  health(signal?: AbortSignal): Promise<ProviderHealth> {
    return this.delegate.health(signal);
  }

  async *run(
    request: RouterRequest,
    signal: AbortSignal,
  ): AsyncIterable<RouterEvent> {
    if (
      request.model.provider !== this.route.providerId ||
      request.model.upstreamModel !== this.route.providerModelId ||
      this.delegate.id !== this.route.providerId
    ) {
      yield {
        type: "error",
        error: new RouterError("unknown_model", "Unknown or unavailable route"),
      };
      return;
    }

    const delegate = this.delegate;
    if (!supportsResolvedExecution(delegate)) {
      yield {
        type: "error",
        error: new RouterError("unknown_model", "Unknown or unavailable route"),
      };
      return;
    }

    try {
      const stream = this.connections.withExecutionCredential(
        this.connection.connectionId,
        (resolvedConnection, credential) => {
          if (
            resolvedConnection.connectionId !== this.route.connectionId ||
            resolvedConnection.providerId !== this.route.providerId ||
            resolvedConnection.connectionKind !== this.connection.connectionKind
          ) {
            throw new Error("Route execution connection changed after resolution");
          }

          return delegate.runWithResolvedExecution(
            request,
            signal,
            resolvedConnection,
            this.route.executionProfile,
            credential,
          );
        },
      );
      for await (const event of stream) yield event;
    } catch {
      yield {
        type: "error",
        error: new RouterError("unknown_model", "Unknown or unavailable route"),
      };
    }
  }

  cancel(requestId: string): Promise<void> {
    return this.delegate.cancel(requestId);
  }
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
    const connection = this.connections.authorizeExecution(route.connectionId);

    if (
      connection.connectionId !== route.connectionId ||
      connection.providerId !== route.providerId
    ) {
      throw new Error(`Route connection does not match route identity: ${route.routeId}`);
    }

    const registeredAdapter = this.registry.getAdapter(route.providerId);
    if (registeredAdapter === undefined || registeredAdapter.id !== route.providerId) {
      throw new Error(`No exact provider adapter is registered: ${route.providerId}`);
    }

    const adapter = new RouteBoundAdapter(
      route,
      connection,
      registeredAdapter,
      this.connections,
    );

    return {
      route,
      connection,
      adapter,
      providerModelId: route.providerModelId,
    };
  }
}
