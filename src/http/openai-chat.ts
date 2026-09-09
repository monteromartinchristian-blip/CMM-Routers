import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ProviderRegistry } from "../registry/provider-registry.js";
import type {
  DiscoveredModel,
  RouterMessage,
  RouterTool,
} from "../core/model.js";
import type { RouterEvent } from "../core/events.js";
import { RouterError } from "../core/errors.js";
import { redactObject } from "../security/secret-redaction.js";
import type { UsageStore } from "../observability/usage-store.js";
import { trackProviderStream } from "./usage-tracking.js";

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

function parseMessages(input: unknown): RouterMessage[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const messages: RouterMessage[] = [];
  for (const entry of input) {
    const record = asRecord(entry);
    if (!record) return null;
    if (
      record.role !== "system" &&
      record.role !== "user" &&
      record.role !== "assistant" &&
      record.role !== "tool"
    ) {
      return null;
    }
    const content =
      record.content === null || record.content === undefined
        ? null
        : typeof record.content === "string"
          ? record.content
          : null;
    if (content === null && record.content !== null && record.content !== undefined) {
      return null;
    }
    const message: RouterMessage = { role: record.role, content };
    if (typeof record.tool_call_id === "string") message.toolCallId = record.tool_call_id;
    if (typeof record.name === "string") message.name = record.name;
    messages.push(message);
  }
  return messages;
}

function parseTools(input: unknown): RouterTool[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return null;
  const tools: RouterTool[] = [];
  for (const entry of input) {
    const record = asRecord(entry) as ChatToolInput | null;
    if (!record || record.type !== "function") return null;
    const fn = record.function;
    if (!fn || typeof fn.name !== "string") return null;
    const parameters =
      fn.parameters === undefined
        ? {}
        : asRecord(fn.parameters) !== null
          ? (fn.parameters as Record<string, unknown>)
          : null;
    if (parameters === null) return null;
    tools.push({
      type: "function",
      function: {
        name: fn.name,
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        parameters,
      },
    });
  }
  return tools;
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

    const tools = parseTools(body.tools);
    if (tools === null) {
      return reply
        .code(400)
        .send({ error: { type: "invalid_request", message: "tools must be an array" } });
    }

    if (body.stream !== undefined && typeof body.stream !== "boolean") {
      return reply
        .code(400)
        .send({ error: { type: "invalid_request", message: "stream must be a boolean" } });
    }

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

    const requestId = newRequestId();
    const routerRequest = {
      requestId,
      model,
      messages,
      tools,
      stream: body.stream === true,
      ...(typeof body.max_tokens === "number" ? { maxOutputTokens: body.max_tokens } : {}),
    };

    const abortController = new AbortController();
    const tearDown = (): void => {
      abortController.abort();
      void adapter.cancel(requestId).catch(() => undefined);
    };
    request.raw.on("close", () => {
      if (!reply.sent) tearDown();
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
        return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
      }
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
      const tracked = trackProviderStream(
        usageStore,
        requestId,
        model.provider,
        model.id,
        adapter.run(routerRequest, abortController.signal),
        abortController.signal,
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
                      index: typed.index,
                      id: typed.id,
                      type: "function",
                      function: {
                        ...(typed.name !== undefined ? { name: typed.name } : {}),
                        ...(typed.argumentsDelta !== undefined
                          ? { arguments: typed.argumentsDelta }
                          : {}),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        } else if (typed.type === "completed") {
          sendChunk({
            id: chunkId,
            object: "chat.completion.chunk",
            created,
            model: model.id,
            choices: [{ index: 0, delta: {}, finish_reason: typed.finishReason }],
          });
          break;
        } else if (typed.type === "error") {
          const mapped = mapRouterErrorToHttp(typed.error);
          sendChunk({ error: { type: mapped.type, message: mapped.message } });
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
