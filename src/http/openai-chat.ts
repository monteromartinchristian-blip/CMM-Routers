import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ProviderRegistry } from "../registry/provider-registry.js";
import type {
  DiscoveredModel,
  ProviderId,
  ReasoningEffort,
  RouterMessage,
  RouterFunctionTool,
} from "../core/model.js";
import { REASONING_EFFORTS } from "../core/model.js";
import type { RouterEvent } from "../core/events.js";
import { RouterError } from "../core/errors.js";
import { isFunctionTool } from "../core/model.js";
import { enforceProviderToolPolicy, parseChatToolChoice } from "../core/tool-policy.js";
import {
  classifyToolDeclarationType,
  representToolDeclaration,
  unsupportedToolKindError,
} from "../core/tool-kind.js";
import type { NormalizedToolChoice } from "../core/tool-policy.js";
import { redactObject } from "../security/secret-redaction.js";
import type { UsageStore } from "../observability/usage-store.js";
import { trackProviderStream } from "./usage-tracking.js";
import { effectiveProfileToolCapability } from "../core/router-profile.js";
import { assertToolResultsWithinBound } from "../core/tool-result-bound.js";
import { validateToolArguments } from "../core/tool-arguments.js";
import type { ConsumerRequest } from "./server.js";

interface ChatMessageInput {
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
}

interface ChatToolInput {
  type?: unknown;
  function?: {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse the [OI]-compatible `reasoning_effort` field. An unknown level is a
 * caller error and must fail with 400 rather than being silently coerced to a
 * different level the caller never asked for.
 */
export function parseReasoningEffort(value: unknown): ReasoningEffort | RouterError | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value)) {
    return value as ReasoningEffort;
  }
  return new RouterError(
    "invalid_request",
    `reasoning_effort must be one of: ${REASONING_EFFORTS.join(", ")}`,
  );
}

function parseMessages(input: unknown): RouterMessage[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const messages: RouterMessage[] = [];
  for (const entry of input) {
    const record = asRecord(entry);
    if (!record) return null;
    // `developer` is the system-level instruction role used by newer OpenAI
    // clients on this surface too; normalize it exactly as the Responses surface
    // does. It carries instructions and no tools.
    const rawRole = record.role;
    const role = rawRole === "developer" ? "system" : rawRole;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      return null;
    }
    let content: string | null = null;
    let images: string[] | undefined;
    if (record.content === null || record.content === undefined) {
      content = null;
    } else if (typeof record.content === "string") {
      content = record.content;
    } else if (Array.isArray(record.content)) {
      // [OI] multimodal user content: text parts plus image_url parts. The
      // image reference is preserved on the internal contract instead of
      // rejecting the whole message for not being a plain string.
      const texts: string[] = [];
      const imageUrls: string[] = [];
      for (const part of record.content) {
        const partRecord = asRecord(part);
        if (!partRecord) return null;
        if (partRecord.type === "text") {
          if (typeof partRecord.text !== "string") return null;
          texts.push(partRecord.text);
          continue;
        }
        if (partRecord.type === "image_url") {
          const imageUrl = asRecord(partRecord.image_url);
          if (!imageUrl || typeof imageUrl.url !== "string") return null;
          imageUrls.push(imageUrl.url);
          continue;
        }
        return null;
      }
      content = texts.join("");
      if (imageUrls.length > 0) images = imageUrls;
    } else {
      return null;
    }
    const message: RouterMessage = { role, content };
    if (images !== undefined) message.images = images;
    if (typeof record.tool_call_id === "string") message.toolCallId = record.tool_call_id;
    if (typeof record.name === "string") message.name = record.name;
    // Preserve assistant tool-call history (OpenAI chat shape) so real tool
    // IDs round-trip into the internal contract instead of being dropped.
    if (record.role === "assistant" && Array.isArray(record.tool_calls)) {
      const toolCalls: RouterMessage["toolCalls"] = [];
      for (const rawCall of record.tool_calls) {
        const call = asRecord(rawCall);
        if (!call || typeof call.id !== "string") continue;
        const fn = asRecord(call.function);
        if (!fn || typeof fn.name !== "string" || typeof fn.arguments !== "string") continue;
        toolCalls.push({
          id: call.id,
          type: "function",
          function: { name: fn.name, arguments: fn.arguments },
        });
      }
      if (toolCalls.length > 0) message.toolCalls = toolCalls;
    }
    messages.push(message);
  }
  return messages;
}

