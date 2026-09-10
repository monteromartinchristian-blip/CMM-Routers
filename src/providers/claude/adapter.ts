import type { ProviderAdapter, ProviderHealth, RouterRequest } from "../../core/provider.js";
import type { DiscoveredModel, RouterTool } from "../../core/model.js";
import type { RouterEvent } from "../../core/events.js";
import { RouterError } from "../../core/errors.js";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NEUTRAL_CWD, buildIsolatedEnvironment, defaultClaudeConfigDir } from "./sdk-client.js";
import { query, startup, resolveSettings, type Query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { BridgeControlServer, type BridgeToolRequest } from "../../bridge/control-ipc.js";
import { DeferredToolBroker, createPublicToolCallId } from "../../core/deferred-tool-broker.js";

/** Injection seams: production uses the real SDK query and a real spawn. */
type QueryFn = typeof query;
type SpawnFn = typeof spawn;

/** Simple async hand-off queue used to race tool calls against SDK messages. */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.items.push(value);
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}

/**
 * A live Claude SDK query held across the split HTTP interaction while its
 * external MCP handler is parked waiting for Qoder's result. The Router keeps
 * consuming the SAME query on the follow-up request: no new session, no
 * textual history reconstruction.
 */
interface LiveClaudeSession {
  sessionKey: string;
  /** Router request that opened this SDK query (for cancellation scoping). */
  requestId: string;
  iterator: AsyncIterator<unknown>;
  inflight: Promise<IteratorResult<unknown>> | undefined;
  toolCalls: AsyncQueue<BridgeToolRequest>;
  toolCallPromise: Promise<BridgeToolRequest> | undefined;
  control: BridgeControlServer;
  bridge: ChildProcess;
  abortController: AbortController;
  sawPartialDelta: boolean;
  usageYielded: boolean;
  /** Bridge request id currently parked with the Router (one at a time). */
  parkedRequestId: string | undefined;
  /** Public id handed to Qoder for the parked call. */
  publicToolCallId: string | undefined;
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
  /** Live tool-capable sessions, keyed by Router-generated public tool-call id. */
  private readonly sessions = new Map<string, LiveClaudeSession>();
  private readonly profileDir: string | undefined;
  private readonly broker: DeferredToolBroker;
  private readonly queryFn: QueryFn;
  private readonly spawnFn: SpawnFn;
  private readonly bridgeEntryPath: string;
  private readonly bridgeCommand: string;

  constructor(
    options: {
      profileDir?: string | undefined;
      broker?: DeferredToolBroker | undefined;
      queryFn?: QueryFn | undefined;
      spawnFn?: SpawnFn | undefined;
      bridgeEntryPath?: string | undefined;
      bridgeCommand?: string | undefined;
    } = {},
  ) {
    this.profileDir = options.profileDir;
    this.broker = options.broker ?? new DeferredToolBroker();
    this.queryFn = options.queryFn ?? query;
    this.spawnFn = options.spawnFn ?? spawn;
    this.bridgeEntryPath = options.bridgeEntryPath ?? defaultBridgeEntryPath();
    this.bridgeCommand = options.bridgeCommand ?? process.execPath;
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

  /** Release a live session: control channel, bridge process, broker entry. */
  private async closeSession(session: LiveClaudeSession): Promise<void> {
    if (session.publicToolCallId !== undefined) {
      this.sessions.delete(session.publicToolCallId);
      this.broker.cancelScope({ provider: "claude", sessionId: session.sessionKey });
      session.publicToolCallId = undefined;
    }
    try {
      if (!session.bridge.killed) session.bridge.kill();
    } catch {
      // A bridge that already exited needs no further action.
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
    if (session.parkedRequestId !== undefined) {
      // One parked call per session: a second concurrent MCP call is refused
      // rather than silently dropped.
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
    const publicId = createPublicToolCallId("claude");
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
        undefined,
        undefined,
        session,
      );
    } catch (error) {
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
    try {
      while (true) {
        if (signal.aborted || session.abortController.signal.aborted) {
          await this.closeSession(session);
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
          yield* this.parkToolCall(session, outcome.tc);
          return;
        }
        session.inflight = undefined;
        const { value, done } = outcome.r;
        if (done) {
          await this.closeSession(session);
          if (signal.aborted || session.abortController.signal.aborted) return;
          throw new RouterError(
            "provider_protocol_error",
            "SDK stream ended without completion event",
          );
        }
        const terminal = yield* this.processSdkMessage(value, state);
        session.sawPartialDelta = state.sawPartialDelta;
        session.usageYielded = state.usageYielded;
        if (terminal) {
          await this.closeSession(session);
          return;
        }
      }
    } catch (error) {
      await this.closeSession(session);
      throw error;
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
        if (session.parkedRequestId !== undefined) {
          session.control.resolve(session.parkedRequestId, result.content ?? "");
          session.parkedRequestId = undefined;
        }
        try {
          yield* this.drainSession(session, signal);
        } catch (error) {
          yield { type: "error", error: this.toRouterError(error) };
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
            message: { role: frame.role, content: frame.text },
            parent_tool_use_id: null,
          };
        }
      })();

      // External MCP bridge: the provider-facing MCP server runs in its own
      // process and can never call back into this process directly. It parks
      // each tools/call over the Router-facing bridge-control IPC instead.
      let control: BridgeControlServer | undefined;
      let bridge: ChildProcess | undefined;
      let toolCalls: AsyncQueue<BridgeToolRequest> | undefined;
      let mcpServers: Options["mcpServers"];
      if (request.tools.length > 0) {
        toolCalls = new AsyncQueue<BridgeToolRequest>();
        const queue = toolCalls;
        control = await BridgeControlServer.listen({ onToolCall: (r) => queue.push(r) });
        const bridgeEnv = {
          PATH: process.env.PATH ?? "",
          CMM_BRIDGE_SOCKET: control.socketPath,
          CMM_BRIDGE_TOKEN: control.token,
          CMM_BRIDGE_SERVER_NAME: "cmm_qoder",
          CMM_BRIDGE_TOOLS: JSON.stringify(bridgeToolDefinitions(request.tools)),
        };
        bridge = this.spawnFn(this.bridgeCommand, [this.bridgeEntryPath], {
          stdio: ["pipe", "pipe", "inherit"],
          env: { ...process.env, ...bridgeEnv },
        });
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
      if (control !== undefined && bridge !== undefined && toolCalls !== undefined) {
        const session: LiveClaudeSession = {
          sessionKey: request.requestId,
          requestId: request.requestId,
          iterator,
          inflight: undefined,
          toolCalls,
          toolCallPromise: undefined,
          control,
          bridge,
          abortController,
          sawPartialDelta: false,
          usageYielded: false,
          parkedRequestId: undefined,
          publicToolCallId: undefined,
        };
        yield* this.drainSession(session, signal);
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
   * Cancel an active request using AbortController.
   */
  async cancel(requestId: string): Promise<void> {
    // Release any live tool session opened by this request: the parked bridge
    // handler, its control socket, and its bridge process are all torn down.
    for (const [publicId, session] of [...this.sessions]) {
      if (session.requestId === requestId) {
        this.sessions.delete(publicId);
        session.publicToolCallId = undefined;
        await this.closeSession(session);
      }
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
