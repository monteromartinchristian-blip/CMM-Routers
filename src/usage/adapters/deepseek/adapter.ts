import type {
  AccessRoute,
  Account,
  Product,
  Provider,
  QuotaBinding,
  QuotaBucket,
  QuotaSnapshot,
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

const DEEPSEEK_PROVIDER_ID = "provider:deepseek";
const DEEPSEEK_ACCOUNT_ID = "account:deepseek";
const DEEPSEEK_PRODUCT_ID = "product:deepseek";
const BALANCE_PATH = "/user/balance";
const CACHE_TTL_MS = 60_000;
const AUTH_SCHEME = "Bearer";

export interface DeepSeekCredential {
  reference: string;
  resolve(reference: string): string | undefined | Promise<string | undefined>;
}

export interface DeepSeekRouteDefinition {
  providerModelId: string;
  displayName: string;
}

export interface DeepSeekUsageAdapterOptions {
  baseUrl: string;
  credential: DeepSeekCredential;
  routes?: readonly DeepSeekRouteDefinition[];
  fetch?: typeof fetch;
  now?: () => Date;
}

interface BalanceEntry {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

interface LoadedBalance {
  loadedAtMs: number;
  observedAt: string;
  isAvailable: boolean;
  balances: BalanceEntry[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * DeepSeek returns monetary values as exact decimal strings. Parse with
 * Number() only after validating the decimal-string shape; never approximate
 * an amount the provider did not report.
 */
function decimalAmount(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function routeId(providerModelId: string): string {
  return `route:deepseek:${stablePart(providerModelId)}`;
}

function bucketId(providerKey: string): string {
  return `bucket:deepseek:${stablePart(providerKey)}`;
}

function bindingId(route: string, bucket: string): string {
  return `binding:deepseek:${stablePart(route)}:${stablePart(bucket)}`;
}

function snapshotStaleness(observedAt: string): string {
  return new Date(Date.parse(observedAt) + CACHE_TTL_MS).toISOString();
}

export class DeepSeekUsageAdapter implements UsageAdapter {
  readonly id = "deepseek";
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly baseUrl: URL;
  private cached: LoadedBalance | undefined;

  constructor(private readonly options: DeepSeekUsageAdapterOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  }

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName: "DeepSeek API",
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
      "collect_balances",
      "collect_quota_snapshots",
      "manual_refresh",
      "background_refresh",
    ]);
  }

  async health(): Promise<UsageAdapterHealth> {
    return { status: "healthy", detail: "DeepSeek balance metadata" };
  }

  private async load(force = false): Promise<LoadedBalance> {
    const now = this.now();
    const nowMs = now.getTime();
    if (!force && this.cached !== undefined && nowMs - this.cached.loadedAtMs < CACHE_TTL_MS) {
      return this.cached;
    }

    let credential: string | undefined;
    try {
      credential = await this.options.credential.resolve(this.options.credential.reference);
    } catch {
      throw new UsageAdapterError("auth", "DeepSeek credential resolution failed");
    }
    if (!credential) throw new UsageAdapterError("auth", "DeepSeek credential is unavailable");

    const url = new URL(BALANCE_PATH.replace(/^\//, ""), this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new UsageAdapterError("protocol", "DeepSeek balance endpoint escaped API origin");
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
      throw new UsageAdapterError("unavailable", "DeepSeek balance endpoint is unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new UsageAdapterError("auth", "DeepSeek balance rejected credentials");
    }
    if (response.status === 429) {
      throw new UsageAdapterError("rate_limit", "DeepSeek balance rate limited the request");
    }
    if (!response.ok) {
      throw new UsageAdapterError("unavailable", `DeepSeek balance returned ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new UsageAdapterError("protocol", "DeepSeek balance returned invalid JSON");
    }
    const record = asRecord(body);
    if (record === undefined || typeof record.is_available !== "boolean") {
      throw new UsageAdapterError("protocol", "DeepSeek balance response is invalid");
    }
    const balances: BalanceEntry[] = [];
    if (Array.isArray(record.balance_infos)) {
      for (const entry of record.balance_infos) {
        const info = asRecord(entry);
        if (!info) continue;
        const currency = nonEmptyString(info.currency);
        const total = decimalAmount(info.total_balance);
        if (currency === undefined || total === undefined) continue;
        balances.push({
          currency,
          total,
          granted: decimalAmount(info.granted_balance) ?? 0,
          toppedUp: decimalAmount(info.topped_up_balance) ?? 0,
        });
      }
    }
    const loaded: LoadedBalance = {
      loadedAtMs: nowMs,
      observedAt: now.toISOString(),
      isAvailable: record.is_available,
      balances,
    };
    this.cached = loaded;
    return loaded;
  }

  async discover(): Promise<UsageDiscoveryResult> {
    const data = await this.load();
    const timestamp = data.observedAt;
    const provider: Provider = {
      id: DEEPSEEK_PROVIDER_ID,
      displayName: "DeepSeek",
      kind: "first_party",
      status: "enabled",
      metadata: { collection: "official_balance_api" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const account: Account = {
      id: DEEPSEEK_ACCOUNT_ID,
      providerId: provider.id,
      label: "DeepSeek API account",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const product: Product = {
      id: DEEPSEEK_PRODUCT_ID,
      providerId: provider.id,
      displayName: "DeepSeek API billing",
      kind: "api",
      metadata: { billing: "payg_balance" },
    };
    const routes: AccessRoute[] = (this.options.routes ?? []).map((route) => ({
      id: routeId(route.providerModelId),
      accountId: DEEPSEEK_ACCOUNT_ID,
      productId: DEEPSEEK_PRODUCT_ID,
      providerModelId: route.providerModelId,
      displayName: route.displayName,
      status: data.isAvailable ? "available" : "degraded",
      metadata: { source: "deepseek_balance" },
    }));
    const buckets: QuotaBucket[] = [];
    const bindings: QuotaBinding[] = [];
    for (const balance of data.balances) {
      const keys: Array<[suffix: string, displayName: string, amount: number]> = [
        ["total", "Total balance", balance.total],
        ["granted", "Granted balance", balance.granted],
        ["topped_up", "Topped-up balance", balance.toppedUp],
      ];
      for (const [suffix, displayName] of keys) {
        const providerKey = `balance:${suffix}:${balance.currency}`;
        const bucket: QuotaBucket = {
          id: bucketId(providerKey),
          accountId: DEEPSEEK_ACCOUNT_ID,
          productId: DEEPSEEK_PRODUCT_ID,
          displayName: `${displayName} (${balance.currency})`,
          metric: { kind: "currency", currency: balance.currency },
          windowPolicy: { kind: "none" },
          unit: balance.currency,
          enforcement: "hard",
          status: data.isAvailable ? "unknown" : "exhausted",
          providerKey,
          metadata: {},
        };
        buckets.push(bucket);
        for (const route of routes) {
          bindings.push({
            id: bindingId(route.id, bucket.id),
            accessRouteId: route.id,
            quotaBucketId: bucket.id,
            activeFrom: timestamp,
            metadata: {},
          });
        }
      }
    }
    return {
      status: "ok",
      providers: [provider],
      accounts: [account],
      products: [product],
      models: [],
      accessRoutes: routes,
      quotaBuckets: buckets,
      quotaBindings: bindings,
      metadata: {
        source: "deepseek_user_balance_contract",
        balanceAvailable: data.isAvailable,
        currencies: [...new Set(data.balances.map((balance) => balance.currency))].sort(),
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
    for (const balance of data.balances) {
      const entries: Array<[suffix: string, amount: number]> = [
        ["total", balance.total],
        ["granted", balance.granted],
        ["topped_up", balance.toppedUp],
      ];
      for (const [suffix, amount] of entries) {
        const providerKey = `balance:${suffix}:${balance.currency}`;
        snapshots.push({
          id: `snapshot:deepseek:${stablePart(providerKey)}:${stablePart(data.observedAt)}`,
          quotaBucketId: bucketId(providerKey),
          observedAt: data.observedAt,
          remainingValue: amount,
          source: "provider_official_api",
          confidence: "exact",
          stalenessAfter,
        });
      }
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
      metadata: { source: "deepseek_user_balance" },
    };
  }
}
