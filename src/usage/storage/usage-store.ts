import type {
  AccessRoute,
  Account,
  ConsumptionRule,
  CostEvent,
  ModelIdentity,
  Product,
  Provider,
  QuotaBinding,
  QuotaBucket,
  QuotaGroup,
  QuotaSnapshot,
  RouteGraph,
  SubscriptionPeriod,
  UsageEvent,
} from "../domain/types.js";

export interface UsageStore {
  initialize(): Promise<void>;
  close(): Promise<void>;

  upsertProvider(value: Provider): Promise<void>;
  upsertAccount(value: Account): Promise<void>;
  upsertProduct(value: Product): Promise<void>;
  upsertSubscriptionPeriod(value: SubscriptionPeriod): Promise<void>;
  upsertModelIdentity(value: ModelIdentity): Promise<void>;
  upsertAccessRoute(value: AccessRoute): Promise<void>;
  upsertQuotaGroup(value: QuotaGroup): Promise<void>;
  upsertQuotaBucket(value: QuotaBucket): Promise<void>;
  upsertQuotaBinding(value: QuotaBinding): Promise<void>;
  upsertConsumptionRule(value: ConsumptionRule): Promise<void>;

  appendUsageEvents(values: readonly UsageEvent[]): Promise<void>;
  appendCostEvents(values: readonly CostEvent[]): Promise<void>;
  appendQuotaSnapshots(values: readonly QuotaSnapshot[]): Promise<void>;

  getProvider(id: string): Promise<Provider | undefined>;
  getAccount(id: string): Promise<Account | undefined>;
  getProduct(id: string): Promise<Product | undefined>;
  getSubscriptionPeriod(id: string): Promise<SubscriptionPeriod | undefined>;
  listSubscriptionPeriods(productId?: string): Promise<SubscriptionPeriod[]>;
  getModelIdentity(id: string): Promise<ModelIdentity | undefined>;
  getAccessRoute(id: string): Promise<AccessRoute | undefined>;
  listAccessRoutes(productId?: string): Promise<AccessRoute[]>;
  getQuotaBucket(id: string): Promise<QuotaBucket | undefined>;
  getCurrentQuotaState(bucketId: string): Promise<QuotaSnapshot[]>;
  getRouteGraph(accessRouteId: string): Promise<RouteGraph>;
  listUsageEvents(limit?: number): Promise<UsageEvent[]>;
}
