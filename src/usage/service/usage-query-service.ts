import { AlertEngine } from "../alerts/alert-engine.js";
import type { QuotaStatus, RouteHealth } from "../domain/types.js";
import { resolveRouteHealth } from "../domain/quota-resolution.js";
import { forecastQuota, type QuotaForecast } from "../forecasting/quota-forecast.js";
import {
  reconcileQuotaSnapshots,
  type ReconciledQuotaState,
} from "../reconciliation/reconciler.js";
import type { UsageStore } from "../storage/usage-store.js";

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
}
