import type {
  AccessRoute,
  Account,
  Product,
  Provider,
  QuotaBinding,
  QuotaBucket,
  QuotaSnapshot,
  QuotaStatus,
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

const GOOGLE_PROVIDER_ID = "provider:google-ai-pro";
const GOOGLE_ACCOUNT_ID = "account:google-ai-pro";
const GOOGLE_PRODUCT_ID = "product:google-ai-pro";
const CACHE_TTL_MS = 60_000;
const AUTH_SCHEME = "Bearer";

export interface GoogleAiProCredential {
  reference: string;
  resolve(reference: string): string | undefined | Promise<string | undefined>;
}

export interface GoogleAiProRouteDefinition {
  providerModelId: string;
  displayName: string;
}

export interface GoogleAiProUsageAdapterOptions {
  baseUrl: string;
  credential: GoogleAiProCredential;
  routes?: readonly GoogleAiProRouteDefinition[];
  fetch?: typeof fetch;
  now?: () => Date;
}

interface QuotaPool {
  key: string;
  tokenType: string;
  modelId?: string;
  remainingAmount?: number;
  remainingFraction?: number;
  resetAt?: string;
}

interface CreditPool {
  creditType: string;
  amount: number;
}

interface LoadedUsage {
  loadedAtMs: number;
  observedAt: string;
  tierName?: string;
  pools: QuotaPool[];
  credits: CreditPool[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const numeric =
    typeof value === "string" && value.length > 0 ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) && numeric >= 0
    ? numeric
    : undefined;
}

function fractionValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function routeId(providerModelId: string): string {
  return `route:google-ai-pro:${stablePart(providerModelId)}`;
}

function bucketId(providerKey: string): string {
  return `bucket:google-ai-pro:${stablePart(providerKey)}`;
}

function bindingId(route: string, bucket: string): string {
  return `binding:google-ai-pro:${stablePart(route)}:${stablePart(bucket)}`;
}

function statusFromRemaining(remainingFraction: number | undefined): QuotaStatus {
  if (remainingFraction === undefined) return "unknown";
  if (remainingFraction <= 0) return "exhausted";
  const used = 1 - remainingFraction;
  if (used >= 0.9) return "critical";
  if (used >= 0.75) return "warning";
  return "healthy";
}

function snapshotStaleness(observedAt: string): string {
  return new Date(Date.parse(observedAt) + CACHE_TTL_MS).toISOString();
}

export class GoogleAiProUsageAdapter implements UsageAdapter {
  readonly id = "google-ai-pro";
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly baseUrl: URL;
  private cached: LoadedUsage | undefined;

  constructor(private readonly options: GoogleAiProUsageAdapterOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  }

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName: "Google AI Pro",
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
    return { status: "healthy", detail: "Google AI Pro Code Assist quota metadata" };
  }

  private async requestPost(path: string, payload: Record<string, unknown>, credential: string): Promise<unknown> {
    if (!/^\/(?!\/)/.test(path)) {
      throw new UsageAdapterError("protocol", "Google quota endpoint must be a root-relative path");
    }
    const url = new URL(path, this.baseUrl.origin);
    if (url.origin !== this.baseUrl.origin) {
      throw new UsageAdapterError("protocol", "Google quota endpoint escaped API origin");
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `${AUTH_SCHEME} ${credential}`,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new UsageAdapterError("unavailable", "Google quota metadata endpoint is unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new UsageAdapterError("auth", "Google quota metadata rejected credentials");
    }
    if (response.status === 429) {
      throw new UsageAdapterError("rate_limit", "Google quota metadata rate limited the request");
    }
    if (!response.ok) {
      throw new UsageAdapterError("unavailable", `Google quota metadata returned ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new UsageAdapterError("protocol", "Google quota metadata returned invalid JSON");
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
      throw new UsageAdapterError("auth", "Google credential resolution failed");
    }
    if (!credential) throw new UsageAdapterError("auth", "Google credential is unavailable");

    const load = asRecord(
      await this.requestPost(
        "/v1internal:loadCodeAssist",
        {
          metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
        },
        credential,
      ),
    );
    if (!load) throw new UsageAdapterError("protocol", "Google loadCodeAssist response is invalid");
    const project = nonEmptyString(load.cloudaicompanionProject);
    if (project === undefined) {
      throw new UsageAdapterError("protocol", "Google Code Assist project is unavailable");
    }
    const paidTier = asRecord(load.paidTier) ?? asRecord(load.currentTier);
    const tierName = nonEmptyString(paidTier?.name);
    const credits: CreditPool[] = [];
    if (Array.isArray(paidTier?.availableCredits)) {
      for (const entry of paidTier.availableCredits) {
        const record = asRecord(entry);
        if (!record) continue;
        const creditType = nonEmptyString(record.creditType);
        const amount = nonNegativeNumber(record.creditAmount);
        if (creditType === undefined || amount === undefined) continue;
        credits.push({ creditType, amount });
      }
    }

    const quota = asRecord(
      await this.requestPost(
        "/v1internal:retrieveUserQuota",
        { project },
        credential,
      ),
    );
    if (!quota) throw new UsageAdapterError("protocol", "Google retrieveUserQuota response is invalid");
    const pools: QuotaPool[] = [];
    if (Array.isArray(quota.buckets)) {
      for (const entry of quota.buckets) {
        const record = asRecord(entry);
        if (!record) continue;
        const tokenType = nonEmptyString(record.tokenType);
        if (tokenType === undefined) continue;
        const modelId = nonEmptyString(record.modelId);
        const remainingFraction = fractionValue(record.remainingFraction);
        const remainingAmount = nonNegativeNumber(record.remainingAmount);
        const resetAt = isoTimestamp(record.resetTime);
        pools.push({
          key: modelId === undefined ? `quota:${tokenType}` : `quota:${tokenType}:${modelId}`,
          tokenType,
          ...(modelId === undefined ? {} : { modelId }),
          ...(remainingFraction === undefined ? {} : { remainingFraction }),
          ...(remainingAmount === undefined ? {} : { remainingAmount }),
          ...(resetAt === undefined ? {} : { resetAt }),
        });
      }
    }

    const loaded: LoadedUsage = {
      loadedAtMs: nowMs,
      observedAt: now.toISOString(),
      ...(tierName === undefined ? {} : { tierName }),
      pools,
      credits,
    };
    this.cached = loaded;
    return loaded;
  }

  private routes(data: LoadedUsage): AccessRoute[] {
    const definitions = new Map<string, GoogleAiProRouteDefinition>();
    for (const route of this.options.routes ?? []) definitions.set(route.providerModelId, route);
    for (const pool of data.pools) {
      if (pool.modelId === undefined || definitions.has(pool.modelId)) continue;
      definitions.set(pool.modelId, { providerModelId: pool.modelId, displayName: pool.modelId });
    }
    return [...definitions.values()].map((route) => ({
      id: routeId(route.providerModelId),
      accountId: GOOGLE_ACCOUNT_ID,
      productId: GOOGLE_PRODUCT_ID,
      providerModelId: route.providerModelId,
      displayName: route.displayName,
      status: "available",
      metadata: { source: "google_ai_pro_quota" },
    }));
  }

  private quotaBuckets(data: LoadedUsage): QuotaBucket[] {
    const values: QuotaBucket[] = [];
    const add = (
      value: Omit<QuotaBucket, "id" | "accountId" | "productId"> & { providerKey: string },
    ) => {
      values.push({ ...value, id: bucketId(value.providerKey), accountId: GOOGLE_ACCOUNT_ID, productId: GOOGLE_PRODUCT_ID });
    };
    for (const pool of data.pools) {
      add({
        displayName:
          pool.modelId === undefined
            ? `${pool.tokenType.split("/").pop() ?? pool.tokenType} pool`
            : `${pool.modelId} (${pool.tokenType.split("/").pop() ?? pool.tokenType})`,
        metric: { kind: "provider_defined", providerKey: pool.tokenType },
        windowPolicy: { kind: "provider_reported" },
        unit: "provider_units",
        enforcement: "hard",
        status: statusFromRemaining(pool.remainingFraction),
        providerKey: pool.key,
        metadata: { tokenType: pool.tokenType },
      });
    }
    for (const credit of data.credits) {
      add({
        displayName: `${credit.creditType.replace(/_/g, " ").toLowerCase()} credits`,
        metric: { kind: "credits" },
        windowPolicy: { kind: "none" },
        unit: "credits",
        enforcement: "soft",
        status: "unknown",
        providerKey: `credits:${credit.creditType}`,
        metadata: {},
      });
    }
    return values;
  }

  private quotaBindings(
    data: LoadedUsage,
    routes: readonly AccessRoute[],
    buckets: readonly QuotaBucket[],
  ): QuotaBinding[] {
    const result: QuotaBinding[] = [];
    const routeByModel = new Map(routes.map((route) => [route.providerModelId, route]));
    const bind = (bucketIdValue: string, routeIdValue: string, activeFrom: string) =>
      result.push({
        id: bindingId(routeIdValue, bucketIdValue),
        accessRouteId: routeIdValue,
        quotaBucketId: bucketIdValue,
        activeFrom,
        metadata: {},
      });
    for (const bucket of buckets) {
      const key = bucket.providerKey ?? "";
      if (key.startsWith("quota:")) {
        const pool = data.pools.find((entry) => entry.key === key);
        if (pool?.modelId !== undefined) {
          const route = routeByModel.get(pool.modelId);
          if (route !== undefined) bind(bucket.id, route.id, data.observedAt);
          continue;
        }
      }
      for (const route of routes) bind(bucket.id, route.id, data.observedAt);
    }
    return result;
  }

  async discover(): Promise<UsageDiscoveryResult> {
    const data = await this.load();
    const timestamp = data.observedAt;
    const provider: Provider = {
      id: GOOGLE_PROVIDER_ID,
      displayName: "Google AI",
      kind: "first_party",
      status: "enabled",
      metadata: { collection: "official_code_assist_quota_api" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const account: Account = {
      id: GOOGLE_ACCOUNT_ID,
      providerId: provider.id,
      label: "Google AI Pro account",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const product: Product = {
      id: GOOGLE_PRODUCT_ID,
      providerId: provider.id,
      displayName: data.tierName ?? "Google AI subscription",
      kind: "subscription",
      metadata: data.tierName === undefined ? {} : { tierName: data.tierName },
    };
    const routes = this.routes(data);
    const buckets = this.quotaBuckets(data);
    return {
      status: "ok",
      providers: [provider],
      accounts: [account],
      products: [product],
      models: [],
      accessRoutes: routes,
      quotaBuckets: buckets,
      quotaBindings: this.quotaBindings(data, routes, buckets),
      metadata: { source: "google_cloudcode_v1internal_quota_contract" },
    };
  }

  async collectUsageEvents(): Promise<UsageEventBatch> {
    return unsupported("collect_usage_events");
  }

  async collectQuotaSnapshots(): Promise<QuotaSnapshotBatch> {
    const data = await this.load();
    const stalenessAfter = snapshotStaleness(data.observedAt);
    const snapshots: QuotaSnapshot[] = [];
    for (const pool of data.pools) {
      const usedFraction =
        pool.remainingFraction === undefined ? undefined : Math.min(1, Math.max(0, 1 - pool.remainingFraction));
      snapshots.push({
        id: `snapshot:google-ai-pro:${stablePart(pool.key)}:${stablePart(data.observedAt)}`,
        quotaBucketId: bucketId(pool.key),
        observedAt: data.observedAt,
        ...(usedFraction === undefined ? {} : { usedFraction }),
        ...(pool.remainingFraction === undefined ? {} : { remainingFraction: pool.remainingFraction }),
        ...(pool.remainingAmount === undefined ? {} : { remainingValue: pool.remainingAmount }),
        ...(pool.resetAt === undefined ? {} : { resetAt: pool.resetAt }),
        source: "provider_official_api",
        confidence: "exact",
        stalenessAfter,
      });
    }
    for (const credit of data.credits) {
      snapshots.push({
        id: `snapshot:google-ai-pro:${stablePart(`credits:${credit.creditType}`)}:${stablePart(data.observedAt)}`,
        quotaBucketId: bucketId(`credits:${credit.creditType}`),
        observedAt: data.observedAt,
        remainingValue: credit.amount,
        source: "provider_official_api",
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
      metadata: { source: "google_cloudcode_v1internal_quota" },
    };
  }
}
