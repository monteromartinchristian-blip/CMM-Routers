import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AccessRoute,
  Account,
  Product,
  Provider,
  QuotaBinding,
  QuotaBucket,
  QuotaSnapshot,
  SubscriptionPeriod,
  UsageEvent,
} from "../../../src/usage/domain/types.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";

const roots: string[] = [];

function tempDb(): string {
  const root = mkdtempSync(join(tmpdir(), "cmm-usage-store-"));
  roots.push(root);
  return join(root, "usage.sqlite");
}

function provider(): Provider {
  return {
    id: "provider:example",
    displayName: "Example Provider",
    kind: "manual",
    status: "active",
    metadata: {},
    createdAt: "2026-09-13T12:00:00.000Z",
    updatedAt: "2026-09-13T12:00:00.000Z",
  };
}

function account(): Account {
  return {
    id: "account:example",
    providerId: "provider:example",
    label: "Example Account",
    status: "active",
    createdAt: "2026-09-13T12:00:00.000Z",
    updatedAt: "2026-09-13T12:00:00.000Z",
  };
}

function product(): Product {
  return {
    id: "product:example",
    providerId: "provider:example",
    displayName: "Example Product",
    kind: "subscription",
    metadata: {},
  };
}

function subscription(status: SubscriptionPeriod["status"] = "active"): SubscriptionPeriod {
  return {
    id: "subscription:example:1",
    accountId: "account:example",
    productId: "product:example",
    status,
    startedAt: "2026-09-01T00:00:00.000Z",
    ...(status === "cancelled" ? { endedAt: "2026-09-13T12:00:00.000Z" } : {}),
    metadata: {},
  };
}

function route(): AccessRoute {
  return {
    id: "route:example",
    accountId: "account:example",
    productId: "product:example",
    subscriptionPeriodId: "subscription:example:1",
    providerModelId: "example-model",
    displayName: "Example Model",
    status: "available",
    metadata: {},
  };
}

function bucket(): QuotaBucket {
  return {
    id: "bucket:example",
    accountId: "account:example",
    productId: "product:example",
    displayName: "Weekly requests",
    metric: { kind: "requests" },
    windowPolicy: {
      kind: "fixed_calendar",
      calendarUnit: "week",
      timezone: "Europe/Madrid",
      anchor: "monday",
    },
    limitValue: 1_000,
    unit: "requests",
    enforcement: "hard",
    status: "healthy",
    metadata: {},
  };
}

function binding(): QuotaBinding {
  return {
    id: "binding:example",
    accessRouteId: "route:example",
    quotaBucketId: "bucket:example",
    activeFrom: "2026-09-01T00:00:00.000Z",
    metadata: {},
  };
}

function snapshot(): QuotaSnapshot {
  return {
    id: "snapshot:example",
    quotaBucketId: "bucket:example",
    observedAt: "2026-09-13T12:00:00.000Z",
    usedValue: 250,
    remainingValue: 750,
    limitValue: 1_000,
    usedFraction: 0.25,
    remainingFraction: 0.75,
    resetAt: "2026-09-14T22:00:00.000Z",
    source: "provider_official_api",
    confidence: "exact",
    stalenessAfter: "2026-09-13T12:10:00.000Z",
    rawSafeMetadata: { providerWindow: "weekly" },
  };
}

