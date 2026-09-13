import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
