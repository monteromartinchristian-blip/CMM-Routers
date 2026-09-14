import type { UsageAdapter } from "../adapters/contract.js";
import type {
  AccessRoute,
  Account,
  CostEvent,
  ModelIdentity,
  Product,
  Provider,
  QuotaBinding,
  QuotaBucket,
  QuotaSnapshot,
  SubscriptionPeriod,
  UsageEvent,
} from "../domain/types.js";
import type { UsageStore } from "../storage/usage-store.js";
import { parseUsageRuntimeConfig, type LoadedUsageRuntimeConfig } from "../runtime/config.js";
import { UsageIntegrationCatalog } from "../runtime/configured-runtime.js";
import type { CredentialWriter } from "../runtime/credential-writer.js";
import { ManagedConfigStore } from "../runtime/managed-config-store.js";

export const PUBLIC_SAFE_DEMO_READ_TOKEN = "cmm-usage-public-demo-read";
export const PUBLIC_SAFE_DEMO_MANAGEMENT_TOKEN = "cmm-usage-public-demo-management";

const observedAt = "2026-09-14T18:00:00.000Z";
const freshUntil = "2026-09-14T19:30:00.000Z";

export const PUBLIC_SAFE_DEMO_CONFIG: LoadedUsageRuntimeConfig = parseUsageRuntimeConfig({
  version: 1,
  apiCredentialRef: "demo://usage-read",
  managementApiCredentialRef: "demo://usage-management",
  integrations: [
    { id: "command-code-demo", type: "command-code", enabled: true, settings: {} },
    { id: "chatgpt-demo", type: "chatgpt-subscription", enabled: true, settings: {} },
    { id: "openrouter-demo", type: "openrouter", enabled: true, settings: {} },
    {
      id: "custom-demo",
      type: "openai-compatible",
      enabled: true,
      settings: {
        name: "Local Lab",
        baseUrl: "http://127.0.0.1:11434/v1",
        defaultModel: "demo-local-model",
        discoverModels: true,
        useInCmmChat: true,
        quotaMode: "unknown",
      },
    },
  ],
});

const providers: Provider[] = [
  { id: "provider:demo:command-code", displayName: "Command Code", kind: "client_plan", status: "enabled", metadata: {}, createdAt: observedAt, updatedAt: observedAt },
  { id: "provider:demo:chatgpt", displayName: "ChatGPT / Codex", kind: "client_plan", status: "enabled", metadata: {}, createdAt: observedAt, updatedAt: observedAt },
  { id: "provider:demo:openrouter", displayName: "OpenRouter", kind: "aggregator", status: "enabled", metadata: {}, createdAt: observedAt, updatedAt: observedAt },
  { id: "provider:demo:kira", displayName: "Kira AI", kind: "first_party", status: "enabled", metadata: {}, createdAt: observedAt, updatedAt: observedAt },
  { id: "provider:demo:trial", displayName: "Northstar", kind: "first_party", status: "enabled", metadata: {}, createdAt: observedAt, updatedAt: observedAt },
  { id: "provider:demo:local", displayName: "Local Lab", kind: "generic", status: "enabled", metadata: {}, createdAt: observedAt, updatedAt: observedAt },
];

const accounts: Account[] = providers.map((provider) => ({
  id: `account:demo:${provider.id.slice("provider:demo:".length)}`,
  providerId: provider.id,
  label: `${provider.displayName} demo`,
  status: "active",
  createdAt: observedAt,
  updatedAt: observedAt,
}));

const products: Product[] = [
  { id: "product:demo:command-code-goat", providerId: "provider:demo:command-code", displayName: "individual-goat", kind: "subscription", metadata: { planId: "individual-goat" } },
  { id: "product:demo:chatgpt", providerId: "provider:demo:chatgpt", displayName: "ChatGPT Plus", kind: "subscription", metadata: {} },
  { id: "product:demo:openrouter", providerId: "provider:demo:openrouter", displayName: "Prepaid API", kind: "api", metadata: {} },
  { id: "product:demo:free", providerId: "provider:demo:kira", displayName: "Community access", kind: "api", metadata: { offerKind: "FREE", offerSource: "provider_official_api", offerConfidence: "exact" } },
  { id: "product:demo:promo", providerId: "provider:demo:kira", displayName: "Launch promotion", kind: "api", metadata: { offerKind: "PROMO", offerSource: "provider_official_api", offerConfidence: "exact", offerObservedAt: observedAt, offerValidUntil: "2026-09-30T23:59:59.000Z" } },
  { id: "product:demo:trial", providerId: "provider:demo:trial", displayName: "Pro trial", kind: "api", metadata: { offerKind: "TRIAL", offerSource: "provider_official_api", offerConfidence: "exact", offerValidUntil: "2026-09-21T23:59:59.000Z" } },
  { id: "product:demo:unknown", providerId: "provider:demo:local", displayName: "Local endpoint", kind: "custom", metadata: { offerKind: "UNKNOWN" } },
];

