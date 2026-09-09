import { spawn } from "node:child_process";
import type { ProviderAdapter, DiscoveredModel, ProviderHealth, RouterRequest } from "../../core/provider.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import { CodexAppServerClient } from "./app-server-client.js";
import {
  buildThreadStartParams,
  buildTurnInterruptParams,
  parseAgentDeltaParams,
  parseTokenUsageParams,
  parseTurnCompletedParams,
  parseTurnStartResponse,
} from "./schema-translator.js";

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

/**
 * Split Router messages into developer instructions, injectable history,
 * and the current user turn input. System content becomes Codex
 * developerInstructions; prior user/assistant turns become Responses-API
 * history items via thread/inject_items; only the newest user text starts
 * the turn. Tool-role messages become labelled user text (external loop
 * owns execution). Returns the pieces without any repository mutation.
 */
export function buildCodexThreadSeeds(messages: RouterRequest["messages"]): {
  developerInstructions: string | undefined;
  historyItems: unknown[];
  turnInput: Array<{ type: "text"; text: string }>;
} {
  const systemParts: string[] = [];
  const historyItems: unknown[] = [];
  let lastUserIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === "user" && (message.content ?? "")) lastUserIndex = index;
  });
  const turnInput: Array<{ type: "text"; text: string }> = [];
  messages.forEach((message, index) => {
    const text = message.content ?? "";
    if (message.role === "system") {
      if (text) systemParts.push(text);
      return;
    }
    if (message.role === "assistant") {
      if (!text) return;
      historyItems.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      });
      return;
    }
    if (message.role === "tool") {
      if (!text) return;
      const label =
        typeof message.toolCallId === "string"
          ? `[tool_result ${message.toolCallId}] ${text}`
          : `[tool_result] ${text}`;
      if (index === lastUserIndex) {
        turnInput.push({ type: "text", text: label });
      } else {
        historyItems.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: label }],
        });
      }
      return;
    }
    // user role
    if (!text) return;
    if (index === lastUserIndex) {
      turnInput.push({ type: "text", text });
    } else {
      historyItems.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      });
    }
  });
  return {
    developerInstructions: systemParts.length > 0 ? systemParts.join("\n") : undefined,
    historyItems,
    turnInput,
  };
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  private client: CodexAppServerClient | null = null;
  private process: ReturnType<typeof spawn> | null = null;
  private activeTurns = new Map<string, { threadId: string; turnId?: string }>();
  private readonly codexHome: string | undefined;
  private readonly codexBinary: string;

  constructor(options: { codexHome?: string | undefined; codexBinary?: string | undefined } = {}) {
    this.codexHome = options.codexHome;
    // LaunchAgent-safe resolution: installer bakes CMM_ROUTER_CODEX_BIN;
    // explicit constructor option wins, then env, then PATH lookup.
    this.codexBinary =
      options.codexBinary ?? process.env.CMM_ROUTER_CODEX_BIN ?? "codex";
  }

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
      const seeds = buildCodexThreadSeeds(request.messages);
      // Ephemeral per-request thread: explicitly requested per the plan's
      // privacy/lifecycle requirement (never rely on a server default).
      const threadParams = buildThreadStartParams({
        model: request.model.upstreamModel,
        sandbox: "read-only",
        ...(seeds.developerInstructions !== undefined
          ? { developerInstructions: seeds.developerInstructions }
          : {}),
        ephemeral: true,
      });
      const threadResponse = await this.client.startThread(threadParams as unknown as Record<string, unknown> as never);
      const threadId = threadResponse.thread.id;

      // Prior conversation history becomes model-visible thread history via
      // the schema-backed thread/inject_items mechanism (roles preserved).
      if (seeds.historyItems.length > 0) {
        await this.client.injectItems({ threadId, items: seeds.historyItems });
      }

      // Only the newest user text starts the active turn.
      const input =
        seeds.turnInput.length > 0
          ? seeds.turnInput
          : [{ type: "text" as const, text: "" }];
      const turnStarted = await this.client.startTurn({ threadId, input });
      // Schema-backed turn id: result.turn.id (never a flat turnId).
      const { turnId } = parseTurnStartResponse(turnStarted as unknown);

      // Track active turn for cancellation
      this.activeTurns.set(request.requestId, { threadId, turnId });

      // Listen for events scoped to OUR thread+turn only — concurrent runs
      // can never consume each other's deltas/usage/completion.
      const scope = { threadId, turnId };
      let completed = false;

      // Explicit bounded timeout per notification wait (60 seconds)
      // This ensures we never wait indefinitely and always produce provider_timeout on deadline expiry
      const NOTIFICATION_TIMEOUT_MS = 60000;

      try {
        while (!completed && !signal.aborted) {
          const notification = await this.client.waitForAnyNotification(
            ["item/agentMessage/delta", "thread/tokenUsage/updated", "turn/completed"],
            NOTIFICATION_TIMEOUT_MS,
            scope,
          );

          if (notification.method === "item/agentMessage/delta") {
            const params = parseAgentDeltaParams(
              (notification as { params?: unknown }).params,
            );
            if (params.delta.length > 0) {
              yield { type: "text_delta", text: params.delta };
            }
          } else if (notification.method === "thread/tokenUsage/updated") {
            const parsed = parseTokenUsageParams(
              (notification as { params?: unknown }).params,
            );
            const usageEvent: RouterEvent = { type: "usage" };
            if (parsed.inputTokens !== undefined) {
              (usageEvent as { inputTokens?: number }).inputTokens = parsed.inputTokens;
            }
            if (parsed.outputTokens !== undefined) {
              (usageEvent as { outputTokens?: number }).outputTokens = parsed.outputTokens;
            }
            if (parsed.reasoningTokens !== undefined) {
              (usageEvent as { reasoningTokens?: number }).reasoningTokens = parsed.reasoningTokens;
            }
            if (parsed.cacheReadTokens !== undefined) {
              (usageEvent as { cacheReadTokens?: number }).cacheReadTokens = parsed.cacheReadTokens;
            }
            yield usageEvent;
          } else if (notification.method === "turn/completed") {
            const parsed = parseTurnCompletedParams(
              (notification as { params?: unknown }).params,
            );
            // Ignore completions for other turns (defensive; scope already
            // filters, but a stale queued frame must never terminate us).
            if (parsed.turnId !== turnId) continue;
            completed = true;
            if (parsed.status === "failed") {
              yield {
                type: "error",
                error: new RouterError(
                  "provider_protocol_error",
                  `Codex turn failed: ${(parsed.errorMessage ?? "unknown").slice(0, 200)}`,
                ),
              };
            } else {
              yield {
                type: "completed",
                finishReason: normalizeCodexFinishReason(parsed.status),
              };
            }
          }
        }
      } finally {
        // Clean up active turn tracking and release this run's buffered
        // notification state so no content survives into later requests.
        this.activeTurns.delete(request.requestId);
        this.client.discardScope(scope);
      }
    } catch (error) {
      // A cancelled/disconnected run terminates silently: the caller aborted
      // and cancel() released our waiter, so there is no one to notify.
      if (signal.aborted) return;
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
      // Fail closed on missing ids: never emit an empty turn interrupt.
      const params = buildTurnInterruptParams({
        threadId: activeTurn.threadId,
        turnId: activeTurn.turnId,
      });
      await this.client.interruptTurn(params);
    } catch {
      // Interrupt failures still release tracking below.
    } finally {
      this.activeTurns.delete(requestId);
      if (activeTurn.threadId || activeTurn.turnId) {
        this.client.discardScope({
          ...(activeTurn.threadId ? { threadId: activeTurn.threadId } : {}),
          ...(typeof activeTurn.turnId === "string" && activeTurn.turnId.length > 0
            ? { turnId: activeTurn.turnId }
            : {}),
        });
      }
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.client) return;

    // Spawn codex app-server (configurable binary; CODEX_HOME scopes the
    // subscription profile without touching the user's default checkout).
    this.process = spawn(this.codexBinary, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "inherit"],
      ...(this.codexHome ? { env: { ...process.env, CODEX_HOME: this.codexHome } } : {}),
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
