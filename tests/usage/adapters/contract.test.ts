import { describe, expect, it } from "vitest";
import { UsageAdapterManager } from "../../../src/usage/adapters/adapter-manager.js";
import {
  UsageAdapterError,
  type CostEventBatch,
  type QuotaSnapshotBatch,
  type UsageAdapter,
  type UsageAdapterCapability,
  type UsageAdapterHealth,
  type UsageAdapterManifest,
  type UsageDiscoveryResult,
  type UsageEventBatch,
  type UsageRefreshResult,
} from "../../../src/usage/adapters/contract.js";

class TestAdapter implements UsageAdapter {
  readonly id = "test-adapter";
  quotaCalls = 0;

  constructor(
    private readonly declaredCapabilities: readonly UsageAdapterCapability[],
    private readonly quotaResult: QuotaSnapshotBatch = { status: "ok", values: [] },
  ) {}

  manifest(): UsageAdapterManifest {
    return {
      id: this.id,
      displayName: "Test Adapter",
      collectionSafety: "non_inference_only",
    };
  }

  capabilities(): ReadonlySet<UsageAdapterCapability> {
    return new Set(this.declaredCapabilities);
  }

  async health(): Promise<UsageAdapterHealth> {
    return { status: "healthy" };
  }

  async discover(): Promise<UsageDiscoveryResult> {
    return { status: "ok", providers: [], accounts: [], products: [], models: [], accessRoutes: [] };
  }

  async collectUsageEvents(): Promise<UsageEventBatch> {
    return { status: "ok", values: [] };
  }

  async collectQuotaSnapshots(): Promise<QuotaSnapshotBatch> {
    this.quotaCalls += 1;
    return this.quotaResult;
  }

  async collectCostEvents(): Promise<CostEventBatch> {
    return { status: "ok", values: [] };
  }

  async refresh(): Promise<UsageRefreshResult> {
    return { status: "ok", refreshedAt: "2026-09-13T12:00:00.000Z" };
  }
}

describe("usage adapter contract", () => {
  it("requires explicit capabilities and does not call unsupported collectors", async () => {
    const adapter = new TestAdapter([]);
    const manager = new UsageAdapterManager();
    manager.register(adapter);

    const result = await manager.collectQuotaSnapshots(adapter.id);

    expect(result).toEqual({
      status: "unsupported",
      capability: "collect_quota_snapshots",
    });
    expect(adapter.quotaCalls).toBe(0);
  });

  it("preserves an adapter's explicit unsupported result instead of converting it to empty data", async () => {
    const adapter = new TestAdapter(["collect_quota_snapshots"], {
      status: "unsupported",
      capability: "collect_quota_snapshots",
    });
    const manager = new UsageAdapterManager();
    manager.register(adapter);

    const result = await manager.collectQuotaSnapshots(adapter.id);

    expect(result).toEqual({
      status: "unsupported",
      capability: "collect_quota_snapshots",
    });
    expect(adapter.quotaCalls).toBe(1);
  });

  it("fails closed when normalized adapter output contains credential-shaped data", async () => {
    const unsafe = new TestAdapter(["collect_quota_snapshots"], {
      status: "ok",
      values: [],
      metadata: { apiKey: "secret-that-must-not-escape" },
    });
    const manager = new UsageAdapterManager();
    manager.register(unsafe);

    const result = await manager.collectQuotaSnapshots(unsafe.id);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected normalized error");
    expect(result.error.kind).toBe("protocol");
    expect(JSON.stringify(result)).not.toContain("secret-that-must-not-escape");
  });

  it.each([
    ["auth", "auth"],
    ["rate_limit", "rate_limit"],
    ["unavailable", "unavailable"],
    ["protocol", "protocol"],
  ] as const)("normalizes %s collection failures", async (thrownKind, expectedKind) => {
    const adapter = new TestAdapter(["collect_quota_snapshots"]);
    adapter.collectQuotaSnapshots = async () => {
      throw new UsageAdapterError(thrownKind, `test ${thrownKind}`);
    };
    const manager = new UsageAdapterManager();
    manager.register(adapter);

    const result = await manager.collectQuotaSnapshots(adapter.id);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected normalized error");
    expect(result.error.kind).toBe(expectedKind);
  });

  it("normalizes unknown thrown failures as protocol errors", async () => {
    const adapter = new TestAdapter(["collect_quota_snapshots"]);
    adapter.collectQuotaSnapshots = async () => {
      throw new Error("unexpected parser failure");
    };
    const manager = new UsageAdapterManager();
    manager.register(adapter);

    const result = await manager.collectQuotaSnapshots(adapter.id);

    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected normalized error");
    expect(result.error.kind).toBe("protocol");
  });

  it("rejects adapters that declare inference probing as a collection mechanism", () => {
    const adapter = new TestAdapter([]);
    adapter.manifest = () => ({
      id: adapter.id,
      displayName: "Unsafe Adapter",
      collectionSafety: "allows_inference_probe" as never,
    });
    const manager = new UsageAdapterManager();

    expect(() => manager.register(adapter)).toThrow(/inference/i);
  });

  it("can disable an adapter without unregistering its contract", async () => {
    const adapter = new TestAdapter(["collect_quota_snapshots"]);
    const manager = new UsageAdapterManager();
    manager.register(adapter);
    manager.setEnabled(adapter.id, false);

    const result = await manager.collectQuotaSnapshots(adapter.id);

    expect(result).toEqual({ status: "disabled" });
    expect(manager.get(adapter.id)).toBe(adapter);
    expect(adapter.quotaCalls).toBe(0);
  });

  it("can register multiple instances of one adapter type under stable runtime ids", () => {
    const first = new TestAdapter([]);
    const second = new TestAdapter([]);
    const manager = new UsageAdapterManager();

    manager.register(first, true, "claude-personal");
    manager.register(second, true, "claude-work");

    expect(manager.get("claude-personal")).toBe(first);
    expect(manager.get("claude-work")).toBe(second);
    expect(manager.list().map(({ id }) => id)).toEqual(["claude-personal", "claude-work"]);
  });
});