async function seedGraph(store: SqliteUsageStore): Promise<void> {
  await store.upsertProvider(provider());
  await store.upsertAccount(account());
  await store.upsertProduct(product());
  await store.upsertSubscriptionPeriod(subscription());
  await store.upsertAccessRoute(route());
  await store.upsertQuotaBucket(bucket());
  await store.upsertQuotaBinding(binding());
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SqliteUsageStore", () => {
  it("scrubs legacy OpenRouter current-key bucket identities when upgrading an existing database", async () => {
    const path = tempDb();
    const legacy = new DatabaseSync(path);
    legacy.exec("PRAGMA foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    legacy.exec(
      readFileSync(
        new URL("../../../src/usage/storage/schema/001_initial.sql", import.meta.url),
        "utf8",
      ),
    );
    legacy
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(1, "2026-09-13T12:00:00.000Z");

    const providerId = "provider:openrouter";
    const accountId = "account:openrouter";
    const productId = "product:openrouter-credits";
    const routeId = "route:openrouter:openai%2Fgpt-4";
    const sensitiveLabel = "private-current-key-label";
    const legacyBucketId = `bucket:openrouter:${encodeURIComponent(`key:${sensitiveLabel}:usage`)}`;
    const orgBucketId = `bucket:openrouter:${encodeURIComponent("org:credits")}`;

    const insertPayload = (
      table: string,
      value: { id: string } & Record<string, unknown>,
      columns: readonly [string, string | null][],
    ) => {
      const names = ["id", ...columns.map(([name]) => name), "payload_json"];
      legacy
        .prepare(`INSERT INTO ${table}(${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
        .run(value.id, ...columns.map(([, entry]) => entry), JSON.stringify(value));
    };

    insertPayload("providers", {
      id: providerId,
      displayName: "OpenRouter",
      kind: "aggregator",
      status: "enabled",
      metadata: {},
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:00:00.000Z",
    }, []);
    insertPayload("accounts", {
      id: accountId,
      providerId,
      label: "OpenRouter account",
      status: "active",
      createdAt: "2026-09-13T12:00:00.000Z",
      updatedAt: "2026-09-13T12:00:00.000Z",
    }, [["provider_id", providerId]]);
    insertPayload("products", {
      id: productId,
      providerId,
      displayName: "OpenRouter credits",
      kind: "api",
      metadata: {},
    }, [["provider_id", providerId]]);
    insertPayload("access_routes", {
      id: routeId,
      accountId,
      productId,
      providerModelId: "openai/gpt-4",
      displayName: "GPT-4",
      status: "available",
      metadata: {},
    }, [
      ["account_id", accountId],
      ["product_id", productId],
      ["subscription_period_id", null],
      ["model_identity_id", null],
    ]);
    insertPayload("quota_buckets", {
      id: legacyBucketId,
      accountId,
      productId,
      displayName: `${sensitiveLabel} total usage`,
      metric: { kind: "currency", currency: "USD" },
      windowPolicy: { kind: "none" },
      unit: "USD",
      enforcement: "unknown",
      status: "unknown",
      providerKey: `key:${sensitiveLabel}:usage`,
      metadata: { counter: true },
    }, [
      ["account_id", accountId],
      ["product_id", productId],
      ["quota_group_id", null],
    ]);
    insertPayload("quota_buckets", {
      id: orgBucketId,
      accountId,
      productId,
      displayName: "Organization credit pool",
      metric: { kind: "currency", currency: "USD" },
      windowPolicy: { kind: "none" },
      unit: "USD",
      enforcement: "hard",
      status: "healthy",
      providerKey: "org:credits",
      metadata: {},
    }, [
      ["account_id", accountId],
      ["product_id", productId],
      ["quota_group_id", null],
    ]);
    insertPayload("quota_bindings", {
      id: "binding:legacy-openrouter",
      accessRouteId: routeId,
      quotaBucketId: legacyBucketId,
      activeFrom: "2026-09-13T12:00:00.000Z",
      metadata: {},
    }, [
      ["access_route_id", routeId],
      ["quota_bucket_id", legacyBucketId],
      ["consumption_rule_id", null],
    ]);
    legacy
      .prepare(
        "INSERT INTO quota_snapshots(id, quota_bucket_id, observed_at, payload_json) VALUES (?, ?, ?, ?)",
      )
      .run(
        "snapshot:legacy-openrouter",
        legacyBucketId,
        "2026-09-13T12:00:00.000Z",
        JSON.stringify({
          id: "snapshot:legacy-openrouter",
          quotaBucketId: legacyBucketId,
          observedAt: "2026-09-13T12:00:00.000Z",
          usedValue: 1,
          source: "provider_official_api",
          confidence: "measured",
          stalenessAfter: "2026-09-13T12:01:00.000Z",
        }),
      );
    legacy.close();

    const store = new SqliteUsageStore(path);
    await store.initialize();

    const buckets = await store.listQuotaBuckets(productId);
    expect(JSON.stringify(buckets)).not.toContain(sensitiveLabel);
    expect(buckets.map((value) => value.id)).toEqual([orgBucketId]);
    expect(await store.getCurrentQuotaState(legacyBucketId)).toEqual([]);
    const graph = await store.getRouteGraph(routeId);
    expect(graph.bindings).toEqual([]);
    await store.close();
  });

  it("migrates an empty database and persists quota snapshots across reopen", async () => {
    const path = tempDb();
    const first = new SqliteUsageStore(path);
    await first.initialize();
    await seedGraph(first);
    await first.appendQuotaSnapshots([snapshot()]);
    await first.close();

    const second = new SqliteUsageStore(path);
    await second.initialize();
    const snapshots = await second.getCurrentQuotaState("bucket:example");
    await second.close();

    expect(snapshots).toEqual([snapshot()]);
  });

  it("enforces foreign keys for graph entities", async () => {
    const store = new SqliteUsageStore(tempDb());
    await store.initialize();

    await expect(store.upsertAccount(account())).rejects.toThrow();
    await store.close();
  });

  it("rolls back a batch when one usage event violates a foreign key", async () => {
    const store = new SqliteUsageStore(tempDb());
    await store.initialize();
    await seedGraph(store);
    const base: UsageEvent = {
      id: "usage:valid",
      occurredAt: "2026-09-13T12:00:00.000Z",
      providerId: "provider:example",
      accountId: "account:example",
      productId: "product:example",
      accessRouteId: "route:example",
      requests: 1,
      source: "router_measured",
      confidence: "measured",
      metadata: {},
    };

    await expect(
      store.appendUsageEvents([
        base,
        { ...base, id: "usage:invalid", accountId: "account:missing" },
      ]),
    ).rejects.toThrow();

    expect(await store.listUsageEvents()).toEqual([]);
    await store.close();
  });

  it("preserves a subscription period after cancellation", async () => {
    const store = new SqliteUsageStore(tempDb());
    await store.initialize();
    await store.upsertProvider(provider());
    await store.upsertAccount(account());
    await store.upsertProduct(product());
    await store.upsertSubscriptionPeriod(subscription());
    await store.upsertSubscriptionPeriod(subscription("cancelled"));

    expect(await store.getSubscriptionPeriod("subscription:example:1")).toEqual(
      subscription("cancelled"),
    );
    await store.close();
  });

  it("retains provenance and confidence on stored quota snapshots", async () => {
    const store = new SqliteUsageStore(tempDb());
    await store.initialize();
    await seedGraph(store);
    await store.appendQuotaSnapshots([snapshot()]);

    const [stored] = await store.getCurrentQuotaState("bucket:example");
    expect(stored?.source).toBe("provider_official_api");
    expect(stored?.confidence).toBe("exact");
    expect(stored?.rawSafeMetadata).toEqual({ providerWindow: "weekly" });
    await store.close();
  });

  it("does not define content or credential columns in the schema", async () => {
    const path = tempDb();
    const store = new SqliteUsageStore(path);
    await store.initialize();
    await store.close();

    const schema = readFileSync(
      new URL("../../../src/usage/storage/schema/001_initial.sql", import.meta.url),
      "utf8",
    ).toLowerCase();
    for (const forbidden of ["prompt", "completion", "api_key", "apikey", "oauth", "authorization"]) {
      expect(schema).not.toContain(forbidden);
    }
  });

  it("rejects sensitive metadata instead of serializing it", async () => {
    const store = new SqliteUsageStore(tempDb());
    await store.initialize();

    await expect(
      store.upsertProvider({
        ...provider(),
        metadata: { apiKey: "must-never-be-persisted" },
      }),
    ).rejects.toThrow(/sensitive/i);
    await store.close();
  });
});
