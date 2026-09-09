import { spawn } from "node:child_process";
import type { ProviderAdapter, DiscoveredModel, ProviderHealth, RouterRequest } from "../../core/provider.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import { CodexAppServerClient } from "./app-server-client.js";

export class CodexAdapter implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  private client: CodexAppServerClient | null = null;
  private process: ReturnType<typeof spawn> | null = null;

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
      // Start a new thread for this request
      const threadResponse = await this.client.startThread({
        model: request.model.upstreamModel,
        sandboxMode: "restricted",
        permissions: [],
      });

      // Prepare input messages
      const input = request.messages.map((msg) => ({
        role: msg.role as "system" | "user" | "assistant",
        content: msg.content || "",
      }));

      // Start turn
      const turnResponse = await this.client.startTurn({
        threadId: threadResponse.threadId,
        input,
        tools: request.tools.map((tool: any) => ({
          type: tool.type,
          function: {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          },
        })),
      });

      // Listen for events
      let completed = false;
      while (!completed && !signal.aborted) {
        try {
          // Wait for agent message delta
          const deltaPromise = this.client.waitForNotification(
            "item/agentMessage/delta",
            1000,
          );

          const tokenUsagePromise = this.client.waitForNotification(
            "thread/tokenUsage/updated",
            1000,
          );

          const completedPromise = this.client.waitForNotification(
            "turn/completed",
            1000,
          );

          const result = await Promise.race([
            deltaPromise.then((n) => ({ type: "delta" as const, notification: n })),
            tokenUsagePromise.then((n) => ({ type: "usage" as const, notification: n })),
            completedPromise.then((n) => ({ type: "completed" as const, notification: n })),
          ]);

          if (result.type === "delta") {
            const params = result.notification.params as any;
            if (params?.delta) {
              yield { type: "text_delta", text: params.delta };
            }
          } else if (result.type === "usage") {
            const params = result.notification.params as any;
            yield {
              type: "usage",
              inputTokens: params?.inputTokens,
              outputTokens: params?.outputTokens,
              reasoningTokens: params?.reasoningTokens,
              cacheReadTokens: params?.cacheReadTokens,
            };
          } else if (result.type === "completed") {
            completed = true;
            const params = result.notification.params as any;
            yield {
              type: "completed",
              finishReason: params?.finishReason || "stop",
            };
          }
        } catch (error) {
          // Timeout or other error - continue listening
          if (error instanceof RouterError && error.code === "provider_timeout") {
            continue;
          }
          throw error;
        }
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

    // We'd need to track active turns to interrupt them
    // For now, this is a placeholder
    console.log(`Cancel requested for ${requestId}`);
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
