import type { UsageEvent } from "../domain/types.js";
import type { UsageStore } from "../storage/usage-store.js";

export class UsageEventIngestor {
  constructor(private readonly store: UsageStore) {}

  async ingest(events: readonly UsageEvent[]): Promise<void> {
    await this.store.appendUsageEvents(events);
  }
}
