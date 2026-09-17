import type {
  ProductSummary,
  RouterCatalogProjection,
} from "../../catalog/projection.js";
import type { ProductKind, RouteSurface } from "../../catalog/types.js";
import type {
  AccessRoute,
  ModelIdentity,
  Product,
  Provider,
} from "../domain/types.js";
import type { UsageQueryService } from "../service/usage-query-service.js";
import type { UsageStore } from "../storage/usage-store.js";
import { friendlyProductName, projectAccessOffer } from "./access-offer.js";
import type { ProviderDirectory } from "./provider-directory.js";
import { projectQuotaSummary } from "./quota-presentation.js";
import type {
  AccessOfferSummary,
  CatalogProviderView,
  CatalogRouteEntry,
  CatalogRouteVisibilityView,
  QuotaSummary,
  UsageRouteStatus,
} from "./types.js";

/**
 * Read-only source of the current canonical Router catalog.
 *
 * CMM Usage depends on this interface rather than on Router internals so
 * production can inject the in-process Router graph directly. It must never be
 * backed by an HTTP call to the router's own catalog endpoint.
 */
export interface RouterCatalogSource {
  read(): Promise<RouterCatalogProjection> | RouterCatalogProjection;
}

export interface PresentationCatalogServiceOptions {
  now?: () => Date;
}

const NO_CANONICAL_ROUTES = (): RouterCatalogProjection => ({
  providers: [],
  accounts: [],
  products: [],
  connections: [],
  models: [],
  routes: [],
});

/**
 * Router source for compositions that have no canonical Router graph wired
 * (for example a Usage-only harness). It reports no routes, so the catalog
 * never invents an operational route out of Usage observations.
 */
export function emptyRouterCatalogSource(): RouterCatalogSource {
  return { read: () => NO_CANONICAL_ROUTES() };
}

type ProductCategory = CatalogRouteEntry["product"]["category"];

function usageProductCategory(
  product: Product,
  provider: Provider,
): ProductCategory {
  if (product.kind === "subscription") return "subscription";
  if (product.kind === "custom" || provider.kind === "generic") return "custom";
  if (product.kind === "local") return "local";
  if (provider.kind === "aggregator") return "aggregator";
  return "api";
}

/**
 * Category fallback for a Router route Usage has not observed yet. Router has
 * no provider-kind concept, so the aggregator/custom distinction can only come
 * from Usage presentation metadata.
 */
function routerProductCategory(kind: ProductKind): ProductCategory {
  if (kind === "subscription" || kind === "enterprise") return "subscription";
  if (kind === "local") return "local";
  return "api";
}

/**
 * Offer fallback for a Router route Usage has not observed yet. It derives only
 * from the Router product kind and makes no source/confidence/validity claim,
 * because no Usage evidence stands behind it.
 */
function routerProductOffer(kind: ProductKind): AccessOfferSummary {
  switch (kind) {
    case "subscription":
    case "enterprise":
      return { kind: "INCLUDED" };
    case "api":
      return { kind: "PAYG" };
    case "free_pool":
      return { kind: "FREE" };
    case "promo_pool":
      return { kind: "PROMO" };
    case "local":
      return { kind: "UNKNOWN" };
  }
}

function offerFromProductKinds(
  routerKind: ProductKind | undefined,
  usageKind: string | undefined,
): AccessOfferSummary {
  if (routerKind !== undefined) return routerProductOffer(routerKind);
  if (usageKind === "subscription") return { kind: "INCLUDED" };
  if (usageKind === "api" || usageKind === "aggregator") return { kind: "PAYG" };
  return { kind: "UNKNOWN" };
}

function usageRouteStatus(route: AccessRoute | undefined): UsageRouteStatus {
  if (route === undefined) return "unknown";
  if (route.status === "available") return "available";
  if (route.status === "degraded" || route.status === "unavailable") {
    return "temporarily_unavailable";
  }
  return "unknown";
}

/**
 * A route is visible to a consumer when Router exposes it on any surface other
 * than the admin console.
 */
export function isVisibleToConsumer(
  visibleOn: readonly RouteSurface[],
): boolean {
  return visibleOn.some((surface) => surface !== "admin_console");
}

function currentAccessOffer(
  route: AccessRoute,
  product: Product,
  now: Date,
): AccessOfferSummary {
  const offer = projectAccessOffer(route, product);
  const expiringKind =
    offer.kind === "FREE" || offer.kind === "PROMO" || offer.kind === "TRIAL";
  if (!expiringKind || offer.validUntil === undefined) return offer;
  const validUntilMs = Date.parse(offer.validUntil);
  if (Number.isFinite(validUntilMs) && validUntilMs > now.getTime()) return offer;
  return { ...offer, kind: "UNKNOWN" };
}

/** Usage-side observability and presentation rows, indexed by canonical ID. */
interface UsageIndex {
  quotasByRoute: Map<string, QuotaSummary[]>;
  routes: Map<string, AccessRoute>;
  products: Map<string, Product>;
  providers: Map<string, Provider>;
  models: Map<string, ModelIdentity>;
}

