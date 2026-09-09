import type { ProviderAdapter, ProviderHealth, RouterRequest } from "../../core/provider.js";
import type { DiscoveredModel } from "../../core/model.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import { CLAUDE_CONFIG_DIR, NEUTRAL_CWD } from "./sdk-client.js";
import { query, startup, resolveSettings, type Query, type Options } from "@anthropic-ai/claude-agent-sdk";

/**
 * Execute a function with isolated Claude environment.
 * Temporarily sets CLAUDE_CONFIG_DIR and ensures no Anthropic PAYG variables leak through.
 */
async function withIsolatedClaudeEnv<T>(fn: () => Promise<T>): Promise<T> {
  // Save original environment
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;

  try {
    // Set isolated environment
    process.env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;
    
    // Explicitly remove any PAYG variables that might exist
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    return await fn();
  } finally {
    // Restore original environment
    if (originalConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
    if (originalBaseUrl !== undefined) {
      process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    }
    if (originalAuthToken !== undefined) {
      process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
    }
  }
}

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
   * Discover available Claude models through the SDK's supportedModels() API.
   *
   * Performs a minimal isolated SDK query/session to obtain account/runtime-backed
   * model list from the authenticated Claude Pro subscription.
   *
   * Models are namespaced as claude/<actual-model-value> to prevent collisions.
   */
  async discoverModels(): Promise<DiscoveredModel[]> {
    return await withIsolatedClaudeEnv(async () => {
      try {
        // Create a minimal query to access supportedModels()
        // This establishes a session with the isolated profile
        const queryResult: Query = query({
          prompt: "",  // Minimal prompt for model discovery
          options: {
            cwd: NEUTRAL_CWD,
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
            permissionMode: "auto",
          },
        });

        // Get supported models from the SDK
        const modelInfos = await queryResult.supportedModels();

        // Interrupt the query immediately after getting models
        try {
          await queryResult.interrupt();
        } catch {
          // Ignore interrupt errors
        }

        if (!modelInfos || modelInfos.length === 0) {
          throw new RouterError(
            "provider_protocol_error",
            "SDK returned no supported models",
          );
        }

        // Map SDK ModelInfo to DiscoveredModel with proper namespacing
        const discoveredModels: DiscoveredModel[] = [];
        const seenValues = new Set<string>();

        for (const modelInfo of modelInfos) {
          const modelValue = modelInfo.value;

          // Deduplicate by model value
          if (seenValues.has(modelValue)) {
            continue;
          }
          seenValues.add(modelValue);

          // Namespace as claude/<model-value>
          const namespacedId = `claude/${modelValue}`;

          discoveredModels.push({
            id: namespacedId,
            provider: "claude",
            upstreamModel: modelValue,
            displayName: modelInfo.displayName || modelValue,
            capability: "CHAT_ONLY",
          });
        }

        return discoveredModels;
      } catch (error) {
        if (error instanceof RouterError) {
          throw error;
        }

        const err = error as Error;

        // Map authentication errors
        if (err.message.includes("auth") || err.message.includes("login")) {
          throw new RouterError(
            "provider_auth_required",
            `Authentication required. Run: claude login --config-dir "${CLAUDE_CONFIG_DIR}"`,
          );
        }

        throw new RouterError(
          "provider_unavailable",
          `Failed to discover models: ${err.message}`,
        );
      }
    });
  }

  /**
   * Check health of the Claude provider by verifying authentication status.
   * Uses the SDK's resolveSettings to check if the isolated profile is authenticated.
   */
  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    return await withIsolatedClaudeEnv(async () => {
      try {
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
      }
    });
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

    try {
      // Collect all events in isolated environment, then yield them
      const events = await withIsolatedClaudeEnv(async (): Promise<RouterEvent[]> => {
        const collectedEvents: RouterEvent[] = [];
        
        // Prepare prompt from messages
        const prompt = request.messages
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join("\n");

        // Configure SDK options with tool restrictions
        const sdkOptions: Options = {
          abortController,
          cwd: NEUTRAL_CWD,
          // Route the request to the model selected from discovery
          model: request.model.upstreamModel,
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
                  collectedEvents.push({ type: "text_delta", text });
                }
              }
            }

            // Collect usage if present (may come before stop_reason in streaming)
            const usage = message.message?.usage;
            if (usage && !collectedEvents.some(e => e.type === "usage")) {
              collectedEvents.push({
                type: "usage",
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
              });
            }
          } else if (message.type === "result") {
            const resultMessage = message as any;
            
            if (resultMessage.subtype === "success") {
              // Successful completion - emit completed event
              let finishReason: "stop" | "tool_calls" | "length" = "stop";
              
              // Try to get stop_reason from the last assistant message if available
              // (In some cases it may be set on the final assistant message)
              
              collectedEvents.push({
                type: "completed",
                finishReason,
              });
              return collectedEvents;
            } else if (resultMessage.subtype?.startsWith("error")) {
              // Handle result error messages
              const errorMessages = resultMessage.errors || [];
              const errorMessage = errorMessages.join("; ") || "Unknown SDK error";
              
              const error = this.mapSdkErrorMessage(errorMessage);
              collectedEvents.push({ type: "error", error });
              return collectedEvents;
            }
          }
        }

        // If we get here without explicit completion, check if aborted
        if (signal.aborted || abortController.signal.aborted) {
          // Cancellation - don't treat as error
          return collectedEvents;
        }

        // No completion event received - this shouldn't happen
        throw new RouterError(
          "provider_protocol_error",
          "SDK stream ended without completion event",
        );
      });

      // Yield all collected events
      for (const event of events) {
        yield event;
      }
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
