import type { AccessRoute, QuotaSnapshot } from "../../domain/types.js";
import { quotaSnapshotSchema } from "../../domain/validation.js";
import { ManualUsageAdapter, type ManualUsageAdapterDefinition } from "../manual/adapter.js";
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

export interface OpenAiCompatibleCredential {
  reference: string;
  resolve(reference: string): string | undefined | Promise<string | undefined>;
}

export interface OpenAiCompatibleModelDiscovery {
  path: string;
  accountId: string;
  productId: string;
  subscriptionPeriodId?: string;
}

export interface OpenAiCompatibleQuotaEndpoint {
  path: string;
  map(body: unknown): readonly QuotaSnapshot[];
}

export interface OpenAiCompatibleUsageAdapterOptions {
  id: string;
  displayName: string;
  baseUrl: string;
  credential?: OpenAiCompatibleCredential;
  manual: ManualUsageAdapterDefinition;
  modelDiscovery?: OpenAiCompatibleModelDiscovery;
  quotaEndpoint?: OpenAiCompatibleQuotaEndpoint;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface OpenAiModelsResponse {
  data?: unknown;
}

function safeMetadataUrl(baseUrl: URL, path: string): URL {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
    throw new Error("Metadata endpoint must be relative to the configured base URL");
  }
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin) {
    throw new Error("Metadata endpoint must remain on the configured API origin");
  }
  const pathname = url.pathname.toLowerCase().replace(/\/+$/, "");
  if (
    pathname.endsWith("/chat/completions") ||
    pathname.endsWith("/completions") ||
    pathname.endsWith("/responses")
  ) {
    throw new Error("Inference endpoints cannot be configured as usage metadata endpoints");
  }
  return url;
}

function discoveredModelIds(body: unknown): string[] {
  if (typeof body !== "object" || body === null) {
    throw new UsageAdapterError("protocol", "Models response must be an object");
  }
  const data = (body as OpenAiModelsResponse).data;
  if (!Array.isArray(data)) {
    throw new UsageAdapterError("protocol", "Models response must contain a data array");
  }
  const ids: string[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null || !("id" in item)) {
      throw new UsageAdapterError("protocol", "Model entries must contain ids");
    }
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) {
      throw new UsageAdapterError("protocol", "Model ids must be non-empty strings");
    }
    ids.push(id);
  }
  return ids;
}

function routeId(adapterId: string, providerModelId: string): string {
  return `${adapterId}:route:${encodeURIComponent(providerModelId)}`;
}

