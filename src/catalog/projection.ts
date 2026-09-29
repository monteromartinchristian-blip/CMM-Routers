/**
 * Read-only Router catalog projection.
 *
 * Ported from `origin/feature/cmm-usage` `src/catalog/projection.ts`, limited to
 * the `GET /v1/cmm/catalog` read path. Two deliberate differences from that
 * branch, both so this branch pulls in no mutation surface and no un-ported
 * authority:
 *
 * 1. The collection sources are declared structurally here (`Listable<T>`)
 *    instead of `Pick<ProviderDirectory | ProviderConnectionService |
 *    ModelIdentityStore | RouteCatalog, "list">`. On the source branch those
 *    four stores are built from the provider manifests, the credential-binding
 *    stores, the secure credential resolver, `catalog/ids.ts`, the route
 *    visibility policy and the catalog reconciler (a live-discovery write path).
 *    None of that exists on this branch, and a `list()`-shaped source is exactly
 *    what the projection consumes, so the real stores stay structurally
 *    assignable when that graph lands.
 * 2. `buildCmmChatRouteProjection` is not ported: it feeds the CMMChat model
 *    picker, which is a separate consumer surface with its own wiring.
 *
 * The projection itself is unchanged: pure, synchronous, snapshot-only, and it
 * emits summary shapes that carry no credential, ref or secret material.
 */
import type {
  AccessRoute,
  Account,
  ModelIdentity,
  ProductKind,
  ProviderConnection,
  ProviderDefinition,
  ProviderProduct,
  RouteCapabilities,
  RouteSurface,
} from "./types.js";

/**
 * A read-only source of one catalog collection. The structural minimum the
 * projection needs from a store; no store method other than `list` is reachable
 * from the read path, so no write method can be.
 */
export interface Listable<T> {
  list(): T[];
}

export interface ProviderSummary {
  readonly providerId: string;
  readonly displayName: string;
}

export interface AccountSummary {
  readonly accountId: string;
  readonly providerId: string;
  readonly label: string;
  readonly identityStatus: Account["identityStatus"];
}

export interface ProductSummary {
  readonly productId: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly kind: ProductKind;
  readonly label: string;
}

export interface ProviderConnectionSummary {
  readonly connectionId: string;
  readonly providerId: string;
  readonly accountId?: string;
  readonly productId?: string;
  readonly connectionKind: string;
  readonly status: ProviderConnection["status"];
  readonly identityStatus: "resolved" | "unresolved";
}

export interface ModelIdentitySummary {
  readonly modelIdentityId: string;
  readonly canonicalName: string;
  readonly family?: string;
  readonly aliases: readonly string[];
}

export interface RouteCapabilitiesSummary {
  readonly chat: boolean;
  readonly tools: boolean;
  readonly vision?: boolean;
  readonly reasoningEffort?: boolean;
  readonly streaming: boolean;
}

export interface RouteVisibilitySummary {
  readonly visibleOn: readonly RouteSurface[];
}

export interface AccessRouteSummary {
  readonly routeId: string;
  readonly modelIdentityId: string;
  readonly connectionId: string;
  readonly providerId: string;
  readonly providerModelId: string;
  readonly executionProfile: string;
  readonly capabilities: RouteCapabilitiesSummary;
  readonly billingClass: string;
  readonly routable: boolean;
  readonly visibility: RouteVisibilitySummary;
}

export interface RouterCatalogProjection {
  readonly providers: readonly ProviderSummary[];
  readonly accounts: readonly AccountSummary[];
  readonly products: readonly ProductSummary[];
  readonly connections: readonly ProviderConnectionSummary[];
  readonly models: readonly ModelIdentitySummary[];
  readonly routes: readonly AccessRouteSummary[];
}

export interface RouterCatalogProjectionInput {
  readonly directory: Listable<ProviderDefinition>;
  readonly accounts: readonly Account[];
  readonly products: readonly ProviderProduct[];
  readonly connections: Listable<ProviderConnection>;
  readonly modelIdentities: Listable<ModelIdentity>;
  readonly routeCatalog: Listable<AccessRoute>;
}

function projectProvider(provider: ProviderDefinition): ProviderSummary {
  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
  };
}