const models: ModelIdentity[] = [
  { id: "model:demo:command-code", canonicalName: "Command Code", vendor: "Command Code", family: "Command", lifecycle: "active", aliases: [], metadata: {} },
  { id: "model:demo:codex", canonicalName: "Codex", vendor: "OpenAI", family: "GPT", lifecycle: "active", aliases: [], metadata: {} },
  { id: "model:demo:claude", canonicalName: "Claude Sonnet", vendor: "Anthropic", family: "Claude", lifecycle: "active", aliases: [], metadata: {} },
  { id: "model:demo:qwen", canonicalName: "Qwen Flash", vendor: "Qwen", family: "Qwen", lifecycle: "active", aliases: [], metadata: {} },
  { id: "model:demo:northstar", canonicalName: "Northstar Pro", vendor: "Northstar", lifecycle: "active", aliases: [], metadata: {} },
  { id: "model:demo:local", canonicalName: "Local Demo 8B", vendor: "Local Lab", lifecycle: "active", aliases: [], metadata: {} },
];

const routes: AccessRoute[] = [
  { id: "route:demo:command-code", accountId: "account:demo:command-code", productId: "product:demo:command-code-goat", subscriptionPeriodId: "subscription:demo:command-code", modelIdentityId: "model:demo:command-code", providerModelId: "command-code", displayName: "Command Code", status: "available", metadata: {} },
  { id: "route:demo:chatgpt", accountId: "account:demo:chatgpt", productId: "product:demo:chatgpt", subscriptionPeriodId: "subscription:demo:chatgpt", modelIdentityId: "model:demo:codex", providerModelId: "codex", displayName: "Codex", status: "available", metadata: {} },
  { id: "route:demo:openrouter-claude", accountId: "account:demo:openrouter", productId: "product:demo:openrouter", modelIdentityId: "model:demo:claude", providerModelId: "anthropic/claude-sonnet", displayName: "Claude Sonnet", status: "available", metadata: {} },
  { id: "route:demo:openrouter-qwen", accountId: "account:demo:openrouter", productId: "product:demo:openrouter", modelIdentityId: "model:demo:qwen", providerModelId: "qwen/qwen-flash", displayName: "Qwen Flash", status: "available", metadata: {} },
  { id: "route:demo:free", accountId: "account:demo:kira", productId: "product:demo:free", modelIdentityId: "model:demo:qwen", providerModelId: "qwen-free", displayName: "Qwen Flash", status: "available", metadata: {} },
  { id: "route:demo:promo", accountId: "account:demo:kira", productId: "product:demo:promo", modelIdentityId: "model:demo:claude", providerModelId: "claude-promo", displayName: "Claude Sonnet", status: "available", metadata: {} },
  { id: "route:demo:trial", accountId: "account:demo:trial", productId: "product:demo:trial", modelIdentityId: "model:demo:northstar", providerModelId: "northstar-pro", displayName: "Northstar Pro", status: "available", metadata: {} },
  { id: "route:demo:unknown", accountId: "account:demo:local", productId: "product:demo:unknown", modelIdentityId: "model:demo:local", providerModelId: "demo-local-model", displayName: "Local Demo 8B", status: "available", metadata: {} },
];

const subscriptionPeriods: SubscriptionPeriod[] = [
  { id: "subscription:demo:command-code", accountId: "account:demo:command-code", productId: "product:demo:command-code-goat", status: "active", startedAt: "2026-09-07T00:00:00.000Z", billingAmount: 20, billingCurrency: "USD", metadata: { providerPeriodEnd: "2026-10-07T00:00:00.000Z" } },
  { id: "subscription:demo:chatgpt", accountId: "account:demo:chatgpt", productId: "product:demo:chatgpt", status: "active", startedAt: "2026-09-01T00:00:00.000Z", billingAmount: 23, billingCurrency: "EUR", metadata: {} },
];

