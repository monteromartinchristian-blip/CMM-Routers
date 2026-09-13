import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Account,
  Product,
  Provider,
  QuotaBucket,
  QuotaSnapshot,
  UsageEvent,
} from "../../../src/usage/domain/types.js";
import { UsageEventIngestor } from "../../../src/usage/ingestion/event-ingestor.js";
import { QuotaSnapshotIngestor } from "../../../src/usage/ingestion/snapshot-ingestor.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";

let store: SqliteUsageStore;

const provider: Provider = {
  id: "provider:test",
  displayName: "Test Provider",
  kind: "first_party",
  status: "enabled",
  metadata: {},
  createdAt: "2026-09-13T12:00:00.000Z",
  updatedAt: "2026-09-13T12:00:00.000Z",
};

const account: Account = {
  id: "account:test",
  providerId: provider.id,
  label: "Test Account",
  status: "active",
  createdAt: "2026-09-13T12:00:00.000Z",
  updatedAt: "2026-09-13T12:00:00.000Z",
};

const product: Product = {
  id: "product:test",
  providerId: provider.id,
  displayName: "Test Product",
  kind: "subscription",
  metadata: {},
};

const bucket: QuotaBucket = {
  id: "bucket:test",
  accountId: account.id,
  productId: product.id,
  displayName: "Test quota",
  metric: { kind: "requests" },
  windowPolicy: { kind: "rolling_duration", durationSeconds: 18_000 },
  unit: "requests",
  enforcement: "hard",
  status: "healthy",
  metadata: {},
};

beforeEach(async () => {
  store = new SqliteUsageStore(":memory:");
  await store.initialize();
  await store.upsertProvider(provider);
  await store.upsertAccount(account);
  await store.upsertProduct(product);
  await store.upsertQuotaBucket(bucket);
});

afterEach(async () => {
  await store.close();
});

describe("usage ingestion", () => {
  it("ingests an upstream usage event idempotently when its identity repeats", async () => {
    const event: UsageEvent = {
      id: "usage:provider-event-1",
      occurredAt: "2026-09-13T12:00:00.000Z",
      providerId: provider.id,
      accountId: account.id,
      productId: product.id,
      requests: 1,
      inputTokens: 100,
      outputTokens: 25,
      source: "provider_official_api",
      confidence: "exact",
      metadata: {},
    };
    const ingestor = new UsageEventIngestor(store);

    await ingestor.ingest([event]);
    await ingestor.ingest([event]);

    expect(await store.listUsageEvents()).toEqual([event]);
  });

  it("ingests quota snapshots idempotently while preserving provenance", async () => {
    const value: QuotaSnapshot = {
      id: "snapshot:provider-observation-1",
      quotaBucketId: bucket.id,
      observedAt: "2026-09-13T12:00:00.000Z",
      remainingFraction: 0.31,
      source: "provider_official_api",
      confidence: "exact",
      stalenessAfter: "2026-09-13T12:10:00.000Z",
    };
    const ingestor = new QuotaSnapshotIngestor(store);

    await ingestor.ingest([value]);
    await ingestor.ingest([value]);

    expect(await store.getCurrentQuotaState(bucket.id)).toEqual([value]);
  });

  it("rejects invalid quota fractions before persistence", async () => {
    const ingestor = new QuotaSnapshotIngestor(store);

    await expect(
      ingestor.ingest([
        {
          id: "snapshot:invalid",
          quotaBucketId: bucket.id,
          observedAt: "2026-09-13T12:00:00.000Z",
          remainingFraction: 1.5,
          source: "provider_official_api",
          confidence: "exact",
          stalenessAfter: "2026-09-13T12:10:00.000Z",
        },
      ]),
    ).rejects.toThrow();

    expect(await store.getCurrentQuotaState(bucket.id)).toEqual([]);
  });
});
