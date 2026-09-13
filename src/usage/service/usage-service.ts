import type { UsageAdapterManager } from "../adapters/adapter-manager.js";
import { UsageEventIngestor } from "../ingestion/event-ingestor.js";
import { QuotaSnapshotIngestor } from "../ingestion/snapshot-ingestor.js";
import {
  CollectionScheduler,
  type CollectionRunResult,
  type CollectionSchedulerOptions,
} from "../scheduler/collection-scheduler.js";
import type { UsageStore } from "../storage/usage-store.js";
import { UsageQueryService } from "./usage-query-service.js";

export interface UsageServiceOptions {
  scheduler?: CollectionSchedulerOptions;
}

export class UsageService {
  readonly queries: UsageQueryService;
  private readonly events: UsageEventIngestor;
  private readonly snapshots: QuotaSnapshotIngestor;
  private readonly scheduler: CollectionScheduler;

  constructor(
    private readonly store: UsageStore,
    private readonly adapters: UsageAdapterManager,
    options: UsageServiceOptions = {},
  ) {
    this.events = new UsageEventIngestor(store);
    this.snapshots = new QuotaSnapshotIngestor(store);
    const nowMs = options.scheduler?.now ?? Date.now;
    this.queries = new UsageQueryService(store, { now: () => new Date(nowMs()) });
    this.scheduler = new CollectionScheduler(
      adapters,
      async (adapterId) => this.collectAdapter(adapterId),
      options.scheduler,
    );
  }

  private async collectAdapter(adapterId: string): Promise<boolean> {
    const adapter = this.adapters.get(adapterId);
    if (adapter === undefined || !this.adapters.isEnabled(adapterId)) return false;
    const capabilities = adapter.capabilities();
    let success = true;

    if (capabilities.has("collect_usage_events")) {
      const result = await this.adapters.collectUsageEvents(adapterId);
      if (result.status === "ok") await this.events.ingest(result.values);
      else if (result.status === "error") success = false;
    }

    if (capabilities.has("collect_quota_snapshots")) {
      const result = await this.adapters.collectQuotaSnapshots(adapterId);
      if (result.status === "ok") await this.snapshots.ingest(result.values);
      else if (result.status === "error") success = false;
    }

    if (capabilities.has("collect_costs")) {
      const result = await this.adapters.collectCostEvents(adapterId);
      if (result.status === "ok") await this.store.appendCostEvents(result.values);
      else if (result.status === "error") success = false;
    }

    return success;
  }

  async runCollectionCycle(): Promise<CollectionRunResult[]> {
    return this.scheduler.runDue();
  }

  async refresh(adapterId: string): Promise<CollectionRunResult> {
    const adapter = this.adapters.get(adapterId);
    if (adapter?.capabilities().has("manual_refresh")) {
      const refreshed = await this.adapters.refresh(adapterId);
      if (refreshed.status === "error") {
        return { adapterId, attempted: true, success: false };
      }
    }
    return this.scheduler.runNow(adapterId);
  }

  start(): void {
    this.scheduler.start();
  }

  isRunning(): boolean {
    return this.scheduler.isRunning();
  }

  async stop(): Promise<void> {
    this.scheduler.stop();
  }
}
