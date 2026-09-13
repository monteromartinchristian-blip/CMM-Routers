import type {
  AccessRoute,
  Account,
  Product,
  Provider,
  QuotaBinding,
  QuotaBucket,
  QuotaSnapshot,
  QuotaStatus,
  SubscriptionPeriod,
  WindowPolicy,
} from "../../domain/types.js";
import {
  UsageAdapterError,
  unsupported,
  type CostEventBatch,
  type QuotaSnapshotBatch,
  type UsageAdapter,
  type UsageAdapterCapability,
  type UsageAdapterHealth,
  type UsageAdapterManifest,
  type UsageDiscoveryResult,
  type UsageEventBatch,
  type UsageRefreshResult,
} from "../contract.js";

const COMMAND_CODE_PROVIDER_ID = "provider:command-code";
const COMMAND_CODE_ACCOUNT_ID = "account:command-code";
const CACHE_TTL_MS = 60_000;

export interface CommandCodeCredential {
  reference: string;
  resolve(reference: string): string | undefined | Promise<string | undefined>;
}

export interface CommandCodeRouteDefinition {
  providerModelId: string;
  displayName: string;
}

export interface CommandCodeUsageAdapterOptions {
  baseUrl: string;
  credential: CommandCodeCredential;
  routes?: readonly CommandCodeRouteDefinition[];
  fetch?: typeof fetch;
  now?: () => Date;
}

interface CommandCodeWindowLimit {
  used: number;
  cap: number;
  resetAt?: string;
}

interface CommandCodeOrgLimit {
  scope: "org" | "model";
  model?: string;
  modelLabel?: string;
  spent: number;
  limit: number;
  resetInterval?: string;
  resetAt?: string;
  exceeded: boolean;
}

interface LoadedUsage {
  loadedAtMs: number;
  observedAt: string;
  orgId?: string;
  planId?: string;
  subscriptionStatus?: string;
  periodStart?: string;
  periodEnd?: string;
  monthlyCredits?: number;
  purchasedCredits?: number;
  freeCredits?: number;
  fiveHour?: CommandCodeWindowLimit;
  weekly?: CommandCodeWindowLimit;
  orgLimits: CommandCodeOrgLimit[];
  summaryTotalCost?: number;
  summaryTotalCount?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function productId(planId: string | undefined): string {
  return `product:command-code:${stablePart(planId ?? "plan")}`;
}

function routeId(modelId: string): string {
  return `route:command-code:${stablePart(modelId)}`;
}

function bucketId(providerKey: string): string {
  return `bucket:command-code:${stablePart(providerKey)}`;
}

function bindingId(route: string, bucket: string): string {
  return `binding:command-code:${stablePart(route)}:${stablePart(bucket)}`;
}

function statusFromFraction(usedFraction: number | undefined, exceeded = false): QuotaStatus {
  if (exceeded || (usedFraction !== undefined && usedFraction >= 1)) return "exhausted";
  if (usedFraction === undefined) return "unknown";
  if (usedFraction >= 0.9) return "critical";
  if (usedFraction >= 0.75) return "warning";
  return "healthy";
}

function exactFraction(used: number, limit: number): number | undefined {
  if (limit <= 0) return undefined;
  return Math.min(1, Math.max(0, used / limit));
}

function windowLimit(value: unknown): CommandCodeWindowLimit | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const used = nonNegativeNumber(record.used);
  const cap = nonNegativeNumber(record.cap);
  if (used === undefined || cap === undefined) return undefined;
  const resetAt = isoTimestamp(record.resetAt);
  return { used, cap, ...(resetAt === undefined ? {} : { resetAt }) };
}

function orgLimits(value: unknown): CommandCodeOrgLimit[] {
  if (!Array.isArray(value)) return [];
  const result: CommandCodeOrgLimit[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const scope = record.scope;
    if (scope !== "org" && scope !== "model") continue;
    const spent = nonNegativeNumber(record.spent);
    const limit = nonNegativeNumber(record.limit);
    if (spent === undefined || limit === undefined) continue;
    const model = nonEmptyString(record.model);
    if (scope === "model" && model === undefined) continue;
    const modelLabel = nonEmptyString(record.modelLabel);
    const resetInterval = nonEmptyString(record.resetInterval);
    const resetAt = isoTimestamp(record.resetAt);
    result.push({
      scope,
      spent,
      limit,
      exceeded: record.exceeded === true,
      ...(model === undefined ? {} : { model }),
      ...(modelLabel === undefined ? {} : { modelLabel }),
      ...(resetInterval === undefined ? {} : { resetInterval }),
      ...(resetAt === undefined ? {} : { resetAt }),
    });
  }
  return result;
}

