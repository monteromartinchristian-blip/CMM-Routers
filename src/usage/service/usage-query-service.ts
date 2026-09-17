import { AlertEngine } from "../alerts/alert-engine.js";
import type {
  AccessRoute,
  CostEvent,
  ModelIdentity,
  Product,
  Provider,
  QuotaBucket,
  QuotaSnapshot,
  QuotaStatus,
  RouteHealth,
  SubscriptionPeriod,
  UsageEvent,
} from "../domain/types.js";
import { resolveRouteHealth } from "../domain/quota-resolution.js";
import { forecastQuota, type QuotaForecast } from "../forecasting/quota-forecast.js";
import {
  reconcileQuotaSnapshots,
  type ReconciledQuotaState,
} from "../reconciliation/reconciler.js";
import type { UsageStore } from "../storage/usage-store.js";

/**
 * Historical Usage for one canonical route, with an explicit marker for
 * whether that route is still a current operational (Router-owned) route.
 */
export interface HistoricalRouteUsageView {
  routeId: string;
  currentOperationalRoute: boolean;
  usageEvents: UsageEvent[];
  costEvents: CostEvent[];
  quotaSnapshots: QuotaSnapshot[];
}

export interface QuotaStateView {
  bucketId: string;
  status: QuotaStatus;
  reconciled: ReconciledQuotaState;
  forecast: QuotaForecast;
}

export interface ModelConstraintView {
  modelIdentityId: string;
  routes: RouteHealth[];
}

export interface ProviderPressureView {
  providerId: string;
  status: QuotaStatus;
  routes: RouteHealth[];
}

export interface UsageQueryServiceOptions {
  now?: () => Date;
}

export interface ProviderUsageView {
  provider: Provider;
  pressure: ProviderPressureView;
}

export interface ModelUsageView {
  model: ModelIdentity;
  constraints: ModelConstraintView;
}

export interface RouteUsageView {
  route: AccessRoute;
  health: RouteHealth;
}

export interface QuotaUsageView extends QuotaStateView {
  bucket: QuotaBucket;
}

export interface UsageAlertView {
  bucketId: string;
  status: Extract<QuotaStatus, "warning" | "critical" | "exhausted">;
  kind: "usage_fraction" | "predicted_exhaustion" | "quota_exhausted";
}

export interface UsageOverview {
  generatedAt: string;
  providerCount: number;
  productCount: number;
  modelCount: number;
  routeCount: number;
  quotaCount: number;
  warningCount: number;
  criticalCount: number;
  exhaustedCount: number;
}

const statusRank: Record<QuotaStatus, number> = {
  healthy: 0,
  unknown: 1,
  unavailable: 2,
  warning: 3,
  critical: 4,
  exhausted: 5,
};

export class UsageQueryService {
  private readonly now: () => Date;

