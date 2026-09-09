import { Duplex } from "node:stream";
import type {
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCNotification,
  InitializeParams,
  InitializeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnInterruptParams,
  ModelListResponse,
} from "./protocol.js";
import { RouterError } from "../../core/errors.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ServerRequestWaiter {
  id: number;
  method: string;
  threadId?: string;
  turnId?: string;
  resolve: (request: {
    id: number | string;
    method: string;
    params?: Record<string, unknown>;
  }) => void;
  reject: (error: Error) => void;
}

interface NotificationWaiter {
  id: number;
  method: string;
  methods?: string[]; // For waitForAnyNotification - list of acceptable methods
  // Correlation scope: when set, only notifications whose params carry the
  // same threadId (and turnId, when known) may resolve this waiter.
  threadId?: string;
  turnId?: string;
  resolve: (notification: JSONRPCNotification) => void;
  reject: (error: Error) => void;
}

function notificationParams(notification: JSONRPCNotification): Record<string, unknown> {
  const params = (notification as { params?: unknown }).params;
  return typeof params === "object" && params !== null
    ? (params as Record<string, unknown>)
    : {};
}

function waiterMatches(
  waiter: Pick<NotificationWaiter, "method" | "methods" | "threadId" | "turnId">,
  notification: JSONRPCNotification,
): boolean {
  if (waiter.method !== notification.method) {
    if (!(waiter.methods && waiter.methods.includes(notification.method))) return false;
  }
  // Unscoped waiters keep legacy method-only behavior (used by tests and
  // non-concurrent paths). Scoped waiters additionally require identifier
  // correlation so concurrent runs never consume each other's events.
  if (waiter.threadId !== undefined || waiter.turnId !== undefined) {
    const params = notificationParams(notification);
    if (waiter.threadId !== undefined && params.threadId !== waiter.threadId) return false;
    if (waiter.turnId !== undefined) {
      const turnId = params.turnId;
      const turn = params.turn;
      const nestedTurnId =
        typeof turn === "object" && turn !== null
          ? (turn as Record<string, unknown>).id
          : undefined;
      if (turnId !== waiter.turnId && nestedTurnId !== waiter.turnId) return false;
    }
  }
  return true;
}

export interface NotificationScope {
  threadId?: string;
  turnId?: string;
}

/**
 * Supported notification methods the Router actively awaits. Buffered only
 * when a scoped waiter may arrive shortly after; everything else follows
 * the discard path below so unrelated protocol traffic never accumulates.
 */
const SUPPORTED_NOTIFICATION_METHODS: ReadonlySet<string> = new Set([
  "item/agentMessage/delta",
  "thread/tokenUsage/updated",
  "turn/completed",
]);

/**
 * Benign protocol events the Router never consumes. Discarded immediately
 * without buffering or content logging.
 */
const IGNORABLE_NOTIFICATION_METHODS: ReadonlySet<string> = new Set([
  "item/started",
  "item/completed",
  "turn/started",
  "thread/started",
]);

/** Bound for the scoped pre-arrival buffer: enough for races, never unbounded. */
const SCOPED_BUFFER_LIMIT = 64;

interface BufferedNotification {
  notification: JSONRPCNotification;
  threadId?: string;
  turnId?: string;
  turnIdNested?: string;
}