const buckets: QuotaBucket[] = [
  { id: "bucket:demo:cc-monthly", accountId: "account:demo:command-code", productId: "product:demo:command-code-goat", displayName: "Monthly plan credits", metric: { kind: "credits" }, windowPolicy: { kind: "billing_cycle", anchorDate: "2026-09-07", timezone: "UTC" }, unit: "credits", enforcement: "hard", status: "healthy", providerKey: "credits:monthly", metadata: { scope: "product" } },
  { id: "bucket:demo:cc-purchased", accountId: "account:demo:command-code", productId: "product:demo:command-code-goat", displayName: "Purchased credits", metric: { kind: "credits" }, windowPolicy: { kind: "none" }, unit: "credits", enforcement: "soft", status: "unknown", providerKey: "credits:purchased", metadata: { scope: "product", supplementalBalance: true } },
  { id: "bucket:demo:cc-free", accountId: "account:demo:command-code", productId: "product:demo:command-code-goat", displayName: "Free credits", metric: { kind: "credits" }, windowPolicy: { kind: "none" }, unit: "credits", enforcement: "soft", status: "unknown", providerKey: "credits:free", metadata: { scope: "product", supplementalBalance: true } },
  { id: "bucket:demo:cc-five-hour", accountId: "account:demo:command-code", productId: "product:demo:command-code-goat", displayName: "5-hour window", metric: { kind: "provider_defined", providerKey: "command_code_window_units" }, windowPolicy: { kind: "rolling_duration", durationSeconds: 18_000 }, limitValue: 14, unit: "provider units", enforcement: "hard", status: "healthy", providerKey: "window:fiveHour", metadata: { scope: "product" } },
  { id: "bucket:demo:cc-weekly", accountId: "account:demo:command-code", productId: "product:demo:command-code-goat", displayName: "Weekly window", metric: { kind: "provider_defined", providerKey: "command_code_window_units" }, windowPolicy: { kind: "rolling_duration", durationSeconds: 604_800 }, limitValue: 35, unit: "provider units", enforcement: "hard", status: "warning", providerKey: "window:weekly", metadata: { scope: "product" } },
  { id: "bucket:demo:chatgpt-percentage", accountId: "account:demo:chatgpt", productId: "product:demo:chatgpt", displayName: "Weekly usage", metric: { kind: "percentage" }, windowPolicy: { kind: "provider_reported" }, unit: "%", enforcement: "hard", status: "healthy", metadata: { scope: "product" } },
  { id: "bucket:demo:openrouter-shared", accountId: "account:demo:openrouter", productId: "product:demo:openrouter", displayName: "Shared prepaid pool", metric: { kind: "currency", currency: "USD" }, windowPolicy: { kind: "none" }, unit: "USD", enforcement: "hard", status: "healthy", metadata: { scope: "shared_pool" } },
  { id: "bucket:demo:free-requests", accountId: "account:demo:kira", productId: "product:demo:free", displayName: "Daily free requests", metric: { kind: "requests" }, windowPolicy: { kind: "fixed_calendar", calendarUnit: "day", timezone: "UTC" }, limitValue: 100, unit: "requests", enforcement: "hard", status: "healthy", metadata: { scope: "route" } },
  { id: "bucket:demo:promo-units", accountId: "account:demo:kira", productId: "product:demo:promo", displayName: "Promo capacity", metric: { kind: "provider_defined", providerKey: "promo_units" }, windowPolicy: { kind: "provider_reported" }, unit: "promo units", enforcement: "hard", status: "healthy", metadata: { scope: "route" } },
  { id: "bucket:demo:trial-tokens", accountId: "account:demo:trial", productId: "product:demo:trial", displayName: "Trial token pool", metric: { kind: "tokens" }, windowPolicy: { kind: "fixed_calendar", calendarUnit: "week", timezone: "UTC" }, limitValue: 2_000_000, unit: "tokens", enforcement: "hard", status: "healthy", metadata: { scope: "route" } },
];

