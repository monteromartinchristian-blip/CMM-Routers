import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ProviderRegistry } from "../registry/provider-registry.js";
import type { DiscoveredModel, RouterMessage, RouterTool } from "../core/model.js";
import type { RouterEvent } from "../core/events.js";
import type { NormalizedToolChoice } from "../core/tool-policy.js";
import { RouterError } from "../core/errors.js";
import { effectiveProfileToolCapability } from "../core/router-profile.js";
import { classifyToolDeclarationType, unsupportedToolKindError } from "../core/tool-kind.js";
import { redactObject } from "../security/secret-redaction.js";
import type { UsageStore } from "../observability/usage-store.js";
import { trackProviderStream } from "./usage-tracking.js";
import {
  enforceSelectedProviderToolPolicy,
  mapRouterErrorToHttp,
  rejectChatOnlyTools,
} from "./openai-chat.js";
import { assertToolResultsWithinBound } from "../core/tool-result-bound.js";
import type { ConsumerRequest } from "./server.js";

/**
 * Anthropic Messages-compatible downstream ingress.
 *
 * This is a PROTOCOL adapter, not a product adapter: it converts the Anthropic
 * Messages wire shape into canonical Router semantics and back. Nothing here
 * knows which client sent the request, and the upstream provider path is
 * completely unchanged.
 *
 * Tool execution ownership is identical to every other surface: the Router
 * relays the provider's structured tool_use, the client executes it, and the
 * client returns a tool_result that continues the same provider turn.
 */

// ---------------------------------------------------------------------------
// Wire types (subset the Router understands)
// ---------------------------------------------------------------------------

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string };

interface AnthropicMessage {
  role?: unknown;
  content?: unknown;
}

interface AnthropicToolDeclaration {
  name?: unknown;
  description?: unknown;
  input_schema?: unknown;
  type?: unknown;
}

export interface AnthropicErrorBody {
  type: "error";
  error: { type: string; message: string };
}

export function anthropicError(type: string, message: string): AnthropicErrorBody {
  return { type: "error", error: { type, message } };
}

/** Map a canonical Router error onto the Anthropic error taxonomy. */
export function anthropicErrorFor(error: unknown): { status: number; body: AnthropicErrorBody } {
  if (error instanceof RouterError) {
    switch (error.code) {
      case "invalid_request":
      case "unknown_provider":
      case "unknown_model":
      case "unsupported_capability":
        return { status: 400, body: anthropicError("invalid_request_error", error.message) };
      case "provider_auth_required":
        return { status: 401, body: anthropicError("authentication_error", "Provider authentication required") };
      case "provider_quota_exhausted":
        return { status: 429, body: anthropicError("rate_limit_error", error.message) };
      case "provider_rate_limited":
        return { status: 429, body: anthropicError("rate_limit_error", error.message) };
      case "provider_timeout":
        return { status: 504, body: anthropicError("api_error", error.message) };
      case "provider_unavailable":
        return { status: 503, body: anthropicError("overloaded_error", error.message) };
      default:
        return { status: 500, body: anthropicError("api_error", "Provider error") };
    }
  }
  const mapped = mapRouterErrorToHttp(error);
  return { status: mapped.status, body: anthropicError("api_error", mapped.message) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) return null;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
      continue;
    }
    return null;
  }
  return parts.join("");
}

/** Flatten a tool_result payload (string or text-block array) to a string. */
function toolResultText(content: unknown): string | null {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) return null;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
      continue;
    }
    return null;
  }
  return parts.join("");
}

export interface ParsedAnthropicRequest {
  messages: RouterMessage[];
  tools: RouterTool[];
  toolChoice?: NormalizedToolChoice;
  parallelToolCalls?: boolean;
}

/**
 * Convert Anthropic messages/tools into canonical Router semantics.
 * Returns a RouterError for anything the Router cannot faithfully represent.
 */
