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

interface NotificationWaiter {
  method: string;
  resolve: (notification: JSONRPCNotification) => void;
  reject: (error: Error) => void;
}

export class CodexAppServerClient {
  private stream: Duplex;
  private nextId = 0;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private notificationQueue: JSONRPCNotification[] = [];
  private notificationWaiters: NotificationWaiter[] = [];
  private buffer = "";
  private stopped = false;

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

  private handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      // Malformed JSON - log but don't crash
      console.error("Codex protocol error: malformed JSON received");
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
      const waiter = this.notificationWaiters.find(
        (w) => w.method === notification.method,
      );
      if (waiter) {
        this.notificationWaiters = this.notificationWaiters.filter(
          (w) => w !== waiter,
        );
        waiter.resolve(notification);
      } else {
        this.notificationQueue.push(notification);
      }
    }
  }

  private handleServerRequest(request: {
    id: number | string;
    method: string;
    params?: Record<string, unknown>;
  }): void {
    // Auto-decline approval requests for security
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
    }
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

  async waitForNotification(method: string, timeoutMs = 5000): Promise<JSONRPCNotification> {
    // Check queue first
    const queued = this.notificationQueue.findIndex((n) => n.method === method);
    if (queued !== -1) {
      const notification = this.notificationQueue.splice(queued, 1)[0];
      return notification!;
    }

    // Wait for new notification
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.notificationWaiters = this.notificationWaiters.filter(
          (w) => w.method !== method,
        );
        reject(
          new RouterError(
            "provider_timeout",
            `Timeout waiting for notification: ${method}`,
          ),
        );
      }, timeoutMs);

      this.notificationWaiters.push({
        method,
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

    // Destroy the stream
    if ("destroy" in this.stream && typeof this.stream.destroy === "function") {
      this.stream.destroy();
    }
  }
}
