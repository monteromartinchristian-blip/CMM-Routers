import type { AccessRoute, Product, Provider } from "../domain/types.js";
import type { UsageQueryService } from "../service/usage-query-service.js";
import type { UsageStore } from "../storage/usage-store.js";
import { friendlyProductName, projectAccessOffer } from "./access-offer.js";
import type { ProviderDirectory } from "./provider-directory.js";
import { projectQuotaSummary } from "./quota-presentation.js";
import type {
  CatalogProviderView,
  CatalogRouteEntry,
  QuotaSummary,
} from "./types.js";
import type { VisibilityStore } from "./visibility-store.js";

export interface PresentationCatalogServiceOptions {
  now?: () => Date;
}

function productCategory(
  product: Product,
  provider: Provider,
): CatalogRouteEntry["product"]["category"] {
  if (product.kind === "subscription") return "subscription";
  if (product.kind === "custom" || provider.kind === "generic") return "custom";
  if (product.kind === "local") return "local";
  if (provider.kind === "aggregator") return "aggregator";
  return "api";
}

function routeAvailability(route: AccessRoute): CatalogRouteEntry["availability"] {
  if (route.status === "available") return "available";
  if (route.status === "degraded" || route.status === "unavailable") {
    return "temporarily_unavailable";
  }
  return "unknown";
}

function currentAccessOffer(
  route: AccessRoute,
  product: Product,
  now: Date,
): CatalogRouteEntry["offer"] {
  const offer = projectAccessOffer(route, product);
  const expiringKind =
    offer.kind === "FREE" || offer.kind === "PROMO" || offer.kind === "TRIAL";
  if (!expiringKind || offer.validUntil === undefined) return offer;
  const validUntilMs = Date.parse(offer.validUntil);
  if (Number.isFinite(validUntilMs) && validUntilMs > now.getTime()) return offer;
  return { ...offer, kind: "UNKNOWN" };
}

export class PresentationCatalogService {
  private readonly now: () => Date;

  constructor(
    private readonly store: UsageStore,
    private readonly queries: UsageQueryService,
    private readonly directory: ProviderDirectory,
    private readonly visibility: VisibilityStore,
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

  async listRoutes(): Promise<CatalogRouteEntry[]> {
    const [routes, quotas] = await Promise.all([
      this.store.listAccessRoutes(),
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

    const entries: CatalogRouteEntry[] = [];
    for (const route of routes) {
      const [product, model] = await Promise.all([
        this.store.getProduct(route.productId),
        route.modelIdentityId === undefined
          ? Promise.resolve(undefined)
          : this.store.getModelIdentity(route.modelIdentityId),
      ]);
      if (product === undefined) continue;
      const provider = await this.store.getProvider(product.providerId);
      if (provider === undefined) continue;
      const routeQuotas = quotasByRoute.get(route.id) ?? [];
      const visibility = await this.visibility.resolveRoute({
        providerId: provider.id,
        productId: product.id,
        routeId: route.id,
      });
      const freshest = routeQuotas
        .filter((quota) => quota.observedAt !== undefined)
        .sort((left, right) => (right.observedAt ?? "").localeCompare(left.observedAt ?? ""))[0];

      entries.push({
        routeId: route.id,
        ...(route.modelIdentityId === undefined ? {} : { modelIdentityId: route.modelIdentityId }),
        provider: {
          id: provider.id,
          displayName: provider.displayName,
        },
        product: {
          id: product.id,
          displayName: friendlyProductName(product),
          category: productCategory(product, provider),
        },
        model: {
          id: model?.id ?? route.providerModelId,
          displayName: model?.canonicalName ?? route.displayName,
          ...(model?.family === undefined ? {} : { family: model.family }),
        },
        offer: currentAccessOffer(route, product, this.now()),
        quota: routeQuotas,
        availability: routeAvailability(route),
        visibility,
        ...(freshest === undefined
          ? {}
          : {
              freshness: {
                ...(freshest.observedAt === undefined ? {} : { observedAt: freshest.observedAt }),
                stale: routeQuotas.some((quota) => quota.stale === true),
              },
            }),
      });
    }
    return entries;
  }

  async getRoute(routeId: string): Promise<CatalogRouteEntry | undefined> {
    return (await this.listRoutes()).find((route) => route.routeId === routeId);
  }

  async listVisibleRoutes(): Promise<CatalogRouteEntry[]> {
    return (await this.listRoutes()).filter((route) => route.visibility === "visible");
  }

  async listPromotions(): Promise<CatalogRouteEntry[]> {
    return (await this.listRoutes()).filter(
      (route) => route.offer.kind === "FREE" || route.offer.kind === "PROMO" || route.offer.kind === "TRIAL",
    );
  }
}
