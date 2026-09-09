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
  /**
   * Pending Qoder-owned tool calls parked across the HTTP boundary, keyed by
   * provider call id. Each entry holds the ORIGINAL wire request id plus the
   * thread/turn that must continue once Qoder's result arrives. Bounded by
   * the broker; entries die on resolve/expire/cancel, never by tool name.
   */
  private readonly pendingTools = new Map<
    string,
    { wireId: number | string; threadId: string; turnId: string; tool: string; argsJson: string }
  >();
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
        // CHAT_AND_TOOLS: the dynamic external tool round-trip (item/tool/call
        // server request → tool call surfaced to Qoder → tool result on the
        // follow-up turn) is implemented and proven deterministically against a
        // scripted app-server. The Router NEVER executes the tool; Qoder owns
        // execution. Live re-proof is deferred to the post-audit live gate.
        capability: "CHAT_AND_TOOLS" as const,
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
      // Follow-up turn carrying Qoder's executed tool results: resolve the
      // ORIGINAL pending wire requests (same thread/turn) BEFORE opening any
      // new thread. Each role:"tool" message must match a parked entry by
      // exact call id; the wire answer carries success:true + Qoder's result.
      const toolResults = request.messages.filter(
        (m) => m.role === "tool" && typeof m.toolCallId === "string",
      );
      if (toolResults.length > 0 && this.client) {
        for (const result of toolResults) {
          const pending = this.pendingTools.get(result.toolCallId as string);
          if (!pending) continue;
          this.pendingTools.delete(result.toolCallId as string);
          this.client.respondToServerRequest(pending.wireId, {
            success: true,
            contentItems: [{ type: "inputText", text: result.content ?? "" }],
          });
          yield* this.drainTurn(request.requestId, pending.threadId, pending.turnId, signal);
          return;
        }
      }

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

      // Externally-owned tools: Codex requests dynamic tool calls as a server
      // request `item/tool/call` (params {arguments, callId, namespace, tool,
      // threadId, turnId}). The Router NEVER executes the tool. When Qoder
      // supplied tool definitions we surface the call to Qoder
      // (tool_call_delta + completed:tool_calls) and end this HTTP request;
      // Qoder executes and returns the result as a role:"tool" message on a
      // follow-up request, which the router injects back into Codex as thread
      // history via thread/inject_items (see buildCodexThreadSeeds). A tool
      // call that arrives without tool definitions is declined so the turn
      // fails closed instead of hanging.
      const toolDefinitionsRequested = request.tools.length > 0;
      // Single tool-call waiter for the whole run, created once and raced
      // against notifications each iteration so a late-arriving call is never
      // lost to a stale per-iteration waiter. The waiter is released by
      // discardScope in finally (turn completed/cancelled) or expires on its
      // own timeout; both produce undefined ("no tool call"), never an
      // unhandled rejection and never a spurious failure of a healthy text
      // turn that simply ran past the waiter deadline.
      const toolCallFuture = toolDefinitionsRequested
        ? this.client
            .waitForToolCall(NOTIFICATION_TIMEOUT_MS, scope)
            .then(
              (toolCall) => ({ kind: "toolCall" as const, toolCall }),
              () => undefined,
            )
        : undefined;

      try {
        while (!completed && !signal.aborted) {
          const notificationPromise = this.client
            .waitForAnyNotification(
              ["item/agentMessage/delta", "thread/tokenUsage/updated", "turn/completed"],
              NOTIFICATION_TIMEOUT_MS,
              scope,
            )
            .then(
              (notification) => ({ kind: "notification" as const, notification }),
              (error: unknown) => ({ kind: "error" as const, error }),
            );
          const raced = toolCallFuture
            ? Promise.race([notificationPromise, toolCallFuture])
            : notificationPromise;
          const outcome = await raced;
          if (outcome === undefined) continue; // tool waiter released: no tool call

          if (outcome.kind === "error") {
            const error = outcome.error;
            // A cancelled/disconnected run terminates silently: the caller
            // aborted and cancel() released our waiter.
            if (signal.aborted) break;
            yield {
              type: "error",
              error:
                error instanceof RouterError
                  ? error
                  : new RouterError(
                      "provider_protocol_error",
                      error instanceof Error ? error.message : String(error),
                    ),
            };
            break;
          }

          if (outcome.kind === "toolCall") {
            const { id: wireRequestId, params } = outcome.toolCall;
            const callId =
              typeof params.callId === "string" && params.callId.length > 0
                ? params.callId
                : `call-${Date.now().toString(36)}`;
            const toolName = typeof params.tool === "string" ? params.tool : "unknown";
            const args =
              typeof params.arguments === "string"
                ? params.arguments
                : JSON.stringify(params.arguments ?? {});
            // Park the ORIGINAL wire request: hold it pending across the Qoder
            // boundary. The follow-up request carrying the matching role:"tool"
            // result resolves THIS request with success:true (see run() head).
            // success:false is reserved for unmatched calls (fail-closed).
            this.pendingTools.set(callId, {
              wireId: wireRequestId,
              threadId,
              turnId,
              tool: toolName,
              argsJson: args,
            });
            // Surface the structured tool call to Qoder (never execute it).
            yield {
              type: "tool_call_delta",
              index: 0,
              id: callId,
              name: toolName,
              argumentsDelta: args,
            };
            yield { type: "completed", finishReason: "tool_calls" };
            break;
          }

          if (outcome.kind === "notification") {
            const notification = outcome.notification;
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

  /**
   * Continue listening on an already-open thread/turn after the pending tool
   * request was resolved with Qoder's result. Streams the turn's remaining
   * deltas/usage/completion on the SAME thread/turn — never a new thread.
   */
  private async *drainTurn(
    requestId: string,
    threadId: string,
    turnId: string,
    signal: AbortSignal,
  ): AsyncIterable<RouterEvent> {
    if (!this.client) {
      throw new RouterError("provider_unavailable", "Codex client not available");
    }
    const client = this.client;
    this.activeTurns.set(requestId, { threadId, turnId });
    const scope = { threadId, turnId };
    const NOTIFICATION_TIMEOUT_MS = 60000;
    try {
      while (!signal.aborted) {
        let notification;
        try {
          notification = await client.waitForAnyNotification(
            ["item/agentMessage/delta", "thread/tokenUsage/updated", "turn/completed"],
            NOTIFICATION_TIMEOUT_MS,
            scope,
          );
        } catch (error) {
          if (signal.aborted) break;
          yield {
            type: "error",
            error:
              error instanceof RouterError
                ? error
                : new RouterError(
                    "provider_protocol_error",
                    error instanceof Error ? error.message : String(error),
                  ),
          };
          break;
        }
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
          if (parsed.turnId !== turnId) continue;
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
          break;
        }
      }
    } finally {
      this.activeTurns.delete(requestId);
      client.discardScope(scope);
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
