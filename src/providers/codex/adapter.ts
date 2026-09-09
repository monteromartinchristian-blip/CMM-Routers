import { spawn } from "node:child_process";
import type { ProviderAdapter, DiscoveredModel, ProviderHealth, RouterRequest } from "../../core/provider.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import { CodexAppServerClient } from "./app-server-client.js";

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
        capability: "CHAT_ONLY_PENDING_TASK_13" as const,
      }));
    } catch (error) {
      console.error("Codex model discovery failed:", error);
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
      let loopCount = 0;
      
      try {
        while (!completed && !signal.aborted) {
          loopCount++;
          
          // Use a single waiter that catches any relevant notification
          // This avoids the timeout issues with racing multiple waiters
          const notification = await this.client.waitForAnyNotification(
            ["item/agentMessage/delta", "thread/tokenUsage/updated", "turn/completed"],
            30000, // 30 second timeout to allow for processing time
          );
          
          console.log(`[CodexAdapter] Received notification: ${notification.method}`);
          
          if (notification.method === "item/agentMessage/delta") {
            const params = notification.params as any;
            if (params?.delta) {
              console.log(`[CodexAdapter] Yielding delta: "${params.delta.substring(0, 50)}..."`);
              yield { type: "text_delta", text: params.delta };
            }
          } else if (notification.method === "thread/tokenUsage/updated") {
            const params = notification.params as any;
            console.log(`[CodexAdapter] Yielding usage update`);
            yield {
              type: "usage",
              inputTokens: params?.inputTokens,
              outputTokens: params?.outputTokens,
              reasoningTokens: params?.reasoningTokens,
              cacheReadTokens: params?.cacheReadTokens,
            };
          } else if (notification.method === "turn/completed") {
            console.log(`[CodexAdapter] Turn completed!`);
            completed = true;
            const params = notification.params as any;
            yield {
              type: "completed",
              finishReason: params?.turn?.status || "stop",
            };
          }
        }
      } finally {
        console.log(`[CodexAdapter] Event loop ended after ${loopCount} iterations`);
        // Clean up active turn tracking
        this.activeTurns.delete(request.requestId);
      }
    } catch (error) {
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
      console.log(`[CodexAdapter] No active turn found for request ${requestId}`);
      return;
    }

    try {
      await this.client.interruptTurn({
        threadId: activeTurn.threadId,
        turnId: activeTurn.turnId || "",
      });
      console.log(`[CodexAdapter] Turn interrupted for request ${requestId}`);
    } catch (error) {
      console.error(`[CodexAdapter] Failed to interrupt turn for ${requestId}:`, error);
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
