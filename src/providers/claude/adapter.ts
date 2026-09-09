import type { ProviderAdapter, ProviderHealth, RouterRequest } from "../../core/provider.js";
import type { DiscoveredModel } from "../../core/model.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import { NEUTRAL_CWD, buildIsolatedEnvironment, defaultClaudeConfigDir } from "./sdk-client.js";
import { query, startup, resolveSettings, type Query, type Options } from "@anthropic-ai/claude-agent-sdk";

/**
 * Extract incremental text from an SDKPartialAssistantMessage frame.
 * Only content_block_delta/text_delta carries user-visible tokens;
 * every other stream frame (message_start, content_block_start/stop,
 * message_delta/stop, pings) yields nothing.
 */
export function extractStreamEventText(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  if (record.type !== "content_block_delta") return null;
  const delta = record.delta as Record<string, unknown> | undefined;
  if (!delta || typeof delta !== "object") return null;
  if (delta.type !== "text_delta" || typeof delta.text !== "string") return null;
  return delta.text.length > 0 ? delta.text : null;
}

/**
 * Split Router messages into a system prompt plus the ordered conversation.
 * System-role content maps to the SDK's dedicated systemPrompt option;
 * every non-system message (user, assistant history, tool results as text)
 * is preserved in order as an SDK user-stream frame. Nothing is dropped
 * except empty non-system turns; provider-native tools stay disabled.
 */
export function buildClaudeConversation(messages: RouterRequest["messages"]): {
  systemPrompt: string | undefined;
  frames: Array<{ role: "user" | "assistant"; text: string }>;
} {
  const systemParts: string[] = [];
  const frames: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const message of messages) {
    const text = message.content ?? "";
    if (message.role === "system") {
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === "assistant") {
      if (text) frames.push({ role: "assistant", text });
      continue;
    }
    // user + tool roles: tool results arrive as text attributed to the user
    // turn (the external tool loop owns execution; the SDK only sees words).
    const label =
      message.role === "tool" && typeof message.toolCallId === "string"
        ? `[tool_result ${message.toolCallId}] ${text}`
        : text;
    if (label) frames.push({ role: "user", text: label });
  }
  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n") : undefined,
    frames,
  };
}