function subscriptionStatus(value: string | undefined): SubscriptionPeriod["status"] | undefined {
  if (
    value === "active" ||
    value === "paused" ||
    value === "cancelled" ||
    value === "expired" ||
    value === "archived"
  ) {
    return value;
  }
  return undefined;
}

function orgLimitKey(limit: CommandCodeOrgLimit): string {
  return limit.scope === "model" && limit.model !== undefined
    ? `org-limit:model:${limit.model}`
    : "org-limit:org";
}

function orgLimitWindow(limit: CommandCodeOrgLimit): WindowPolicy {
  return limit.resetInterval === undefined
    ? { kind: "provider_reported" }
    : { kind: "provider_reported" };
}

function snapshotStaleness(observedAt: string): string {
  return new Date(Date.parse(observedAt) + CACHE_TTL_MS).toISOString();
}

export class CommandCodeUsageAdapter implements UsageAdapter {
  readonly id = "command-code";
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly baseUrl: URL;
  private cached: LoadedUsage | undefined;

  constructor(private readonly options: CommandCodeUsageAdapterOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  }

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName: "Command Code",
      collectionSafety: "non_inference_only",
      minimumRefreshIntervalMs: CACHE_TTL_MS,
    };
  }

  capabilities(): ReadonlySet<UsageAdapterCapability> {
    return new Set([
      "discover_accounts",
      "discover_products",
      "discover_models",
      "discover_quota_graph",
      "collect_quota_snapshots",
      "manual_refresh",
      "background_refresh",
    ]);
  }

  async health(): Promise<UsageAdapterHealth> {
    return { status: "healthy", detail: "Command Code CLI usage metadata" };
  }

  private async requestJson(path: string, credential: string): Promise<unknown> {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new UsageAdapterError("protocol", "Command Code metadata endpoint escaped API origin");
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential}`,
        },
      });
    } catch {
      throw new UsageAdapterError("unavailable", "Command Code metadata endpoint is unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new UsageAdapterError("auth", "Command Code metadata rejected credentials");
    }
    if (response.status === 429) {
      throw new UsageAdapterError("rate_limit", "Command Code metadata rate limited the request");
    }
    if (!response.ok) {
      throw new UsageAdapterError("unavailable", `Command Code metadata returned ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new UsageAdapterError("protocol", "Command Code metadata returned invalid JSON");
    }
  }

  private async load(force = false): Promise<LoadedUsage> {
    const now = this.now();
    const nowMs = now.getTime();
    if (!force && this.cached !== undefined && nowMs - this.cached.loadedAtMs < CACHE_TTL_MS) {
      return this.cached;
    }

    let credential: string | undefined;
    try {
      credential = await this.options.credential.resolve(this.options.credential.reference);
    } catch {
      throw new UsageAdapterError("auth", "Command Code credential resolution failed");
    }
    if (!credential) throw new UsageAdapterError("auth", "Command Code credential is unavailable");

    const whoami = asRecord(await this.requestJson("/alpha/whoami?limits=1", credential));
    if (!whoami) throw new UsageAdapterError("protocol", "Command Code whoami response is invalid");
    const org = asRecord(whoami.org);
    const orgId = nonEmptyString(org?.id);
    const queryOrg = orgId === undefined ? "" : `?orgId=${encodeURIComponent(orgId)}`;

    const creditsResponse = asRecord(
      await this.requestJson(`/alpha/billing/credits${queryOrg}`, credential),
    );
    const subscriptionResponse = asRecord(
      await this.requestJson(`/alpha/billing/subscriptions${queryOrg}`, credential),
    );
    if (!creditsResponse || !subscriptionResponse) {
      throw new UsageAdapterError("protocol", "Command Code billing metadata response is invalid");
    }
    const credits = asRecord(creditsResponse.credits);
    const subscription = asRecord(subscriptionResponse.data);
    const periodStart = isoTimestamp(subscription?.currentPeriodStart);
    const summaryParams = new URLSearchParams();
    if (orgId !== undefined) summaryParams.set("orgId", orgId);
    if (periodStart !== undefined) summaryParams.set("since", periodStart);
    const summaryPath = `/alpha/usage/summary${summaryParams.size > 0 ? `?${summaryParams.toString()}` : ""}`;
    const summary = asRecord(await this.requestJson(summaryPath, credential));
    if (!summary) throw new UsageAdapterError("protocol", "Command Code usage summary response is invalid");

    const planId = nonEmptyString(subscription?.planId) ?? nonEmptyString(credits?.planId);
    const windowLimits = asRecord(creditsResponse.windowLimits);
    const value: LoadedUsage = {
      loadedAtMs: nowMs,
      observedAt: now.toISOString(),
      orgLimits: orgLimits(whoami.orgLimits),
      ...(orgId === undefined ? {} : { orgId }),
      ...(planId === undefined ? {} : { planId }),
      ...(nonEmptyString(subscription?.status) === undefined
        ? {}
        : { subscriptionStatus: nonEmptyString(subscription?.status)! }),
      ...(periodStart === undefined ? {} : { periodStart }),
      ...(isoTimestamp(subscription?.currentPeriodEnd) === undefined
        ? {}
        : { periodEnd: isoTimestamp(subscription?.currentPeriodEnd)! }),
      ...(nonNegativeNumber(credits?.monthlyCredits) === undefined
        ? {}
        : { monthlyCredits: nonNegativeNumber(credits?.monthlyCredits)! }),
      ...(nonNegativeNumber(credits?.purchasedCredits) === undefined
        ? {}
        : { purchasedCredits: nonNegativeNumber(credits?.purchasedCredits)! }),
      ...(nonNegativeNumber(credits?.freeCredits) === undefined
        ? {}
        : { freeCredits: nonNegativeNumber(credits?.freeCredits)! }),
      ...(windowLimit(windowLimits?.fiveHour) === undefined
        ? {}
        : { fiveHour: windowLimit(windowLimits?.fiveHour)! }),
      ...(windowLimit(windowLimits?.weekly) === undefined
        ? {}
        : { weekly: windowLimit(windowLimits?.weekly)! }),
      ...(nonNegativeNumber(summary.totalCost) === undefined
        ? {}
        : { summaryTotalCost: nonNegativeNumber(summary.totalCost)! }),
      ...(nonNegativeNumber(summary.totalCount) === undefined
        ? {}
        : { summaryTotalCount: nonNegativeNumber(summary.totalCount)! }),
    };
    this.cached = value;
    return value;
  }

  private routes(data: LoadedUsage): AccessRoute[] {
    const definitions = new Map<string, CommandCodeRouteDefinition>();
    for (const route of this.options.routes ?? []) definitions.set(route.providerModelId, route);
    for (const limit of data.orgLimits) {
      if (limit.scope !== "model" || limit.model === undefined || definitions.has(limit.model)) continue;
      definitions.set(limit.model, {
        providerModelId: limit.model,
        displayName: limit.modelLabel ?? limit.model,
      });
    }
    if (definitions.size === 0) {
      definitions.set("command-code-plan", {
        providerModelId: "command-code-plan",
        displayName: "Command Code plan",
      });
    }
    const product = productId(data.planId);
    return [...definitions.values()].map((route) => ({
      id: routeId(route.providerModelId),
      accountId: COMMAND_CODE_ACCOUNT_ID,
      productId: product,
      ...(data.periodStart === undefined
        ? {}
        : { subscriptionPeriodId: `subscription:command-code:${stablePart(data.periodStart)}` }),
      providerModelId: route.providerModelId,
      displayName: route.displayName,
      status: "available",
      metadata: { source: "command_code_usage" },
    }));
  }

  private quotaBuckets(data: LoadedUsage): QuotaBucket[] {
    const accountId = COMMAND_CODE_ACCOUNT_ID;
    const product = productId(data.planId);
    const values: QuotaBucket[] = [];
    const add = (value: Omit<QuotaBucket, "id" | "accountId" | "productId"> & { providerKey: string }) => {
      values.push({
        ...value,
        id: bucketId(value.providerKey),
        accountId,
        productId: product,
      });
    };

    if (data.monthlyCredits !== undefined) {
      add({
        displayName: "Monthly plan credits",
        metric: { kind: "credits" },
        windowPolicy:
          data.periodStart === undefined
            ? { kind: "provider_reported" }
            : { kind: "billing_cycle", anchorDate: data.periodStart, timezone: "UTC" },
        unit: "credits",
        enforcement: "soft",
        status: "unknown",
        providerKey: "credits:monthly",
        metadata: {},
      });
    }
    if (data.purchasedCredits !== undefined) {
      add({
        displayName: "Purchased credits",
        metric: { kind: "credits" },
        windowPolicy: { kind: "none" },
        unit: "credits",
        enforcement: "soft",
        status: "unknown",
        providerKey: "credits:purchased",
        metadata: {},
      });
    }
    if (data.freeCredits !== undefined) {
      add({
        displayName: "Free credits",
        metric: { kind: "credits" },
        windowPolicy: { kind: "none" },
        unit: "credits",
        enforcement: "soft",
        status: "unknown",
        providerKey: "credits:free",
        metadata: {},
      });
    }
    if (data.fiveHour !== undefined) {
      const fraction = exactFraction(data.fiveHour.used, data.fiveHour.cap);
      add({
        displayName: "5-hour usage window",
        metric: { kind: "provider_defined", providerKey: "command_code_window_units" },
        windowPolicy: { kind: "rolling_duration", durationSeconds: 18_000 },
        limitValue: data.fiveHour.cap,
        unit: "provider_units",
        enforcement: "hard",
        status: statusFromFraction(fraction),
        providerKey: "window:fiveHour",
        metadata: {},
      });
    }
    if (data.weekly !== undefined) {
      const fraction = exactFraction(data.weekly.used, data.weekly.cap);
      add({
        displayName: "Weekly usage window",
        metric: { kind: "provider_defined", providerKey: "command_code_window_units" },
        windowPolicy: { kind: "provider_reported" },
        limitValue: data.weekly.cap,
        unit: "provider_units",
        enforcement: "hard",
        status: statusFromFraction(fraction),
        providerKey: "window:weekly",
        metadata: {},
      });
    }
    for (const limit of data.orgLimits) {
      const fraction = exactFraction(limit.spent, limit.limit);
      const key = orgLimitKey(limit);
      add({
        displayName:
          limit.scope === "model"
            ? `${limit.modelLabel ?? limit.model ?? "Model"} spend limit`
            : "Organization spend limit",
        metric: { kind: "currency", currency: "USD" },
        windowPolicy: orgLimitWindow(limit),
        limitValue: limit.limit,
        unit: "USD",
        enforcement: "hard",
        status: statusFromFraction(fraction, limit.exceeded),
        providerKey: key,
        metadata: {
          scope: limit.scope,
          ...(limit.resetInterval === undefined ? {} : { resetInterval: limit.resetInterval }),
        },
      });
    }
    return values;
  }

  private quotaBindings(data: LoadedUsage, routes: readonly AccessRoute[], buckets: readonly QuotaBucket[]): QuotaBinding[] {
    const result: QuotaBinding[] = [];
    const routeByModel = new Map(routes.map((route) => [route.providerModelId, route]));
    for (const bucket of buckets) {
      const key = bucket.providerKey;
      if (key?.startsWith("org-limit:model:")) {
        const model = key.slice("org-limit:model:".length);
        const route = routeByModel.get(model);
        if (route !== undefined) {
          result.push({
            id: bindingId(route.id, bucket.id),
            accessRouteId: route.id,
            quotaBucketId: bucket.id,
            activeFrom: data.periodStart ?? data.observedAt,
            metadata: {},
          });
        }
        continue;
      }
      for (const route of routes) {
        result.push({
          id: bindingId(route.id, bucket.id),
          accessRouteId: route.id,
          quotaBucketId: bucket.id,
          activeFrom: data.periodStart ?? data.observedAt,
          metadata: {},
        });
      }
    }
    return result;
  }

  async discover(): Promise<UsageDiscoveryResult> {
    const data = await this.load();
    const timestamp = data.observedAt;
    const provider: Provider = {
      id: COMMAND_CODE_PROVIDER_ID,
      displayName: "Command Code",
      kind: "client_plan",
      status: "enabled",
      metadata: { collection: "official_cli_metadata" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const account: Account = {
      id: COMMAND_CODE_ACCOUNT_ID,
      providerId: provider.id,
      label: "Command Code account",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const product: Product = {
      id: productId(data.planId),
      providerId: provider.id,
      displayName: data.planId ?? "Command Code plan",
      kind: "subscription",
      metadata: data.planId === undefined ? {} : { planId: data.planId },
    };
    const routes = this.routes(data);
    const buckets = this.quotaBuckets(data);
    const subscription = subscriptionStatus(data.subscriptionStatus);
    const periods: SubscriptionPeriod[] =
      subscription !== undefined && data.periodStart !== undefined
        ? [
            {
              id: `subscription:command-code:${stablePart(data.periodStart)}`,
              accountId: account.id,
              productId: product.id,
              status: subscription,
              startedAt: data.periodStart,
              ...(subscription === "active" || data.periodEnd === undefined
                ? {}
                : { endedAt: data.periodEnd }),
              metadata: data.periodEnd === undefined ? {} : { providerPeriodEnd: data.periodEnd },
            },
          ]
        : [];
    return {
      status: "ok",
      providers: [provider],
      accounts: [account],
      products: [product],
      models: [],
      accessRoutes: routes,
      subscriptionPeriods: periods,
      quotaBuckets: buckets,
      quotaBindings: this.quotaBindings(data, routes, buckets),
      metadata: {
        source: "command_code_cli_1_50_usage_contract",
        ...(data.summaryTotalCost === undefined ? {} : { summaryTotalCost: data.summaryTotalCost }),
        ...(data.summaryTotalCount === undefined ? {} : { summaryTotalCount: data.summaryTotalCount }),
      },
    };
  }

  async collectUsageEvents(): Promise<UsageEventBatch> {
    return unsupported("collect_usage_events");
  }

  async collectQuotaSnapshots(): Promise<QuotaSnapshotBatch> {
    const data = await this.load();
    const stalenessAfter = snapshotStaleness(data.observedAt);
    const snapshots: QuotaSnapshot[] = [];
    const pushBalance = (key: string, remainingValue: number, resetAt?: string) => {
      snapshots.push({
        id: `snapshot:command-code:${stablePart(key)}:${stablePart(data.observedAt)}`,
        quotaBucketId: bucketId(key),
        observedAt: data.observedAt,
        remainingValue,
        ...(resetAt === undefined ? {} : { resetAt }),
        source: "provider_official_cli",
        confidence: "exact",
        stalenessAfter,
      });
    };
    if (data.monthlyCredits !== undefined) {
      pushBalance("credits:monthly", data.monthlyCredits, data.periodEnd);
    }
    if (data.purchasedCredits !== undefined) pushBalance("credits:purchased", data.purchasedCredits);
    if (data.freeCredits !== undefined) pushBalance("credits:free", data.freeCredits);

    const pushWindow = (key: string, value: CommandCodeWindowLimit) => {
      const remaining = Math.max(0, value.cap - value.used);
      const usedFraction = exactFraction(value.used, value.cap);
      snapshots.push({
        id: `snapshot:command-code:${stablePart(key)}:${stablePart(data.observedAt)}`,
        quotaBucketId: bucketId(key),
        observedAt: data.observedAt,
        usedValue: Math.min(value.used, value.cap),
        remainingValue: remaining,
        limitValue: value.cap,
        ...(usedFraction === undefined
          ? {}
          : { usedFraction, remainingFraction: Math.max(0, 1 - usedFraction) }),
        ...(value.resetAt === undefined ? {} : { resetAt: value.resetAt }),
        source: "provider_official_cli",
        confidence: "exact",
        stalenessAfter,
      });
    };
    if (data.fiveHour !== undefined) pushWindow("window:fiveHour", data.fiveHour);
    if (data.weekly !== undefined) pushWindow("window:weekly", data.weekly);

    for (const limit of data.orgLimits) {
      const key = orgLimitKey(limit);
      const used = Math.min(limit.spent, limit.limit);
      const remaining = Math.max(0, limit.limit - used);
      const usedFraction = exactFraction(used, limit.limit);
      snapshots.push({
        id: `snapshot:command-code:${stablePart(key)}:${stablePart(data.observedAt)}`,
        quotaBucketId: bucketId(key),
        observedAt: data.observedAt,
        usedValue: used,
        remainingValue: remaining,
        limitValue: limit.limit,
        ...(usedFraction === undefined
          ? {}
          : { usedFraction, remainingFraction: Math.max(0, 1 - usedFraction) }),
        ...(limit.resetAt === undefined ? {} : { resetAt: limit.resetAt }),
        source: "provider_official_cli",
        confidence: "exact",
        stalenessAfter,
      });
    }
    return { status: "ok", values: snapshots };
  }

  async collectCostEvents(): Promise<CostEventBatch> {
    return unsupported("collect_costs");
  }

  async refresh(): Promise<UsageRefreshResult> {
    this.cached = undefined;
    const loaded = await this.load(true);
    return {
      status: "ok",
      refreshedAt: loaded.observedAt,
      metadata: { source: "command_code_cli_usage" },
    };
  }
}