  constructor(
    private readonly store: UsageStore,
    options: UsageQueryServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async getQuotaState(quotaBucketId: string): Promise<QuotaStateView> {
    const bucket = await this.store.getQuotaBucket(quotaBucketId);
    if (bucket === undefined) throw new Error(`Unknown quota bucket: ${quotaBucketId}`);
    const snapshots = await this.store.getCurrentQuotaState(quotaBucketId);
    const now = this.now();
    const reconciled = reconcileQuotaSnapshots(snapshots, now);
    const forecast = forecastQuota(bucket, snapshots, now);
    const status = new AlertEngine().evaluate({
      bucket,
      ...(reconciled.selected === undefined ? {} : { snapshot: reconciled.selected }),
      forecast,
      now,
    }).status;
    return { bucketId: quotaBucketId, status, reconciled, forecast };
  }

  async getRouteHealth(accessRouteId: string): Promise<RouteHealth> {
    const graph = await this.store.getRouteGraph(accessRouteId);
    const statesByBucket = new Map<string, Awaited<ReturnType<UsageQueryService["getQuotaState"]>>>();
    for (const binding of graph.bindings) {
      if (!statesByBucket.has(binding.quotaBucketId)) {
        statesByBucket.set(binding.quotaBucketId, await this.getQuotaState(binding.quotaBucketId));
      }
    }

    const quotaStates = graph.quotaStates.map(({ bucket }) => {
      const view = statesByBucket.get(bucket.id);
      if (view === undefined) return { bucket };
      return {
        bucket: { ...bucket, status: view.status },
        ...(view.reconciled.selected === undefined ? {} : { snapshot: view.reconciled.selected }),
        ...(view.forecast.predictedExhaustionAt === undefined
          ? {}
          : { predictedExhaustionAt: view.forecast.predictedExhaustionAt }),
      };
    });

    return resolveRouteHealth({
      accessRoute: graph.accessRoute,
      bindings: graph.bindings,
      quotaStates,
      now: this.now().toISOString(),
    });
  }

  async getModelConstraints(modelIdentityId: string): Promise<ModelConstraintView> {
    if ((await this.store.getModelIdentity(modelIdentityId)) === undefined) {
      throw new Error(`Unknown model identity: ${modelIdentityId}`);
    }
    const routes = (await this.store.listAccessRoutes()).filter(
      (route) => route.modelIdentityId === modelIdentityId,
    );
    return {
      modelIdentityId,
      routes: await Promise.all(routes.map((route) => this.getRouteHealth(route.id))),
    };
  }

  async getProviderPressure(providerId: string): Promise<ProviderPressureView> {
    if ((await this.store.getProvider(providerId)) === undefined) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    const providerRoutes = [];
    for (const route of await this.store.listAccessRoutes()) {
      const product = await this.store.getProduct(route.productId);
      if (product?.providerId === providerId) providerRoutes.push(route);
    }
    const routes = await Promise.all(providerRoutes.map((route) => this.getRouteHealth(route.id)));
    const status = routes.reduce<QuotaStatus>(
      (current, route) => (statusRank[route.status] > statusRank[current] ? route.status : current),
      routes.length === 0 ? "unknown" : "healthy",
    );
    return { providerId, status, routes };
  }

  async getOverview(): Promise<UsageOverview> {
    const [providers, products, models, routes, quotas] = await Promise.all([
      this.store.listProviders(),
      this.store.listProducts(),
      this.store.listModelIdentities(),
      this.store.listAccessRoutes(),
      this.listQuotas(),
    ]);
    return {
      generatedAt: this.now().toISOString(),
      providerCount: providers.length,
      productCount: products.length,
      modelCount: models.length,
      routeCount: routes.length,
      quotaCount: quotas.length,
      warningCount: quotas.filter((quota) => quota.status === "warning").length,
      criticalCount: quotas.filter((quota) => quota.status === "critical").length,
      exhaustedCount: quotas.filter((quota) => quota.status === "exhausted").length,
    };
  }

  async listProviders(): Promise<ProviderUsageView[]> {
    const providers = await this.store.listProviders();
    return Promise.all(
      providers.map(async (provider) => ({
        provider,
        pressure: await this.getProviderPressure(provider.id),
      })),
    );
  }

  async listProducts(): Promise<Product[]> {
    return this.store.listProducts();
  }

  async listModels(): Promise<ModelUsageView[]> {
    const models = await this.store.listModelIdentities();
    return Promise.all(
      models.map(async (model) => ({
        model,
        constraints: await this.getModelConstraints(model.id),
      })),
    );
  }

  async listRoutes(): Promise<RouteUsageView[]> {
    const routes = await this.store.listAccessRoutes();
    return Promise.all(
      routes.map(async (route) => ({
        route,
        health: await this.getRouteHealth(route.id),
      })),
    );
  }

  async listQuotas(): Promise<QuotaUsageView[]> {
    const buckets = await this.store.listQuotaBuckets();
    return Promise.all(
      buckets.map(async (bucket) => ({
        bucket,
        ...(await this.getQuotaState(bucket.id)),
      })),
    );
  }

  async listHistory(limit = 100): Promise<UsageEvent[]> {
    return this.store.listUsageEvents(limit);
  }

  async listCosts(limit = 100): Promise<CostEvent[]> {
    return this.store.listCostEvents(limit);
  }

  async listSubscriptions(): Promise<SubscriptionPeriod[]> {
    return this.store.listSubscriptionPeriods();
  }

  /**
   * Historical observations for one canonical route id.
   *
   * Usage history is indexed by the canonical Router route id stored on each
   * row and is deliberately independent of whether that route is still part of
   * the current Router projection: retiring or disconnecting a Router route
   * must never delete the accounting Usage already observed for it.
   *
   * `currentOperationalRoute` is the explicit non-current marker — it is
   * `false` when the route is no longer in the caller's current operational
   * route set, while every observation is still returned.
   */
  async getRouteHistory(
    routeId: string,
    currentRouteIds: ReadonlySet<string> = new Set(),
    limit = 100,
  ): Promise<HistoricalRouteUsageView> {
    const [usageEvents, costEvents, quotaSnapshots] = await Promise.all([
      this.store.listRouteUsageEvents(routeId, limit),
      this.store.listRouteCostEvents(routeId, limit),
      this.store.listRouteQuotaSnapshots(routeId, limit),
    ]);
    return {
      routeId,
      currentOperationalRoute: currentRouteIds.has(routeId),
      usageEvents,
      costEvents,
      quotaSnapshots,
    };
  }

  async listAlerts(): Promise<UsageAlertView[]> {
    const quotas = await this.listQuotas();
    const alerts: UsageAlertView[] = [];
    for (const quota of quotas) {
      if (quota.status === "exhausted") {
        alerts.push({ bucketId: quota.bucketId, status: quota.status, kind: "quota_exhausted" });
        continue;
      }
      if (quota.status !== "critical" && quota.status !== "warning") continue;
      alerts.push({
        bucketId: quota.bucketId,
        status: quota.status,
        kind: quota.forecast.willExhaustBeforeReset
          ? "predicted_exhaustion"
          : "usage_fraction",
      });
    }
    return alerts;
  }
}
