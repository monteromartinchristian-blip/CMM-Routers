import type {
  AccessRoute,
  Account,
  ModelIdentity,
  Product,
  Provider,
  QuotaBinding,
  QuotaBucket,
  QuotaSnapshot,
  QuotaStatus,
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

const OPENROUTER_PROVIDER_ID = "provider:openrouter";
const OPENROUTER_ACCOUNT_ID = "account:openrouter";
const OPENROUTER_PRODUCT_ID = "product:openrouter-credits";
const CACHE_TTL_MS = 60_000;
const AUTH_SCHEME = "Bearer";
const ORG_CREDITS_KEY = "org:credits";

export interface OpenRouterCredential {
  reference: string;
  resolve(reference: string): string | undefined | Promise<string | undefined>;
}

export interface OpenRouterUsageAdapterOptions {
  baseUrl?: string;
  credential: OpenRouterCredential;
  managementCredential?: OpenRouterCredential;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface KeyState {
  owner: string;
  label: string;
  limit?: number;
  limitRemaining?: number;
  limitReset?: string | null;
  usage: number;
  usageDaily?: number;
  usageWeekly?: number;
  usageMonthly?: number;
  includeByokInLimit?: boolean;
  disabled?: boolean;
}

interface OrgCredits {
  totalCredits: number;
  totalUsage: number;
}

interface LoadedState {
  loadedAtMs: number;
  observedAt: string;
  models: Array<{ id: string; name?: string }>;
  currentKey: KeyState;
  managementKeys: KeyState[];
  credits?: OrgCredits;
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

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function windowPolicyForReset(limitReset: string | null | undefined): WindowPolicy {
  switch (limitReset) {
    case null:
      return { kind: "none" };
    case "daily":
      return { kind: "fixed_calendar", calendarUnit: "day", timezone: "UTC" };
    case "weekly":
      return { kind: "fixed_calendar", calendarUnit: "week", timezone: "UTC" };
    case "monthly":
      return { kind: "fixed_calendar", calendarUnit: "month", timezone: "UTC" };
    default:
      return { kind: "provider_reported" };
  }
}

function statusFromFraction(usedFraction: number | undefined): QuotaStatus {
  if (usedFraction === undefined) return "unknown";
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.9) return "critical";
  if (usedFraction >= 0.75) return "warning";
  return "healthy";
}

function modelVendor(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "openrouter";
}

function routeId(providerModelId: string): string {
  return `route:openrouter:${stablePart(providerModelId)}`;
}

function modelId(providerModelId: string): string {
  return `model:openrouter:${stablePart(providerModelId)}`;
}

function bucketId(providerKey: string): string {
  return `bucket:openrouter:${stablePart(providerKey)}`;
}

function bindingId(route: string, bucket: string): string {
  return `binding:openrouter:${stablePart(route)}:${stablePart(bucket)}`;
}

function snapshotStaleness(observedAt: string): string {
  return new Date(Date.parse(observedAt) + CACHE_TTL_MS).toISOString();
}

function parseKeyState(
  data: Record<string, unknown>,
  fallbackLabel: string,
  ownerOverride?: string,
): KeyState {
  const label = nonEmptyString(data.label) ?? nonEmptyString(data.name) ?? fallbackLabel;
  const owner = ownerOverride ?? label;
  const usage = nonNegativeNumber(data.usage) ?? 0;
  const limit = nonNegativeNumber(data.limit);
  const limitRemaining = nonNegativeNumber(data.limit_remaining);
  const limitReset = data.limit_reset === null ? null : nonEmptyString(data.limit_reset);
  const usageDaily = nonNegativeNumber(data.usage_daily);
  const usageWeekly = nonNegativeNumber(data.usage_weekly);
  const usageMonthly = nonNegativeNumber(data.usage_monthly);
  return {
    owner,
    label,
    ...(limit === undefined ? {} : { limit }),
    ...(limitRemaining === undefined ? {} : { limitRemaining }),
    ...(limitReset === undefined ? {} : { limitReset }),
    usage,
    ...(usageDaily === undefined ? {} : { usageDaily }),
    ...(usageWeekly === undefined ? {} : { usageWeekly }),
    ...(usageMonthly === undefined ? {} : { usageMonthly }),
    ...(typeof data.include_byok_in_limit === "boolean"
      ? { includeByokInLimit: data.include_byok_in_limit }
      : {}),
    ...(typeof data.disabled === "boolean" ? { disabled: data.disabled } : {}),
  };
}

export class OpenRouterUsageAdapter implements UsageAdapter {
  readonly id = "openrouter";
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly baseUrl: URL;
  private cached: LoadedState | undefined;

  constructor(private readonly options: OpenRouterUsageAdapterOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    const base = options.baseUrl ?? "https://openrouter.ai/api/v1";
    this.baseUrl = new URL(base.endsWith("/") ? base : `${base}/`);
  }

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName: "OpenRouter",
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
    return { status: "healthy", detail: "OpenRouter key/credits metadata" };
  }

  private async requestJson(
    path: string,
    credential: string,
  ): Promise<unknown> {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new UsageAdapterError("protocol", "OpenRouter endpoint escaped API origin");
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
      throw new UsageAdapterError("unavailable", "OpenRouter metadata endpoint is unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new UsageAdapterError("auth", "OpenRouter metadata rejected credentials");
    }
    if (response.status === 429) {
      throw new UsageAdapterError("rate_limit", "OpenRouter metadata rate limited the request");
    }
    if (!response.ok) {
      throw new UsageAdapterError("unavailable", `OpenRouter metadata returned ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new UsageAdapterError("protocol", "OpenRouter metadata returned invalid JSON");
    }
  }

  private async resolveCredential(credential: OpenRouterCredential, name: string): Promise<string> {
    let value: string | undefined;
    try {
      value = await credential.resolve(credential.reference);
    } catch {
      throw new UsageAdapterError("auth", `OpenRouter ${name} credential resolution failed`);
    }
    if (!value) throw new UsageAdapterError("auth", `OpenRouter ${name} credential is unavailable`);
    return value;
  }

  private async load(force = false): Promise<LoadedState> {
    const now = this.now();
    const nowMs = now.getTime();
    if (!force && this.cached !== undefined && nowMs - this.cached.loadedAtMs < CACHE_TTL_MS) {
      return this.cached;
    }

    const keyCredential = await this.resolveCredential(this.options.credential, "api");

    const modelsBody = asRecord(await this.requestJson("models", keyCredential));
    if (!modelsBody || !Array.isArray(modelsBody.data)) {
      throw new UsageAdapterError("protocol", "OpenRouter models response is invalid");
    }
    const models: Array<{ id: string; name?: string }> = [];
    for (const entry of modelsBody.data) {
      const item = asRecord(entry);
      const id = nonEmptyString(item?.id);
      if (id === undefined) {
        throw new UsageAdapterError("protocol", "OpenRouter model entries must contain ids");
      }
      const name = nonEmptyString(item?.name);
      models.push({ id, ...(name === undefined ? {} : { name }) });
    }

    const keyBody = asRecord(await this.requestJson("key", keyCredential));
    const keyData = asRecord(keyBody?.data);
    if (!keyData) {
      throw new UsageAdapterError("protocol", "OpenRouter key response is invalid");
    }
    const currentKey = parseKeyState(keyData, "current", "current");

    let credits: OrgCredits | undefined;
    let managementKeys: KeyState[] = [];
    if (this.options.managementCredential !== undefined) {
      try {
        const mgmtCredential = await this.resolveCredential(
          this.options.managementCredential,
          "management",
        );
        const creditsBody = asRecord(await this.requestJson("credits", mgmtCredential));
        const creditsData = asRecord(creditsBody?.data);
        const totalCredits = nonNegativeNumber(creditsData?.total_credits);
        const totalUsage = nonNegativeNumber(creditsData?.total_usage);
        if (totalCredits !== undefined && totalUsage !== undefined) {
          credits = { totalCredits, totalUsage };
        }
        const keysBody = asRecord(
          await this.requestJson("keys?include_disabled=true", mgmtCredential),
        );
        if (Array.isArray(keysBody?.data)) {
          for (const entry of keysBody.data) {
            const item = asRecord(entry);
            if (!item) continue;
            const hash = nonEmptyString(item.hash);
            if (hash === undefined) continue;
            managementKeys.push(parseKeyState(item, hash, hash));
          }
        }
      } catch (error) {
        if (error instanceof UsageAdapterError && (error.kind === "auth" || error.kind === "unavailable")) {
          // Management surface unavailable: standard key surface remains valid.
          credits = undefined;
          managementKeys = [];
        } else {
          throw error;
        }
      }
    }

    const loaded: LoadedState = {
      loadedAtMs: nowMs,
      observedAt: now.toISOString(),
      models,
      currentKey,
      managementKeys,
      ...(credits === undefined ? {} : { credits }),
    };
    this.cached = loaded;
    return loaded;
  }



  private quotaBuckets(data: LoadedState): QuotaBucket[] {
    const values: QuotaBucket[] = [];
    const add = (
      value: Omit<QuotaBucket, "id" | "accountId" | "productId"> & { providerKey: string },
    ) => {
      values.push({
        ...value,
        id: bucketId(value.providerKey),
        accountId: OPENROUTER_ACCOUNT_ID,
        productId: OPENROUTER_PRODUCT_ID,
      });
    };

    const addKeyBuckets = (key: KeyState) => {
      const owner = key.owner;
      if (key.limit !== undefined) {
        const remaining = key.limitRemaining;
        const used = remaining === undefined ? undefined : Math.min(key.limit, key.limit - remaining);
        const usedFraction =
          used === undefined || key.limit <= 0 ? undefined : Math.min(1, used / key.limit);
        add({
          displayName: `${owner} spend cap`,
          metric: { kind: "currency", currency: "USD" },
          windowPolicy: windowPolicyForReset(key.limitReset),
          limitValue: key.limit,
          unit: "USD",
          enforcement: "hard",
          status: statusFromFraction(usedFraction),
          providerKey: `key:${owner}:limit`,
          metadata: {
            ...(key.limitReset === undefined ? {} : { limitReset: key.limitReset }),
            ...(key.includeByokInLimit === undefined ? {} : { includeByokInLimit: key.includeByokInLimit }),
          },
        });
      }
      const counters: Array<[suffix: string, displayName: string, window: WindowPolicy, amount: number | undefined]> = [
        ["usage", `${owner} total usage`, { kind: "none" }, key.usage],
        ["usage_daily", `${owner} daily usage`, { kind: "fixed_calendar", calendarUnit: "day", timezone: "UTC" }, key.usageDaily],
        ["usage_weekly", `${owner} weekly usage`, { kind: "fixed_calendar", calendarUnit: "week", timezone: "UTC" }, key.usageWeekly],
        ["usage_monthly", `${owner} monthly usage`, { kind: "fixed_calendar", calendarUnit: "month", timezone: "UTC" }, key.usageMonthly],
      ];
      for (const [suffix, displayName, windowPolicy, amount] of counters) {
        if (amount === undefined) continue;
        add({
          displayName,
          metric: { kind: "currency", currency: "USD" },
          windowPolicy,
          unit: "USD",
          enforcement: "unknown",
          status: "unknown",
          providerKey: `key:${owner}:${suffix}`,
          metadata: { counter: true },
        });
      }
    };

    if (data.credits !== undefined) {
      const used = Math.min(data.credits.totalCredits, data.credits.totalUsage);
      const usedFraction =
        data.credits.totalCredits > 0 ? used / data.credits.totalCredits : undefined;
      add({
        displayName: "Organization credit pool",
        metric: { kind: "currency", currency: "USD" },
        windowPolicy: { kind: "none" },
        limitValue: data.credits.totalCredits,
        unit: "USD",
        enforcement: "hard",
        status: statusFromFraction(usedFraction),
        providerKey: ORG_CREDITS_KEY,
        metadata: { scope: "organization", allTime: true },
      });
    }
    addKeyBuckets(data.currentKey);
    for (const key of data.managementKeys) addKeyBuckets(key);
    return values;
  }

  async discover(): Promise<UsageDiscoveryResult> {
    const data = await this.load();
    const timestamp = data.observedAt;
    const provider: Provider = {
      id: OPENROUTER_PROVIDER_ID,
      displayName: "OpenRouter",
      kind: "aggregator",
      status: "enabled",
      metadata: { collection: "official_key_credits_metadata_api" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const account: Account = {
      id: OPENROUTER_ACCOUNT_ID,
      providerId: provider.id,
      label: "OpenRouter account",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const product: Product = {
      id: OPENROUTER_PRODUCT_ID,
      providerId: provider.id,
      displayName: "OpenRouter credits",
      kind: "api",
      metadata: { billing: "prepaid_credits" },
    };
    const models: ModelIdentity[] = data.models.map((model) => ({
      id: modelId(model.id),
      canonicalName: model.name ?? model.id,
      vendor: modelVendor(model.id),
      lifecycle: "active",
      aliases: [],
      metadata: { source: "openrouter_models" },
    }));
    const routes: AccessRoute[] = data.models.map((model) => ({
      id: routeId(model.id),
      accountId: OPENROUTER_ACCOUNT_ID,
      productId: OPENROUTER_PRODUCT_ID,
      modelIdentityId: modelId(model.id),
      providerModelId: model.id,
      displayName: model.name ?? model.id,
      status: "available",
      metadata: { source: "openrouter_models" },
    }));
    const buckets = this.quotaBuckets(data);
    const bindings: QuotaBinding[] = [];
    for (const bucket of buckets) {
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
    return {
      status: "ok",
      providers: [provider],
      accounts: [account],
      products: [product],
      models,
      accessRoutes: routes,
      quotaBuckets: buckets,
      quotaBindings: bindings,
      metadata: {
        source: "openrouter_key_credits_contract",
        managementSurface: this.options.managementCredential !== undefined,
      },
    };
  }

  async collectUsageEvents(): Promise<UsageEventBatch> {
    return unsupported("collect_usage_events");
  }

  async collectQuotaSnapshots(): Promise<QuotaSnapshotBatch> {
    const data = await this.load();
    const stalenessAfter = snapshotStaleness(data.observedAt);
    const observedAt = data.observedAt;
    const snapshots: QuotaSnapshot[] = [];

    const addKeySnapshots = (key: KeyState) => {
      const owner = key.owner;
      if (key.limit !== undefined) {
        const remaining = key.limitRemaining;
        if (remaining !== undefined) {
          const used = Math.min(key.limit, Math.max(0, key.limit - remaining));
          const usedFraction = key.limit > 0 ? used / key.limit : undefined;
          snapshots.push({
            id: `snapshot:openrouter:${stablePart(`key:${owner}:limit`)}:${stablePart(observedAt)}`,
            quotaBucketId: bucketId(`key:${owner}:limit`),
            observedAt,
            usedValue: used,
            remainingValue: remaining,
            limitValue: key.limit,
            ...(usedFraction === undefined ? {} : { usedFraction, remainingFraction: 1 - usedFraction }),
            source: "provider_official_api",
            confidence: "exact",
            stalenessAfter,
          });
        }
      }
      const counters: Array<[suffix: string, amount: number | undefined]> = [
        ["usage", key.usage],
        ["usage_daily", key.usageDaily],
        ["usage_weekly", key.usageWeekly],
        ["usage_monthly", key.usageMonthly],
      ];
      for (const [suffix, amount] of counters) {
        if (amount === undefined) continue;
        snapshots.push({
          id: `snapshot:openrouter:${stablePart(`key:${owner}:${suffix}`)}:${stablePart(observedAt)}`,
          quotaBucketId: bucketId(`key:${owner}:${suffix}`),
          observedAt,
          usedValue: amount,
          source: "provider_official_api",
          confidence: "measured",
          stalenessAfter,
        });
      }
    };

    if (data.credits !== undefined) {
      const remaining = Math.max(0, data.credits.totalCredits - data.credits.totalUsage);
      const used = Math.min(data.credits.totalCredits, data.credits.totalUsage);
      const usedFraction =
        data.credits.totalCredits > 0 ? used / data.credits.totalCredits : undefined;
      snapshots.push({
        id: `snapshot:openrouter:${stablePart(ORG_CREDITS_KEY)}:${stablePart(observedAt)}`,
        quotaBucketId: bucketId(ORG_CREDITS_KEY),
        observedAt,
        usedValue: used,
        remainingValue: remaining,
        limitValue: data.credits.totalCredits,
        ...(usedFraction === undefined ? {} : { usedFraction, remainingFraction: 1 - usedFraction }),
        source: "provider_official_api",
        confidence: "exact",
        stalenessAfter,
      });
    }
    addKeySnapshots(data.currentKey);
    for (const key of data.managementKeys) addKeySnapshots(key);
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
      metadata: { source: "openrouter_key_credits" },
    };
  }
}