export function parseAnthropicRequest(
  body: Record<string, unknown>,
): ParsedAnthropicRequest | RouterError {
  const messages: RouterMessage[] = [];

  if (body.system !== undefined) {
    const system = textOf(body.system);
    if (system === null) {
      return new RouterError("invalid_request", "system must be a string or an array of text blocks");
    }
    messages.push({ role: "system", content: system });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new RouterError("invalid_request", "messages must be a non-empty array");
  }

  for (const raw of body.messages as AnthropicMessage[]) {
    const record = asRecord(raw);
    if (!record) return new RouterError("invalid_request", "each message must be an object");
    const role = record.role;
    if (role !== "user" && role !== "assistant") {
      return new RouterError("invalid_request", "message role must be 'user' or 'assistant'");
    }

    // Plain string content.
    if (typeof record.content === "string") {
      messages.push({ role, content: record.content });
      continue;
    }
    if (!Array.isArray(record.content)) {
      return new RouterError("invalid_request", "message content must be a string or a block array");
    }

    const texts: string[] = [];
    const toolCalls: RouterMessage["toolCalls"] = [];
    const toolResults: Array<{ id: string; text: string }> = [];

    for (const rawBlock of record.content as AnthropicContentBlock[]) {
      const block = asRecord(rawBlock);
      if (!block) return new RouterError("invalid_request", "each content block must be an object");
      if (block.type === "text") {
        if (typeof block.text !== "string") {
          return new RouterError("invalid_request", "a text block requires a string text");
        }
        texts.push(block.text);
        continue;
      }
      if (block.type === "tool_use") {
        if (typeof block.id !== "string" || typeof block.name !== "string") {
          return new RouterError("invalid_request", "a tool_use block requires an id and a name");
        }
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
        continue;
      }
      if (block.type === "tool_result") {
        if (typeof block.tool_use_id !== "string") {
          return new RouterError("invalid_request", "a tool_result block requires a tool_use_id");
        }
        const text = toolResultText(block.content);
        if (text === null) {
          return new RouterError(
            "invalid_request",
            "tool_result content must be a string or an array of text blocks",
          );
        }
        toolResults.push({ id: block.tool_use_id, text });
        continue;
      }
      return new RouterError(
        "unsupported_capability",
        `The Anthropic-compatible surface cannot faithfully represent a content block of type '${String(
          block.type,
        )}'; refusing to drop it silently`,
      );
    }

    if (texts.length > 0 || toolCalls.length > 0) {
      const message: RouterMessage = { role, content: texts.length > 0 ? texts.join("") : null };
      if (toolCalls.length > 0) message.toolCalls = toolCalls;
      messages.push(message);
    }
    for (const result of toolResults) {
      messages.push({ role: "tool", content: result.text, toolCallId: result.id });
    }
  }

  const tools: RouterTool[] = [];
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      return new RouterError("invalid_request", "tools must be an array");
    }
    for (const rawTool of body.tools as AnthropicToolDeclaration[]) {
      const record = asRecord(rawTool);
      if (!record) return new RouterError("invalid_request", "each tool must be an object");
      if (typeof record.name !== "string") {
        return new RouterError("invalid_request", "a tool requires a name");
      }
      const explicitType = record.type;
      if (explicitType !== undefined) {
        const kind = classifyToolDeclarationType(explicitType);
        if (kind !== "function") return unsupportedToolKindError(kind, explicitType);
      }
      const schema =
        record.input_schema === undefined
          ? {}
          : asRecord(record.input_schema) !== null
            ? (record.input_schema as Record<string, unknown>)
            : null;
      if (schema === null) {
        return new RouterError("invalid_request", "a tool's input_schema must be an object");
      }
      tools.push({
        type: "function",
        function: {
          name: record.name,
          ...(typeof record.description === "string" ? { description: record.description } : {}),
          parameters: schema,
        },
      });
    }
  }

  let toolChoice: NormalizedToolChoice | undefined;
  let parallelToolCalls: boolean | undefined;
  const rawChoice = body.tool_choice;
  if (rawChoice !== undefined) {
    const choice = asRecord(rawChoice);
    if (!choice || typeof choice.type !== "string") {
      return new RouterError(
        "invalid_request",
        "tool_choice must be an object with a type of 'auto', 'any', 'none' or 'tool'",
      );
    }
    switch (choice.type) {
      case "auto":
        toolChoice = { kind: "auto" };
        break;
      case "none":
        toolChoice = { kind: "none" };
        break;
      case "any":
        toolChoice = { kind: "required" };
        break;
      case "tool": {
        if (typeof choice.name !== "string" || choice.name.length === 0) {
          return new RouterError("invalid_request", "tool_choice type 'tool' requires a name");
        }
        toolChoice = { kind: "named", name: choice.name };
        break;
      }
      default:
        return new RouterError(
          "unsupported_capability",
          `The Anthropic-compatible surface cannot represent tool_choice type '${choice.type}'`,
        );
    }
    if (choice.disable_parallel_tool_use === true) parallelToolCalls = false;
    else if (choice.disable_parallel_tool_use === false) parallelToolCalls = true;
    else if (choice.disable_parallel_tool_use !== undefined) {
      return new RouterError(
        "invalid_request",
        "tool_choice.disable_parallel_tool_use must be a boolean",
      );
    }
  }

  const parsed: ParsedAnthropicRequest = { messages, tools };
  if (toolChoice !== undefined) parsed.toolChoice = toolChoice;
  if (parallelToolCalls !== undefined) parsed.parallelToolCalls = parallelToolCalls;
  return parsed;
}

