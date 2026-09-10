import { spawn } from "node:child_process";
import type { Duplex } from "node:stream";
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
  toDynamicToolSpecs,
} from "./schema-translator.js";
import type { InitializeParams } from "./protocol.js";
import {
  DeferredToolBroker,
  createPublicToolCallId,
  type PendingToolContext,
} from "../../core/deferred-tool-broker.js";

/**
 * Codex 0.153.4 app-server requires an explicit experimental-API opt-in before
 * it will accept experimental fields such as `thread/start.dynamicTools`.
 * Exact wire shape verified against the generated experimental schema
 * (InitializeCapabilities.experimentalApi: boolean, default false).
 */
export function buildCodexInitializeParams(): InitializeParams {
  return {
    clientInfo: {
      name: "cmm-subscription-router",
      title: "CMM Subscription Router",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  };
}

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
   * Router-owned bounded pending state. Production injects the shared broker
   * from the composition root so every adapter shares one bounded map; the
   * default keeps the adapter self-contained for direct construction.
   */
  private readonly broker: DeferredToolBroker;
  private readonly codexHome: string | undefined;
  private readonly codexBinary: string;
  /**
   * Explicit transport seam. Production leaves this unset and spawns the real
   * app-server; tests inject a deterministic Duplex that speaks the same
   * observable JSON-RPC protocol. The adapter's production methods
   * (ensureStarted/initialize/run/drainTurn/cancel) are unchanged.
   */
  private readonly transportFactory: (() => Duplex) | undefined;

  constructor(
    options: {
      codexHome?: string | undefined;
      codexBinary?: string | undefined;
      transportFactory?: (() => Duplex) | undefined;
      broker?: DeferredToolBroker | undefined;
    } = {},
  ) {
    this.codexHome = options.codexHome;
    this.transportFactory = options.transportFactory;
    this.broker = options.broker ?? new DeferredToolBroker();
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
      // new thread. Qoder returns only the PUBLIC tool_call_id it was given;
      // the broker maps that back to the exact provider-internal call.
      const toolResults = request.messages.filter(
        (m) => m.role === "tool" && typeof m.toolCallId === "string",
      );
      if (toolResults.length > 0 && this.client) {
        for (const result of toolResults) {
          const claim = this.broker.claimByPublicToolCallId<PendingToolContext>(
            result.toolCallId as string,
          );
          if (claim.outcome !== "resolved" || !claim.context) continue;
          const ctx = claim.context;
          if (ctx.wireRequestId === undefined) continue;
          this.client.respondToServerRequest(ctx.wireRequestId, {
            success: true,
            contentItems: [{ type: "inputText", text: result.content ?? "" }],
          });
          if (ctx.providerSession && ctx.providerTurn) {
            yield* this.drainTurn(
              request.requestId,
              ctx.providerSession,
              ctx.providerTurn,
              signal,
            );
          }
          return;
        }
        // A tool result that matches no parked call is a correlation failure
        // (guessed id, wrong consumer, expired entry). Fail closed instead of
        // silently opening a fresh thread, which would leak a new provider run.
        yield {
          type: "error",
          error: new RouterError(
            "provider_protocol_error",
            "Codex tool result does not match any pending Qoder tool call",
          ),
        };
        return;
      }

      const seeds = buildCodexThreadSeeds(request.messages);
      // Qoder tool definitions are declared on the SAME thread/start that
      // creates the tool-capable thread. Experimental API was opted into during
      // initialize (buildCodexInitializeParams). Text-only turns send no
      // dynamicTools field at all so wire bytes are unchanged.
      const dynamicTools =
        request.tools.length > 0 ? toDynamicToolSpecs(request.tools) : undefined;
      // Ephemeral per-request thread: explicitly requested per the plan's
      // privacy/lifecycle requirement (never rely on a server default).
      const threadParams = buildThreadStartParams({
        model: request.model.upstreamModel,
        sandbox: "read-only",
        ...(seeds.developerInstructions !== undefined
          ? { developerInstructions: seeds.developerInstructions }
          : {}),
        ephemeral: true,
        ...(dynamicTools !== undefined ? { dynamicTools } : {}),
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
      // Immutable per-thread declared-tool ACL: only the dynamicTools sent on
      // THIS thread's thread/start may be requested. Authentication of the
      // transport is not authorization to call an undeclared function.
      const declaredToolNames = new Set(request.tools.map((tool) => tool.function.name));
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
            // Fail closed on missing protocol identity. The 0.153.4 schema
            // requires arguments/callId/threadId/tool/turnId; a fabricated id
            // would let a malformed frame masquerade as a real call, so never
            // synthesize one.
            const callId =
              typeof params.callId === "string" && params.callId.length > 0
                ? params.callId
                : undefined;
            const toolName =
              typeof params.tool === "string" && params.tool.length > 0
                ? params.tool
                : undefined;
            const hasThreadId =
              typeof params.threadId === "string" && params.threadId.length > 0;
            const hasTurnId =
              typeof params.turnId === "string" && params.turnId.length > 0;
            const hasArguments = params.arguments !== undefined;
            if (!callId || !toolName || !hasThreadId || !hasTurnId || !hasArguments) {
              // Answer the original request so the provider turn terminates
              // instead of hanging, then fail the run closed.
              this.client.respondToServerRequest(wireRequestId, {
                success: false,
                contentItems: [],
              });
              yield {
                type: "error",
                error: new RouterError(
                  "provider_protocol_error",
                  "Codex item/tool/call missing required protocol identity",
                ),
              };
              break;
            }
            const args =
              typeof params.arguments === "string"
                ? params.arguments
                : JSON.stringify(params.arguments);
            if (!declaredToolNames.has(toolName)) {
              // Undeclared dynamic tool: answer the wire request so the turn
              // terminates, then fail closed. No Qoder surface, no broker entry.
              this.client.respondToServerRequest(wireRequestId, {
                success: false,
                contentItems: [],
              });
              yield {
                type: "error",
                error: new RouterError(
                  "provider_protocol_error",
                  "Codex requested a dynamic tool that was not declared on this thread",
                ),
              };
              break;
            }
            // Park the ORIGINAL wire request in the shared bounded broker. The
            // consumer-visible id is a Router-generated globally unique PUBLIC
            // id; the provider's own callId stays internal. A follow-up request
            // carrying the public id resolves THIS request with success:true.
            const publicToolCallId = createPublicToolCallId("chatgpt");
            this.broker.createPendingCall<PendingToolContext>(
              {
                consumer: "qoder",
                provider: "chatgpt",
                sessionId: threadId,
                turnId,
                toolCallId: publicToolCallId,
                publicToolCallId,
              },
              undefined,
              signal,
              {
                provider: "chatgpt",
                providerSession: threadId,
                providerTurn: turnId,
                providerCallId: callId,
                wireRequestId,
              },
            );
            // Surface the structured tool call to Qoder (never execute it).
            yield {
              type: "tool_call_delta",
              index: 0,
              id: publicToolCallId,
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
      // Explicit Qoder/provider cancellation releases the parked correlation
      // for this thread so it does not linger until TTL. (A tool call parked
      // for the cross-request round-trip is not "active" — the run already
      // returned — so this cannot cancel a live round-trip.)
      this.broker.cancelScope({ provider: "chatgpt", sessionId: activeTurn.threadId });
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

    if (this.transportFactory) {
      this.client = new CodexAppServerClient(this.transportFactory());
      await this.client.initialize(buildCodexInitializeParams());
      await this.client.sendInitializedNotification();
      return;
    }

    // Spawn codex app-server (configurable binary; CODEX_HOME scopes the
    // subscription profile without touching the user's default checkout).
    this.process = spawn(this.codexBinary, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "inherit"],
      ...(this.codexHome ? { env: { ...process.env, CODEX_HOME: this.codexHome } } : {}),
    });

    // Provider subprocess death releases every pending correlation for this
    // provider: a parked tool call can never be answered by a dead app-server,
    // so it must not linger until TTL.
    this.process.on("exit", () => {
      this.process = null;
      this.client = null;
      this.broker.cancelScope({ provider: "chatgpt" });
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

    // Initialize handshake, including the experimental-API opt-in required to
    // declare Qoder tools via thread/start.dynamicTools.
    await this.client.initialize(buildCodexInitializeParams());

    await this.client.sendInitializedNotification();
  }
}
