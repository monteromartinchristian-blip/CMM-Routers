import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ProviderRegistry } from "../registry/provider-registry.js";
import type { DiscoveredModel, RouterMessage, RouterTool } from "../core/model.js";
import type { RouterEvent } from "../core/events.js";
import { redactObject } from "../security/secret-redaction.js";
import { mapRouterErrorToHttp } from "./openai-chat.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inputToMessages(input: unknown): RouterMessage[] | null {
  if (typeof input === "string") {
    if (input.length === 0) return null;
    return [{ role: "user", content: input }];
  }
  if (!Array.isArray(input) || input.length === 0) return null;
  const messages: RouterMessage[] = [];
  for (const entry of input) {
    const record = asRecord(entry);
    if (!record) return null;
    const role = record.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      return null;
    }
    let content: string | null = null;
    if (typeof record.content === "string") {
      content = record.content;
    } else if (Array.isArray(record.content)) {
      const parts: string[] = [];
      for (const part of record.content) {
        const partRecord = asRecord(part);
        if (!partRecord) return null;
        if (partRecord.type === "input_text" || partRecord.type === "output_text") {
          if (typeof partRecord.text !== "string") return null;
          parts.push(partRecord.text);
        } else {
          return null;
        }
      }
      content = parts.join("");
    } else {
      return null;
    }
    const message: RouterMessage = { role, content };
    if (typeof record.tool_call_id === "string") message.toolCallId = record.tool_call_id;
    if (typeof record.name === "string") message.name = record.name;
    messages.push(message);
  }
  return messages;
}

function parseResponseTools(input: unknown): RouterTool[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return null;
  const tools: RouterTool[] = [];
  for (const entry of input) {
    const record = asRecord(entry);
    if (!record) return null;
    // Responses-style: {type:"function", name, description?, parameters?}
    if (record.type === "function" && typeof record.name === "string") {
      const parameters =
        record.parameters === undefined
          ? {}
          : asRecord(record.parameters) !== null
            ? (record.parameters as Record<string, unknown>)
            : null;
      if (parameters === null) return null;
      tools.push({
        type: "function",
        function: {
          name: record.name,
          ...(typeof record.description === "string" ? { description: record.description } : {}),
          parameters,
        },
      });
      continue;
    }
    // Chat-style passthrough
    if (record.type === "function" && asRecord(record.function) !== null) {
      const fn = record.function as Record<string, unknown>;
      if (typeof fn.name !== "string") return null;
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
      continue;
    }
    return null;
  }
  return tools;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function registerResponsesApi(
  fastify: FastifyInstance,
  registry: ProviderRegistry,
): void {
  fastify.post("/v1/responses", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = asRecord(request.body);
    if (!body) {
      return reply.code(400).send({ error: { type: "invalid_request", message: "Body must be an object" } });
    }
    if (typeof body.model !== "string" || body.model.length === 0) {
      return reply
        .code(400)
        .send({ error: { type: "invalid_request", message: "model must be a non-empty string" } });
    }
    const messages = inputToMessages(body.input);
    if (!messages) {
      return reply
        .code(400)
        .send({ error: { type: "invalid_request", message: "input must be a string or message array" } });
    }
    const tools = parseResponseTools(body.tools);
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

    const requestId = newId("req");
    const responseId = newId("resp");
    const routerRequest = {
      requestId,
      model,
      messages,
      tools,
      stream: body.stream === true,
      ...(typeof body.max_output_tokens === "number"
        ? { maxOutputTokens: body.max_output_tokens }
        : {}),
      ...(body.reasoning !== undefined && (body.reasoning as Record<string, unknown>).effort !== undefined
        ? { reasoningEffort: (body.reasoning as Record<string, unknown>).effort as "low" | "medium" | "high" }
        : {}),
    };

    const abortController = new AbortController();
    request.raw.on("close", () => {
      if (!reply.sent) {
        abortController.abort();
        void adapter.cancel(requestId).catch(() => undefined);
      }
    });

    if (body.stream !== true) {
      const events: RouterEvent[] = [];
      try {
        for await (const event of adapter.run(routerRequest, abortController.signal)) {
          events.push(event as RouterEvent);
        }
      } catch (error) {
        const mapped = mapRouterErrorToHttp(error);
        return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
      }
      let content = "";
      const functionCalls: Array<{ id: string; name: string; arguments: string }> = [];
      const pending = new Map<string, { id: string; name: string; arguments: string; index: number }>();
      let status: "completed" | "failed" = "completed";
      let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null = null;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      for (const event of events) {
        if (event.type === "text_delta") content += event.text;
        else if (event.type === "tool_call_delta") {
          const existing = pending.get(event.id) ?? { id: event.id, name: event.name ?? "", arguments: "", index: event.index };
          if (event.name) existing.name = event.name;
          if (event.argumentsDelta) existing.arguments += event.argumentsDelta;
          pending.set(event.id, existing);
        } else if (event.type === "usage") {
          if (event.inputTokens !== undefined) inputTokens = event.inputTokens;
          if (event.outputTokens !== undefined) outputTokens = event.outputTokens;
        } else if (event.type === "error") {
          const mapped = mapRouterErrorToHttp(event.error);
          return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
        }
      }
      functionCalls.push(
        ...[...pending.values()]
          .sort((a, b) => a.index - b.index)
          .map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
      );
      if (inputTokens !== undefined || outputTokens !== undefined) {
        usage = {
          input_tokens: inputTokens ?? 0,
          output_tokens: outputTokens ?? 0,
          total_tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
        };
      }
      return reply.send(
        redactObject({
          id: responseId,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          status,
          output: [
            ...(content
              ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }]
              : []),
            ...functionCalls.map((call) => ({
              type: "function_call",
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            })),
          ],
          ...(usage ? { usage } : {}),
        }),
      );
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    const send = (event: string, data: unknown): boolean => {
      if (reply.raw.destroyed) return false;
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    };

    try {
      send("response.created", { id: responseId, object: "response", model: model.id, status: "in_progress" });
      let itemIndex = 0;
      for await (const event of adapter.run(routerRequest, abortController.signal)) {
        const typed = event as RouterEvent;
        if (reply.raw.destroyed) {
          abortController.abort();
          await adapter.cancel(requestId).catch(() => undefined);
          break;
        }
        if (typed.type === "text_delta") {
          send("response.output_text.delta", { item_id: `msg-${itemIndex}`, delta: typed.text });
        } else if (typed.type === "tool_call_delta") {
          send("response.function_call_arguments.delta", {
            item_id: typed.id,
            delta: typed.argumentsDelta ?? "",
            name: typed.name,
          });
          itemIndex += 1;
        } else if (typed.type === "completed") {
          send("response.completed", { id: responseId, status: "completed" });
          break;
        } else if (typed.type === "error") {
          const mapped = mapRouterErrorToHttp(typed.error);
          send("response.failed", { error: { type: mapped.type, message: mapped.message } });
          break;
        }
      }
    } catch (error) {
      const mapped = mapRouterErrorToHttp(error);
      if (!reply.raw.destroyed) {
        send("response.failed", { error: { type: mapped.type, message: mapped.message } });
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