function parseTools(input: unknown): { tools: RouterFunctionTool[] } | { error: RouterError } {
  if (input === undefined) return { tools: [] };
  if (!Array.isArray(input)) {
    return { error: new RouterError("invalid_request", "tools must be an array") };
  }
  const tools: RouterFunctionTool[] = [];
  for (const entry of input) {
    const record = asRecord(entry) as ChatToolInput | null;
    if (!record) {
      return { error: new RouterError("invalid_request", "each entry in tools must be an object") };
    }
    // Capability-class classification: only client-owned functions are
    // representable, and an unsupported class is refused by name rather than
    // silently dropped.
    const kind = classifyToolDeclarationType(record.type);
    if (kind !== "function") {
      return { error: unsupportedToolKindError(kind, record.type) };
    }
    const fn = record.function;
    if (!fn || typeof fn.name !== "string") {
      return { error: new RouterError("invalid_request", "a function tool requires a name") };
    }
    const parameters =
      fn.parameters === undefined
        ? {}
        : asRecord(fn.parameters) !== null
          ? (fn.parameters as Record<string, unknown>)
          : null;
    if (parameters === null) {
      return {
        error: new RouterError("invalid_request", "a function tool's parameters must be an object"),
      };
    }
    const represented = representToolDeclaration("function", {
      type: "function",
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      parameters: parameters,
    });
    if (!isFunctionTool(represented)) {
      return { error: unsupportedToolKindError("function", record.type) };
    }
    tools.push(represented);
  }
  return { tools };
}

/**
 * Detect assistant tool-call history in the RAW request body, before
 * parseMessages discards the tool_calls member. Covers OpenAI chat
 * (message.tool_calls, message.function_call) and Responses-style content
 * parts (function_call / function_call_output items).
 */
