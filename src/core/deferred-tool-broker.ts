import { RouterError } from "./errors.js";
import type { ProviderId } from "./model.js";

export interface BrokerKey {
  consumer: "qoder";
  provider: ProviderId;
  sessionId: string;
  turnId?: string;
  toolCallId: string;
}

export type ResolveOutcome = "resolved" | "duplicate" | "stale" | "unknown";

interface Entry {
  id: string;
  provider: ProviderId;
  sessionId: string;
  waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  timer: ReturnType<typeof setTimeout>;
}

function keyOf(key: BrokerKey): string {
  if (!key.sessionId || !key.toolCallId) {
    throw new RouterError(
      "provider_protocol_error",
      "Broker key requires sessionId and toolCallId",
    );
  }
  return `${key.provider}|${key.sessionId}|${key.turnId ?? ""}|${key.toolCallId}`;
}

function splitScope(id: string): { provider: string; sessionId: string } {
  const [provider = "", sessionId = ""] = id.split("|");
  return { provider, sessionId };
}

/**
 * Bounded coordination state for deferred provider tool calls. Holds pending
 * correlation only — never executes tools, never retains arguments/results
 * beyond the single resolution handoff.
 */
export class DeferredToolBroker {
  private readonly entries = new Map<string, Entry>();
  private readonly terminal = new Map<string, "resolved" | "expired" | "cancelled">();
  private readonly maxPending: number;
  private readonly defaultTtlMs: number;

  constructor(options: { maxPending?: number; defaultTtlMs?: number } = {}) {
    this.maxPending = options.maxPending ?? 64;
    this.defaultTtlMs = options.defaultTtlMs ?? 120_000;
  }

  createPendingCall(key: BrokerKey, ttlMs?: number, signal?: AbortSignal): void {
    if (key.consumer !== "qoder") {
      throw new RouterError("provider_protocol_error", "Broker accepts Qoder entries only");
    }
    const id = keyOf(key);
    if (this.entries.has(id)) {
      throw new RouterError("provider_protocol_error", "Duplicate pending tool call");
    }
    this.terminal.delete(id);
    if (this.entries.size >= this.maxPending) {
      throw new RouterError(
        "provider_rate_limited",
        "Tool broker pending state bounded; refusing new entry",
      );
    }
    const ttl = ttlMs ?? this.defaultTtlMs;
    const timer = setTimeout(() => this.failEntry(id, "expired"), ttl);
    if (typeof timer.unref === "function") timer.unref();
    this.entries.set(id, {
      id,
      provider: key.provider,
      sessionId: key.sessionId,
      waiters: [],
      timer,
    });
    if (signal !== undefined) {
      if (signal.aborted) {
        this.failEntry(id, "cancelled");
        return;
      }
      signal.addEventListener("abort", () => this.failEntry(id, "cancelled"), { once: true });
    }
  }

  awaitCall(key: BrokerKey): Promise<unknown> {
    const id = keyOf(key);
    const entry = this.entries.get(id);
    if (!entry) {
      return Promise.reject(
        new RouterError("provider_protocol_error", "Unknown pending tool call"),
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      entry.waiters.push({ resolve, reject });
    });
  }

  resolveCall(key: BrokerKey, result: unknown): ResolveOutcome {
    const id = keyOf(key);
    const entry = this.entries.get(id);
    if (!entry) {
      const state = this.terminal.get(id);
      if (state === "resolved") return "duplicate";
      if (state === "expired" || state === "cancelled") return "stale";
      return "unknown";
    }
    clearTimeout(entry.timer);
    this.entries.delete(id);
    this.rememberTerminal(id, "resolved");
    for (const waiter of entry.waiters) waiter.resolve(result);
    return "resolved";
  }

  cancelScope(filter: { sessionId?: string; provider?: ProviderId }): void {
    for (const [id] of [...this.entries]) {
      const scope = splitScope(id);
      if (filter.provider !== undefined && filter.provider !== scope.provider) continue;
      if (filter.sessionId !== undefined && filter.sessionId !== scope.sessionId) continue;
      this.failEntry(id, "cancelled");
    }
  }

  activeCount(): number {
    return this.entries.size;
  }

  private failEntry(id: string, state: "expired" | "cancelled"): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    this.rememberTerminal(id, state);
    const error = new RouterError(
      state === "expired" ? "provider_timeout" : "provider_protocol_error",
      state === "expired" ? "Deferred tool call expired" : "Deferred tool call cancelled",
    );
    for (const waiter of entry.waiters) waiter.reject(error);
  }

  private rememberTerminal(id: string, state: "resolved" | "expired" | "cancelled"): void {
    this.terminal.set(id, state);
    while (this.terminal.size > this.maxPending) {
      const oldest = this.terminal.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.terminal.delete(oldest);
    }
  }
}
