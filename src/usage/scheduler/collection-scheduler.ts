import type { UsageAdapterManager } from "../adapters/adapter-manager.js";

export interface CollectionSchedulerOptions {
  now?: () => number;
  random?: () => number;
  jitterRatio?: number;
  baseBackoffMs?: number;
  maximumBackoffMs?: number;
  pumpIntervalMs?: number;
}

export type AdapterCollector = (adapterId: string) => Promise<boolean>;

export interface CollectionRunResult {
  adapterId: string;
  attempted: boolean;
  success?: boolean;
  nextDueAt?: number;
}

export class CollectionScheduler {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly jitterRatio: number;
  private readonly baseBackoffMs: number;
  private readonly maximumBackoffMs: number;
  private readonly pumpIntervalMs: number;
  private readonly nextDueAt = new Map<string, number>();
  private readonly consecutiveFailures = new Map<string, number>();
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly manager: UsageAdapterManager,
    private readonly collect: AdapterCollector,
    options: CollectionSchedulerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.jitterRatio = options.jitterRatio ?? 0.05;
    this.baseBackoffMs = options.baseBackoffMs ?? 5_000;
    this.maximumBackoffMs = options.maximumBackoffMs ?? 5 * 60_000;
    this.pumpIntervalMs = options.pumpIntervalMs ?? 1_000;
  }

  isRunning(): boolean {
    return this.running;
  }

  private withJitter(baseMs: number): number {
    if (baseMs <= 0 || this.jitterRatio <= 0) return Math.max(0, baseMs);
    return Math.max(0, Math.round(baseMs + baseMs * this.jitterRatio * this.random()));
  }

  private nextDelay(adapterId: string, success: boolean): number {
    if (success) {
      this.consecutiveFailures.delete(adapterId);
      const minimum = this.manager.get(adapterId)?.manifest().minimumRefreshIntervalMs ?? 60_000;
      return this.withJitter(minimum);
    }

    const failures = (this.consecutiveFailures.get(adapterId) ?? 0) + 1;
    this.consecutiveFailures.set(adapterId, failures);
    const exponential = this.baseBackoffMs * 2 ** Math.max(0, failures - 1);
    return this.withJitter(Math.min(this.maximumBackoffMs, exponential));
  }

  private async attempt(adapterId: string): Promise<CollectionRunResult> {
    const success = await this.collect(adapterId);
    const nextDueAt = this.now() + this.nextDelay(adapterId, success);
    this.nextDueAt.set(adapterId, nextDueAt);
    return { adapterId, attempted: true, success, nextDueAt };
  }

  async runDue(): Promise<CollectionRunResult[]> {
    const now = this.now();
    const results = await Promise.all(
      this.manager.list().map(async ({ id, enabled }) => {
        if (!enabled) return { adapterId: id, attempted: false } satisfies CollectionRunResult;
        const due = this.nextDueAt.get(id);
        if (due !== undefined && now < due) {
          return { adapterId: id, attempted: false, nextDueAt: due } satisfies CollectionRunResult;
        }
        return this.attempt(id);
      }),
    );
    return results;
  }

  async runNow(adapterId: string): Promise<CollectionRunResult> {
    if (!this.manager.isEnabled(adapterId)) {
      return { adapterId, attempted: false };
    }
    return this.attempt(adapterId);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedulePump();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedulePump(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.runDue().finally(() => this.schedulePump());
    }, this.pumpIntervalMs);
    this.timer.unref?.();
  }
}
