import type {
  AccessRoute,
  Account,
  ModelIdentity,
  Product,
  Provider,
  QuotaBinding,
  QuotaBucket,
  QuotaSnapshot,
  SubscriptionPeriod,
} from "../../../src/usage/domain/types.js";
import type { UsageStore } from "../../../src/usage/storage/usage-store.js";

const observedAt = "2026-09-14T18:00:00.000Z";
const freshUntil = "2026-09-14T19:00:00.000Z";

const providers: Provider[] = [
  { id: "provider:command-code", displayName: "Command Code", kind: "client_plan", status: "enabled", metadata: {}, createdAt: observedAt, updatedAt: observedAt },
  { id: "provider:anthropic", displayName: "Anthropic", kind: "first_party", status: "enabled", metadata: {}, createdAt: observedAt, updatedAt: observedAt },
  { id: "provider:google", displayName: "Google AI Pro", kind: "first_party", status: "enabled", metadata: {}, createdAt: observedAt, updatedAt: observedAt },
  { id: "provider:openrouter", displayName: "OpenRouter", kind: "aggregator", status: "enabled", metadata: {}, createdAt: observedAt, updatedAt: observedAt },
  { id: "provider:kira", displayName: "Kira AI", kind: "generic", status: "enabled", metadata: {}, createdAt: observedAt, updatedAt: observedAt },
];

const accounts: Account[] = providers.map((provider) => ({
  id: `account:${provider.id.slice("provider:".length)}`,
  providerId: provider.id,
  label: `${provider.displayName} account`,
  status: "active",
  createdAt: observedAt,
  updatedAt: observedAt,
}));

const products: Product[] = [
  { id: "product:command-code:individual-goat", providerId: "provider:command-code", displayName: "individual-goat", kind: "subscription", metadata: { planId: "individual-goat" } },
  { id: "product:anthropic", providerId: "provider:anthropic", displayName: "Claude subscription", kind: "subscription", metadata: {} },
  { id: "product:google", providerId: "provider:google", displayName: "Google AI Pro", kind: "subscription", metadata: {} },
  { id: "product:openrouter", providerId: "provider:openrouter", displayName: "OpenRouter credits", kind: "api", metadata: { billing: "prepaid_credits" } },
  { id: "product:kira-promo", providerId: "provider:kira", displayName: "Kira free access", kind: "api", metadata: { offerKind: "PROMO", offerSource: "provider_official_api", offerConfidence: "exact", offerValidUntil: "2026-09-30T23:59:59.000Z" } },
];

const models: ModelIdentity[] = [
  { id: "model:claude-sonnet", canonicalName: "Claude Sonnet", vendor: "Anthropic", lifecycle: "active", aliases: [], metadata: {} },
  { id: "model:qwen-flash", canonicalName: "Qwen Flash", vendor: "Qwen", lifecycle: "active", aliases: [], metadata: {} },
  { id: "model:command-code", canonicalName: "Command Code", vendor: "Command Code", lifecycle: "active", aliases: [], metadata: {} },
];

const routes: AccessRoute[] = [
  { id: "route:command-code", accountId: "account:command-code", productId: "product:command-code:individual-goat", modelIdentityId: "model:command-code", providerModelId: "command-code", displayName: "Command Code", status: "available", metadata: {} },
  { id: "route:anthropic:claude", accountId: "account:anthropic", productId: "product:anthropic", modelIdentityId: "model:claude-sonnet", providerModelId: "claude-sonnet", displayName: "Claude Sonnet", status: "available", metadata: {} },
  { id: "route:google:claude", accountId: "account:google", productId: "product:google", modelIdentityId: "model:claude-sonnet", providerModelId: "claude-sonnet", displayName: "Claude Sonnet", status: "available", metadata: {} },
  { id: "route:openrouter:claude", accountId: "account:openrouter", productId: "product:openrouter", modelIdentityId: "model:claude-sonnet", providerModelId: "anthropic/claude-sonnet", displayName: "Claude Sonnet", status: "available", metadata: {} },
  { id: "route:openrouter:qwen", accountId: "account:openrouter", productId: "product:openrouter", modelIdentityId: "model:qwen-flash", providerModelId: "qwen/qwen-flash", displayName: "Qwen Flash", status: "available", metadata: {} },
  { id: "route:kira:qwen", accountId: "account:kira", productId: "product:kira-promo", modelIdentityId: "model:qwen-flash", providerModelId: "qwen-flash", displayName: "Qwen Flash", status: "available", metadata: { offerKind: "PROMO" } },
];

