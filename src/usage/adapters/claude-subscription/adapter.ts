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

const CLAUDE_PROVIDER_ID = "provider:claude-subscription";
const CLAUDE_ACCOUNT_ID = "account:claude-subscription";
const CLAUDE_PRODUCT_ID = "product:claude-subscription";
const USAGE_PATH = "/api/oauth/usage";
const CACHE_TTL_MS = 60_000;
const AUTH_SCHEME = "Bearer";
const FIVE_HOUR_SECONDS = 18_000;
const WEEK_SECONDS = 604_800;

export interface ClaudeSubscriptionCredential {
  reference: string;
  resolve(reference: string): string | undefined | Promise<string | undefined>;
}

export interface ClaudeSubscriptionRouteDefinition {
  providerModelId: string;
  displayName: string;
}

export interface ClaudeSubscriptionUsageAdapterOptions {
  baseUrl: string;
  credential: ClaudeSubscriptionCredential;
  routes?: readonly ClaudeSubscriptionRouteDefinition[];
  planLabel?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface UtilizationWindow {
  usedFraction: number;
  remainingFraction: number;
  resetAt?: string;
}

interface CreditsState {
  used: number;
  limit: number;
  currency: string;
  minorRemaining: number;
  scale: number;
}

interface LoadedUsage {
  loadedAtMs: number;
  observedAt: string;
  windows: Map<string, UtilizationWindow>;
  credits?: CreditsState;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function routeId(modelId: string): string {
  return `route:claude-subscription:${stablePart(modelId)}`;
}

function bucketId(providerKey: string): string {
  return `bucket:claude-subscription:${stablePart(providerKey)}`;
}

function bindingId(route: string, bucket: string): string {
  return `binding:claude-subscription:${stablePart(route)}:${stablePart(bucket)}`;
}

function windowSeconds(key: string): number {
  return key === "five_hour" ? FIVE_HOUR_SECONDS : WEEK_SECONDS;
}

function windowFamily(key: string): string | undefined {
  const match = /^seven_day_(.+)$/.exec(key);
  if (match === null || match[1] === undefined) return undefined;
  const family = match[1];
  return family === "oauth_apps" ? undefined : family;
}

function parseWindow(value: unknown): UtilizationWindow | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const percent = finiteNumber(record.utilization);
  if (percent === undefined || percent < 0) return undefined;
  const resetAt = isoTimestamp(record.resets_at);
  const usedFraction = Math.min(1, Math.max(0, percent / 100));
  return {
    usedFraction,
    remainingFraction: Math.min(1, Math.max(0, (100 - percent) / 100)),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

function moneyAmount(value: unknown): { amount: number; currency: string } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const minor = finiteNumber(record.amount_minor);
  const currency = nonEmptyString(record.currency);
  const exponent = finiteNumber(record.exponent);
  if (minor === undefined || currency === undefined || exponent === undefined || minor < 0) {
    return undefined;
  }
  return { amount: minor / 10 ** exponent, currency };
}

function parseCredits(utilization: Record<string, unknown>): CreditsState | undefined {
  const spend = asRecord(utilization.spend);
  if (spend !== undefined && spend.enabled === true) {
    const used = moneyAmount(spend.used);
    const limit = moneyAmount(spend.limit);
    if (used !== undefined && limit !== undefined && limit.currency === used.currency) {
      const usedMinor = finiteNumber(asRecord(spend.used)?.amount_minor) ?? 0;
      const limitMinor = finiteNumber(asRecord(spend.limit)?.amount_minor) ?? 0;
      const exponent = finiteNumber(asRecord(spend.limit)?.exponent) ?? 2;
      return {
        used: used.amount,
        limit: limit.amount,
        currency: used.currency,
        minorRemaining: Math.max(0, limitMinor - usedMinor),
        scale: 10 ** exponent,
      };
    }
    // spend was enabled but unparseable; do not double-report from extra_usage.
    return undefined;
  }
  const extra = asRecord(utilization.extra_usage);
  if (extra === undefined || extra.is_enabled !== true) return undefined;
  const monthly = finiteNumber(extra.monthly_limit);
  const usedCredits = finiteNumber(extra.used_credits);
  const currency = nonEmptyString(extra.currency);
  const decimalPlaces = finiteNumber(extra.decimal_places);
  if (
    monthly === undefined ||
    usedCredits === undefined ||
    currency === undefined ||
    decimalPlaces === undefined ||
    monthly <= 0 ||
    usedCredits < 0 ||
    decimalPlaces < 0
  ) {
    return undefined;
  }
  const scale = 10 ** decimalPlaces;
  return { used: usedCredits / scale, limit: monthly / scale, currency, minorRemaining: monthly - usedCredits, scale };
}

function statusFromFraction(usedFraction: number): QuotaStatus {
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.9) return "critical";
  if (usedFraction >= 0.75) return "warning";
  return "healthy";
}

function snapshotStaleness(observedAt: string): string {
  return new Date(Date.parse(observedAt) + CACHE_TTL_MS).toISOString();
}

export class ClaudeSubscriptionUsageAdapter implements UsageAdapter {
  readonly id = "claude-subscription";
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly baseUrl: URL;
  private cached: LoadedUsage | undefined;