interface ResolvedProduct {
  id: string;
  displayName: string;
  category: ProductCategory;
  routerKind: ProductKind | undefined;
  usageProduct: Product | undefined;
}

function resolveProduct(
  routerProduct: ProductSummary | undefined,
  usageProduct: Product | undefined,
  usageProvider: Provider | undefined,
): ResolvedProduct | undefined {
  if (routerProduct === undefined) {
    if (usageProduct === undefined) return undefined;
    return {
      id: usageProduct.id,
      displayName: friendlyProductName(usageProduct),
      category: usageProvider === undefined
        ? routerProductCategory("api")
        : usageProductCategory(usageProduct, usageProvider),
      routerKind: undefined,
      usageProduct,
    };
  }
  // Router owns product identity. Usage may refine the presentation label and
  // category only when its row agrees with Router about the product identity;
  // a disagreeing Usage row must never relabel or re-categorise the route.
  if (usageProduct !== undefined && usageProduct.id === routerProduct.productId) {
    return {
      id: routerProduct.productId,
      displayName: friendlyProductName(usageProduct),
      category: usageProvider === undefined
        ? routerProductCategory(routerProduct.kind)
        : usageProductCategory(usageProduct, usageProvider),
      routerKind: routerProduct.kind,
      usageProduct,
    };
  }
  return {
    id: routerProduct.productId,
    displayName: routerProduct.label,
    category: routerProductCategory(routerProduct.kind),
    routerKind: routerProduct.kind,
    usageProduct,
  };
}

export class PresentationCatalogService {
  private readonly now: () => Date;

  constructor(
    private readonly routerCatalog: RouterCatalogSource,
    private readonly store: UsageStore,
    private readonly queries: UsageQueryService,
    /**
     * Retained Usage presentation metadata for the Providers product surface.
     * Provider-directory authority moves in a later task; this task only
     * removes `VisibilityStore` as the effective-visibility authority.
     */
    private readonly directory: ProviderDirectory,
    options: PresentationCatalogServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async listProviders(): Promise<CatalogProviderView[]> {
    return this.directory.list().map((entry) => ({
      directory: entry,
      instanceIds: this.directory.instanceIds(entry.integrationType),
    }));
  }

  private async affectedRoutesByBucket(): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    for (const route of await this.store.listAccessRoutes()) {
      const graph = await this.store.getRouteGraph(route.id);
      for (const binding of graph.bindings) {
        const routes = result.get(binding.quotaBucketId) ?? [];
        if (!routes.includes(route.id)) routes.push(route.id);
        result.set(binding.quotaBucketId, routes);
      }
    }
    return result;
  }

  async listQuotaSummaries(): Promise<QuotaSummary[]> {
    const [quotaViews, routeViews, affectedRoutes] = await Promise.all([
      this.queries.listQuotas(),
      this.queries.listRoutes(),
      this.affectedRoutesByBucket(),
    ]);
    const primaryBucketIds = new Set(
      routeViews.flatMap((view) =>
        view.health.primaryConstraint === undefined
          ? []
          : [view.health.primaryConstraint.bucketId],
      ),
    );

    return quotaViews.map((view) => projectQuotaSummary({
      bucket: view.bucket,
      ...(view.reconciled.selected === undefined ? {} : { snapshot: view.reconciled.selected }),
      status: view.status,
      stale: view.reconciled.stale,
      constraining: primaryBucketIds.has(view.bucket.id),
      affectedRouteIds: affectedRoutes.get(view.bucket.id) ?? [],
    }));
  }

  private async usageIndex(): Promise<UsageIndex> {
    const [routes, products, providers, models, quotas] = await Promise.all([
      this.store.listAccessRoutes(),
      this.store.listProducts(),
      this.store.listProviders(),
      this.store.listModelIdentities(),
      this.listQuotaSummaries(),
    ]);
    const quotasByRoute = new Map<string, QuotaSummary[]>();
    for (const quota of quotas) {
      for (const routeId of quota.affectedRouteIds ?? []) {
        const values = quotasByRoute.get(routeId) ?? [];
        values.push(quota);
        quotasByRoute.set(routeId, values);
      }
    }
    return {
      quotasByRoute,
      routes: new Map(routes.map((route) => [route.id, route])),
      products: new Map(products.map((product) => [product.id, product])),
      providers: new Map(providers.map((provider) => [provider.id, provider])),
      models: new Map(models.map((model) => [model.id, model])),
    };
  }