const bindings: QuotaBinding[] = [
  { id: "binding:demo:cc-monthly", accessRouteId: "route:demo:command-code", quotaBucketId: "bucket:demo:cc-monthly", activeFrom: observedAt, priority: 1, metadata: {} },
  { id: "binding:demo:cc-five-hour", accessRouteId: "route:demo:command-code", quotaBucketId: "bucket:demo:cc-five-hour", activeFrom: observedAt, priority: 2, metadata: {} },
  { id: "binding:demo:cc-weekly", accessRouteId: "route:demo:command-code", quotaBucketId: "bucket:demo:cc-weekly", activeFrom: observedAt, priority: 3, metadata: {} },
  { id: "binding:demo:chatgpt", accessRouteId: "route:demo:chatgpt", quotaBucketId: "bucket:demo:chatgpt-percentage", activeFrom: observedAt, metadata: {} },
  { id: "binding:demo:openrouter-claude", accessRouteId: "route:demo:openrouter-claude", quotaBucketId: "bucket:demo:openrouter-shared", activeFrom: observedAt, metadata: {} },
  { id: "binding:demo:openrouter-qwen", accessRouteId: "route:demo:openrouter-qwen", quotaBucketId: "bucket:demo:openrouter-shared", activeFrom: observedAt, metadata: {} },
  { id: "binding:demo:free", accessRouteId: "route:demo:free", quotaBucketId: "bucket:demo:free-requests", activeFrom: observedAt, metadata: {} },
  { id: "binding:demo:promo", accessRouteId: "route:demo:promo", quotaBucketId: "bucket:demo:promo-units", activeFrom: observedAt, metadata: {} },
  { id: "binding:demo:trial", accessRouteId: "route:demo:trial", quotaBucketId: "bucket:demo:trial-tokens", activeFrom: observedAt, metadata: {} },
];

