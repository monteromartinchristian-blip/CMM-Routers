import { randomUUID } from "node:crypto";
import { RouterError } from "./errors.js";
import type { ProviderId } from "./model.js";

/**
 * Consumer-visible tool-call identity.
 *
 * `toolCallId` is the Qoder-visible PUBLIC id. It must be globally unique and
 * unguessable because Qoder's standard OpenAI follow-up only round-trips
 * `tool_call_id` plus ordinary message history — there is no proven way to make
 * Qoder echo a Router-private correlation field. Provider-internal identity is
 * carried separately in the entry context (see PendingToolContext).
 */
export interface BrokerKey {
  consumer: "qoder";
  provider: ProviderId;
  sessionId: string;
  turnId?: string;
  toolCallId: string;
  /**
   * Optional public id index. When set, the entry becomes resolvable by public
   * id alone (safe because Router-generated public ids are globally unique).
   * Omitted by unit tests that key purely by composite identity.
   */
  publicToolCallId?: string;
}

/**
 * Provider-internal identity retained alongside a pending public id. This is
 * never exposed to the consumer; it is what lets the Router answer the exact
 * provider wire request after Qoder returns the public id.
 */
export interface PendingToolContext {
  provider: ProviderId;
  providerSession?: string;
  providerTurn?: string;
  providerCallId?: string;
  wireRequestId?: number | string;
}

export type ResolveOutcome = "resolved" | "duplicate" | "stale" | "unknown";

export interface ClaimResult<TContext = unknown> {
  outcome: ResolveOutcome;
  context?: TContext;
}

interface Entry {
  id: string;
  provider: ProviderId;
  sessionId: string;
  context?: unknown;
  waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  timer: ReturnType<typeof setTimeout>;
}

/** Router-generated globally unique public tool call id. */
export function createPublicToolCallId(provider: ProviderId): string {
  return `cmm_${provider.replace(/-/g, "_")}_${randomUUID()}`;
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
  /** publicToolCallId → composite entry key. */
  private readonly publicIndex = new Map<string, string>();
  /** publicToolCallId → terminal state, for duplicate/late detection. */
  private readonly publicTerminal = new Map<string, "resolved" | "expired" | "cancelled">();
  private readonly maxPending: number;
  private readonly defaultTtlMs: number;

  constructor(options: { maxPending?: number; defaultTtlMs?: number } = {}) {
    this.maxPending = options.maxPending ?? 64;
    this.defaultTtlMs = options.defaultTtlMs ?? 120_000;
  }

  createPendingCall<TContext = PendingToolContext>(
    key: BrokerKey,
    ttlMs?: number,
    signal?: AbortSignal,
    context?: TContext,
  ): void {
    if (key.consumer !== "qoder") {
      throw new RouterError("provider_protocol_error", "Broker accepts Qoder entries only");
    }
    const id = keyOf(key);
    if (this.entries.has(id)) {
      throw new RouterError("provider_protocol_error", "Duplicate pending tool call");
    }
    if (
      key.publicToolCallId !== undefined &&
      (this.publicIndex.has(key.publicToolCallId) ||
        this.publicTerminal.has(key.publicToolCallId))
    ) {
      throw new RouterError("provider_protocol_error", "Duplicate public tool call id");
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
      ...(context !== undefined ? { context } : {}),
      waiters: [],
      timer,
    });
    if (key.publicToolCallId !== undefined) {
      this.publicIndex.set(key.publicToolCallId, id);
    }
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

  /** Resolve by public id only. Safe because public ids are globally unique. */
  claimByPublicToolCallId<TContext = PendingToolContext>(
    publicToolCallId: string,
  ): ClaimResult<TContext> {
    const id = this.publicIndex.get(publicToolCallId);
    if (id === undefined) {
      const state = this.publicTerminal.get(publicToolCallId);
      if (state === "resolved") return { outcome: "duplicate" };
      if (state === "expired" || state === "cancelled") return { outcome: "stale" };
      return { outcome: "unknown" };
    }
    return this.take<TContext>(id) as ClaimResult<TContext>;
  }

  /** Resolve by full composite identity. Returns the retained provider context. */
  claimCall<TContext = PendingToolContext>(key: BrokerKey): ClaimResult<TContext> {
    return this.take<TContext>(keyOf(key)) as ClaimResult<TContext>;
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

  /** Terminal entries retained for duplicate/late detection. Bounded. */
  terminalCount(): number {
    return this.terminal.size + this.publicTerminal.size;
  }

  private take<TContext>(id: string): ClaimResult<TContext> {
    const entry = this.entries.get(id);
    if (!entry) {
      const state = this.terminal.get(id);
      if (state === "resolved") return { outcome: "duplicate" };
      if (state === "expired" || state === "cancelled") return { outcome: "stale" };
      return { outcome: "unknown" };
    }
    clearTimeout(entry.timer);
    this.entries.delete(id);
    this.rememberTerminal(id, "resolved");
    const context = entry.context as TContext | undefined;
    for (const waiter of entry.waiters) waiter.resolve(context);
    return context !== undefined ? { outcome: "resolved", context } : { outcome: "resolved" };
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
    // Move the public index entry into terminal state so a late/duplicate
    // public result is classified instead of resolving a fresh call.
    for (const [publicId, mappedId] of this.publicIndex) {
      if (mappedId === id) {
        this.publicIndex.delete(publicId);
        this.publicTerminal.set(publicId, state);
        while (this.publicTerminal.size > this.maxPending) {
          const oldest = this.publicTerminal.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.publicTerminal.delete(oldest);
        }
        break;
      }
    }
    this.terminal.set(id, state);
    while (this.terminal.size > this.maxPending) {
      const oldest = this.terminal.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.terminal.delete(oldest);
    }
  }
}
