import type { QuotaSnapshot } from "../domain/types.js";
import { quotaSnapshotSchema } from "../domain/validation.js";
import type { UsageStore } from "../storage/usage-store.js";

export class QuotaSnapshotIngestor {
  constructor(private readonly store: UsageStore) {}

  async ingest(snapshots: readonly QuotaSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) quotaSnapshotSchema.parse(snapshot);
    await this.store.appendQuotaSnapshots(snapshots);
  }
}
