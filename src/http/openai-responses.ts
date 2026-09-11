import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ProviderRegistry } from "../registry/provider-registry.js";
import type { DiscoveredModel, RouterMessage, RouterTool } from "../core/model.js";
import type { RouterEvent } from "../core/events.js";
import { redactObject } from "../security/secret-redaction.js";
import { RouterError } from "../core/errors.js";
import { mapRouterErrorToHttp, rejectChatOnlyTools, codexUnsupportedToolPolicy, parseReasoningEffort } from "./openai-chat.js";
import { parseResponsesToolChoice } from "../core/tool-policy.js";
import { effectiveToolCapability } from "../core/consumer-capability.js";
import { assertToolResultsWithinBound } from "../core/tool-result-bound.js";
import type { ConsumerRequest } from "./server.js";
import type { UsageStore } from "../observability/usage-store.js";
import { trackProviderStream } from "./usage-tracking.js";

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
    // Canonical Responses items carry no chat role: function_call becomes
    // assistant tool-call history; function_call_output becomes the tool
    // result message. IDs round-trip byte-exact.
    if (record.type === "function_call") {
      if (typeof record.call_id !== "string" || typeof record.name !== "string" || typeof record.arguments !== "string") {
        return null;
      }
      messages.push({
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: record.call_id,
            type: "function",
            function: { name: record.name, arguments: record.arguments },
          },
        ],
      });
      continue;
    }
    if (record.type === "function_call_output") {
      if (typeof record.call_id !== "string" || typeof record.output !== "string") {
        return null;
      }
      messages.push({ role: "tool", content: record.output, toolCallId: record.call_id });
      continue;
    }
    const role = record.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      return null;
    }
    let content: string | null = null;
    const toolCalls: RouterMessage["toolCalls"] = [];
    const imageUrls: string[] = [];
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
        } else if (partRecord.type === "input_image") {
          // Responses image input: `image_url` carries either an https URL or a
          // base64 data URL; both are preserved verbatim for the adapter.
          if (typeof partRecord.image_url !== "string") return null;
          imageUrls.push(partRecord.image_url);
        } else if (
          partRecord.type === "function_call" &&
          typeof partRecord.call_id === "string" &&
          typeof partRecord.name === "string" &&
          typeof partRecord.arguments === "string"
        ) {
          // Responses function_call content part → assistant tool-call history.
          toolCalls.push({
            id: partRecord.call_id,
            type: "function",
            function: { name: partRecord.name, arguments: partRecord.arguments },
          });
        } else {
          return null;
        }
      }
      content = parts.join("");
    } else {
      return null;
    }
    const message: RouterMessage = { role, content };
    if (imageUrls.length > 0) message.images = imageUrls;
    if (typeof record.tool_call_id === "string") message.toolCallId = record.tool_call_id;
    if (typeof record.name === "string") message.name = record.name;
    if (toolCalls.length > 0) message.toolCalls = toolCalls;
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
  usageStore?: UsageStore,
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
    let parallelToolCalls: boolean | undefined;
    if (body.parallel_tool_calls !== undefined) {
      if (typeof body.parallel_tool_calls !== "boolean") {
        return reply
          .code(400)
          .send({ error: { type: "invalid_request", message: "parallel_tool_calls must be a boolean" } });
      }
      parallelToolCalls = body.parallel_tool_calls;
    }
    // The Responses API has its OWN tool_choice wire shape: a named function
    // choice is FLAT ({type:"function", name}). Normalizing it here keeps the
    // shared provider policy API-independent, so a canonical Responses choice
    // is no longer misread as an invalid request.
    const parsedToolChoice = parseResponsesToolChoice(body.tool_choice);
    if (parsedToolChoice instanceof RouterError) {
      const mapped = mapRouterErrorToHttp(parsedToolChoice);
      return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
    }
    const toolChoice = parsedToolChoice;

    const reasoningRecord = asRecord(body.reasoning);
    if (body.reasoning !== undefined && body.reasoning !== null && !reasoningRecord) {
      return reply
        .code(400)
        .send({ error: { type: "invalid_request", message: "reasoning must be an object" } });
    }
    const parsedEffort = parseReasoningEffort(reasoningRecord?.effort);
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

    const consumerId = (request as ConsumerRequest).consumerId;
    const effective = effectiveToolCapability(consumerId, model.capability);

    // Capability guard runs on the RAW body: assistant function_call history
    // is rejected before inputToMessages would discard its shape.
    const earlyCapabilityError = rejectChatOnlyTools(effective, body, []);
    if (earlyCapabilityError) {
      const mapped = mapRouterErrorToHttp(earlyCapabilityError);
      return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
    }

    const messages = inputToMessages(body.input);
    if (!messages) {
      return reply
        .code(400)
        .send({ error: { type: "invalid_request", message: "input must be a string or message array" } });
    }
    try {
      assertToolResultsWithinBound(messages);
    } catch (error) {
      const mapped = mapRouterErrorToHttp(error);
      return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
    }

    const capabilityError = rejectChatOnlyTools(effective, body, messages);
    if (capabilityError) {
      const mapped = mapRouterErrorToHttp(capabilityError);
      return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
    }

    // Same Codex tool-policy rejection as /v1/chat/completions: an
    // unrepresentable constraint must fail identically on both surfaces.
    const codexPolicyError = codexUnsupportedToolPolicy(
      model.provider,
      toolChoice,
      parallelToolCalls,
    );
    if (codexPolicyError) {
      const mapped = mapRouterErrorToHttp(codexPolicyError);
      return reply.code(mapped.status).send({ error: { type: mapped.type, message: mapped.message } });
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
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
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
    request.raw.on("close", () => {
      if (!reply.sent && !responseCompleted) tearDown();
    });
    reply.raw.on("close", () => {
      if (!responseCompleted) tearDown();
    });

    if (body.stream !== true) {
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
          responseCompleted = true;
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
      responseCompleted = true;
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
              // Responses distinguishes the output item id from the call id used
              // to submit function_call_output. Both are emitted; the item id is
              // the canonical `fc_`-prefixed form and the call id is preserved
              // verbatim so the continuation round-trips exactly.
              id: `fc_${call.id}`,
              call_id: call.id,
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
      let nextOutputIndex = 0;
      let textItemIndex: number | undefined;
      // Canonical function-call item lifecycle, keyed by upstream tool index.
      const pendingCalls = new Map<
        number,
        { itemId: string; callId: string; name: string; args: string; outputIndex: number }
      >();
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
          if (textItemIndex === undefined) textItemIndex = nextOutputIndex++;
          send("response.output_text.delta", { item_id: `msg-${textItemIndex}`, delta: typed.text });
        } else if (typed.type === "tool_call_delta") {
          const index = typed.index ?? 0;
          let call = pendingCalls.get(index);
          if (call === undefined) {
            call = {
              itemId: `fc_${typed.id}`,
              callId: typed.id,
              name: typed.name ?? "",
              args: "",
              outputIndex: nextOutputIndex++,
            };
            pendingCalls.set(index, call);
            send("response.output_item.added", {
              output_index: call.outputIndex,
              item: {
                type: "function_call",
                id: call.itemId,
                call_id: call.callId,
                name: call.name,
                arguments: "",
              },
            });
          }
          const delta = typed.argumentsDelta ?? "";
          if (delta.length > 0) call.args += delta;
          send("response.function_call_arguments.delta", {
            item_id: call.itemId,
            output_index: call.outputIndex,
            delta,
            name: call.name,
          });
        } else if (typed.type === "completed") {
          // Close every open function-call item with its fully assembled
          // arguments before the terminal event.
          const ordered = [...pendingCalls.values()].sort(
            (a, b) => a.outputIndex - b.outputIndex,
          );
          for (const call of ordered) {
            send("response.function_call_arguments.done", {
              item_id: call.itemId,
              output_index: call.outputIndex,
              arguments: call.args,
              name: call.name,
            });
            send("response.output_item.done", {
              output_index: call.outputIndex,
              item: {
                type: "function_call",
                id: call.itemId,
                call_id: call.callId,
                name: call.name,
                arguments: call.args,
                status: "completed",
              },
            });
          }
          send("response.completed", { id: responseId, status: "completed" });
          responseCompleted = true;
          break;
        } else if (typed.type === "error") {
          const mapped = mapRouterErrorToHttp(typed.error);
          send("response.failed", { error: { type: mapped.type, message: mapped.message } });
          responseCompleted = true;
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
