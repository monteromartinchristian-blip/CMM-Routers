import type {
  CostEventBatch,
  QuotaSnapshotBatch,
  UsageAdapter,
  UsageAdapterCapability,
  UsageAdapterErrorState,
  UsageDiscoveryResult,
  UsageEventBatch,
  UsageRefreshResult,
} from "./contract.js";
import { UsageAdapterError, unsupported } from "./contract.js";

type AdapterResult =
  | UsageDiscoveryResult
  | UsageEventBatch
  | QuotaSnapshotBatch
  | CostEventBatch
  | UsageRefreshResult;

interface ManagedAdapter {
  adapter: UsageAdapter;
  enabled: boolean;
}

export interface ManagedUsageAdapterView {
  id: string;
  adapter: UsageAdapter;
  enabled: boolean;
}

const forbiddenOutputKeys = new Set([
  "apikey",
  "token",
  "oauthtoken",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "authorizationheader",
  "bearer",
  "bearertoken",
  "secret",
  "password",
]);

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertSafeOutput(value: unknown, path = "result"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeOutput(entry, `${path}[${index}]`));
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenOutputKeys.has(normalizedKey(key))) {
      throw new UsageAdapterError(
        "protocol",
        `Adapter output contained a sensitive field at ${path}.${key}`,
      );
    }
    assertSafeOutput(entry, `${path}.${key}`);
  }
}

function normalizeFailure(error: unknown): { status: "error"; error: UsageAdapterErrorState } {
  if (error instanceof UsageAdapterError) {
    return {
      status: "error",
      error: {
        kind: error.kind,
        message:
          error.kind === "protocol"
            ? "Usage adapter returned an invalid or unsafe response"
            : `Usage adapter failed: ${error.kind}`,
      },
    };
  }

  return {
    status: "error",
    error: {
      kind: "protocol",
      message: "Usage adapter failed with an unexpected error",
    },
  };
}

export class UsageAdapterManager {
  private readonly adapters = new Map<string, ManagedAdapter>();

  register(adapter: UsageAdapter, enabled = true): void {
    const manifest = adapter.manifest();
    if (manifest.id !== adapter.id) {
      throw new Error(`Usage adapter manifest id mismatch: ${adapter.id}`);
    }
    if (manifest.collectionSafety !== "non_inference_only") {
      throw new Error(`Usage adapter ${adapter.id} cannot use inference probing for metadata`);
    }
    this.adapters.set(adapter.id, { adapter, enabled });
  }

  get(id: string): UsageAdapter | undefined {
    return this.adapters.get(id)?.adapter;
  }

  setEnabled(id: string, enabled: boolean): void {
    const managed = this.adapters.get(id);
    if (managed === undefined) throw new Error(`Unknown usage adapter: ${id}`);
    managed.enabled = enabled;
  }

  isEnabled(id: string): boolean {
    return this.adapters.get(id)?.enabled ?? false;
  }

  list(): ManagedUsageAdapterView[] {
    return [...this.adapters.entries()].map(([id, managed]) => ({
      id,
      adapter: managed.adapter,
      enabled: managed.enabled,
    }));
  }

  private async invoke<T extends AdapterResult>(
    id: string,
    capability: UsageAdapterCapability,
    action: (adapter: UsageAdapter) => Promise<T>,
  ): Promise<T | { status: "unsupported"; capability: UsageAdapterCapability } | { status: "disabled" } | { status: "error"; error: UsageAdapterErrorState }> {
    const managed = this.adapters.get(id);
    if (managed === undefined) {
      return {
        status: "error",
        error: { kind: "unavailable", message: "Usage adapter is not registered" },
      };
    }
    if (!managed.enabled) return { status: "disabled" };
    if (!managed.adapter.capabilities().has(capability)) return unsupported(capability);

    try {
      const result = await action(managed.adapter);
      assertSafeOutput(result);
      return result;
    } catch (error) {
      return normalizeFailure(error);
    }
  }

  async collectQuotaSnapshots(id: string): Promise<QuotaSnapshotBatch> {
    return this.invoke(id, "collect_quota_snapshots", (adapter) => adapter.collectQuotaSnapshots());
  }

  async collectUsageEvents(id: string, cursor?: string): Promise<UsageEventBatch> {
    return this.invoke(id, "collect_usage_events", (adapter) => adapter.collectUsageEvents(cursor));
  }

  async collectCostEvents(id: string, cursor?: string): Promise<CostEventBatch> {
    return this.invoke(id, "collect_costs", (adapter) => adapter.collectCostEvents(cursor));
  }

  async refresh(id: string): Promise<UsageRefreshResult> {
    return this.invoke(id, "manual_refresh", (adapter) => adapter.refresh());
  }
}