export class OpenAiCompatibleUsageAdapter implements UsageAdapter {
  readonly id: string;
  private readonly baseUrl: URL;
  private readonly modelDiscoveryUrl: URL | undefined;
  private readonly quotaUrl: URL | undefined;
  private readonly manualAdapter: ManualUsageAdapter;
  private readonly capabilitiesSet: ReadonlySet<UsageAdapterCapability>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: OpenAiCompatibleUsageAdapterOptions) {
    if (options.manual.id !== options.id) {
      throw new Error("Generic adapter id must match its manual graph id");
    }
    this.id = options.id;
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    this.modelDiscoveryUrl =
      options.modelDiscovery === undefined
        ? undefined
        : safeMetadataUrl(this.baseUrl, options.modelDiscovery.path);
    this.quotaUrl =
      options.quotaEndpoint === undefined
        ? undefined
        : safeMetadataUrl(this.baseUrl, options.quotaEndpoint.path);
    this.manualAdapter = new ManualUsageAdapter(options.manual);
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());

    if (options.modelDiscovery !== undefined) {
      const account = options.manual.accounts.find(
        (value) => value.id === options.modelDiscovery?.accountId,
      );
      const product = options.manual.products.find(
        (value) => value.id === options.modelDiscovery?.productId,
      );
      if (account === undefined || product === undefined || account.providerId !== product.providerId) {
        throw new Error("Model discovery target must reference a configured account and product");
      }
      if (
        options.modelDiscovery.subscriptionPeriodId !== undefined &&
        !(options.manual.subscriptionPeriods ?? []).some(
          (value) => value.id === options.modelDiscovery?.subscriptionPeriodId,
        )
      ) {
        throw new Error("Model discovery target references an unknown subscription period");
      }
    }

    const declared = new Set<UsageAdapterCapability>([
      "discover_accounts",
      "discover_products",
      "discover_quota_graph",
      "manual_refresh",
    ]);
    if (options.modelDiscovery !== undefined || (options.manual.models?.length ?? 0) > 0) {
      declared.add("discover_models");
    }
    if (options.quotaEndpoint !== undefined || options.manual.quotaSnapshots.length > 0) {
      declared.add("collect_quota_snapshots");
    }
    this.capabilitiesSet = declared;
  }

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName: this.options.displayName,
      collectionSafety: "non_inference_only",
      minimumRefreshIntervalMs: 60_000,
    };
  }

  capabilities(): ReadonlySet<UsageAdapterCapability> {
    return this.capabilitiesSet;
  }

  async health(): Promise<UsageAdapterHealth> {
    return { status: "healthy" };
  }

  private async requestJson(url: URL): Promise<unknown> {
    const headers = new Headers({ accept: "application/json" });
    if (this.options.credential !== undefined) {
      let value: string | undefined;
      try {
        value = await this.options.credential.resolve(this.options.credential.reference);
      } catch {
        throw new UsageAdapterError("auth", "Credential resolution failed");
      }
      if (value === undefined || value.length === 0) {
        throw new UsageAdapterError("auth", "Credential is unavailable");
      }
      headers.set("authorization", `Bearer ${value}`);
    }

    let response: Response;
    try {
      response = await this.fetcher(url, { method: "GET", headers });
    } catch {
      throw new UsageAdapterError("unavailable", "Metadata endpoint is unavailable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new UsageAdapterError("auth", "Metadata endpoint rejected credentials");
    }
    if (response.status === 429) {
      throw new UsageAdapterError("rate_limit", "Metadata endpoint rate limited the request");
    }
    if (!response.ok) {
      throw new UsageAdapterError("unavailable", `Metadata endpoint returned ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new UsageAdapterError("protocol", "Metadata endpoint returned invalid JSON");
    }
  }

  async discover(): Promise<UsageDiscoveryResult> {
    const manual = await this.manualAdapter.discover();
    if (manual.status !== "ok") return manual;
    if (this.options.modelDiscovery === undefined || this.modelDiscoveryUrl === undefined) return manual;

    const ids = discoveredModelIds(await this.requestJson(this.modelDiscoveryUrl));
    const known = new Set(manual.accessRoutes.map((value) => value.providerModelId));
    const discoveredRoutes: AccessRoute[] = ids
      .filter((providerModelId) => !known.has(providerModelId))
      .map((providerModelId) => ({
        id: routeId(this.id, providerModelId),
        accountId: this.options.modelDiscovery!.accountId,
        productId: this.options.modelDiscovery!.productId,
        ...(this.options.modelDiscovery!.subscriptionPeriodId === undefined
          ? {}
          : { subscriptionPeriodId: this.options.modelDiscovery!.subscriptionPeriodId }),
        providerModelId,
        displayName: providerModelId,
        status: "available",
        metadata: { discoveredBy: "openai_compatible_models" },
      }));
    return { ...manual, accessRoutes: [...manual.accessRoutes, ...discoveredRoutes] };
  }

  async collectUsageEvents(): Promise<UsageEventBatch> {
    return unsupported("collect_usage_events");
  }

  async collectQuotaSnapshots(): Promise<QuotaSnapshotBatch> {
    const manual = await this.manualAdapter.collectQuotaSnapshots();
    if (manual.status !== "ok") return manual;
    if (this.options.quotaEndpoint === undefined || this.quotaUrl === undefined) return manual;

    const body = await this.requestJson(this.quotaUrl);
    let mapped: readonly QuotaSnapshot[];
    try {
      mapped = this.options.quotaEndpoint.map(body);
    } catch {
      throw new UsageAdapterError("protocol", "Quota response mapping failed");
    }
    const bucketIds = new Set(this.options.manual.quotaBuckets.map((value) => value.id));
    const validated = mapped.map((snapshot) => {
      if (!bucketIds.has(snapshot.quotaBucketId)) {
        throw new UsageAdapterError("protocol", "Quota response references an unknown bucket");
      }
      const parsed = quotaSnapshotSchema.safeParse(snapshot);
      if (!parsed.success) {
        throw new UsageAdapterError("protocol", "Quota response produced an invalid snapshot");
      }
      return structuredClone(snapshot);
    });
    return { status: "ok", values: [...manual.values, ...validated] };
  }

  async collectCostEvents(): Promise<CostEventBatch> {
    return unsupported("collect_costs");
  }

  async refresh(): Promise<UsageRefreshResult> {
    return {
      status: "ok",
      refreshedAt: this.now().toISOString(),
      metadata: { mode: "openai_compatible" },
    };
  }
}
