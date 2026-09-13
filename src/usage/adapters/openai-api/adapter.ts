import type {
  AccessRoute,
  Account,
  CostEvent,
  ModelIdentity,
  Product,
  Provider,
  UsageEvent,
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

const OPENAI_PROVIDER_ID = "provider:openai-api";
const OPENAI_ACCOUNT_ID = "account:openai-api";
const OPENAI_PRODUCT_ID = "product:openai-api";
const DEFAULT_USAGE_PATH = "/v1/organization/usage/completions";
const DEFAULT_COSTS_PATH = "/v1/organization/costs";
const DEFAULT_LOOKBACK_DAYS = 30;
const AUTH_SCHEME = "Bearer";

export interface OpenAiApiCredential {
  reference: string;
  resolve(reference: string): string | undefined | Promise<string | undefined>;
}

export interface OpenAiApiRouteDefinition {
  providerModelId: string;
  displayName: string;
}

export interface OpenAiApiUsageAdapterOptions {
  baseUrl?: string;
  credential: OpenAiApiCredential;
  models?: readonly OpenAiApiRouteDefinition[];
  projectId?: string;
  lookbackDays?: number;
  usagePath?: string;
  costsPath?: string;
  fetch?: typeof fetch;
  now?: () => Date;
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

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function routeId(providerModelId: string): string {
  return `route:openai-api:${stablePart(providerModelId)}`;
}

function inferencePath(path: string): boolean {
  const pathname = path.split("?")[0]?.toLowerCase().replace(/\/+$/, "") ?? "";
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (last === "responses") return true;
  if (last === "completions") {
    const parent = segments.at(-2);
    // Allow billing/usage endpoints (e.g. organization/usage/completions).
    return parent === "chat" || parent === "v1";
  }
  return false;
}

function safeMetadataUrl(baseUrl: URL, path: string, label: string): URL {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
    throw new Error(`OpenAI ${label} endpoint must be relative to the configured base URL`);
  }
  const url = new URL(path.replace(/^\//, ""), baseUrl);
  if (url.origin !== baseUrl.origin) {
    throw new Error(`OpenAI ${label} endpoint must remain on the configured API origin`);
  }
  if (inferencePath(url.pathname)) {
    throw new Error(`OpenAI ${label} endpoint cannot be an inference endpoint`);
  }
  return url;
}

interface PagedResult<T> {
  values: T[];
  cursor?: string;
}

export class OpenAiApiUsageAdapter implements UsageAdapter {
  readonly id = "openai-api";
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly baseUrl: URL;
  private readonly usageUrl: URL;
  private readonly costsUrl: URL;

  constructor(private readonly options: OpenAiApiUsageAdapterOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.baseUrl = new URL(
      (options.baseUrl ?? "https://api.openai.com/v1").endsWith("/")
        ? (options.baseUrl ?? "https://api.openai.com/v1")
        : `${options.baseUrl ?? "https://api.openai.com/v1"}/`,
    );
    this.usageUrl = safeMetadataUrl(
      this.baseUrl,
      options.usagePath ?? DEFAULT_USAGE_PATH,
      "usage",
    );
    this.costsUrl = safeMetadataUrl(this.baseUrl, options.costsPath ?? DEFAULT_COSTS_PATH, "costs");
  }

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName: "OpenAI API (billing)",
      collectionSafety: "non_inference_only",
    };
  }

  capabilities(): ReadonlySet<UsageAdapterCapability> {
    return new Set([
      "discover_accounts",
      "discover_products",
      "discover_models",
      "collect_usage_events",
      "collect_costs",
      "manual_refresh",
    ]);
  }

  async health(): Promise<UsageAdapterHealth> {
    return { status: "healthy", detail: "OpenAI organization usage/cost metadata" };
  }

  private async requestJson(url: URL, credential: string): Promise<unknown> {
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
      throw new UsageAdapterError("unavailable", "OpenAI usage metadata endpoint is unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new UsageAdapterError("auth", "OpenAI usage metadata rejected credentials");
    }
    if (response.status === 429) {
      throw new UsageAdapterError("rate_limit", "OpenAI usage metadata rate limited the request");
    }
    if (!response.ok) {
      throw new UsageAdapterError("unavailable", `OpenAI usage metadata returned ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new UsageAdapterError("protocol", "OpenAI usage metadata returned invalid JSON");
    }
  }

  private async resolveCredential(): Promise<string> {
    let credential: string | undefined;
    try {
      credential = await this.options.credential.resolve(this.options.credential.reference);
    } catch {
      throw new UsageAdapterError("auth", "OpenAI credential resolution failed");
    }
    if (!credential) throw new UsageAdapterError("auth", "OpenAI credential is unavailable");
    return credential;
  }

  private windowStart(): number {
    const lookbackDays = this.options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    return Math.floor(this.now().getTime() / 1000) - lookbackDays * 86_400;
  }

  private buildUrl(base: URL, cursor?: string, groupByModel = false): URL {
    const url = new URL(base.toString());
    url.searchParams.set("start_time", String(this.windowStart()));
    url.searchParams.set("bucket_width", "1d");
    if (groupByModel) url.searchParams.append("group_by[]", "model");
    if (this.options.projectId !== undefined) {
      url.searchParams.append("project_ids[]", this.options.projectId);
    }
    if (cursor !== undefined) url.searchParams.set("page", cursor);
    return url;
  }

  private parseUsagePage(body: unknown): PagedResult<UsageEvent> {
    const record = asRecord(body);
    if (!record || !Array.isArray(record.data)) {
      throw new UsageAdapterError("protocol", "OpenAI usage response is invalid");
    }
    const values: UsageEvent[] = [];
    for (const entry of record.data) {
      const bucket = asRecord(entry);
      if (!bucket) continue;
      const occurredAt = unixSecondsToIso(bucket.start_time);
      if (occurredAt === undefined || !Array.isArray(bucket.results)) continue;
      for (const item of bucket.results) {
        const result = asRecord(item);
        if (!result) continue;
        const providerModelId = nonEmptyString(result.model);
        if (providerModelId === undefined) continue;
        const inputTokens = nonNegativeNumber(result.input_tokens);
        const outputTokens = nonNegativeNumber(result.output_tokens);
        const requests = nonNegativeNumber(result.num_model_requests);
        if (inputTokens === undefined && outputTokens === undefined && requests === undefined) {
          continue;
        }
        values.push({
          id: `usage:openai-api:${stablePart(providerModelId)}:${stablePart(occurredAt)}`,
          occurredAt,
          providerId: OPENAI_PROVIDER_ID,
          accountId: OPENAI_ACCOUNT_ID,
          productId: OPENAI_PRODUCT_ID,
          accessRouteId: routeId(providerModelId),
          modelIdentityId: `model:openai-api:${stablePart(providerModelId)}`,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(requests === undefined ? {} : { requests }),
          source: "provider_official_api",
          confidence: "measured",
          metadata: { billing: "openai_api" },
        });
      }
    }
    const cursor = nonEmptyString(record.next_page);
    return { values, ...(cursor === undefined ? {} : { cursor }) };
  }

  private parseCostPage(body: unknown): PagedResult<CostEvent> {
    const record = asRecord(body);
    if (!record || !Array.isArray(record.data)) {
      throw new UsageAdapterError("protocol", "OpenAI costs response is invalid");
    }
    const values: CostEvent[] = [];
    for (const entry of record.data) {
      const bucket = asRecord(entry);
      if (!bucket) continue;
      const occurredAt = unixSecondsToIso(bucket.start_time);
      if (occurredAt === undefined || !Array.isArray(bucket.results)) continue;
      for (const item of bucket.results) {
        const result = asRecord(item);
        if (!result) continue;
        const amount = asRecord(result.amount);
        const value = nonNegativeNumber(amount?.value);
        const currency = nonEmptyString(amount?.currency);
        if (value === undefined || currency === undefined) continue;
        values.push({
          id: `cost:openai-api:${stablePart(occurredAt)}:${stablePart(currency)}`,
          occurredAt,
          providerId: OPENAI_PROVIDER_ID,
          accountId: OPENAI_ACCOUNT_ID,
          productId: OPENAI_PRODUCT_ID,
          amount: value,
          currency,
          kind: "usage",
          source: "provider_official_api",
          confidence: "measured",
          metadata: { billing: "openai_api" },
        });
      }
    }
    const cursor = nonEmptyString(record.next_page);
    return { values, ...(cursor === undefined ? {} : { cursor }) };
  }

  async discover(): Promise<UsageDiscoveryResult> {
    const timestamp = this.now().toISOString();
    const provider: Provider = {
      id: OPENAI_PROVIDER_ID,
      displayName: "OpenAI",
      kind: "first_party",
      status: "enabled",
      metadata: { collection: "official_organization_usage_api" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const account: Account = {
      id: OPENAI_ACCOUNT_ID,
      providerId: provider.id,
      label: "OpenAI platform organization",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const product: Product = {
      id: OPENAI_PRODUCT_ID,
      providerId: provider.id,
      displayName: "OpenAI API billing",
      kind: "api",
      metadata: { billing: "payg_organization" },
    };
    const models: ModelIdentity[] = (this.options.models ?? []).map((route) => ({
      id: `model:openai-api:${stablePart(route.providerModelId)}`,
      canonicalName: route.displayName,
      vendor: "OpenAI",
      lifecycle: "active",
      aliases: [route.providerModelId],
      metadata: { billing: "openai_api" },
    }));
    const accessRoutes: AccessRoute[] = (this.options.models ?? []).map((route) => ({
      id: routeId(route.providerModelId),
      accountId: OPENAI_ACCOUNT_ID,
      productId: OPENAI_PRODUCT_ID,
      modelIdentityId: `model:openai-api:${stablePart(route.providerModelId)}`,
      providerModelId: route.providerModelId,
      displayName: route.displayName,
      status: "available",
      metadata: { billing: "openai_api" },
    }));
    return {
      status: "ok",
      providers: [provider],
      accounts: [account],
      products: [product],
      models,
      accessRoutes,
      quotaBuckets: [],
      quotaBindings: [],
      metadata: {
        source: "openai_organization_usage_api_contract",
        note: "PAYG billing source; quota state is not owned by this adapter",
      },
    };
  }

  async collectUsageEvents(cursor?: string): Promise<UsageEventBatch> {
    const credential = await this.resolveCredential();
    const page = this.parseUsagePage(
      await this.requestJson(this.buildUrl(this.usageUrl, cursor, true), credential),
    );
    return {
      status: "ok",
      values: page.values,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    };
  }

  async collectQuotaSnapshots(): Promise<QuotaSnapshotBatch> {
    return unsupported("collect_quota_snapshots");
  }

  async collectCostEvents(cursor?: string): Promise<CostEventBatch> {
    const credential = await this.resolveCredential();
    const page = this.parseCostPage(
      await this.requestJson(this.buildUrl(this.costsUrl, cursor, false), credential),
    );
    return {
      status: "ok",
      values: page.values,
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    };
  }

  async refresh(): Promise<UsageRefreshResult> {
    const credential = await this.resolveCredential();
    await this.requestJson(this.buildUrl(this.usageUrl, undefined, true), credential);
    return {
      status: "ok",
      refreshedAt: this.now().toISOString(),
      metadata: { source: "openai_organization_usage_api" },
    };
  }
}
