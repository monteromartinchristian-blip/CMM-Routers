import { spawn } from "node:child_process";
import type { ProviderAdapter, DiscoveredModel, ProviderHealth, RouterRequest } from "../../core/provider.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import { CodexAppServerClient } from "./app-server-client.js";

/**
 * Normalize Codex turn status into the neutral Router finish vocabulary.
 * Upstream uses values like "completed"; the Router contract only allows
 * stop | tool_calls | length. Unknown statuses fail safe to "stop".
 */
export function normalizeCodexFinishReason(
  status: unknown,
): "stop" | "tool_calls" | "length" {
  if (status === "tool_calls" || status === "tool_calls_requested") return "tool_calls";
  if (
    status === "length" ||
    status === "max_tokens" ||
    status === "max_output_tokens" ||
    status === "truncated"
  ) {
    return "length";
  }
  return "stop";
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  private client: CodexAppServerClient | null = null;
  private process: ReturnType<typeof spawn> | null = null;
  private activeTurns = new Map<string, { threadId: string; turnId?: string }>();

  async discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]> {
    await this.ensureStarted();

    if (!this.client) {
      throw new RouterError("provider_unavailable", "Codex client not initialized");
    }

    try {
      const response = await this.client.listModels();
      return response.data.map((model) => ({
        id: `chatgpt/${model.model || model.id}`,
        provider: "chatgpt",
        upstreamModel: model.model || model.id,
        displayName: model.displayName || model.id,
        capability: "CHAT_ONLY" as const,
      }));
    } catch (error) {
      if (error instanceof RouterError) {
        throw error;
      }
      throw new RouterError(
        "provider_unavailable",
        `Failed to discover Codex models: ${error instanceof Error ? error.message : String(error)}`,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    try {
      // Try to list models as a health check
      await this.discoverModels(signal);
      return { status: "ready" };
    } catch (error) {
      if (error instanceof RouterError) {
        if (error.code === "provider_auth_required") {
          return { status: "auth_required", detail: error.message };
        }
        if (error.code === "provider_unavailable") {
          return { status: "unavailable", detail: error.message };
        }
      }
      return { status: "degraded", detail: String(error) };
    }
  }

  async *run(
    request: RouterRequest,
    signal: AbortSignal,
  ): AsyncIterable<RouterEvent> {
    await this.ensureStarted();

    if (!this.client) {
      throw new RouterError("provider_unavailable", "Codex client not available");
    }

    try {
      // Start a new thread for this request with restrictive sandbox
      const threadResponse = await this.client.startThread({
        model: request.model.upstreamModel,
        sandbox: "read-only",
      });
      const threadId = threadResponse.thread.id;

      // Prepare input messages as UserInput objects
      const input = request.messages.map((msg) => {
        if (msg.role === "user" || msg.role === "system") {
          return {
            type: "text" as const,
            text: msg.content || "",
          };
        } else if (msg.role === "assistant") {
          // Assistant messages are also text type
          return {
            type: "text" as const,
            text: msg.content || "",
          };
        } else {
          // Tool messages - treat as text for now
          return {
            type: "text" as const,
            text: msg.content || "",
          };
        }
      });

      // Start turn
      const turnResponse = await this.client.startTurn({
        threadId,
        input,
      });
      
      // Track active turn for cancellation
      this.activeTurns.set(request.requestId, { threadId, turnId: turnResponse.turnId });

      // Listen for events - wait for real turn/completed from upstream
      let completed = false;

      // Explicit bounded timeout per notification wait (60 seconds)
      // This ensures we never wait indefinitely and always produce provider_timeout on deadline expiry
      const NOTIFICATION_TIMEOUT_MS = 60000;

      try {
        while (!completed && !signal.aborted) {
          // Use a single waiter that catches any relevant notification
          // This avoids the timeout issues with racing multiple waiters
          const notification = await this.client.waitForAnyNotification(
            ["item/agentMessage/delta", "thread/tokenUsage/updated", "turn/completed"],
            NOTIFICATION_TIMEOUT_MS,
          );
          
          if (notification.method === "item/agentMessage/delta") {
            const params = notification.params as { delta?: unknown };
            if (typeof params?.delta === "string" && params.delta.length > 0) {
              yield { type: "text_delta", text: params.delta };
            }
          } else if (notification.method === "thread/tokenUsage/updated") {
            const params = notification.params as {
              inputTokens?: unknown;
              outputTokens?: unknown;
              reasoningTokens?: unknown;
              cacheReadTokens?: unknown;
            };
            const usageEvent: RouterEvent = { type: "usage" };
            if (typeof params?.inputTokens === "number") {
              (usageEvent as { inputTokens?: number }).inputTokens = params.inputTokens;
            }
            if (typeof params?.outputTokens === "number") {
              (usageEvent as { outputTokens?: number }).outputTokens = params.outputTokens;
            }
            if (typeof params?.reasoningTokens === "number") {
              (usageEvent as { reasoningTokens?: number }).reasoningTokens = params.reasoningTokens;
            }
            if (typeof params?.cacheReadTokens === "number") {
              (usageEvent as { cacheReadTokens?: number }).cacheReadTokens = params.cacheReadTokens;
            }
            yield usageEvent;
          } else if (notification.method === "turn/completed") {
            completed = true;
            const params = notification.params as { turn?: { status?: unknown } };
            yield {
              type: "completed",
              finishReason: normalizeCodexFinishReason(params?.turn?.status),
            };
          }
        }
      } finally {
        // Clean up active turn tracking
        this.activeTurns.delete(request.requestId);
      }
    } catch (error) {
      // Timeout or other errors are caught here and yielded as error events
      // Timeout produces provider_timeout, never completed
      if (error instanceof RouterError) {
        yield { type: "error", error };
      } else {
        yield {
          type: "error",
          error: new RouterError(
            "provider_protocol_error",
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    }
  }

  async cancel(requestId: string): Promise<void> {
    if (!this.client) return;

    const activeTurn = this.activeTurns.get(requestId);
    if (!activeTurn) {
      return;
    }

    try {
      await this.client.interruptTurn({
        threadId: activeTurn.threadId,
        turnId: activeTurn.turnId || "",
      });
    } catch {
      // Interrupt failures still release tracking below.
    } finally {
      this.activeTurns.delete(requestId);
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.client) return;

    // Spawn codex app-server
    this.process = spawn("codex", ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new RouterError(
        "provider_unavailable",
        "Failed to spawn codex app-server",
      );
    }

    // Create duplex stream from process stdio
    const { Duplex } = await import("node:stream");
    const proc = this.process;
    const duplex = new Duplex({
      read: () => {},
      write(chunk: Buffer, encoding: string, callback: () => void) {
        proc!.stdin!.write(chunk);
        callback();
      },
    });

    // Pipe process stdout to duplex
    if (proc.stdout) {
      proc.stdout.on("data", (chunk: Buffer) => {
        duplex.push(chunk);
      });
    }

    this.client = new CodexAppServerClient(duplex);

    // Initialize handshake
    await this.client.initialize({
      clientInfo: {
        name: "cmm-subscription-router",
        title: "CMM Subscription Router",
        version: "0.1.0",
      },
    });

    await this.client.sendInitializedNotification();
  }
}
