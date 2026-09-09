import type { ProviderAdapter, ProviderHealth, RouterRequest } from "../../core/provider.js";
import type { DiscoveredModel } from "../../core/model.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import { buildIsolatedEnvironment, CLAUDE_CONFIG_DIR, NEUTRAL_CWD } from "./sdk-client.js";
import { query, startup, resolveSettings, type Query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";

/**
 * Claude subscription provider adapter.
 *
 * Uses the official @anthropic-ai/claude-agent-sdk to interact with Claude
 * through subscription authentication (not API key/PAYG).
 *
 * IMPORTANT: This adapter requires the isolated Claude profile to be authenticated
 * via `claude login --config-dir <CLAUDE_CONFIG_DIR>` before use.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;

  private activeRequests = new Map<string, { abortController?: AbortController }>();

  /**
   * Discover available Claude models through the installed runtime.
   *
   * Currently uses a static list of known subscription models since the
   * Agent SDK does not expose a dynamic model discovery API. Models are
   * only exposed after confirming they are usable through the installed
   * Claude Code runtime configuration.
   */
  async discoverModels(): Promise<DiscoveredModel[]> {
    // TODO: Probe installed Claude runtime for available models once auth is confirmed
    // For now, return statically known Claude subscription models
    return [
      {
        id: "claude/sonnet-4",
        provider: "claude",
        upstreamModel: "claude-sonnet-4",
        displayName: "Claude Sonnet 4",
        capability: "CHAT_ONLY_PENDING_TASK_13",
      },
      {
        id: "claude/opus-4",
        provider: "claude",
        upstreamModel: "claude-opus-4",
        displayName: "Claude Opus 4",
        capability: "CHAT_ONLY_PENDING_TASK_13",
      },
      {
        id: "claude/haiku-4",
        provider: "claude",
        upstreamModel: "claude-haiku-4",
        displayName: "Claude Haiku 4",
        capability: "CHAT_ONLY_PENDING_TASK_13",
      },
    ];
  }

  /**
   * Check health of the Claude provider by verifying authentication status.
   * Uses the SDK's resolveSettings to check if the isolated profile is authenticated.
   */
  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    
    try {
      // Set isolated config dir for SDK
      process.env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;

      // Resolve settings with isolated config
      const settings = await resolveSettings({
        cwd: NEUTRAL_CWD,
      });

      // Check if authenticated (apiProvider should be 'firstParty' for subscription)
      const apiProvider = settings.effective.apiProvider;

      if (!apiProvider || apiProvider === 'firstParty') {
        // Need to verify actual authentication status
        // Try a minimal startup to see if we're authenticated
        try {
          await startup({
            options: {
              cwd: NEUTRAL_CWD,
            },
            initializeTimeoutMs: 5000,
          });

          return {
            status: "ready",
            detail: "Authenticated via Claude subscription",
          };
        } catch (err) {
          const error = err as Error;
          if (error.message.includes("auth") || error.message.includes("login")) {
            return {
              status: "auth_required",
              detail: `Run: claude login --config-dir "${CLAUDE_CONFIG_DIR}"`,
            };
          }

          return {
            status: "unavailable",
            detail: error.message,
          };
        }
      }

      return {
        status: "ready",
        detail: `API provider: ${apiProvider}`,
      };
    } catch (error) {
      const err = error as Error;
      if (err.message.includes("auth") || err.message.includes("login")) {
        return {
          status: "auth_required",
          detail: `Run: claude login --config-dir "${CLAUDE_CONFIG_DIR}"`,
        };
      }

      return {
        status: "unavailable",
        detail: err.message,
      };
    } finally {
      // Restore original env
      if (originalConfigDir !== undefined) {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      } else {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    }
  }

  /**
   * Execute a Claude request using the official SDK with isolated environment.
   * Streams SDK events and maps them to RouterEvents.
   */
  async *run(
    request: RouterRequest,
    signal: AbortSignal,
  ): AsyncIterable<RouterEvent> {
    // Track active request for cancellation
    const abortController = new AbortController();
    this.activeRequests.set(request.requestId, { abortController });

    // Link external signal to our controller
    signal.addEventListener("abort", () => {
      abortController.abort();
    }, { once: true });

    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

    try {
      // Set isolated config dir for SDK
      process.env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;

      // Prepare prompt from messages
      const prompt = request.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");

      // Configure SDK options with tool restrictions
      const sdkOptions: Options = {
        abortController,
        cwd: NEUTRAL_CWD,
        // Disable all native tools - Qoder remains the tool owner
        disallowedTools: [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "WebFetch",
          "WebSearch",
          "Glob",
          "Grep",
          "NotebookEdit",
          "ImageGen",
        ],
        // Set permission mode to auto (tools are disabled above so no risk)
        permissionMode: "auto",
      };

      // Execute query with SDK
      const queryResult: Query = query({
        prompt,
        options: sdkOptions,
      });

      let hasReceivedOutput = false;
      let accumulatedText = "";

      // Stream SDK messages and map to RouterEvents
      for await (const message of queryResult) {
        if (message.type === "assistant") {
          // Extract text content from assistant message
          const contentBlocks = message.message?.content || [];
          for (const block of contentBlocks) {
            if (block.type === "text") {
              const text = block.text;
              if (text) {
                hasReceivedOutput = true;
                accumulatedText += text;
                yield { type: "text_delta", text };
              }
            }
          }

          // Check for completion
          if (message.message?.stop_reason) {
            // Yield usage info if available
            const usage = message.message.usage;
            if (usage) {
              yield {
                type: "usage",
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
              };
            }

            // Map stop reason to finish reason
            let finishReason: "stop" | "tool_calls" | "length" = "stop";
            if (message.message.stop_reason === "max_tokens") {
              finishReason = "length";
            } else if (message.message.stop_reason === "tool_use") {
              finishReason = "tool_calls";
            }

            yield {
              type: "completed",
              finishReason,
            };
            return;
          }
        } else if (message.type === "result" && message.subtype?.startsWith("error")) {
          // Handle result error messages
          const resultError = message as any;
          const errorMessages = resultError.errors || [];
          const errorMessage = errorMessages.join("; ") || "Unknown SDK error";
          
          const error = this.mapSdkErrorMessage(errorMessage);
          yield { type: "error", error };
          return;
        }
      }

      // If we get here without explicit completion, check if aborted
      if (signal.aborted || abortController.signal.aborted) {
        // Cancellation - don't treat as error
        return;
      }

      // No completion event received - this shouldn't happen
      throw new RouterError(
        "provider_protocol_error",
        "SDK stream ended without completion event",
      );
    } catch (error) {
      if (signal.aborted || abortController.signal.aborted) {
        // Cancellation - don't treat as error
        return;
      }

      if (error instanceof RouterError) {
        yield { type: "error", error };
      } else {
        const err = error as Error;
        // Map common error patterns
        let errorCode = "provider_protocol_error";
        let errorMessage = err.message;

        if (err.message.includes("auth") || err.message.includes("login")) {
          errorCode = "provider_auth_required";
          errorMessage = `Authentication required. Run: claude login --config-dir "${CLAUDE_CONFIG_DIR}"`;
        } else if (err.message.includes("quota") || err.message.includes("usage limit")) {
          errorCode = "provider_quota_exhausted";
        } else if (err.message.includes("rate limit")) {
          errorCode = "provider_rate_limited";
        } else if (err.name === "AbortError") {
          errorCode = "provider_timeout";
          errorMessage = "Request timed out or was cancelled";
        }

        yield {
          type: "error",
          error: new RouterError(errorCode as any, errorMessage),
        };
      }
    } finally {
      this.activeRequests.delete(request.requestId);
      
      // Restore original env
      if (originalConfigDir !== undefined) {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      } else {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    }
  }

  /**
   * Cancel an active request using AbortController.
   */
  async cancel(requestId: string): Promise<void> {
    const activeRequest = this.activeRequests.get(requestId);
    if (!activeRequest) {
      return;
    }

    try {
      activeRequest.abortController?.abort();
    } catch (err) {
      // AbortError is expected when child process is already terminating
      if ((err as Error).name !== "AbortError") {
        throw err;
      }
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  /**
   * Map SDK error messages to router error codes.
   */
  private mapSdkErrorMessage(errorText: string): RouterError {
    if (errorText.includes("auth") || errorText.includes("login")) {
      return new RouterError(
        "provider_auth_required",
        `Authentication required. Run: claude login --config-dir "${CLAUDE_CONFIG_DIR}"`,
      );
    }

    if (errorText.includes("quota") || errorText.includes("usage limit")) {
      return new RouterError("provider_quota_exhausted", "Subscription quota exhausted");
    }

    if (errorText.includes("rate limit")) {
      return new RouterError("provider_rate_limited", "Rate limited by Claude");
    }

    if (errorText.includes("timeout")) {
      return new RouterError("provider_timeout", "Request timed out");
    }

    if (errorText.includes("unavailable") || errorText.includes("not found")) {
      return new RouterError("provider_unavailable", "Claude service unavailable");
    }

    return new RouterError(
      "provider_protocol_error",
      `Unexpected SDK error: ${errorText.substring(0, 200)}`,
    );
  }
}