/**
 * Claude subscription provider adapter.
 *
 * Uses the official @anthropic-ai/claude-agent-sdk to interact with Claude
 * through subscription authentication (not API key/PAYG).
 *
 * IMPORTANT: This adapter requires the isolated Claude profile to be authenticated
 * via `claude login` against the adapter's effective profile directory.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;

  private activeRequests = new Map<string, { abortController?: AbortController }>();
  private readonly profileDir: string | undefined;

  constructor(options: { profileDir?: string | undefined } = {}) {
    this.profileDir = options.profileDir;
  }

  private effectiveProfileDir(): string {
    return this.profileDir ?? defaultClaudeConfigDir();
  }

  private sdkEnv(): Record<string, string> {
    return buildIsolatedEnvironment(this.profileDir);
  }

  /**
   * Discover available Claude models through the SDK's supportedModels() API.
   *
   * Performs a minimal isolated SDK query/session to obtain account/runtime-backed
   * model list from the authenticated Claude Pro subscription.
   *
   * Models are namespaced as claude/<actual-model-value> to prevent collisions.
   */
  async discoverModels(): Promise<DiscoveredModel[]> {
    // Per-request isolated subprocess environment. options.env REPLACES the
    // subprocess environment entirely (never merged), so global process.env
    // is never touched — concurrent requests cannot observe each other.
    const env = this.sdkEnv();
    try {
      // Create a minimal query to access supportedModels()
      // This establishes a session with the isolated profile.
      // options.env REPLACES the SDK subprocess environment (never merged),
      // so PAYG variables and the normal profile can never leak in.
      // settingSources: [] disables user/project/local settings files so
      // discovery can never inherit the normal Claude/OmniRoute profile.
      const queryResult: Query = query({
        prompt: "",  // Minimal prompt for model discovery
        options: {
          env,
          cwd: NEUTRAL_CWD,
          settingSources: [],
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
          `Authentication required. Run: claude login --config-dir "${this.effectiveProfileDir()}"`,
        );
      }

      throw new RouterError(
        "provider_unavailable",
        `Failed to discover models: ${err.message}`,
      );
    }
  }

  /**
   * Check health of the Claude provider by probing the isolated Router
   * profile only. Never consults normal user settings: resolveSettings runs
   * with settingSources [] and the verdict comes from isolated startup(),
   * never from a third-party apiProvider observation.
   */
  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    void signal;
    const env = this.sdkEnv();
    try {
      // Isolated settings resolution only — user/project/local sources are
      // disabled so a normal Claude/OmniRoute profile cannot influence us.
      // The result itself is NOT an auth oracle; startup() decides.
      await resolveSettings({
        cwd: NEUTRAL_CWD,
        settingSources: [],
      });

      // Verify actual authentication status against the isolated profile.
      // options.env REPLACES the SDK subprocess environment.
      try {
        await startup({
          options: {
            env,
            cwd: NEUTRAL_CWD,
            settingSources: [],
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
            detail: `Run: claude login --config-dir "${this.effectiveProfileDir()}"`,
          };
        }

        return {
          status: "unavailable",
          detail: error.message,
        };
      }
    } catch (error) {
      const err = error as Error;
      if (err.message.includes("auth") || err.message.includes("login")) {
        return {
          status: "auth_required",
          detail: `Run: claude login --config-dir "${this.effectiveProfileDir()}"`,
        };
      }

      return {
        status: "unavailable",
        detail: err.message,
      };
    }
  }

  /**
   * Execute a Claude request using the official SDK with isolated environment.
   * Yields RouterEvents incrementally as SDK messages arrive — deltas are
   * never buffered until upstream completion.
   */
  async *run(
    request: RouterRequest,
    signal: AbortSignal,
  ): AsyncIterable<RouterEvent> {
    // Track active request for cancellation
    const abortController = new AbortController();
    this.activeRequests.set(request.requestId, { abortController });

    // Link external signal to our controller
    const onAbort = () => abortController.abort();
    signal.addEventListener("abort", onAbort, { once: true });

    // Per-request isolated subprocess environment. options.env REPLACES the
    // SDK subprocess environment entirely (never merged with process.env),
    // so global process.env is never touched — concurrent requests cannot
    // observe each other and PAYG values can never leak in.
    const env = this.sdkEnv();

    try {
      // Full conversation semantics: system messages map to the SDK's
      // dedicated systemPrompt option; user + assistant history + tool
      // results stream in order as SDK user messages. Nothing
      // semantically relevant is dropped; native tools stay disabled.
      const conversation = buildClaudeConversation(request.messages);
      const prompt = (async function* () {
        for (const frame of conversation.frames) {
          yield {
            type: "user" as const,
            message: { role: frame.role, content: frame.text },
            parent_tool_use_id: null,
          };
        }
      })();

      // Configure SDK options with tool restrictions
      const sdkOptions: Options = {
        env,
        abortController,
        cwd: NEUTRAL_CWD,
        // Route the request to the model selected from discovery
        model: request.model.upstreamModel,
        // Incremental token streaming: without this the SDK only emits
        // complete AssistantMessage objects after generation finishes.
        includePartialMessages: true,
        // Isolation mode: never read user/project/local settings files, so
        // the normal Claude/OmniRoute profile cannot influence the Router.
        settingSources: [],
        ...(conversation.systemPrompt !== undefined
          ? {
              systemPrompt: {
                type: "custom" as const,
                prompt: conversation.systemPrompt,
                snapshot: false,
              },
            }
          : {}),
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

      let usageYielded = false;
      // Once a partial text delta has been emitted, the trailing complete
      // assistant message repeats the same text and must not be re-emitted.
      let sawPartialDelta = false;

      // Stream SDK messages and map to RouterEvents incrementally.
      for await (const message of queryResult) {
        if (signal.aborted || abortController.signal.aborted) {
          return;
        }
        if (message.type === "stream_event") {
          const text = extractStreamEventText(
            (message as { event?: unknown }).event,
          );
          if (text) {
            sawPartialDelta = true;
            yield { type: "text_delta", text };
          }
          continue;
        }
        if (message.type === "assistant") {
          // Extract text content from assistant message
          const contentBlocks = message.message?.content || [];
          for (const block of contentBlocks) {
            if (block.type === "text" && !sawPartialDelta) {
              const text = block.text;
              if (text) {
                yield { type: "text_delta", text };
              }
            }
          }

          // Collect usage if present (may come before stop_reason in streaming)
          const usage = message.message?.usage as
            | { input_tokens?: number; output_tokens?: number }
            | undefined;
          if (usage && !usageYielded) {
            usageYielded = true;
            const usageEvent: RouterEvent = { type: "usage" };
            if (typeof usage.input_tokens === "number") {
              (usageEvent as { inputTokens?: number }).inputTokens = usage.input_tokens;
            }
            if (typeof usage.output_tokens === "number") {
              (usageEvent as { outputTokens?: number }).outputTokens = usage.output_tokens;
            }
            yield usageEvent;
          }
        } else if (message.type === "result") {
          const resultMessage = message as {
            subtype?: string;
            errors?: string[];
            usage?: { input_tokens?: number; output_tokens?: number };
          };

          if (resultMessage.subtype === "success") {
            // Successful completion - map stop reason to finish reason.
            const stopReason = (resultMessage as { stop_reason?: string }).stop_reason;
            let finishReason: "stop" | "tool_calls" | "length" = "stop";
            if (stopReason === "max_tokens") {
              finishReason = "length";
            } else if (stopReason === "tool_use") {
              finishReason = "tool_calls";
            }

            const resultUsage = resultMessage.usage as
              | { input_tokens?: number; output_tokens?: number }
              | undefined;
            if (resultUsage && !usageYielded) {
              usageYielded = true;
              const usageEvent: RouterEvent = { type: "usage" };
              if (typeof resultUsage.input_tokens === "number") {
                (usageEvent as { inputTokens?: number }).inputTokens = resultUsage.input_tokens;
              }
              if (typeof resultUsage.output_tokens === "number") {
                (usageEvent as { outputTokens?: number }).outputTokens = resultUsage.output_tokens;
              }
              yield usageEvent;
            }

            yield {
              type: "completed",
              finishReason,
            };
            return;
          } else if (resultMessage.subtype?.startsWith("error")) {
            // Handle result error messages
            const errorMessages = resultMessage.errors || [];
            const errorMessage = errorMessages.join("; ") || "Unknown SDK error";

            const error = this.mapSdkErrorMessage(errorMessage);
            yield { type: "error", error };
            return;
          }
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
          errorMessage = `Authentication required. Run: claude login --config-dir "${this.effectiveProfileDir()}"`;
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
      signal.removeEventListener("abort", onAbort);
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
        `Authentication required. Run: claude login --config-dir "${this.effectiveProfileDir()}"`,
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