  constructor(private readonly options: ClaudeSubscriptionUsageAdapterOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  }

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName: "Claude Subscription",
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
    return { status: "healthy", detail: "Claude subscription usage metadata" };
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
      throw new UsageAdapterError("auth", "Claude subscription credential resolution failed");
    }
    if (!credential) {
      throw new UsageAdapterError("auth", "Claude subscription credential is unavailable");
    }

    const url = new URL(USAGE_PATH.replace(/^\//, ""), this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new UsageAdapterError("protocol", "Claude usage endpoint escaped API origin");
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `${AUTH_SCHEME} ${credential}`,
        },
      });
    } catch {
      throw new UsageAdapterError("unavailable", "Claude usage metadata endpoint is unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new UsageAdapterError("auth", "Claude usage metadata rejected credentials");
    }
    if (response.status === 429) {
      throw new UsageAdapterError("rate_limit", "Claude usage metadata rate limited the request");
    }
    if (!response.ok) {
      throw new UsageAdapterError("unavailable", `Claude usage metadata returned ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new UsageAdapterError("protocol", "Claude usage metadata returned invalid JSON");
    }

    const utilization = asRecord(asRecord(body)?.utilization);
    if (utilization === undefined) {
      throw new UsageAdapterError("protocol", "Claude usage metadata response is invalid");
    }

    const windows = new Map<string, UtilizationWindow>();
    for (const [key, value] of Object.entries(utilization)) {
      if (!/^(five_hour|seven_day(_.+)?)$/.test(key)) continue;
      const parsed = parseWindow(value);
      if (parsed !== undefined) windows.set(key, parsed);
    }
    const credits = parseCredits(utilization);

    const loaded: LoadedUsage = {
      loadedAtMs: nowMs,
      observedAt: now.toISOString(),
      windows,
      ...(credits === undefined ? {} : { credits }),
    };
    this.cached = loaded;
    return loaded;
  }

  private routes(): AccessRoute[] {
    const definitions = this.options.routes ?? [];
    if (definitions.length === 0) {
      return [
        {
          id: routeId("claude-subscription-plan"),
          accountId: CLAUDE_ACCOUNT_ID,
          productId: CLAUDE_PRODUCT_ID,
          providerModelId: "claude-subscription-plan",
          displayName: "Claude subscription plan",
          status: "available",
          metadata: { source: "claude_subscription_usage" },
        },
      ];
    }
    return definitions.map((route) => ({
      id: routeId(route.providerModelId),
      accountId: CLAUDE_ACCOUNT_ID,
      productId: CLAUDE_PRODUCT_ID,
      providerModelId: route.providerModelId,
      displayName: route.displayName,
      status: "available",
      metadata: { source: "claude_subscription_usage" },
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
        accountId: CLAUDE_ACCOUNT_ID,
        productId: CLAUDE_PRODUCT_ID,
      });
    };

    for (const [key, window] of data.windows) {
      add({
        displayName:
          key === "five_hour"
            ? "5-hour session window"
            : key === "seven_day"
              ? "Weekly all-model window"
              : `Weekly ${key.slice("seven_day_".length).replace(/_/g, " ")} window`,
        metric: { kind: "percentage" },
        windowPolicy: { kind: "rolling_duration", durationSeconds: windowSeconds(key) },
        unit: "percent",
        enforcement: "hard",
        status: statusFromFraction(window.usedFraction),
        providerKey: `window:${key}`,
        metadata: {},
      });
    }
    if (data.credits !== undefined) {
      add({
        displayName: "Extra usage credits",
        metric: { kind: "currency", currency: data.credits.currency },
        windowPolicy: { kind: "provider_reported" },
        limitValue: data.credits.limit,
        unit: data.credits.currency,
        enforcement: "hard",
        status: statusFromFraction(
          data.credits.limit > 0 ? Math.min(1, data.credits.used / data.credits.limit) : 1,
        ),
        providerKey: "credits:extra_usage",
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
    const bind = (bucket: QuotaBucket, route: AccessRoute) => {
      result.push({
        id: bindingId(route.id, bucket.id),
        accessRouteId: route.id,
        quotaBucketId: bucket.id,
        activeFrom: data.observedAt,
        metadata: {},
      });
    };
    for (const bucket of buckets) {
      const key = bucket.providerKey ?? "";
      if (key.startsWith("window:")) {
        const family = windowFamily(key.slice("window:".length));
        if (family !== undefined) {
          for (const route of routes) {
            if (route.providerModelId.toLowerCase().includes(family)) bind(bucket, route);
          }
          continue;
        }
      }
      for (const route of routes) bind(bucket, route);
    }
    return result;
  }

  async discover(): Promise<UsageDiscoveryResult> {
    const data = await this.load();
    const timestamp = data.observedAt;
    const provider: Provider = {
      id: CLAUDE_PROVIDER_ID,
      displayName: "Anthropic Claude",
      kind: "first_party",
      status: "enabled",
      metadata: { collection: "official_subscription_usage_api" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const account: Account = {
      id: CLAUDE_ACCOUNT_ID,
      providerId: provider.id,
      label: "Claude subscription account",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const product: Product = {
      id: CLAUDE_PRODUCT_ID,
      providerId: provider.id,
      displayName: this.options.planLabel ?? "Claude subscription",
      kind: "subscription",
      metadata: {},
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
        source: "claude_ai_oauth_usage_contract",
        endpoint: USAGE_PATH,
        windowKeys: [...data.windows.keys()].sort(),
        extraUsageEnabled: data.credits !== undefined,
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

    for (const [key, window] of data.windows) {
      snapshots.push({
        id: `snapshot:claude-subscription:${stablePart(`window:${key}`)}:${stablePart(data.observedAt)}`,
        quotaBucketId: bucketId(`window:${key}`),
        observedAt: data.observedAt,
        usedFraction: window.usedFraction,
        remainingFraction: window.remainingFraction,
        ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt }),
        source: "provider_official_api",
        confidence: "exact",
        stalenessAfter,
      });
    }
    if (data.credits !== undefined) {
      const used = Math.min(data.credits.used, data.credits.limit);
      const remaining = data.credits.minorRemaining / data.credits.scale;
      const usedFraction = data.credits.limit > 0 ? used / data.credits.limit : 1;
      snapshots.push({
        id: `snapshot:claude-subscription:${stablePart("credits:extra_usage")}:${stablePart(data.observedAt)}`,
        quotaBucketId: bucketId("credits:extra_usage"),
        observedAt: data.observedAt,
        usedValue: used,
        remainingValue: remaining,
        limitValue: data.credits.limit,
        usedFraction,
        remainingFraction: Math.max(0, 1 - usedFraction),
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
      metadata: { source: "claude_ai_oauth_usage" },
    };
  }
}