function notificationScopeIds(notification: JSONRPCNotification): {
  threadId?: string;
  turnId?: string;
  turnIdNested?: string;
} {
  const params = notificationParams(notification);
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
  const turn = params.turn;
  const turnIdNested =
    typeof turn === "object" && turn !== null
      ? (() => {
          const id = (turn as Record<string, unknown>).id;
          return typeof id === "string" ? id : undefined;
        })()
      : undefined;
  return {
    ...(threadId !== undefined ? { threadId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(turnIdNested !== undefined ? { turnIdNested } : {}),
  };
}

function bufferedMatchesScope(
  buffered: BufferedNotification,
  scope: { threadId?: string; turnId?: string },
): boolean {
  if (scope.threadId !== undefined && buffered.threadId !== scope.threadId) return false;
  if (scope.turnId !== undefined) {
    if (buffered.turnId !== scope.turnId && buffered.turnIdNested !== scope.turnId) return false;
  }
  return true;
}

export class CodexAppServerClient {
  private stream: Duplex;
  private nextId = 0;
  private waiterSeq = 0;
  private pendingRequests = new Map<number | string, PendingRequest>();
  /**
   * Bounded scoped pre-arrival buffer. Holds ONLY supported methods with
   * extractable correlation ids so a notification racing waiter registration
   * is not lost; drained on match, evicted FIFO at the bound, and purged on
   * run completion/cancel/error/stop. Never a global content history.
   */
  private notificationQueue: BufferedNotification[] = [];
  private notificationWaiters: NotificationWaiter[] = [];
  private serverRequestWaiters: ServerRequestWaiter[] = [];
  private buffer = "";
  private stopped = false;
  private protocolError: RouterError | null = null;

  constructor(stream: Duplex) {
    this.stream = stream;
    this.setupParser();
  }

  private setupParser(): void {
    this.stream.on("data", (chunk: Buffer) => {
      if (this.stopped) return;

      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      // Keep last incomplete line in buffer
      this.buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          this.handleMessage(line);
        }
      }
    });

    this.stream.on("error", (error) => {
      // Reject all pending requests on stream error
      for (const [, pending] of this.pendingRequests) {
        pending.reject(error);
      }
      this.pendingRequests.clear();
    });
  }

  private failProtocol(reason: string): RouterError {
    const error = new RouterError("provider_protocol_error", reason);
    if (this.protocolError === null) this.protocolError = error;
    for (const [, pending] of this.pendingRequests) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
    // Reject only scoped waiters tied to live runs; unscoped legacy probes
    // stay usable so one malformed frame cannot poison unrelated callers.
    const scoped = this.notificationWaiters.filter(
      (w) => w.threadId !== undefined || w.turnId !== undefined,
    );
    if (scoped.length > 0) {
      const stale = new Set(scoped);
      this.notificationWaiters = this.notificationWaiters.filter((w) => !stale.has(w));
      for (const waiter of scoped) {
        waiter.reject(error);
      }
      this.notificationQueue.length = 0;
    }
    return error;
  }

  /** Clear the recorded protocol failure (tests only; production stays failed). */
  clearProtocolErrorForTest(): void {
    this.protocolError = null;
  }

  private handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      // A non-empty stdout line that is not JSON-RPC is a protocol failure,
      // not a skippable frame. Fail the affected run without logging content.
      this.failProtocol("invalid JSON-RPC frame from codex app-server");
      return;
    }

    const msg = message as JSONRPCResponse | JSONRPCNotification;

    // Check if it's a response (has id and result/error)
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const response = msg as JSONRPCResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(
            new RouterError(
              "provider_protocol_error",
              `Codex error: ${response.error.message}`,
              { code: response.error.code },
            ),
          );
        } else {
          pending.resolve(response.result);
        }
      }
    }
    // Check if it's a server request (has id and method, but no result)
    else if ("id" in msg && "method" in msg && !("result" in msg)) {
      this.handleServerRequest(msg as any);
    }
    // Otherwise it's a notification
    else if ("method" in msg) {
      const notification = msg as JSONRPCNotification;

      // Find the first waiter whose method AND correlation scope match.
      // Scoped waiters never consume another thread/turn's events.
      const waiterIndex = this.notificationWaiters.findIndex((w) =>
        waiterMatches(w, notification),
      );

      if (waiterIndex !== -1) {
        const waiter = this.notificationWaiters[waiterIndex]!;
        this.notificationWaiters.splice(waiterIndex, 1);
        waiter.resolve(notification);
        // The run's terminal event was consumed: drop any remaining buffered
        // frames for that scope so content never lingers after completion.
        if (notification.method === "turn/completed") {
          this.purgeScope(notification);
        }
      } else if (SUPPORTED_NOTIFICATION_METHODS.has(notification.method)) {
        this.bufferSupported(notification);
      } else if (IGNORABLE_NOTIFICATION_METHODS.has(notification.method)) {
        // Known benign protocol traffic: discard immediately, no retention.
      } else {
        // Unknown/unawaited server event: metadata-only drop. The method
        // name alone is untrusted input, so keep no payload and no content.
        void notification.method;
      }
    }
  }

  private bufferSupported(notification: JSONRPCNotification): void {
    const ids = notificationScopeIds(notification);
    this.notificationQueue.push({ notification, ...ids });
    while (this.notificationQueue.length > SCOPED_BUFFER_LIMIT) {
      this.notificationQueue.shift();
    }
  }

  private purgeScope(notification: JSONRPCNotification): void {
    const ids = notificationScopeIds(notification);
    if (ids.threadId === undefined && ids.turnId === undefined && ids.turnIdNested === undefined) {
      return;
    }
    const scope: NotificationScope = {
      ...(ids.threadId !== undefined ? { threadId: ids.threadId } : {}),
      ...(() => {
        const turnId = ids.turnId ?? ids.turnIdNested;
        return turnId !== undefined ? { turnId } : {};
      })(),
    };
    this.notificationQueue = this.notificationQueue.filter(
      (buffered) => !bufferedMatchesScope(buffered, scope),
    );
  }

  /** Release buffered state for one finished/cancelled run scope. */
  discardScope(scope: NotificationScope): void {
    if (scope.threadId === undefined && scope.turnId === undefined) return;
    this.notificationQueue = this.notificationQueue.filter(
      (buffered) => !bufferedMatchesScope(buffered, scope),
    );
    const waiters = this.notificationWaiters.filter((waiter) => {
      if (waiter.threadId === undefined && waiter.turnId === undefined) return false;
      if (scope.threadId !== undefined && waiter.threadId !== undefined && waiter.threadId !== scope.threadId) {
        return false;
      }
      if (scope.turnId !== undefined && waiter.turnId !== undefined && waiter.turnId !== scope.turnId) {
        return false;
      }
      return (
        (scope.threadId === undefined || waiter.threadId === scope.threadId) &&
        (scope.turnId === undefined || waiter.turnId === scope.turnId)
      );
    });
    if (waiters.length > 0) {
      const stale = new Set(waiters);
      this.notificationWaiters = this.notificationWaiters.filter((w) => !stale.has(w));
      for (const waiter of waiters) {
        waiter.reject(new RouterError("provider_protocol_error", "Codex run released; waiter cancelled"));
      }
    }
    // Release any outstanding tool-call waiter for this scope (cancel path).
    const requestWaiters = this.serverRequestWaiters.filter((w) => {
      if (scope.threadId === undefined && scope.turnId === undefined) return false;
      if (scope.threadId !== undefined && w.threadId !== undefined && w.threadId !== scope.threadId) {
        return false;
      }
      if (scope.turnId !== undefined && w.turnId !== undefined && w.turnId !== scope.turnId) {
        return false;
      }
      return (
        (scope.threadId === undefined || w.threadId === scope.threadId) &&
        (scope.turnId === undefined || w.turnId === scope.turnId)
      );
    });
    if (requestWaiters.length > 0) {
      const stale = new Set(requestWaiters);
      this.serverRequestWaiters = this.serverRequestWaiters.filter((w) => !stale.has(w));
      for (const waiter of requestWaiters) {
        waiter.reject(new RouterError("provider_protocol_error", "Codex run released; tool-call waiter cancelled"));
      }
    }
  }

  private handleServerRequest(request: {
    id: number | string;
    method: string;
    params?: Record<string, unknown>;
  }): void {
    // Auto-decline approval requests for security (native execution blockade).
    const approvalMethods = [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "applyPatchApproval",
      "execCommandApproval",
    ];

    if (approvalMethods.includes(request.method)) {
      // Send decline response
      const declineResponse: JSONRPCResponse = {
        jsonrpc: "2.0",
        id: request.id,
        result: { decision: "decline" },
      };
      this.sendRaw(JSON.stringify(declineResponse));
      return;
    }

    // Externally-owned dynamic tool request: the model wants the HOST (Qoder,
    // through the Router) to execute a tool. Never execute it here. Route it
    // to the scoped waiter of the active run so the adapter can surface it as
    // a tool call to the consumer; the consumer's result is answered later
    // via respondToServerRequest. Unmatched tool calls (no active waiter) are
    // declined so the turn can fail closed rather than hang.
    if (request.method === "item/tool/call") {
      const params = request.params ?? {};
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
      const waiterIndex = this.serverRequestWaiters.findIndex((w) => {
        if (w.method !== "item/tool/call") return false;
        if (w.threadId !== undefined && w.threadId !== threadId) return false;
        if (w.turnId !== undefined && w.turnId !== turnId) return false;
        return true;
      });
      if (waiterIndex !== -1) {
        const waiter = this.serverRequestWaiters[waiterIndex]!;
        this.serverRequestWaiters.splice(waiterIndex, 1);
        waiter.resolve(request);
      } else {
        this.sendRaw(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { success: false, contentItems: [] },
          } satisfies JSONRPCResponse),
        );
      }
      return;
    }

    // item/tool/requestUserInput and other server requests are not part of the
    // supported external-tool loop: decline deterministically, never grant.
    this.sendRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { decision: "decline" },
      } satisfies JSONRPCResponse),
    );
  }

  private sendRaw(data: string): void {
    if (!this.stopped) {
      this.stream.write(data + "\n");
    }
  }

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.nextId;
    const request: JSONRPCRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.sendRaw(JSON.stringify(request));
    });
  }

  async waitForNotification(
    method: string,
    timeoutMs = 5000,
    scope?: NotificationScope,
  ): Promise<JSONRPCNotification> {
    if (this.protocolError !== null && (scope?.threadId !== undefined || scope?.turnId !== undefined)) {
      throw this.protocolError;
    }
    // Check scoped buffer first (only a correlation-matching entry)
    const probe: Pick<NotificationWaiter, "method" | "threadId" | "turnId"> = {
      method,
      ...(scope?.threadId !== undefined ? { threadId: scope.threadId } : {}),
      ...(scope?.turnId !== undefined ? { turnId: scope.turnId } : {}),
    };
    const queued = this.notificationQueue.findIndex((n) => waiterMatches(probe, n.notification));
    if (queued !== -1) {
      const notification = this.notificationQueue.splice(queued, 1)[0]!.notification;
      return notification;
    }

    // Wait for new notification; the timeout removes ONLY this waiter by id.
    const waiterId = ++this.waiterSeq;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.notificationWaiters = this.notificationWaiters.filter((w) => w.id !== waiterId);
        reject(
          new RouterError(
            "provider_timeout",
            `Timeout waiting for notification: ${method}`,
          ),
        );
      }, timeoutMs);

      this.notificationWaiters.push({
        id: waiterId,
        method,
        ...(scope?.threadId !== undefined ? { threadId: scope.threadId } : {}),
        ...(scope?.turnId !== undefined ? { turnId: scope.turnId } : {}),
        resolve: (notification) => {
          clearTimeout(timeout);
          resolve(notification);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  async waitForAnyNotification(
    methods: string[],
    timeoutMs = 5000,
    scope?: NotificationScope,
  ): Promise<JSONRPCNotification> {
    if (this.protocolError !== null && (scope?.threadId !== undefined || scope?.turnId !== undefined)) {
      throw this.protocolError;
    }
    // Check scoped buffer first for any of the requested methods.
    for (const method of methods) {
      const probe: Pick<NotificationWaiter, "method" | "threadId" | "turnId"> = {
        method,
        ...(scope?.threadId !== undefined ? { threadId: scope.threadId } : {}),
        ...(scope?.turnId !== undefined ? { turnId: scope.turnId } : {}),
      };
      const queued = this.notificationQueue.findIndex((n) => waiterMatches(probe, n.notification));
      if (queued !== -1) {
        const notification = this.notificationQueue.splice(queued, 1)[0]!.notification;
        return notification;
      }
    }

    // Wait for any of the specified notifications; timeout removes only self.
    const waiterId = ++this.waiterSeq;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.notificationWaiters = this.notificationWaiters.filter((w) => w.id !== waiterId);
        reject(
          new RouterError(
            "provider_timeout",
            `Timeout waiting for any of: ${methods.join(", ")}`,
          ),
        );
      }, timeoutMs);

      const waiter: NotificationWaiter = {
        id: waiterId,
        method: "__any__",
        methods, // Store the list of acceptable methods
        ...(scope?.threadId !== undefined ? { threadId: scope.threadId } : {}),
        ...(scope?.turnId !== undefined ? { turnId: scope.turnId } : {}),
        resolve: (notification) => {
          clearTimeout(timeout);
          resolve(notification);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };

      this.notificationWaiters.push(waiter);
    });
  }

  /**
   * Wait for an externally-owned dynamic tool request (server request
   * `item/tool/call`) correlated to this run's thread/turn. The Router NEVER
   * executes the tool: it surfaces the call to the consumer (Qoder), which
   * executes, then calls respondToServerRequest with the result. Scoped so
   * concurrent runs never consume each other's tool calls.
   */
  async waitForToolCall(
    timeoutMs: number,
    scope: NotificationScope,
  ): Promise<{ id: number | string; params: Record<string, unknown> }> {
    const waiterId = ++this.waiterSeq;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.serverRequestWaiters = this.serverRequestWaiters.filter((w) => w.id !== waiterId);
        reject(
          new RouterError(
            "provider_timeout",
            "Timeout waiting for external tool call from codex app-server",
          ),
        );
      }, timeoutMs);
      this.serverRequestWaiters.push({
        id: waiterId,
        method: "item/tool/call",
        ...(scope.threadId !== undefined ? { threadId: scope.threadId } : {}),
        ...(scope.turnId !== undefined ? { turnId: scope.turnId } : {}),
        resolve: (request) => {
          clearTimeout(timeout);
          resolve({ id: request.id, params: request.params ?? {} });
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  /** Answer a dynamic tool call with the host-executed result. */
  respondToServerRequest(
    requestId: number | string,
    result: Record<string, unknown>,
  ): void {
    const response: JSONRPCResponse = {
      jsonrpc: "2.0",
      id: requestId,
      result,
    };
    this.sendRaw(JSON.stringify(response));
  }

  async initialize(params: InitializeParams): Promise<InitializeResponse> {
    const result = await this.sendRequest("initialize", params as any);
    return result as InitializeResponse;
  }

  async sendInitializedNotification(): Promise<void> {
    const notification: JSONRPCNotification = {
      jsonrpc: "2.0",
      method: "initialized",
    };
    this.sendRaw(JSON.stringify(notification));
  }

  async startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    const result = await this.sendRequest("thread/start", params as any);
    return result as ThreadStartResponse;
  }

  /** Canonical method per generated ClientRequest discriminator: thread/inject_items. */
  static readonly INJECT_ITEMS_METHOD = "thread/inject_items";

  async injectItems(params: { threadId: string; items: unknown[] }): Promise<unknown> {
    return await this.sendRequest(CodexAppServerClient.INJECT_ITEMS_METHOD, params as unknown as Record<string, unknown>);
  }

  async startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    const result = await this.sendRequest("turn/start", params as any);
    return result as TurnStartResponse;
  }

  async interruptTurn(params: TurnInterruptParams): Promise<void> {
    await this.sendRequest("turn/interrupt", params as any);
  }

  async listModels(): Promise<ModelListResponse> {
    const result = await this.sendRequest("model/list", {});
    return result as ModelListResponse;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pendingRequests.clear();
    this.notificationWaiters = [];
    this.notificationQueue.length = 0;
    this.serverRequestWaiters = [];

    // Destroy the stream
    if ("destroy" in this.stream && typeof this.stream.destroy === "function") {
      this.stream.destroy();
    }
  }
}
