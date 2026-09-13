import type {
  AccessRoute,
  Account,
  ModelIdentity,
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

const QWEN_PROVIDER_ID = "provider:qwen";
const TOKEN_PLAN_ACCOUNT_ID = "account:qwen-token-plan";
const PAYG_ACCOUNT_ID = "account:qwen-payg";
const TOKEN_PLAN_PRODUCT_ID = "product:qwen-token-plan";
const PAYG_PRODUCT_ID = "product:qwen-payg";
const CACHE_TTL_MS = 60_000;
const OBSERVATION_TTL_MS = 86_400_000;
const AUTH_SCHEME = "Bearer";
const WEEK_SECONDS = 604_800;

export type QwenModelStudioKind = "token-plan" | "payg";

export interface QwenModelStudioCredential {
  reference: string;
  resolve(reference: string): string | undefined | Promise<string | undefined>;
}

export interface QwenTokenPlanEvidence {
  edition: "personal" | "team";
  tierLabel?: string;
  windowLimitCredits?: number;
}

/**
 * Operator-recorded plan-console observation. The provider exposes plan usage
 * only through authenticated console pages (no supported machine-readable
 * quota API as of the 2026-09-13 verification), so consumption data enters
 * through this channel and is stored with `manual` provenance.
 */
export interface QwenPlanObservation {
  usedCredits?: number;
  remainingCredits?: number;
  windowLimitCredits?: number;
  resetAt?: string;
  windowStartAt?: string;
}

export interface QwenModelStudioUsageAdapterOptions {
  kind: QwenModelStudioKind;
  baseUrl: string;
  credential: QwenModelStudioCredential;
  displayName?: string;
  plan?: QwenTokenPlanEvidence;
  observations?: () => readonly QwenPlanObservation[];
  fetch?: typeof fetch;
  now?: () => Date;
}

interface LoadedModels {
  loadedAtMs: number;
  observedAt: string;
  modelIds: string[];
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
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function modelId(providerModelId: string): string {
  return `model:qwen:${stablePart(providerModelId)}`;
}

function namespaceKey(kind: QwenModelStudioKind): string {
  return kind === "token-plan" ? "qwen-token-plan" : "qwen-payg";
}

function routeId(kind: QwenModelStudioKind, providerModelId: string): string {
  return `route:${namespaceKey(kind)}:${stablePart(providerModelId)}`;
}

function bucketId(providerKey: string): string {
  return `bucket:qwen:${stablePart(providerKey)}`;
}

function bindingId(route: string, bucket: string): string {
  return `binding:qwen:${stablePart(route)}:${stablePart(bucket)}`;
}

function windowProviderKey(plan: QwenTokenPlanEvidence): string {
  return plan.edition === "personal" ? "credits-window:7day" : "credits-window:month";
}

export class QwenModelStudioUsageAdapter implements UsageAdapter {
  readonly id: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly baseUrl: URL;
  private cached: LoadedModels | undefined;

  constructor(private readonly options: QwenModelStudioUsageAdapterOptions) {
    this.id = options.kind === "token-plan" ? "qwen-token-plan" : "qwen-payg";
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    const base = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
    this.baseUrl = new URL(base);
  }

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName:
        this.options.displayName ??
        (this.options.kind === "token-plan" ? "Qwen Token Plan" : "Qwen Model Studio API"),
      collectionSafety: "non_inference_only",
      minimumRefreshIntervalMs: CACHE_TTL_MS,
    };
  }

  capabilities(): ReadonlySet<UsageAdapterCapability> {
    const shared: UsageAdapterCapability[] = [
      "discover_accounts",
      "discover_products",
      "discover_models",
      "manual_refresh",
    ];
    if (this.options.kind === "token-plan") {
      return new Set<UsageAdapterCapability>([
        ...shared,
        "discover_quota_graph",
        "collect_quota_snapshots",
        "background_refresh",
      ]);
    }
    return new Set<UsageAdapterCapability>(shared);
  }

  async health(): Promise<UsageAdapterHealth> {
    return { status: "healthy", detail: "Qwen Model Studio OpenAI-compatible metadata" };
  }

  private async load(force = false): Promise<LoadedModels> {
    const now = this.now();
    const nowMs = now.getTime();
    if (!force && this.cached !== undefined && nowMs - this.cached.loadedAtMs < CACHE_TTL_MS) {
      return this.cached;
    }

    let credential: string | undefined;
    try {
      credential = await this.options.credential.resolve(this.options.credential.reference);
    } catch {
      throw new UsageAdapterError("auth", "Qwen credential resolution failed");
    }
    if (!credential) throw new UsageAdapterError("auth", "Qwen credential is unavailable");

    const url = new URL("models", this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new UsageAdapterError("protocol", "Qwen models endpoint escaped API origin");
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
      throw new UsageAdapterError("unavailable", "Qwen models endpoint is unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new UsageAdapterError("auth", "Qwen models rejected credentials");
    }
    if (response.status === 429) {
      throw new UsageAdapterError("rate_limit", "Qwen models rate limited the request");
    }
    if (!response.ok) {
      throw new UsageAdapterError("unavailable", `Qwen models returned ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new UsageAdapterError("protocol", "Qwen models returned invalid JSON");
    }
    const record = asRecord(body);
    if (!record || !Array.isArray(record.data)) {
      throw new UsageAdapterError("protocol", "Qwen models response is invalid");
    }
    const ids: string[] = [];
    for (const entry of record.data) {
      const item = asRecord(entry);
      const id = nonEmptyString(item?.id);
      if (id === undefined) {
        throw new UsageAdapterError("protocol", "Qwen model entries must contain ids");
      }
      ids.push(id);
    }
    const loaded: LoadedModels = {
      loadedAtMs: nowMs,
      observedAt: now.toISOString(),
      modelIds: [...new Set(ids)].sort(),
    };
    this.cached = loaded;
    return loaded;
  }

  private product(): Product {
    if (this.options.kind === "token-plan") {
      const plan = this.options.plan;
      return {
        id: TOKEN_PLAN_PRODUCT_ID,
        providerId: QWEN_PROVIDER_ID,
        displayName:
          plan?.tierLabel === undefined
            ? "Qwen Token Plan"
            : `Qwen Token Plan (${plan.tierLabel})`,
        kind: "subscription",
        metadata: {
          billing: "credits_subscription",
          edition: plan?.edition ?? "personal",
          source: "model_studio_token_plan_contract",
        },
      };
    }
    return {
      id: PAYG_PRODUCT_ID,
      providerId: QWEN_PROVIDER_ID,
      displayName: "Qwen Model Studio API",
      kind: "api",
      metadata: { billing: "payg", source: "model_studio_payg_contract" },
    };
  }

  private quotaBuckets(): QuotaBucket[] {
    if (this.options.kind !== "token-plan") return [];
    const plan = this.options.plan;
    if (plan === undefined) return [];
    const key = windowProviderKey(plan);
    return [
      {
        id: bucketId(key),
        accountId: TOKEN_PLAN_ACCOUNT_ID,
        productId: TOKEN_PLAN_PRODUCT_ID,
        displayName:
          plan.edition === "personal"
            ? "7-day Credits window"
            : "Monthly Credits quota",
        metric: { kind: "credits" },
        windowPolicy:
          plan.edition === "personal"
            ? { kind: "rolling_duration", durationSeconds: WEEK_SECONDS }
            : { kind: "provider_reported" },
        ...(plan.windowLimitCredits === undefined
          ? {}
          : { limitValue: plan.windowLimitCredits }),
        unit: "credits",
        enforcement: "hard",
        // The supported metadata surface never reports consumption or resets;
        // unknown stays unknown until an operator observation arrives.
        status: "unknown",
        providerKey: key,
        metadata: {},
      },
    ];
  }

  async discover(): Promise<UsageDiscoveryResult> {
    const data = await this.load();
    const timestamp = data.observedAt;
    const kind = this.options.kind;
    const provider: Provider = {
      id: QWEN_PROVIDER_ID,
      displayName: "Qwen (Alibaba Model Studio)",
      kind: "first_party",
      status: "enabled",
      metadata: { collection: "openai_compatible_models_metadata" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const account: Account = {
      id: kind === "token-plan" ? TOKEN_PLAN_ACCOUNT_ID : PAYG_ACCOUNT_ID,
      providerId: provider.id,
      label: kind === "token-plan" ? "Qwen Token Plan credentials" : "Qwen PAYG credentials",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const models: ModelIdentity[] = data.modelIds.map((id) => ({
      id: modelId(id),
      canonicalName: id,
      vendor: "Qwen",
      lifecycle: "active",
      aliases: [],
      metadata: { source: "model_studio_models" },
    }));
    const product = this.product();
    const routes: AccessRoute[] = data.modelIds.map((id) => ({
      id: routeId(kind, id),
      accountId: account.id,
      productId: product.id,
      modelIdentityId: modelId(id),
      providerModelId: id,
      displayName: id,
      status: "available",
      metadata: { source: "model_studio_models" },
    }));
    const buckets = this.quotaBuckets();
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
      metadata: { source: "qwen_model_studio_openai_compatible", kind },
    };
  }

  async collectUsageEvents(): Promise<UsageEventBatch> {
    return unsupported("collect_usage_events");
  }

  async collectQuotaSnapshots(): Promise<QuotaSnapshotBatch> {
    if (this.options.kind !== "token-plan") {
      return unsupported("collect_quota_snapshots");
    }
    const buckets = this.quotaBuckets();
    if (buckets.length === 0) return { status: "ok", values: [] };
    const observations = this.options.observations?.() ?? [];
    const nowMs = this.now().getTime();
    const stalenessAfter = new Date(nowMs + OBSERVATION_TTL_MS).toISOString();
    const values: QuotaSnapshot[] = [];
    observations.forEach((observation, index) => {
      const bucket = buckets[0];
      if (bucket === undefined) return;
      const limit = observation.windowLimitCredits ?? bucket.limitValue;
      const used =
        observation.usedCredits ??
        (limit !== undefined && observation.remainingCredits !== undefined
          ? limit - observation.remainingCredits
          : undefined);
      const remaining =
        observation.remainingCredits ??
        (limit !== undefined && used !== undefined ? Math.max(0, limit - used) : undefined);
      const usedFraction =
        limit !== undefined && used !== undefined && limit > 0
          ? Math.min(1, Math.max(0, used / limit))
          : undefined;
      const remainingFraction =
        usedFraction === undefined ? undefined : Math.min(1, Math.max(0, 1 - usedFraction));
      const resetAt = isoTimestamp(observation.resetAt);
      values.push({
        id: `snapshot:qwen:${stablePart(bucket.providerKey ?? "credits-window")}:${String(index)}:${stablePart(this.now().toISOString())}`,
        quotaBucketId: bucket.id,
        observedAt: this.now().toISOString(),
        ...(used === undefined ? {} : { usedValue: used }),
        ...(remaining === undefined ? {} : { remainingValue: remaining }),
        ...(limit === undefined ? {} : { limitValue: limit }),
        ...(usedFraction === undefined ? {} : { usedFraction }),
        ...(remainingFraction === undefined ? {} : { remainingFraction }),
        ...(resetAt === undefined ? {} : { resetAt }),
        source: "manual",
        confidence: "measured",
        stalenessAfter,
        rawSafeMetadata: { channel: "operator_observation" },
      });
    });
    return { status: "ok", values };
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
      metadata: { source: "qwen_model_studio_openai_compatible" },
    };
  }
}