const snapshots: QuotaSnapshot[] = [
  { id: "snapshot:demo:cc-monthly", quotaBucketId: "bucket:demo:cc-monthly", observedAt, remainingValue: 35, resetAt: "2026-10-07T00:00:00.000Z", source: "provider_official_cli", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:demo:cc-purchased", quotaBucketId: "bucket:demo:cc-purchased", observedAt, remainingValue: 12, source: "provider_official_cli", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:demo:cc-free", quotaBucketId: "bucket:demo:cc-free", observedAt, remainingValue: 0, source: "provider_official_cli", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:demo:cc-five-hour", quotaBucketId: "bucket:demo:cc-five-hour", observedAt, usedValue: 4, remainingValue: 10, limitValue: 14, usedFraction: 4 / 14, remainingFraction: 10 / 14, source: "provider_official_cli", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:demo:cc-weekly", quotaBucketId: "bucket:demo:cc-weekly", observedAt, usedValue: 27, remainingValue: 8, limitValue: 35, usedFraction: 27 / 35, remainingFraction: 8 / 35, source: "provider_official_cli", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:demo:chatgpt", quotaBucketId: "bucket:demo:chatgpt-percentage", observedAt, usedFraction: 0.41, remainingFraction: 0.59, providerResetText: "Provider reports a user-triggerable reset when available", source: "provider_official_api", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:demo:openrouter", quotaBucketId: "bucket:demo:openrouter-shared", observedAt, remainingValue: 7.31, source: "provider_official_api", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:demo:free", quotaBucketId: "bucket:demo:free-requests", observedAt, usedValue: 58, remainingValue: 42, limitValue: 100, resetAt: "2026-09-15T00:00:00.000Z", source: "provider_official_api", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:demo:promo", quotaBucketId: "bucket:demo:promo-units", observedAt, usedValue: 18, remainingValue: 82, limitValue: 100, source: "provider_official_api", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:demo:trial", quotaBucketId: "bucket:demo:trial-tokens", observedAt, usedValue: 1_200_000, remainingValue: 800_000, limitValue: 2_000_000, source: "provider_official_api", confidence: "exact", stalenessAfter: freshUntil },
];

const usageEvents: UsageEvent[] = [
  { id: "usage:demo:1", occurredAt: "2026-09-14T17:45:00.000Z", providerId: "provider:demo:command-code", accountId: "account:demo:command-code", productId: "product:demo:command-code-goat", accessRouteId: "route:demo:command-code", modelIdentityId: "model:demo:command-code", requests: 3, providerUnits: 4, providerUnitName: "provider units", source: "router_measured", confidence: "measured", metadata: {} },
  { id: "usage:demo:2", occurredAt: "2026-09-14T17:30:00.000Z", providerId: "provider:demo:openrouter", accountId: "account:demo:openrouter", productId: "product:demo:openrouter", accessRouteId: "route:demo:openrouter-qwen", modelIdentityId: "model:demo:qwen", inputTokens: 12_400, outputTokens: 2_100, requests: 2, source: "router_measured", confidence: "measured", metadata: {} },
];

const costEvents: CostEvent[] = [
  { id: "cost:demo:subscription", occurredAt: "2026-09-07T00:00:00.000Z", providerId: "provider:demo:command-code", accountId: "account:demo:command-code", productId: "product:demo:command-code-goat", amount: 20, currency: "USD", kind: "subscription_fee", source: "manual", confidence: "exact", metadata: {} },
  { id: "cost:demo:openrouter", occurredAt: "2026-09-14T17:30:00.000Z", providerId: "provider:demo:openrouter", accountId: "account:demo:openrouter", productId: "product:demo:openrouter", accessRouteId: "route:demo:openrouter-qwen", amount: 0.13, currency: "USD", kind: "usage", source: "provider_official_api", confidence: "exact", metadata: {} },
];

export async function seedPublicSafeCatalogFixture(store: UsageStore): Promise<void> {
  for (const value of providers) await store.upsertProvider(value);
  for (const value of accounts) await store.upsertAccount(value);
  for (const value of products) await store.upsertProduct(value);
  for (const value of subscriptionPeriods) await store.upsertSubscriptionPeriod(value);
  for (const value of models) await store.upsertModelIdentity(value);
  for (const value of routes) await store.upsertAccessRoute(value);
  for (const value of buckets) await store.upsertQuotaBucket(value);
  for (const value of bindings) await store.upsertQuotaBinding(value);
  await store.appendQuotaSnapshots(snapshots);
  await store.appendUsageEvents(usageEvents);
  await store.appendCostEvents(costEvents);
}

function demoAdapter(id: string): UsageAdapter {
  return {
    id,
    manifest: () => ({
      id,
      displayName: "Public demo fixture",
      collectionSafety: "non_inference_only",
      minimumRefreshIntervalMs: 60_000,
    }),
    capabilities: () => new Set(),
    health: async () => ({ status: "healthy" }),
    discover: async () => ({ status: "ok", providers: [], accounts: [], products: [], models: [], accessRoutes: [] }),
    collectUsageEvents: async () => ({ status: "unsupported", capability: "collect_usage_events" }),
    collectQuotaSnapshots: async () => ({ status: "unsupported", capability: "collect_quota_snapshots" }),
    collectCostEvents: async () => ({ status: "unsupported", capability: "collect_costs" }),
    refresh: async () => ({ status: "unsupported", capability: "manual_refresh" }),
  };
}

export function createPublicSafeDemoIntegrationCatalog(): UsageIntegrationCatalog {
  const catalog = new UsageIntegrationCatalog();
  for (const type of new Set(PUBLIC_SAFE_DEMO_CONFIG.integrations.map((entry) => entry.type))) {
    catalog.register(type, (definition) => demoAdapter(definition.id));
  }
  return catalog;
}

function copyConfig(value: LoadedUsageRuntimeConfig): LoadedUsageRuntimeConfig {
  return parseUsageRuntimeConfig(JSON.parse(JSON.stringify(value)) as unknown);
}

export class PublicSafeDemoManagedConfigStore extends ManagedConfigStore {
  private value: LoadedUsageRuntimeConfig;

  constructor(initial: LoadedUsageRuntimeConfig = PUBLIC_SAFE_DEMO_CONFIG) {
    super("/dev/null/cmm-usage-public-demo");
    this.value = copyConfig(initial);
  }

  override async read(): Promise<LoadedUsageRuntimeConfig> {
    return copyConfig(this.value);
  }

  override async write(value: LoadedUsageRuntimeConfig): Promise<void> {
    this.value = copyConfig(value);
  }

  override async update(
    mutate: (current: LoadedUsageRuntimeConfig) => LoadedUsageRuntimeConfig,
  ): Promise<LoadedUsageRuntimeConfig> {
    this.value = copyConfig(mutate(await this.read()));
    return this.read();
  }
}

export class PublicSafeDemoCredentialWriter implements CredentialWriter {
  private readonly values = new Set<string>();

  async write(instanceId: string, secret: string) {
    const value = secret.trim();
    if (value.length === 0) throw new Error("Credential value must not be empty");
    const reference = `demo://credential/${encodeURIComponent(instanceId)}`;
    this.values.add(reference);
    return { credentialRef: reference, hint: value.length <= 4 ? "••••" : `••••${value.slice(-4)}` };
  }

  async remove(reference: string): Promise<void> {
    this.values.delete(reference);
  }
}

export const publicSafeCatalogFixture = {
  observedAt,
  providers,
  products,
  routes,
  buckets,
  bindings,
  snapshots,
} as const;