const subscriptionPeriods: SubscriptionPeriod[] = [
  { id: "subscription:command-code", accountId: "account:command-code", productId: "product:command-code:individual-goat", status: "active", startedAt: "2026-09-07T00:00:00.000Z", metadata: { providerPeriodEnd: "2026-10-07T00:00:00.000Z" } },
];

const buckets: QuotaBucket[] = [
  { id: "bucket:cc:monthly", accountId: "account:command-code", productId: "product:command-code:individual-goat", displayName: "Monthly plan credits", metric: { kind: "credits" }, windowPolicy: { kind: "billing_cycle", anchorDate: "2026-09-07", timezone: "UTC" }, unit: "credits", enforcement: "hard", status: "healthy", providerKey: "credits:monthly", metadata: { scope: "product" } },
  { id: "bucket:cc:purchased", accountId: "account:command-code", productId: "product:command-code:individual-goat", displayName: "Purchased credits", metric: { kind: "credits" }, windowPolicy: { kind: "none" }, unit: "credits", enforcement: "soft", status: "unknown", providerKey: "credits:purchased", metadata: { scope: "product", supplementalBalance: true } },
  { id: "bucket:cc:free", accountId: "account:command-code", productId: "product:command-code:individual-goat", displayName: "Free credits", metric: { kind: "credits" }, windowPolicy: { kind: "none" }, unit: "credits", enforcement: "soft", status: "unknown", providerKey: "credits:free", metadata: { scope: "product", supplementalBalance: true } },
  { id: "bucket:cc:five-hour", accountId: "account:command-code", productId: "product:command-code:individual-goat", displayName: "5-hour window", metric: { kind: "provider_defined", providerKey: "command_code_window_units" }, windowPolicy: { kind: "rolling_duration", durationSeconds: 18_000 }, limitValue: 14, unit: "provider units", enforcement: "hard", status: "healthy", providerKey: "window:fiveHour", metadata: { scope: "product" } },
  { id: "bucket:cc:weekly", accountId: "account:command-code", productId: "product:command-code:individual-goat", displayName: "Weekly window", metric: { kind: "provider_defined", providerKey: "command_code_window_units" }, windowPolicy: { kind: "rolling_duration", durationSeconds: 604_800 }, limitValue: 35, unit: "provider units", enforcement: "hard", status: "healthy", providerKey: "window:weekly", metadata: { scope: "product" } },
  { id: "bucket:anthropic:weekly", accountId: "account:anthropic", productId: "product:anthropic", displayName: "Weekly utilization", metric: { kind: "percentage" }, windowPolicy: { kind: "provider_reported" }, unit: "%", enforcement: "hard", status: "healthy", metadata: { scope: "product" } },
  { id: "bucket:google:tokens", accountId: "account:google", productId: "product:google", displayName: "Claude token pool", metric: { kind: "tokens" }, windowPolicy: { kind: "fixed_calendar", calendarUnit: "day", timezone: "UTC" }, limitValue: 2_000_000, unit: "tokens", enforcement: "hard", status: "healthy", metadata: { scope: "shared_pool" } },
  { id: "bucket:openrouter:credits", accountId: "account:openrouter", productId: "product:openrouter", displayName: "Shared prepaid pool", metric: { kind: "currency", currency: "USD" }, windowPolicy: { kind: "none" }, unit: "USD", enforcement: "hard", status: "healthy", metadata: { scope: "shared_pool" } },
  { id: "bucket:kira:requests", accountId: "account:kira", productId: "product:kira-promo", displayName: "Daily allowance", metric: { kind: "requests" }, windowPolicy: { kind: "fixed_calendar", calendarUnit: "day", timezone: "UTC" }, limitValue: 100, unit: "requests", enforcement: "hard", status: "healthy", metadata: { scope: "route" } },
];