function newMessageId(): string {
  return `msg_cmm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

interface AggregatedAnthropic {
  text: string;
  toolUses: Array<{ id: string; name: string; input: unknown; partialJson: string }>;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  inputTokens: number;
  outputTokens: number;
}

function anthropicStopReason(reason: string): "end_turn" | "tool_use" | "max_tokens" {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

export function registerAnthropicMessages(
  fastify: FastifyInstance,
  registry: ProviderRegistry,
  usageStore?: UsageStore,
): void {
  fastify.post("/v1/messages", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = asRecord(request.body);
    if (!body) {
      return reply.code(400).send(anthropicError("invalid_request_error", "Body must be an object"));
    }
    if (typeof body.model !== "string" || body.model.length === 0) {
      return reply
        .code(400)
        .send(anthropicError("invalid_request_error", "model must be a non-empty string"));
    }
    if (body.stream !== undefined && typeof body.stream !== "boolean") {
      return reply
        .code(400)
        .send(anthropicError("invalid_request_error", "stream must be a boolean"));
    }

    const parsed = parseAnthropicRequest(body);
    if (parsed instanceof RouterError) {
      const mapped = anthropicErrorFor(parsed);
      return reply.code(mapped.status).send(mapped.body);
    }

    try {
      assertToolResultsWithinBound(parsed.messages);
    } catch (error) {
      const mapped = anthropicErrorFor(error);
      return reply.code(mapped.status).send(mapped.body);
    }

    let model: DiscoveredModel;
    try {
      model = await registry.resolve(body.model);
    } catch (error) {
      const mapped = anthropicErrorFor(error);
      return reply.code(mapped.status).send(mapped.body);
    }
    const adapter = registry.getAdapter(model.provider);
    if (!adapter) {
      return reply
        .code(400)
        .send(anthropicError("invalid_request_error", "Unknown provider"));
    }

    const identity = (request as ConsumerRequest).identity;
    const effective = effectiveProfileToolCapability(identity.profile, model.capability);
    const capabilityError = rejectChatOnlyTools(effective, body, parsed.messages);
    if (capabilityError) {
      const mapped = anthropicErrorFor(capabilityError);
      return reply.code(mapped.status).send(mapped.body);
    }

    // The tool-declaration ACL below is the only place a provider-facing payload
    // is derived, and it is the same shared policy the OpenAI surfaces use.
    const providerPolicyError = enforceSelectedProviderToolPolicy(
      model.provider,
      parsed.toolChoice,
      parsed.parallelToolCalls,
    );
    if (providerPolicyError) {
      const mapped = anthropicErrorFor(providerPolicyError);
      return reply.code(mapped.status).send(mapped.body);
    }

    const requestId = newMessageId();
    const routerRequest = {
      requestId,
      model,
      messages: parsed.messages,
      tools: parsed.tools,
      stream: body.stream === true,
      ...(typeof body.max_tokens === "number" ? { maxOutputTokens: body.max_tokens } : {}),
      ...(parsed.toolChoice !== undefined ? { toolChoice: parsed.toolChoice } : {}),
      ...(parsed.parallelToolCalls !== undefined
        ? { parallelToolCalls: parsed.parallelToolCalls }
        : {}),
    };

    const abortController = new AbortController();
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

    const messageId = `msg_${requestId}`;

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
          identity,
        );
        for await (const event of tracked) events.push(event as RouterEvent);
      } catch (error) {
        const mapped = anthropicErrorFor(error);
        return reply.code(mapped.status).send(mapped.body);
      }

      let text = "";
      const pending = new Map<string, { id: string; name: string; args: string; index: number }>();
      let stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";
      let inputTokens = 0;
      let outputTokens = 0;
      for (const event of events) {
        if (event.type === "text_delta") text += event.text;
        else if (event.type === "tool_call_delta") {
          const existing =
            pending.get(event.id) ?? { id: event.id, name: event.name ?? "", args: "", index: event.index };
          if (event.name) existing.name = event.name;
          if (event.argumentsDelta) existing.args += event.argumentsDelta;
          pending.set(event.id, existing);
        } else if (event.type === "usage") {
          if (event.inputTokens !== undefined) inputTokens = event.inputTokens;
          if (event.outputTokens !== undefined) outputTokens = event.outputTokens;
        } else if (event.type === "completed") {
          stopReason = anthropicStopReason(event.finishReason);
        } else if (event.type === "error") {
          const mapped = anthropicErrorFor(event.error);
          return reply.code(mapped.status).send(mapped.body);
        }
      }

      const content: unknown[] = [];
      if (text.length > 0) content.push({ type: "text", text });
      for (const call of [...pending.values()].sort((a, b) => a.index - b.index)) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.args) as unknown;
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: call.id, name: call.name, input });
      }

      responseCompleted = true;
      return reply.send(
        redactObject({
          id: messageId,
          type: "message",
          role: "assistant",
          model: model.id,
          content,
          stop_reason: stopReason,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        }),
      );
    }

    // ---- streaming ----
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    const send = (event: string, data: unknown): boolean => {
      if (reply.raw.destroyed) return false;
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    };

    let inputTokens = 0;
    let outputTokens = 0;
    try {
      send("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: model.id,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      let nextIndex = 0;
      let textIndex: number | undefined;
      const toolBlocks = new Map<
        number,
        { index: number; id: string; name: string; args: string; started: boolean }
      >();
      let stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";

      const tracked = trackProviderStream(
        usageStore,
        requestId,
        model.provider,
        model.id,
        adapter.run(routerRequest, abortController.signal),
        abortController.signal,
        identity,
      );

      const closeToolBlocks = (): void => {
        for (const block of [...toolBlocks.values()].sort((a, b) => a.index - b.index)) {
          if (block.started) {
            send("content_block_stop", { type: "content_block_stop", index: block.index });
          }
        }
      };

      for await (const event of tracked) {
        const typed = event as RouterEvent;
        if (reply.raw.destroyed) {
          tearDown();
          break;
        }
        if (typed.type === "text_delta") {
          if (textIndex === undefined) {
            textIndex = nextIndex++;
            send("content_block_start", {
              type: "content_block_start",
              index: textIndex,
              content_block: { type: "text", text: "" },
            });
          }
          send("content_block_delta", {
            type: "content_block_delta",
            index: textIndex,
            delta: { type: "text_delta", text: typed.text },
          });
        } else if (typed.type === "tool_call_delta") {
          if (textIndex !== undefined) {
            send("content_block_stop", { type: "content_block_stop", index: textIndex });
            textIndex = undefined;
          }
          const index = typed.index ?? 0;
          let block = toolBlocks.get(index);
          if (block === undefined) {
            block = {
              index: nextIndex++,
              id: typed.id,
              name: typed.name ?? "",
              args: "",
              started: false,
            };
            toolBlocks.set(index, block);
            send("content_block_start", {
              type: "content_block_start",
              index: block.index,
              content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            });
            block.started = true;
          }
          const delta = typed.argumentsDelta ?? "";
          if (delta.length > 0) {
            block.args += delta;
            send("content_block_delta", {
              type: "content_block_delta",
              index: block.index,
              delta: { type: "input_json_delta", partial_json: delta },
            });
          }
        } else if (typed.type === "usage") {
          if (typed.inputTokens !== undefined) inputTokens = typed.inputTokens;
          if (typed.outputTokens !== undefined) outputTokens = typed.outputTokens;
        } else if (typed.type === "completed") {
          stopReason = anthropicStopReason(typed.finishReason);
          if (textIndex !== undefined) {
            send("content_block_stop", { type: "content_block_stop", index: textIndex });
            textIndex = undefined;
          }
          closeToolBlocks();
          send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: outputTokens },
          });
          send("message_stop", { type: "message_stop" });
          responseCompleted = true;
          break;
        } else if (typed.type === "error") {
          const mapped = anthropicErrorFor(typed.error);
          send("error", mapped.body);
          responseCompleted = true;
          break;
        }
      }
    } catch (error) {
      const mapped = anthropicErrorFor(error);
      if (!reply.raw.destroyed) send("error", mapped.body);
    } finally {
      if (!reply.raw.destroyed) reply.raw.end();
    }
    return reply;
  });
}