function projectAccount(account: Account): AccountSummary {
  return {
    accountId: account.accountId,
    providerId: account.providerId,
    label: account.label,
    identityStatus: account.identityStatus,
  };
}

function projectProduct(product: ProviderProduct): ProductSummary {
  return {
    productId: product.productId,
    accountId: product.accountId,
    providerId: product.providerId,
    kind: product.kind,
    label: product.label,
  };
}

function projectConnection(
  connection: ProviderConnection,
  accountIdentityStatusById: ReadonlyMap<string, Account["identityStatus"]>,
): ProviderConnectionSummary {
  const identityStatus =
    connection.accountId === undefined
      ? "unresolved"
      : accountIdentityStatusById.get(connection.accountId) ?? "unresolved";
  if (connection.accountId !== undefined && connection.productId !== undefined) {
    return {
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      accountId: connection.accountId,
      productId: connection.productId,
      connectionKind: connection.connectionKind,
      status: connection.status,
      identityStatus,
    };
  }
  if (connection.accountId !== undefined) {
    return {
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      accountId: connection.accountId,
      connectionKind: connection.connectionKind,
      status: connection.status,
      identityStatus,
    };
  }
  if (connection.productId !== undefined) {
    return {
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      productId: connection.productId,
      connectionKind: connection.connectionKind,
      status: connection.status,
      identityStatus,
    };
  }
  return {
    connectionId: connection.connectionId,
    providerId: connection.providerId,
    connectionKind: connection.connectionKind,
    status: connection.status,
    identityStatus,
  };
}

function projectModel(identity: ModelIdentity): ModelIdentitySummary {
  if (identity.family !== undefined) {
    return {
      modelIdentityId: identity.modelIdentityId,
      canonicalName: identity.canonicalName,
      family: identity.family,
      aliases: identity.aliases.slice(),
    };
  }
  return {
    modelIdentityId: identity.modelIdentityId,
    canonicalName: identity.canonicalName,
    aliases: identity.aliases.slice(),
  };
}

function projectCapabilities(
  capabilities: RouteCapabilities,
): RouteCapabilitiesSummary {
  if (
    capabilities.vision !== undefined &&
    capabilities.reasoningEffort !== undefined
  ) {
    return {
      chat: capabilities.chat,
      tools: capabilities.tools,
      vision: capabilities.vision,
      reasoningEffort: capabilities.reasoningEffort,
      streaming: capabilities.streaming,
    };
  }
  if (capabilities.vision !== undefined) {
    return {
      chat: capabilities.chat,
      tools: capabilities.tools,
      vision: capabilities.vision,
      streaming: capabilities.streaming,
    };
  }
  if (capabilities.reasoningEffort !== undefined) {
    return {
      chat: capabilities.chat,
      tools: capabilities.tools,
      reasoningEffort: capabilities.reasoningEffort,
      streaming: capabilities.streaming,
    };
  }
  return {
    chat: capabilities.chat,
    tools: capabilities.tools,
    streaming: capabilities.streaming,
  };
}

function projectRoute(route: AccessRoute): AccessRouteSummary {
  return {
    routeId: route.routeId,
    modelIdentityId: route.modelIdentityId,
    connectionId: route.connectionId,
    providerId: route.providerId,
    providerModelId: route.providerModelId,
    executionProfile: route.executionProfile,
    capabilities: projectCapabilities(route.capabilities),
    billingClass: route.billingClass,
    routable: route.routable,
    visibility: { visibleOn: route.visibility.visibleOn.slice() },
  };
}

export function buildRouterCatalogProjection(
  input: RouterCatalogProjectionInput,
): RouterCatalogProjection {
  const accountIdentityStatusById = new Map(
    input.accounts.map((account) => [account.accountId, account.identityStatus] as const),
  );
  return {
    providers: input.directory.list().map(projectProvider),
    accounts: input.accounts.map(projectAccount),
    products: input.products.map(projectProduct),
    connections: input.connections
      .list()
      .map((connection) => projectConnection(connection, accountIdentityStatusById)),
    models: input.modelIdentities.list().map(projectModel),
    routes: input.routeCatalog.list().map(projectRoute),
  };
}