const bindings: QuotaBinding[] = [
  { id: "binding:cc:monthly", accessRouteId: "route:command-code", quotaBucketId: "bucket:cc:monthly", activeFrom: observedAt, priority: 1, metadata: {} },
  { id: "binding:cc:five-hour", accessRouteId: "route:command-code", quotaBucketId: "bucket:cc:five-hour", activeFrom: observedAt, priority: 2, metadata: {} },
  { id: "binding:cc:weekly", accessRouteId: "route:command-code", quotaBucketId: "bucket:cc:weekly", activeFrom: observedAt, priority: 3, metadata: {} },
  { id: "binding:anthropic", accessRouteId: "route:anthropic:claude", quotaBucketId: "bucket:anthropic:weekly", activeFrom: observedAt, metadata: {} },
  { id: "binding:google", accessRouteId: "route:google:claude", quotaBucketId: "bucket:google:tokens", activeFrom: observedAt, metadata: {} },
  { id: "binding:openrouter:claude", accessRouteId: "route:openrouter:claude", quotaBucketId: "bucket:openrouter:credits", activeFrom: observedAt, metadata: {} },
  { id: "binding:openrouter:qwen", accessRouteId: "route:openrouter:qwen", quotaBucketId: "bucket:openrouter:credits", activeFrom: observedAt, metadata: {} },
  { id: "binding:kira", accessRouteId: "route:kira:qwen", quotaBucketId: "bucket:kira:requests", activeFrom: observedAt, metadata: {} },
];

const snapshots: QuotaSnapshot[] = [
  { id: "snapshot:cc:monthly", quotaBucketId: "bucket:cc:monthly", observedAt, remainingValue: 35, resetAt: "2026-10-07T00:00:00.000Z", source: "provider_official_cli", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:cc:purchased", quotaBucketId: "bucket:cc:purchased", observedAt, remainingValue: 0, source: "provider_official_cli", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:cc:free", quotaBucketId: "bucket:cc:free", observedAt, remainingValue: 0, source: "provider_official_cli", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:cc:five-hour", quotaBucketId: "bucket:cc:five-hour", observedAt, remainingValue: 14, limitValue: 14, remainingFraction: 1, source: "provider_official_cli", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:cc:weekly", quotaBucketId: "bucket:cc:weekly", observedAt, remainingValue: 35, limitValue: 35, remainingFraction: 1, source: "provider_official_cli", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:anthropic", quotaBucketId: "bucket:anthropic:weekly", observedAt, usedFraction: 0.61, remainingFraction: 0.39, source: "provider_official_api", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:google", quotaBucketId: "bucket:google:tokens", observedAt, usedValue: 1_200_000, remainingValue: 800_000, limitValue: 2_000_000, source: "provider_official_api", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:openrouter", quotaBucketId: "bucket:openrouter:credits", observedAt, remainingValue: 7.31, source: "provider_official_api", confidence: "exact", stalenessAfter: freshUntil },
  { id: "snapshot:kira", quotaBucketId: "bucket:kira:requests", observedAt, usedValue: 58, remainingValue: 42, limitValue: 100, resetAt: "2026-09-15T00:00:00.000Z", source: "provider_official_api", confidence: "exact", stalenessAfter: freshUntil },
];

export async function seedCatalogScenario(store: UsageStore): Promise<void> {
  for (const value of providers) await store.upsertProvider(value);
  for (const value of accounts) await store.upsertAccount(value);
  for (const value of products) await store.upsertProduct(value);
  for (const value of subscriptionPeriods) await store.upsertSubscriptionPeriod(value);
  for (const value of models) await store.upsertModelIdentity(value);
  for (const value of routes) await store.upsertAccessRoute(value);
  for (const value of buckets) await store.upsertQuotaBucket(value);
  for (const value of bindings) await store.upsertQuotaBinding(value);
  await store.appendQuotaSnapshots(snapshots);
}

export const catalogScenario = {
  observedAt,
  providers,
  products,
  routes,
  buckets,
  bindings,
  snapshots,
} as const;
