export type UsageStatus =
  | "success"
  | "provider_error"
  | "auth_error"
  | "quota_error"
  | "rate_limit_error"
  | "timeout_error"
  | "cancelled";

export interface UsageRecord {
  requestId: string;
  provider: string;
  model: string;
  startedAt: string;
  durationMs: number;
  status: UsageStatus;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: string;
}

export interface UsageAggregates {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  quotaEvents: number;
  rateLimitEvents: number;
  timeoutEvents: number;
  cancelledEvents: number;
  activeRequests: number;
  lastSuccessAt: string | null;
  activeModel: string | null;
  averageLatencyMs: number | null;
}

const MAX_RECORDS = 500;

export class UsageStore {
  private records: UsageRecord[] = [];
  private active = new Map<string, { provider: string; model: string; startedAt: number }>();

  beginRequest(requestId: string, provider: string, model: string): void {
    this.active.set(requestId, { provider, model, startedAt: Date.now() });
  }

  endRequest(
    requestId: string,
    outcome: {
      status: UsageStatus;
      inputTokens?: number | undefined;
      outputTokens?: number | undefined;
      errorCode?: string | undefined;
    },
  ): UsageRecord {
    const started = this.active.get(requestId);
    this.active.delete(requestId);
    const startedAt = started?.startedAt ?? Date.now();
    const record: UsageRecord = {
      requestId,
      provider: started?.provider ?? "unknown",
      model: started?.model ?? "unknown",
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      status: outcome.status,
      ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
      ...(outcome.outputTokens !== undefined ? { outputTokens: outcome.outputTokens } : {}),
      ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
    };
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) {
      this.records.splice(0, this.records.length - MAX_RECORDS);
    }
    return record;
  }

  listRecent(limit = 50): UsageRecord[] {
    return this.records.slice(-limit).reverse();
  }

  aggregates(): UsageAggregates {
    const totalRequests = this.records.length;
    let successCount = 0;
    let quotaEvents = 0;
    let rateLimitEvents = 0;
    let timeoutEvents = 0;
    let cancelledEvents = 0;
    let latencySum = 0;
    let lastSuccessAt: string | null = null;
    for (const record of this.records) {
      latencySum += record.durationMs;
      if (record.status === "success") {
        successCount += 1;
        lastSuccessAt = record.startedAt;
      }
      if (record.status === "quota_error") quotaEvents += 1;
      if (record.status === "rate_limit_error") rateLimitEvents += 1;
      if (record.status === "timeout_error") timeoutEvents += 1;
      if (record.status === "cancelled") cancelledEvents += 1;
    }
    const activeEntries = [...this.active.values()];
    return {
      totalRequests,
      successCount,
      failureCount: totalRequests - successCount,
      quotaEvents,
      rateLimitEvents,
      timeoutEvents,
      cancelledEvents,
      activeRequests: this.active.size,
      lastSuccessAt,
      activeModel: activeEntries.length > 0 ? (activeEntries[0]?.model ?? null) : null,
      averageLatencyMs: totalRequests > 0 ? Math.round(latencySum / totalRequests) : null,
    };
  }
}
