import { assertStableId, buildRouteId } from "./ids.js";
import type { ModelIdentityStore } from "./model-identities.js";
import type { ProviderConnectionService } from "./provider-connections.js";
import type {
  AccessRoute,
  RouteCapabilities,
  RouteSurface,
  RouteVisibility,
} from "./types.js";

export interface RouteCatalogOptions {
  connections: ProviderConnectionService;
  modelIdentities: ModelIdentityStore;
}

const ROUTE_SURFACES = new Set<RouteSurface>([
  "cmmchat_model_picker",
  "cmmcode_model_picker",
  "admin_console",
]);

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function snapshotCapabilities(capabilities: RouteCapabilities): RouteCapabilities {
  if (
    typeof capabilities !== "object" ||
    capabilities === null ||
    typeof capabilities.chat !== "boolean" ||
    typeof capabilities.tools !== "boolean" ||
    typeof capabilities.streaming !== "boolean"
  ) {
    throw new TypeError("Route capabilities must contain boolean chat, tools and streaming fields");
  }
  if (
    capabilities.vision !== undefined &&
    typeof capabilities.vision !== "boolean"
  ) {
    throw new TypeError("Route capability vision must be boolean when supplied");
  }
  if (
    capabilities.reasoningEffort !== undefined &&
    typeof capabilities.reasoningEffort !== "boolean"
  ) {
    throw new TypeError("Route capability reasoningEffort must be boolean when supplied");
  }

  const snapshot: RouteCapabilities = {
    chat: capabilities.chat,
    tools: capabilities.tools,
    streaming: capabilities.streaming,
  };
  if (capabilities.vision !== undefined) snapshot.vision = capabilities.vision;
  if (capabilities.reasoningEffort !== undefined) {
    snapshot.reasoningEffort = capabilities.reasoningEffort;
  }
  return snapshot;
}

function snapshotVisibility(visibility: RouteVisibility): RouteVisibility {
  if (
    typeof visibility !== "object" ||
    visibility === null ||
    !Array.isArray(visibility.visibleOn)
  ) {
    throw new TypeError("Route visibility must contain a visibleOn array");
  }

  const visibleOn = visibility.visibleOn.map((surface) => {
    if (!ROUTE_SURFACES.has(surface)) {
      throw new TypeError("Route visibility contains an unsupported surface");
    }
    return surface;
  });
  return { visibleOn };
}

function snapshotRoute(route: AccessRoute): AccessRoute {
  if (typeof route !== "object" || route === null) {
    throw new TypeError("Access route must be an object");
  }
  assertStableId(route.routeId, "route");
  assertStableId(route.modelIdentityId, "model");
  assertNonEmpty(route.connectionId, "connectionId");
  assertNonEmpty(route.providerId, "providerId");
  assertNonEmpty(route.providerModelId, "providerModelId");
  assertNonEmpty(route.executionProfile, "executionProfile");
  assertNonEmpty(route.billingClass, "billingClass");
  if (typeof route.routable !== "boolean") {
    throw new TypeError("routable must be boolean");
  }

  const expectedRouteId = buildRouteId({
    providerId: route.providerId,
    connectionId: route.connectionId,
    providerModelId: route.providerModelId,
    executionProfile: route.executionProfile,
  });
  if (route.routeId !== expectedRouteId) {
    throw new Error("Route ID does not match its provider, connection, model and execution profile");
  }

  return {
    routeId: route.routeId,
    modelIdentityId: route.modelIdentityId,
    connectionId: route.connectionId,
    providerId: route.providerId,
    providerModelId: route.providerModelId,
    executionProfile: route.executionProfile,
    capabilities: snapshotCapabilities(route.capabilities),
    billingClass: route.billingClass,
    routable: route.routable,
    visibility: snapshotVisibility(route.visibility),
  };
}

export class RouteCatalog {
  private readonly routes = new Map<string, AccessRoute>();
  private readonly connections: ProviderConnectionService;
  private readonly modelIdentities: ModelIdentityStore;

  constructor(options: RouteCatalogOptions) {
    this.connections = options.connections;
    this.modelIdentities = options.modelIdentities;
  }

  upsert(route: AccessRoute): AccessRoute {
    const stored = snapshotRoute(route);
    if (
      !this.modelIdentities
        .list()
        .some((identity) => identity.modelIdentityId === stored.modelIdentityId)
    ) {
      throw new Error(`Unknown model identity: ${stored.modelIdentityId}`);
    }
    this.routes.set(stored.routeId, stored);
    return snapshotRoute(stored);
  }

  get(routeId: string): AccessRoute | undefined {
    const route = this.routes.get(routeId);
    return route === undefined ? undefined : snapshotRoute(route);
  }

  list(): AccessRoute[] {
    return [...this.routes.values()].map(snapshotRoute);
  }

  listVisible(surface: RouteSurface): AccessRoute[] {
    if (!ROUTE_SURFACES.has(surface)) {
      throw new TypeError("Unsupported route surface");
    }
    return [...this.routes.values()]
      .filter((route) => route.visibility.visibleOn.includes(surface))
      .map(snapshotRoute);
  }

  async resolveForConsumer(
    routeId: string,
    surface: RouteSurface,
  ): Promise<AccessRoute> {
    if (!ROUTE_SURFACES.has(surface)) {
      throw new TypeError("Unsupported route surface");
    }
    const route = this.routes.get(routeId);
    if (route === undefined) {
      throw new Error(`Unknown route: ${routeId}`);
    }
    if (!route.visibility.visibleOn.includes(surface)) {
      throw new Error(`Route is not visible on consumer surface: ${surface}`);
    }
    if (!route.routable) {
      throw new Error(`Route is not routable: ${routeId}`);
    }

    const connection = await this.connections.validateExecution(route.connectionId);
    if (connection.status !== "ready" || connection.providerId !== route.providerId) {
      throw new Error(`Route connection is not execution-ready: ${route.connectionId}`);
    }
    return snapshotRoute(route);
  }

  markUnavailable(connectionId: string, providerModelId: string): void {
    assertNonEmpty(connectionId, "connectionId");
    assertNonEmpty(providerModelId, "providerModelId");
    for (const route of this.routes.values()) {
      if (
        route.connectionId === connectionId &&
        route.providerModelId === providerModelId
      ) {
        route.routable = false;
      }
    }
  }
}