export function rawBodyHasAssistantToolHistory(body: Record<string, unknown>): boolean {
  const containers: unknown[] = [];
  if (Array.isArray(body.messages)) containers.push(...body.messages);
  if (Array.isArray(body.input)) containers.push(...body.input);
  for (const entry of containers) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) return true;
    if (record.function_call !== undefined && record.function_call !== null) return true;
    if (typeof record.type === "string") {
      const type = record.type;
      if (
        type === "function_call" ||
        type === "function_call_output" ||
        type === "tool_call" ||
        type === "tool_result" ||
        type === "tool_use"
      ) {
        return true;
      }
    }
    const content = record.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== "object" || part === null) continue;
        const partType = (part as Record<string, unknown>).type;
        if (
          partType === "function_call" ||
          partType === "function_call_output" ||
          partType === "tool_call" ||
          partType === "tool_result" ||
          partType === "tool_use"
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Fail closed when the EFFECTIVE capability (consumer policy AND model
 * capability) is CHAT_ONLY and the request carries tool semantics. Runs
 * BEFORE provider resolution execution: tool definitions, tool_choice /
 * parallel_tool_calls provider equivalents, tool-role continuation messages,
 * or assistant tool-call history are all rejected deterministically with
 * unsupported_capability. Never strips, never forwards, never falls back.
 */
export function rejectChatOnlyTools(
  capability: string | undefined,
  body: Record<string, unknown>,
  messages: Array<{ role: string }>,
): RouterError | null {
  if (capability === "CHAT_AND_TOOLS") return null;
  if (capability !== undefined && capability !== "CHAT_ONLY") return null;
  const tools = body.tools;
  if (tools !== undefined && !(Array.isArray(tools) && tools.length === 0)) {
    return new RouterError(
      "unsupported_capability",
      "Model supports chat only; tools are not supported on this route",
    );
  }
  if (body.tool_choice !== undefined || body.parallel_tool_calls !== undefined) {
    return new RouterError(
      "unsupported_capability",
      "Model supports chat only; tool selection is not supported on this route",
    );
  }
  if (messages.some((m) => m.role === "tool")) {
    return new RouterError(
      "unsupported_capability",
      "Model supports chat only; tool-result continuation is not supported on this route",
    );
  }
  if (rawBodyHasAssistantToolHistory(body)) {
    return new RouterError(
      "unsupported_capability",
      "Model supports chat only; assistant tool-call history is not supported on this route",
    );
  }
  return null;
}

/**
 * One shared provider tool policy for both HTTP surfaces. Each provider either
 * maps the caller's constraint exactly or rejects it explicitly; a constraint
 * is never accepted and then silently dropped.
 *
 * The policy argument is the API-independent normalized form: each surface
 * parses its OWN wire shape first, so this function never sees a raw public
 * tool_choice object.
 */
export function enforceSelectedProviderToolPolicy(
  provider: string,
  policy: NormalizedToolChoice | undefined,
  parallelToolCalls: boolean | undefined,
): RouterError | null {
  return enforceProviderToolPolicy(
    provider as ProviderId,
    policy,
    parallelToolCalls,
  );
}

export function mapRouterErrorToHttp(error: unknown): { status: number; type: string; message: string } {
  if (error instanceof RouterError) {
    switch (error.code) {
      case "invalid_request":
        return { status: 400, type: error.code, message: error.message };
      case "unknown_provider":
        return { status: 400, type: error.code, message: error.message };
      case "unknown_model":
        return { status: 400, type: error.code, message: error.message };
      case "unsupported_capability":
        return { status: 400, type: error.code, message: error.message };
      case "provider_auth_required":
        return { status: 401, type: error.code, message: "Provider authentication required" };
      case "provider_quota_exhausted":
      case "provider_rate_limited":
        return { status: 429, type: error.code, message: error.message };
      case "provider_timeout":
        return { status: 504, type: error.code, message: error.message };
      case "provider_unavailable":
        return { status: 503, type: error.code, message: error.message };
      default:
        return { status: 500, type: error.code, message: "Provider error" };
    }
  }
  return { status: 500, type: "router_internal_error", message: "Internal error" };
}

interface AggregatedCompletion {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: "stop" | "tool_calls" | "length";
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

function aggregateEvents(events: RouterEvent[]): AggregatedCompletion | { error: unknown } {
  let content = "";
  const toolCalls = new Map<string, { id: string; name: string; arguments: string; index: number }>();
  let finishReason: AggregatedCompletion["finishReason"] = "stop";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  for (const event of events) {
    if (event.type === "text_delta") {
      content += event.text;
    } else if (event.type === "tool_call_delta") {
      const existing = toolCalls.get(event.id) ?? {
        id: event.id,
        name: event.name ?? "",
        arguments: "",
        index: event.index,
      };
      if (event.name) existing.name = event.name;
      if (event.argumentsDelta) existing.arguments += event.argumentsDelta;
      existing.index = event.index;
      toolCalls.set(event.id, existing);
    } else if (event.type === "usage") {
      if (event.inputTokens !== undefined) inputTokens = event.inputTokens;
      if (event.outputTokens !== undefined) outputTokens = event.outputTokens;
    } else if (event.type === "completed") {
      finishReason = event.finishReason;
    } else if (event.type === "error") {
      return { error: event.error };
    }
  }

  const ordered = [...toolCalls.values()].sort((a, b) => a.index - b.index);
  return {
    content,
    toolCalls: ordered.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
    finishReason,
    usage:
      inputTokens !== undefined || outputTokens !== undefined
        ? {
            prompt_tokens: inputTokens ?? 0,
            completion_tokens: outputTokens ?? 0,
            total_tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
          }
        : null,
  };
}

function newRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function registerChatCompletions(
  fastify: FastifyInstance,
  registry: ProviderRegistry,
  usageStore?: UsageStore,
): void {
  fastify.post("/v1/chat/completions", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = asRecord(request.body);
    if (!body) {
      return reply.code(400).send({ error: { type: "invalid_request", message: "Body must be an object" } });
    }

    if (typeof body.model !== "string" || body.model.length === 0) {
      return reply
        .code(400)
        .send({ error: { type: "invalid_request", message: "model must be a non-empty string" } });
    }

    const messages = parseMessages(body.messages);
    if (!messages) {
      return reply
        .code(400)
        .send({ error: { type: "invalid_request", message: "messages must be a non-empty array" } });
    }
    try {
      assertToolResultsWithinBound(messages);
    } catch (error) {
      const mapped = mapRouterErrorToHttp(error);
      return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
    }

    const parsedTools = parseTools(body.tools);
    if ("error" in parsedTools) {
      const mapped = mapRouterErrorToHttp(parsedTools.error);
      return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
    }
    const tools = parsedTools.tools;

    if (body.stream !== undefined && typeof body.stream !== "boolean") {
      return reply
        .code(400)
        .send({ error: { type: "invalid_request", message: "stream must be a boolean" } });
    }

    let parallelToolCalls: boolean | undefined;
    if (body.parallel_tool_calls !== undefined) {
      if (typeof body.parallel_tool_calls !== "boolean") {
        return reply
          .code(400)
          .send({ error: { type: "invalid_request", message: "parallel_tool_calls must be a boolean" } });
      }
      parallelToolCalls = body.parallel_tool_calls;
    }
    // Chat Completions has its OWN tool_choice wire shape (nested
    // {type:"function", function:{name}}); normalize it here so the shared
    // provider policy only ever sees the API-independent internal form.
    const parsedToolChoice = parseChatToolChoice(body.tool_choice);
    if (parsedToolChoice instanceof RouterError) {
      const mapped = mapRouterErrorToHttp(parsedToolChoice);
      return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
    }
    const toolChoice = parsedToolChoice;

    const parsedEffort = parseReasoningEffort(body.reasoning_effort);
    if (parsedEffort instanceof RouterError) {
      const mapped = mapRouterErrorToHttp(parsedEffort);
      return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
    }
    const reasoningEffort = parsedEffort;

    let model: DiscoveredModel;
    try {
      model = await registry.resolve(body.model);
    } catch (error) {
      const mapped = mapRouterErrorToHttp(error);
      return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
    }

    const adapter = registry.getAdapter(model.provider);
    if (!adapter) {
      return reply.code(400).send({ error: { type: "unknown_provider", message: "Unknown provider" } });
    }

    // Authorization subject is the authenticated PROFILE, never the client
    // application identifier.
    const identity = (request as ConsumerRequest).identity;
    const effective = effectiveProfileToolCapability(identity.profile, model.capability);
    const capabilityError = rejectChatOnlyTools(effective, body, messages);
    if (capabilityError) {
      const mapped = mapRouterErrorToHttp(capabilityError);
      return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
    }

    // Codex 0.153.4 CAN declare client tools (experimental dynamicTools), but it
    // still cannot represent a caller tool-selection or parallel-execution
    // constraint. Reject those instead of silently dropping them.
    const codexPolicyError = enforceSelectedProviderToolPolicy(
      model.provider,
      toolChoice,
      parallelToolCalls,
    );
    if (codexPolicyError) {
      const mapped = mapRouterErrorToHttp(codexPolicyError);
      return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
    }

    const requestId = newRequestId();
    const routerRequest = {
      requestId,
      model,
      messages,
      tools,
      stream: body.stream === true,
      ...(typeof body.max_tokens === "number" ? { maxOutputTokens: body.max_tokens } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
    };

    const abortController = new AbortController();
    // NORMAL FIRST tool_calls RESPONSE COMPLETION is NOT a cancellation: a
    // parked cross-request tool session must survive the first reply. Only a
    // close that arrives BEFORE the response reached its terminal outcome is a
    // real client cancellation.
    let responseCompleted = false;
    const tearDown = (): void => {
      abortController.abort();
      void adapter.cancel(requestId).catch(() => undefined);
    };
    // request close fires before the handler settles; reply-socket close
    // fires when the client disconnects mid-stream after headers flush.
    // Either must tear down the provider run — but only when the response had
    // not already completed normally.
    request.raw.on("close", () => {
      if (!reply.sent && !responseCompleted) tearDown();
    });
    reply.raw.on("close", () => {
      if (!responseCompleted) tearDown();
    });

    const stream = body.stream === true;

    if (!stream) {
      const events: RouterEvent[] = [];
      try {
        const tracked = trackProviderStream(
          usageStore,
          requestId,
          model.provider,
          model.id,
          adapter.run(routerRequest, abortController.signal),
          abortController.signal,
          identity,
        );
        for await (const event of tracked) {
          events.push(event as RouterEvent);
        }
      } catch (error) {
        const mapped = mapRouterErrorToHttp(error);
        return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
      }
      const aggregated = aggregateEvents(events);
      if ("error" in aggregated) {
        const mapped = mapRouterErrorToHttp(aggregated.error);
        responseCompleted = true;
        return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
      }
      // Fail closed on provider arguments that are not usable JSON: a
      // fabricated `{}` would hand the client an executable call with invented
      // parameters.
      const argumentsError = validateToolArguments(
        aggregated.toolCalls.map((call) => call.arguments),
      );
      if (argumentsError) {
        const mapped = mapRouterErrorToHttp(argumentsError);
        responseCompleted = true;
        return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
      }
      responseCompleted = true;
      return reply.send(
        redactObject({
          id: `chatcmpl-cmm-${requestId}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: model.id,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: aggregated.content,
                ...(aggregated.toolCalls.length > 0
                  ? {
                      tool_calls: aggregated.toolCalls.map((call) => ({
                        id: call.id,
                        type: "function",
                        function: { name: call.name, arguments: call.arguments },
                      })),
                    }
                  : {}),
              },
              finish_reason: aggregated.finishReason,
            },
          ],
          ...(aggregated.usage ? { usage: aggregated.usage } : {}),
        }),
      );
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");

    const chunkId = `chatcmpl-cmm-${requestId}`;
    const created = Math.floor(Date.now() / 1000);
    const sendChunk = (payload: unknown): boolean => {
      if (reply.raw.destroyed) return false;
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    };

    try {
      let contentIndex = 0;
      const streamedCalls = new Map<
        number,
        { index: number; id: string; name: string; args: string }
      >();
      const tracked = trackProviderStream(
        usageStore,
        requestId,
        model.provider,
        model.id,
        adapter.run(routerRequest, abortController.signal),
        abortController.signal,
        identity,
      );
      for await (const event of tracked) {
        const typed = event as RouterEvent;
        if (reply.raw.destroyed) {
          tearDown();
          break;
        }
        if (typed.type === "text_delta") {
          sendChunk({
            id: chunkId,
            object: "chat.completion.chunk",
            created,
            model: model.id,
            choices: [{ index: 0, delta: { role: "assistant", content: typed.text }, finish_reason: null }],
          });
          contentIndex += 1;
        } else if (typed.type === "tool_call_delta") {
          // Buffer instead of forwarding fragments: a tool call is only surfaced
          // once its complete arguments are known to be usable JSON, so a
          // malformed provider payload can never become an executable call.
          const index = typed.index ?? 0;
          const existing = streamedCalls.get(index) ?? {
            index,
            id: typed.id,
            name: typed.name ?? "",
            args: "",
          };
          if (typed.name !== undefined) existing.name = typed.name;
          if (typed.argumentsDelta !== undefined) existing.args += typed.argumentsDelta;
          streamedCalls.set(index, existing);
        } else if (typed.type === "completed") {
          const streamed = [...streamedCalls.values()].sort((a, b) => a.index - b.index);
          const streamedError = validateToolArguments(streamed.map((call) => call.args));
          if (streamedError) {
            const mapped = mapRouterErrorToHttp(streamedError);
            sendChunk({ error: { type: mapped.type, message: mapped.message } });
            responseCompleted = true;
            break;
          }
          for (const call of streamed) {
            sendChunk({
              id: chunkId,
              object: "chat.completion.chunk",
              created,
              model: model.id,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: call.index,
                        id: call.id,
                        type: "function",
                        function: {
                          ...(call.name.length > 0 ? { name: call.name } : {}),
                          ...(call.args.length > 0 ? { arguments: call.args } : {}),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            });
          }
          sendChunk({
            id: chunkId,
            object: "chat.completion.chunk",
            created,
            model: model.id,
            choices: [{ index: 0, delta: {}, finish_reason: typed.finishReason }],
          });
          responseCompleted = true;
          break;
        } else if (typed.type === "error") {
          const mapped = mapRouterErrorToHttp(typed.error);
          sendChunk({ error: { type: mapped.type, message: mapped.message } });
          responseCompleted = true;
          break;
        }
      }
      void contentIndex;
    } catch (error) {
      const mapped = mapRouterErrorToHttp(error);
      if (!reply.raw.destroyed) {
        sendChunk({ error: { type: mapped.type, message: mapped.message } });
      }
    } finally {
      if (!reply.raw.destroyed) {
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      }
    }
    return reply;
  });
}
