import type { ProviderAdapter, ProviderHealth, RouterRequest } from "../../core/provider.js";
import type { DiscoveredModel, RouterTool } from "../../core/model.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import { fileURLToPath } from "node:url";
import { NEUTRAL_CWD, buildIsolatedEnvironment, defaultClaudeConfigDir } from "./sdk-client.js";
import { query, startup, resolveSettings, type Query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { BridgeControlServer, type BridgeToolRequest } from "../../bridge/control-ipc.js";
import { DeferredToolBroker, createPublicToolCallId } from "../../core/deferred-tool-broker.js";
import { BoundedQueue } from "../../core/bounded-queue.js";

/** Injection seam: production uses the real SDK query. */
type QueryFn = typeof query;

/**
 * Finite lifetime for a parked tool session. The broker entry expires on the
 * same bound, so a session whose continuation never arrives cannot leak its
 * SDK query, MCP child, or control socket.
 */
const DEFAULT_SESSION_TTL_MS = 120_000;

/**
 * Maximum simultaneously parked provider tool sessions. A second concurrent
 * MCP tools/call on one session is refused: the split HTTP round-trip supports
 * exactly one parked call per provider session.
 */
const DEFAULT_MAX_LIVE_TOOL_SESSIONS = 64;
const MAX_PENDING_TOOL_CALLS_PER_MCP_SESSION = 1;

/**
 * A live Claude SDK query held across the split HTTP interaction while its
 * external MCP handler is parked waiting for Qoder's result. The Router keeps
 * consuming the SAME query on the follow-up request: no new session, no
 * textual history reconstruction.
 */
interface LiveClaudeSession {
  sessionKey: string;
  /** Router request that currently drives this SDK query (for cancellation). */
  requestId: string;
  iterator: AsyncIterator<unknown>;
  inflight: Promise<IteratorResult<unknown>> | undefined;
  toolCalls: BoundedQueue<BridgeToolRequest>;
  toolCallPromise: Promise<BridgeToolRequest> | undefined;
  control: BridgeControlServer;
  abortController: AbortController;
  sawPartialDelta: boolean;
  usageYielded: boolean;
  /** Bridge request id currently parked with the Router (one at a time). */
  parkedRequestId: string | undefined;
  /** Public id handed to Qoder for the parked call. */
  publicToolCallId: string | undefined;
  /**
   * True WHILE a call is parked: a second, genuinely concurrent call is
   * refused. It reopens once the parked call has been delivered, so the NEXT
   * sequential call of the same logical run is accepted.
   */
  gate: { parked: boolean };
  /** Bounded lifetime for a parked session whose continuation never arrives. */
  ttlTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set once the session has reached a terminal state (cleanup ran). */
  terminated: boolean;
}


/**
 * Absolute path to the compiled external MCP bridge entry point. Production
 * runs from dist/, so the bridge is a sibling of the compiled adapter.
 */
export function defaultBridgeEntryPath(): string {
  return fileURLToPath(new URL("../../bridge/mcp-bridge-process.js", import.meta.url));
}

/**
 * Qoder tool definitions as the external MCP bridge exposes them. Only the
 * caller's tools are exposed — nothing native, nothing implicit.
 */
export function bridgeToolDefinitions(
  tools: RouterTool[],
): Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> {
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
    inputSchema: tool.function.parameters ?? {},
  }));
}

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
 * Effort levels the Claude Agent SDK accepts (Options.effort). The canonical
 * Router vocabulary also carries "none", which has no SDK equivalent.
 */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

/**
 * Split Router messages into a system prompt plus the ordered conversation.
 * System-role content maps to the SDK's dedicated systemPrompt option;
 * every non-system message (user, assistant history, tool results as text)
 * is preserved in order as an SDK user-stream frame. Nothing is dropped
 * except empty non-system turns; provider-native tools stay disabled.
 */