  /**
   * Builds the current operational route list from Router truth.
   *
   * Iteration is driven exclusively by the Router projection. Usage SQLite can
   * enrich a route but can never add, remove, re-identify, hide, un-hide or
   * re-route one.
   */
  async listRoutes(): Promise<CatalogRouteEntry[]> {
    const [projection, usage] = await Promise.all([
      this.routerCatalog.read(),
      this.usageIndex(),
    ]);

    const providerById = new Map(
      projection.providers.map((provider) => [provider.providerId, provider]),
    );
    const productById = new Map(
      projection.products.map((product) => [product.productId, product]),
    );
    const modelById = new Map(
      projection.models.map((model) => [model.modelIdentityId, model]),
    );
    const connectionById = new Map(
      projection.connections.map((connection) => [connection.connectionId, connection]),
    );
    const accountById = new Map(
      projection.accounts.map((account) => [account.accountId, account]),
    );
    const now = this.now();

    const entries: CatalogRouteEntry[] = [];
    for (const route of projection.routes) {
      const connection = connectionById.get(route.connectionId);
      const usageRoute = usage.routes.get(route.routeId);
      const usageProduct = usageRoute === undefined
        ? undefined
        : usage.products.get(usageRoute.productId);
      const usageProvider = usageProduct === undefined
        ? undefined
        : usage.providers.get(usageProduct.providerId);

      // Router owns product identity; the Usage product row only refines the
      // presentation label and category of a product Usage already knows.
      const product = resolveProduct(
        (connection?.productId === undefined
          ? undefined
          : productById.get(connection.productId))
          ?? (usageProduct === undefined ? undefined : productById.get(usageProduct.id)),
        usageProduct,
        usageProvider,
      );
      if (product === undefined) {
        // No real product identity exists anywhere for this route. Emitting one
        // would fabricate product state, so the route stays out of the product
        // catalog while remaining visible on the Router catalog endpoint.
        continue;
      }

      const routerProvider = providerById.get(route.providerId);
      const account =
        connection?.accountId === undefined
          ? undefined
          : accountById.get(connection.accountId);
      const routerModel = modelById.get(route.modelIdentityId);
      const usageModel = usageRoute?.modelIdentityId === undefined
        ? undefined
        : usage.models.get(usageRoute.modelIdentityId);
      const family = routerModel?.family ?? usageModel?.family;
      const routeQuotas = usage.quotasByRoute.get(route.routeId) ?? [];
      const freshest = routeQuotas
        .filter((quota) => quota.observedAt !== undefined)
        .sort((left, right) => (right.observedAt ?? "").localeCompare(left.observedAt ?? ""))[0];

      entries.push({
        routeId: route.routeId,
        modelIdentityId: route.modelIdentityId,
        connectionId: route.connectionId,
        providerId: route.providerId,
        providerModelId: route.providerModelId,
        executionProfile: route.executionProfile,
        provider: {
          id: route.providerId,
          displayName: routerProvider?.displayName
            ?? usageProvider?.displayName
            ?? route.providerId,
        },
        ...(account === undefined
          ? {}
          : { account: { id: account.accountId, label: account.label } }),
        product: {
          id: product.id,
          displayName: product.displayName,
          category: product.category,
        },
        model: {
          id: route.modelIdentityId,
          displayName: routerModel?.canonicalName
            ?? usageModel?.canonicalName
            ?? usageRoute?.displayName
            ?? route.providerModelId,
          ...(family === undefined ? {} : { family }),
          aliases: [...(routerModel?.aliases ?? usageModel?.aliases ?? [])],
        },
        routable: route.routable,
        capabilities: { ...route.capabilities },
        billingClass: route.billingClass,
        visibility: { visibleOn: route.visibility.visibleOn.slice() },
        offer: usageRoute !== undefined && product.usageProduct !== undefined
          ? currentAccessOffer(usageRoute, product.usageProduct, now)
          : offerFromProductKinds(product.routerKind, product.usageProduct?.kind),
        quota: routeQuotas,
        ...(freshest === undefined
          ? {}
          : {
              freshness: {
                ...(freshest.observedAt === undefined ? {} : { observedAt: freshest.observedAt }),
                stale: routeQuotas.some((quota) => quota.stale === true),
              },
            }),
        usageStatus: usageRouteStatus(usageRoute),
      });
    }
    return entries;
  }

  async getRoute(routeId: string): Promise<CatalogRouteEntry | undefined> {
    return (await this.listRoutes()).find((route) => route.routeId === routeId);
  }

  async listVisibleRoutes(): Promise<CatalogRouteEntry[]> {
    return (await this.listRoutes())
      .filter((route) => isVisibleToConsumer(route.visibility.visibleOn));
  }

  async listPromotions(): Promise<CatalogRouteEntry[]> {
    return (await this.listRoutes()).filter(
      (route) => route.offer.kind === "FREE" || route.offer.kind === "PROMO" || route.offer.kind === "TRIAL",
    );
  }

  /**
   * Compatibility view of Router effective visibility for the current
   * operational routes. It replaces the former SQLite-preference read.
   */
  async listRouteVisibility(): Promise<CatalogRouteVisibilityView[]> {
    return (await this.listRoutes()).map((route) => ({
      scope: "global" as const,
      providerId: route.providerId,
      productId: route.product.id,
      routeId: route.routeId,
      state: isVisibleToConsumer(route.visibility.visibleOn)
        ? "visible" as const
        : "hidden" as const,
    }));
  }
}
