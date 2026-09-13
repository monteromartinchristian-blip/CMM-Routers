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

const CHATGPT_PROVIDER_ID = "provider:chatgpt-subscription";
const CHATGPT_ACCOUNT_ID = "account:chatgpt-subscription";
const CHATGPT_PRODUCT_ID = "product:chatgpt-subscription";
const USAGE_PATH = "/api/codex/usage";
const CACHE_TTL_MS = 60_000;
const AUTH_SCHEME = "Bearer";

export interface ChatGptSubscriptionCredential {
  reference: string;
  resolve(reference: string): string | undefined | Promise<string | undefined>;
}

export interface ChatGptSubscriptionRouteDefinition {
  providerModelId: string;
  displayName: string;
}

export interface ChatGptSubscriptionUsageAdapterOptions {
  baseUrl: string;
  credential: ChatGptSubscriptionCredential;
  accountId: string;
  routes?: readonly ChatGptSubscriptionRouteDefinition[];
  fetch?: typeof fetch;
  now?: () => Date;
}

interface WindowState {
  usedFraction: number;
  remainingFraction: number;
  durationSeconds?: number;
  resetAt?: string;
}

interface LoadedUsage {
  loadedAtMs: number;
  observedAt: string;
  planType?: string;
  limitName?: string;
  rateLimitReached?: string;
  primary?: WindowState;
  secondary?: WindowState;
  creditsBalance?: number;
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

function unixSecondsToIso(value: unknown): string | undefined {
  const seconds = nonNegativeNumber(value);
  if (seconds === undefined) return undefined;
  const date = new Date(Math.floor(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseWindow(
  value: unknown,
  observedAtMs: number,
): WindowState | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const percent = nonNegativeNumber(record.used_percent ?? record.utilization);
  if (percent === undefined) return undefined;
  const windowMinutes = nonNegativeNumber(record.window_minutes);
  const windowSeconds = nonNegativeNumber(record.limit_window_seconds);
  const resetSeconds = nonNegativeNumber(record.reset_after_seconds);
  const durationSeconds =
    windowSeconds ?? (windowMinutes === undefined ? undefined : windowMinutes * 60);
  const resetAt =
    unixSecondsToIso(record.resets_at) ??
    (resetSeconds === undefined
      ? undefined
      : new Date(observedAtMs + resetSeconds * 1000).toISOString());
  return {
    usedFraction: Math.min(1, Math.max(0, percent / 100)),
    remainingFraction: Math.min(1, Math.max(0, (100 - percent) / 100)),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

function statusFromWindow(window: WindowState, limitReached: boolean): QuotaStatus {
  if (limitReached || window.usedFraction >= 1) return "exhausted";
  if (window.usedFraction >= 0.9) return "critical";
  if (window.usedFraction >= 0.75) return "warning";
  return "healthy";
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function routeId(providerModelId: string): string {
  return `route:chatgpt-subscription:${stablePart(providerModelId)}`;
}

function bucketId(providerKey: string): string {
  return `bucket:chatgpt-subscription:${stablePart(providerKey)}`;
}

function bindingId(route: string, bucket: string): string {
  return `binding:chatgpt-subscription:${stablePart(route)}:${stablePart(bucket)}`;
}

function snapshotStaleness(observedAt: string): string {
  return new Date(Date.parse(observedAt) + CACHE_TTL_MS).toISOString();
}

export class ChatGptSubscriptionUsageAdapter implements UsageAdapter {
  readonly id = "chatgpt-subscription";
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly baseUrl: URL;
  private cached: LoadedUsage | undefined;

  constructor(private readonly options: ChatGptSubscriptionUsageAdapterOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  }

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName: "ChatGPT Subscription",
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
    return { status: "healthy", detail: "ChatGPT subscription usage metadata" };
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
      throw new UsageAdapterError("auth", "ChatGPT subscription credential resolution failed");
    }
    if (!credential) {
      throw new UsageAdapterError("auth", "ChatGPT subscription credential is unavailable");
    }

    const url = new URL(USAGE_PATH.replace(/^\//, ""), this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new UsageAdapterError("protocol", "ChatGPT usage endpoint escaped API origin");
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `${AUTH_SCHEME} ${credential}`,
          "chatgpt-account-id": this.options.accountId,
        },
      });
    } catch {
      throw new UsageAdapterError("unavailable", "ChatGPT usage metadata endpoint is unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new UsageAdapterError("auth", "ChatGPT usage metadata rejected credentials");
    }
    if (response.status === 429) {
      throw new UsageAdapterError("rate_limit", "ChatGPT usage metadata rate limited the request");
    }
    if (!response.ok) {
      throw new UsageAdapterError("unavailable", `ChatGPT usage metadata returned ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new UsageAdapterError("protocol", "ChatGPT usage metadata returned invalid JSON");
    }
    const record = asRecord(body);
    if (record === undefined) {
      throw new UsageAdapterError("protocol", "ChatGPT usage metadata response is invalid");
    }

    const observedAt = now.toISOString();
    const planType = nonEmptyString(record.plan_type);
    const limitName = nonEmptyString(record.limit_name);
    const rateLimitReached = nonEmptyString(record.rate_limit_reached_type);
    const primary = parseWindow(record.primary, nowMs);
    const secondary = parseWindow(record.secondary, nowMs);
    const credits = asRecord(record.credits);
    const creditsBalance =
      credits !== undefined && credits.has_credits === true
        ? nonNegativeNumber(
            typeof credits.balance === "string" ? Number(credits.balance) : credits.balance,
          )
        : undefined;

    const loaded: LoadedUsage = {
      loadedAtMs: nowMs,
      observedAt,
      ...(planType === undefined ? {} : { planType }),
      ...(limitName === undefined ? {} : { limitName }),
      ...(rateLimitReached === undefined ? {} : { rateLimitReached }),
      ...(primary === undefined ? {} : { primary }),
      ...(secondary === undefined ? {} : { secondary }),
      ...(creditsBalance === undefined ? {} : { creditsBalance }),
    };
    this.cached = loaded;
    return loaded;
  }

  private routes(): AccessRoute[] {
    const definitions = this.options.routes ?? [];
    if (definitions.length === 0) {
      return [
        {
          id: routeId("chatgpt-subscription-plan"),
          accountId: CHATGPT_ACCOUNT_ID,
          productId: CHATGPT_PRODUCT_ID,
          providerModelId: "chatgpt-subscription-plan",
          displayName: "ChatGPT subscription plan",
          status: "available",
          metadata: { source: "chatgpt_subscription_usage" },
        },
      ];
    }
    return definitions.map((route) => ({
      id: routeId(route.providerModelId),
      accountId: CHATGPT_ACCOUNT_ID,
      productId: CHATGPT_PRODUCT_ID,
      providerModelId: route.providerModelId,
      displayName: route.displayName,
      status: "available",
      metadata: { source: "chatgpt_subscription_usage" },
    }));
  }

  private quotaBuckets(data: LoadedUsage): QuotaBucket[] {
    const values: QuotaBucket[] = [];
    const add = (
      value: Omit<QuotaBucket, "id" | "accountId" | "productId"> & { providerKey: string },
    ) => {
      values.push({
        ...value,
        id: bucketId(value.providerKey),
        accountId: CHATGPT_ACCOUNT_ID,
        productId: CHATGPT_PRODUCT_ID,
      });
    };
    const reached = data.rateLimitReached !== undefined;
    const windows: Array<[key: string, label: string, window: WindowState | undefined]> = [
      ["window:primary", "Session window", data.primary],
      ["window:secondary", "Weekly window", data.secondary],
    ];
    for (const [key, label, window] of windows) {
      if (window === undefined) continue;
      add({
        displayName: label,
        metric: { kind: "percentage" },
        windowPolicy:
          window.durationSeconds === undefined
            ? { kind: "provider_reported" }
            : { kind: "rolling_duration", durationSeconds: window.durationSeconds },
        unit: "percent",
        enforcement: "hard",
        status: statusFromWindow(window, reached),
        providerKey: key,
        metadata: {},
      });
    }
    if (data.creditsBalance !== undefined) {
      add({
        displayName: "ChatGPT credits",
        metric: { kind: "provider_defined", providerKey: "chatgpt_credits" },
        windowPolicy: { kind: "none" },
        unit: "provider_units",
        enforcement: "soft",
        status: "unknown",
        providerKey: "credits",
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
    for (const bucket of buckets) {
      for (const route of routes) {
        result.push({
          id: bindingId(route.id, bucket.id),
          accessRouteId: route.id,
          quotaBucketId: bucket.id,
          activeFrom: data.observedAt,
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
      id: CHATGPT_PROVIDER_ID,
      displayName: "OpenAI ChatGPT",
      kind: "first_party",
      status: "enabled",
      metadata: { collection: "official_subscription_usage_api" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const account: Account = {
      id: CHATGPT_ACCOUNT_ID,
      providerId: provider.id,
      label: "ChatGPT subscription account",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const product: Product = {
      id: CHATGPT_PRODUCT_ID,
      providerId: provider.id,
      displayName:
        data.planType === undefined
          ? "ChatGPT subscription"
          : `ChatGPT ${data.planType.charAt(0).toUpperCase()}${data.planType.slice(1)}`,
      kind: "subscription",
      metadata: data.planType === undefined ? {} : { planType: data.planType },
    };
    const routes = this.routes();
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
      metadata: {
        source: "chatgpt_codex_usage_contract",
        endpoint: USAGE_PATH,
        ...(data.limitName === undefined ? {} : { limitName: data.limitName }),
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
    const windows: Array<[key: string, window: WindowState | undefined]> = [
      ["window:primary", data.primary],
      ["window:secondary", data.secondary],
    ];
    for (const [key, window] of windows) {
      if (window === undefined) continue;
      snapshots.push({
        id: `snapshot:chatgpt-subscription:${stablePart(key)}:${stablePart(data.observedAt)}`,
        quotaBucketId: bucketId(key),
        observedAt: data.observedAt,
        usedFraction: window.usedFraction,
        remainingFraction: window.remainingFraction,
        ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt }),
        source: "provider_official_api",
        confidence: "exact",
        stalenessAfter,
      });
    }
    if (data.creditsBalance !== undefined) {
      snapshots.push({
        id: `snapshot:chatgpt-subscription:credits:${stablePart(data.observedAt)}`,
        quotaBucketId: bucketId("credits"),
        observedAt: data.observedAt,
        remainingValue: data.creditsBalance,
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
      metadata: { source: "chatgpt_codex_usage" },
    };
  }
}