export function buildClaudeConversation(messages: RouterRequest["messages"]): {
  systemPrompt: string | undefined;
  frames: Array<{
    role: "user" | "assistant";
    text: string;
    images?: Array<Record<string, unknown>>;
  }>;
} {
  const systemParts: string[] = [];
  const frames: Array<{
    role: "user" | "assistant";
    text: string;
    images?: Array<Record<string, unknown>>;
  }> = [];
  for (const message of messages) {
    const text = message.content ?? "";
    if (message.role === "system") {
      if (text) systemParts.push(text);
      continue;
    }
    const images = (message.images ?? []).map(toClaudeImageBlock);
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
    if (label || images.length > 0) {
      frames.push({
        role: "user",
        text: label,
        ...(images.length > 0 ? { images } : {}),
      });
    }
  }
  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n") : undefined,
    frames,
  };
}

/**
 * Convert one [OI] image reference into an Anthropic Messages image block.
 * A data URL is split into its declared media type plus base64 payload; any
 * other reference becomes a URL source the SDK resolves itself.
 */
export function toClaudeImageBlock(url: string): Record<string, unknown> {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataUrl) {
    return {
      type: "image",
      source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] },
    };
  }
  return { type: "image", source: { type: "url", url } };
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
  /** Live tool-capable sessions, keyed by Router-generated public tool-call id. */
  private readonly sessions = new Map<string, LiveClaudeSession>();
  /**
   * Live tool-capable sessions keyed by the Router request that currently
   * drives them. Lets a continuation cancellation reach the exact provider run.
   */
  private readonly sessionsByRequest = new Map<string, LiveClaudeSession>();
  private readonly profileDir: string | undefined;
  private readonly broker: DeferredToolBroker;
  private readonly queryFn: QueryFn;
  private readonly bridgeEntryPath: string;
  private readonly bridgeCommand: string;
  private readonly sessionTtlMs: number;
  private readonly maxLiveSessions: number;

  constructor(
    options: {
      profileDir?: string | undefined;
      broker?: DeferredToolBroker | undefined;
      queryFn?: QueryFn | undefined;
      bridgeEntryPath?: string | undefined;
      bridgeCommand?: string | undefined;
      sessionTtlMs?: number | undefined;
      maxLiveSessions?: number | undefined;
    } = {},
  ) {
    this.profileDir = options.profileDir;
    this.broker = options.broker ?? new DeferredToolBroker();
    this.queryFn = options.queryFn ?? query;
    this.bridgeEntryPath = options.bridgeEntryPath ?? defaultBridgeEntryPath();
    this.bridgeCommand = options.bridgeCommand ?? process.execPath;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxLiveSessions = options.maxLiveSessions ?? DEFAULT_MAX_LIVE_TOOL_SESSIONS;
  }

  /** Live tool sessions held across the HTTP split (test/diagnostic accessor). */
  activeToolSessions(): number {
    return this.sessions.size;
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
          // Qoder-owned tools traverse the external MCP bridge held open across
          // the split HTTP interaction; the Router never executes the tool and
          // Claude's native shell/file/edit tools stay disabled.
          capability: "CHAT_AND_TOOLS",
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

  /** Map an arbitrary thrown value to a RouterError without leaking content. */
  private toRouterError(error: unknown): RouterError {
    if (error instanceof RouterError) return error;
    const err = error as Error;
    let code: "provider_protocol_error" | "provider_auth_required" | "provider_quota_exhausted" | "provider_rate_limited" | "provider_timeout" =
      "provider_protocol_error";
    let message = err?.message ?? String(error);
    if (message.includes("auth") || message.includes("login")) {
      code = "provider_auth_required";
      message = `Authentication required. Run: claude login --config-dir "${this.effectiveProfileDir()}"`;
    } else if (message.includes("quota") || message.includes("usage limit")) {
      code = "provider_quota_exhausted";
    } else if (message.includes("rate limit")) {
      code = "provider_rate_limited";
    } else if (err?.name === "AbortError") {
      code = "provider_timeout";
      message = "Request timed out or was cancelled";
    }
    return new RouterError(code, message);
  }

  /**
   * Map one SDK stream message to RouterEvents. Returns true when the message
   * is terminal (result received) so the caller stops draining.
   */
  private *processSdkMessage(
    message: unknown,
    state: { sawPartialDelta: boolean; usageYielded: boolean },
  ): Generator<RouterEvent, boolean, void> {
    const typed = message as {
      type?: string;
      event?: unknown;
      message?: { content?: Array<{ type: string; text?: string }>; usage?: unknown };
      subtype?: string;
      errors?: string[];
      usage?: unknown;
      stop_reason?: string;
    };
    if (typed.type === "stream_event") {
      const text = extractStreamEventText(typed.event);
      if (text) {
        state.sawPartialDelta = true;
        yield { type: "text_delta", text };
      }
      return false;
    }
    if (typed.type === "assistant") {
      const contentBlocks = typed.message?.content ?? [];
      for (const block of contentBlocks) {
        if (block.type === "text" && !state.sawPartialDelta && block.text) {
          yield { type: "text_delta", text: block.text };
        }
      }
      const usage = typed.message?.usage as
        | { input_tokens?: number; output_tokens?: number }
        | undefined;
      if (usage && !state.usageYielded) {
        state.usageYielded = true;
        const usageEvent: RouterEvent = { type: "usage" };
        if (typeof usage.input_tokens === "number") {
          (usageEvent as { inputTokens?: number }).inputTokens = usage.input_tokens;
        }
        if (typeof usage.output_tokens === "number") {
          (usageEvent as { outputTokens?: number }).outputTokens = usage.output_tokens;
        }
        yield usageEvent;
      }
      return false;
    }
    if (typed.type === "result") {
      if (typed.subtype === "success") {
        let finishReason: "stop" | "tool_calls" | "length" = "stop";
        if (typed.stop_reason === "max_tokens") finishReason = "length";
        else if (typed.stop_reason === "tool_use") finishReason = "tool_calls";
        const resultUsage = typed.usage as
          | { input_tokens?: number; output_tokens?: number }
          | undefined;
        if (resultUsage && !state.usageYielded) {
          state.usageYielded = true;
          const usageEvent: RouterEvent = { type: "usage" };
          if (typeof resultUsage.input_tokens === "number") {
            (usageEvent as { inputTokens?: number }).inputTokens = resultUsage.input_tokens;
          }
          if (typeof resultUsage.output_tokens === "number") {
            (usageEvent as { outputTokens?: number }).outputTokens = resultUsage.output_tokens;
          }
          yield usageEvent;
        }
        yield { type: "completed", finishReason };
        return true;
      }
      if (typed.subtype?.startsWith("error")) {
        const errorMessage = (typed.errors ?? []).join("; ") || "Unknown SDK error";
        yield { type: "error", error: this.mapSdkErrorMessage(errorMessage) };
        return true;
      }
    }
    return false;
  }

  /** Map one SDK stream message to RouterEvents, reusing the shared mapping. */
  private async *drainPlain(
    iterator: AsyncIterator<unknown>,
    signal: AbortSignal,
    abortController: AbortController,
  ): AsyncIterable<RouterEvent> {
    const state = { sawPartialDelta: false, usageYielded: false };
    const iterable: AsyncIterable<unknown> = { [Symbol.asyncIterator]: () => iterator };
    for await (const message of iterable) {
      if (signal.aborted || abortController.signal.aborted) return;
      const terminal = yield* this.processSdkMessage(message, state);
      if (terminal) return;
    }
    if (signal.aborted || abortController.signal.aborted) return;
    throw new RouterError("provider_protocol_error", "SDK stream ended without completion event");
  }

  /**
   * Terminate a live provider run and release every Router-side resource.
   *
   * Order is deliberate and race-free:
   *   1. stop the TTL timer
   *   2. abort the provider run (the SDK owns the MCP child and tears it down)
   *   3. reject/close the pending bridge request
   *   4. broker scope cleanup
   *   5. release the SDK iterator
   *   6. close the control channel
   *   7. session map cleanup
   */
  private async closeSession(session: LiveClaudeSession): Promise<void> {
    if (session.terminated) return;
    session.terminated = true;
    if (session.ttlTimer !== undefined) {
      clearTimeout(session.ttlTimer);
      session.ttlTimer = undefined;
    }
    // Terminate the live SDK query. Never invent an SDK method: the standard
    // AbortController passed as options.abortController is the supported
    // cancellation handle, and the SDK owns the MCP child process.
    try {
      session.abortController.abort();
    } catch {
      // An already-aborted controller needs no further action.
    }
    if (session.parkedRequestId !== undefined) {
      session.control.reject(session.parkedRequestId, "provider run terminated");
      session.parkedRequestId = undefined;
    }
    this.sessionsByRequest.delete(session.requestId);
    if (session.publicToolCallId !== undefined) {
      this.sessions.delete(session.publicToolCallId);
      session.publicToolCallId = undefined;
    }
    this.broker.cancelScope({ provider: "claude", sessionId: session.sessionKey });
    try {
      await session.iterator.return?.();
    } catch {
      // The iterator may already be finished; cleanup continues.
    }
    await session.control.close().catch(() => undefined);
  }

  /**
   * Park a Qoder-owned tool call: surface it to the consumer and keep the SDK
   * query alive so the follow-up resolves the SAME logical session. The Router
   * never executes the tool.
   */
  private async *parkToolCall(
    session: LiveClaudeSession,
    request: BridgeToolRequest,
  ): AsyncIterable<RouterEvent> {
    if (session.gate.parked) {
      // One parked call per session: a second concurrent MCP call is refused
      // rather than silently dropped or left unanswered.
      session.control.reject(request.id, "concurrent tool calls are not supported");
      await this.closeSession(session);
      yield {
        type: "error",
        error: new RouterError(
          "provider_protocol_error",
          "Concurrent Claude MCP tool calls are not supported",
        ),
      };
      return;
    }
    if (this.sessions.size >= this.maxLiveSessions) {
      session.control.reject(request.id, "too many live provider tool sessions");
      await this.closeSession(session);
      yield {
        type: "error",
        error: new RouterError(
          "provider_rate_limited",
          "Live provider tool sessions are at capacity; refusing another parked call",
        ),
      };
      return;
    }
    const publicId = createPublicToolCallId("claude");
    session.gate.parked = true;
    session.parkedRequestId = request.id;
    session.publicToolCallId = publicId;
    try {
      this.broker.createPendingCall<LiveClaudeSession>(
        {
          consumer: "qoder",
          provider: "claude",
          sessionId: session.sessionKey,
          toolCallId: publicId,
          publicToolCallId: publicId,
        },
        this.sessionTtlMs,
        undefined,
        session,
      );
    } catch (error) {
      session.gate.parked = false;
      session.parkedRequestId = undefined;
      session.publicToolCallId = undefined;
      session.control.reject(request.id, "router could not park the tool call");
      await this.closeSession(session);
      yield {
        type: "error",
        error:
          error instanceof RouterError
            ? error
            : new RouterError("provider_protocol_error", "Router could not park the tool call"),
      };
      return;
    }
    this.sessions.set(publicId, session);
    // Bounded lifetime: a continuation that never arrives must not leak the
    // live SDK query, the MCP child, or the control socket.
    const timer = setTimeout(() => {
      void this.closeSession(session);
    }, this.sessionTtlMs);
    if (typeof timer.unref === "function") timer.unref();
    session.ttlTimer = timer;
    yield {
      type: "tool_call_delta",
      index: 0,
      id: publicId,
      name: request.name,
      argumentsDelta: JSON.stringify(request.input ?? {}),
    };
    yield { type: "completed", finishReason: "tool_calls" };
  }

  /**
   * Drive a live tool-capable session: race SDK messages against parked bridge
   * tool calls. On a tool call the session is left alive (the SDK query keeps
   * running) and the current HTTP exchange ends with finishReason "tool_calls".
   */
  private async *drainSession(
    session: LiveClaudeSession,
    signal: AbortSignal,
  ): AsyncIterable<RouterEvent> {
    const state = { sawPartialDelta: session.sawPartialDelta, usageYielded: session.usageYielded };
    // A session that parked a call must survive this drain (the continuation
    // arrives on a later request); every other exit terminates the provider run.
    let parkedHere = false;
    try {
      while (true) {
        if (signal.aborted || session.abortController.signal.aborted) {
          return;
        }
        session.inflight ??= session.iterator.next();
        session.toolCallPromise ??= session.toolCalls.next();
        const outcome = await Promise.race([
          session.inflight.then((r) => ({ kind: "sdk" as const, r })),
          session.toolCallPromise.then((tc) => ({ kind: "tool" as const, tc })),
        ]);
        if (outcome.kind === "tool") {
          session.toolCallPromise = undefined;
          session.sawPartialDelta = state.sawPartialDelta;
          session.usageYielded = state.usageYielded;
          parkedHere = true;
          yield* this.parkToolCall(session, outcome.tc);
          return;
        }
        session.inflight = undefined;
        const { value, done } = outcome.r;
        if (done) {
          if (signal.aborted || session.abortController.signal.aborted) return;
          throw new RouterError(
            "provider_protocol_error",
            "SDK stream ended without completion event",
          );
        }
        const terminal = yield* this.processSdkMessage(value, state);
        session.sawPartialDelta = state.sawPartialDelta;
        session.usageYielded = state.usageYielded;
        if (terminal) return;
      }
    } finally {
      // Guaranteed cleanup even when the consumer stops iterating at the
      // terminal event instead of draining the generator to completion.
      if (!parkedHere) await this.closeSession(session);
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
    // Follow-up carrying Qoder's executed tool result: release the parked
    // external MCP handler and keep draining the SAME SDK query. This is the
    // cross-request continuation; no new session is opened.
    const toolResults = request.messages.filter(
      (message) => message.role === "tool" && typeof message.toolCallId === "string",
    );
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        const publicId = result.toolCallId as string;
        const claim = this.broker.claimByPublicToolCallId<LiveClaudeSession>(publicId);
        if (claim.outcome !== "resolved" || !claim.context) continue;
        const session = claim.context;
        this.sessions.delete(publicId);
        session.publicToolCallId = undefined;
        // Rebind the session to THIS request so a cancellation of the
        // continuation reaches the exact same live provider run.
        this.sessionsByRequest.delete(session.requestId);
        session.requestId = request.requestId;
        this.sessionsByRequest.set(request.requestId, session);
        if (session.parkedRequestId !== undefined) {
          const parkedRequestId = session.parkedRequestId;
          session.parkedRequestId = undefined;
          if (session.control.resolve(parkedRequestId, result.content ?? "")) {
            // The parked round-trip is COMPLETE: Qoder's result has been
            // delivered to the provider-facing MCP handler. Reopen the gate so
            // the SAME logical run may issue its NEXT sequential tools/call. A
            // genuinely PARALLEL call that arrived before this point was
            // already refused, so concurrency safety is unchanged.
            session.gate.parked = false;
            if (session.ttlTimer !== undefined) {
              // The TTL only guards a session whose continuation never arrives;
              // it has arrived, so retire the previous deadline. The next park
              // installs a fresh one, keeping every parked window bounded.
              clearTimeout(session.ttlTimer);
              session.ttlTimer = undefined;
            }
          }
        }
        try {
          yield* this.drainSession(session, signal);
        } catch (error) {
          yield { type: "error", error: this.toRouterError(error) };
        } finally {
          this.sessionsByRequest.delete(request.requestId);
        }
        return;
      }
      yield {
        type: "error",
        error: new RouterError(
          "provider_protocol_error",
          "Claude tool result does not match any pending Qoder tool call",
        ),
      };
      return;
    }

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
            message: {
              role: frame.role,
              content:
                frame.images !== undefined
                  ? ([
                      ...(frame.text ? [{ type: "text" as const, text: frame.text }] : []),
                      ...frame.images,
                    ] as unknown as SDKUserMessage["message"]["content"])
                  : frame.text,
            },
            parent_tool_use_id: null,
          };
        }
      })();

      // External MCP bridge: the provider-facing MCP server is owned by the
      // SDK, which spawns it from `options.mcpServers`. The Router creates only
      // the Router-side control channel it connects back to. The bridge
      // performs transport only and can never reach into this process.
      let control: BridgeControlServer | undefined;
      let toolCalls: BoundedQueue<BridgeToolRequest> | undefined;
      // The gate closes while a call is parked, so a second CONCURRENT
      // tools/call is refused deterministically instead of sitting unanswered
      // in a queue. It reopens when the parked call is delivered, which lets
      // the same logical run issue its NEXT sequential call.
      const gate = { parked: false };
      let sessionRef: LiveClaudeSession | undefined;
      let mcpServers: Options["mcpServers"];
      if (request.tools.length > 0) {
        toolCalls = new BoundedQueue<BridgeToolRequest>(MAX_PENDING_TOOL_CALLS_PER_MCP_SESSION);
        const queue = toolCalls;
        control = await BridgeControlServer.listen({
          onToolCall: (r) => {
            if (gate.parked || !queue.tryPush(r)) {
              control!.reject(r.id, "concurrent tool calls are not supported");
            }
          },
          // A dead MCP bridge while the provider waits must fail the parked
          // session closed immediately rather than at TTL.
          onDisconnect: () => {
            if (sessionRef !== undefined) void this.closeSession(sessionRef);
          },
        });
        const bridgeEnv = {
          PATH: process.env.PATH ?? "",
          CMM_BRIDGE_SOCKET: control.socketPath,
          CMM_BRIDGE_TOKEN: control.token,
          CMM_BRIDGE_SERVER_NAME: "cmm_qoder",
          CMM_BRIDGE_TOOLS: JSON.stringify(bridgeToolDefinitions(request.tools)),
        };
        // Exactly ONE provider-facing MCP config is declared; the SDK owns and
        // spawns that single stdio process. The Router never spawns a second.
        mcpServers = {
          cmm_qoder: {
            type: "stdio",
            command: this.bridgeCommand,
            args: [this.bridgeEntryPath],
            env: bridgeEnv,
            // Tools must be present when the turn-1 prompt is built.
            alwaysLoad: true,
          },
        };
      }

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
        // Reasoning effort, forwarded only when the caller asked for one and
        // only for a level the SDK accepts. An explicit "none" has no SDK
        // equivalent, so the option stays absent and the model default applies.
        ...(request.reasoningEffort !== undefined &&
        request.reasoningEffort !== "none" &&
        CLAUDE_EFFORT_LEVELS.includes(request.reasoningEffort)
          ? { effort: request.reasoningEffort as ClaudeEffortLevel }
          : {}),
        // Qoder-owned tools are the ONLY extra capability: the external MCP
        // bridge exposes exactly the caller's tools and nothing else.
        ...(mcpServers !== undefined ? { mcpServers } : {}),
        ...(request.tools.length > 0
          ? { allowedTools: request.tools.map((tool) => `mcp__cmm_qoder__${tool.function.name}`) }
          : {}),
      };

      // Execute query with SDK (injected seam; production uses the real query).
      const queryResult: Query = this.queryFn({
        prompt,
        options: sdkOptions,
      });
      const iterator = (queryResult as AsyncIterable<unknown>)[Symbol.asyncIterator]();

      // Tool-capable run: hold a live session so a parked external MCP call can
      // be resolved on the follow-up request without opening a new session.
      if (control !== undefined && toolCalls !== undefined) {
        const session: LiveClaudeSession = {
          sessionKey: request.requestId,
          requestId: request.requestId,
          iterator,
          inflight: undefined,
          toolCalls,
          toolCallPromise: undefined,
          control,
          abortController,
          sawPartialDelta: false,
          usageYielded: false,
          parkedRequestId: undefined,
          publicToolCallId: undefined,
          gate,
          ttlTimer: undefined,
          terminated: false,
        };
        sessionRef = session;
        this.sessionsByRequest.set(request.requestId, session);
        yield* this.drainSession(session, signal);
        this.sessionsByRequest.delete(request.requestId);
        return;
      }

      yield* this.drainPlain(iterator, signal, abortController);
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
   * Cancel an active request using the SDK-supported cancellation handle.
   *
   * A request that currently drives a live tool session (parked awaiting Qoder,
   * or resuming after a result) is terminated through the same AbortController,
   * so post-result cancellation reaches the exact provider run. A session that
   * is merely parked with no request bound to it is left to its TTL: the HTTP
   * layer closes the reply socket after the normal tool_calls response, which is
   * not a cancellation.
   */
  async cancel(requestId: string): Promise<void> {
    const session = this.sessionsByRequest.get(requestId);
    if (session !== undefined) {
      await this.closeSession(session);
      return;
    }
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
