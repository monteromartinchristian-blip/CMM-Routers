import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { RouterError } from "../../src/core/errors.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";

/**
 * CLAUDE_PROVIDER_ERROR_AS_SUCCESS_TEXT = OBSERVED.
 *
 * This is a PIN, not a claim of correct behaviour. It records what the live
 * Claude lane does today so the defect cannot drift silently.
 *
 * Live evidence, control probe on 2026-10-03 against the running Router on
 * :8790 -- a chat completion with NO reasoning effort at all, which cannot be
 * an effort problem:
 *
 *   HTTP 200
 *   content: "API Error: 400 Claude Code 2.1.266 does not support this model;
 *             version 2.1.280 or newer is required. Run 'claude update' ..."
 *
 * The caller sees a successful completion whose entire body is an error
 * string. Anything reading status alone -- a retry policy, a Hub health check,
 * a client that counts successes -- reads a broken lane as a working one.
 *
 * Why it happens, in `src/providers/claude/adapter.ts`
 * `processSdkMessage()`:
 *
 *   - the `assistant` branch forwards EVERY text block verbatim as a
 *     `text_delta`, with no test of what the text is;
 *   - only a `result` message whose `subtype` starts with "error" becomes a
 *     Router `error` event.
 *
 * So when the runtime is too old for the model, Claude Code reports the API
 * rejection inside the assistant turn and then completes with
 * `subtype: "success"`. The Router has an error path, it is just not on the
 * route this failure takes.
 *
 * The intended contract -- NOT implemented here, deliberately, because
 * normalising provider error text is a separate piece of work tracked as
 * CLAUDE_PROVIDER_ERROR_NORMALIZATION = OPEN -- is a non-2xx response. When
 * that lands, the first test below fails on purpose and is rewritten the same
 * way the inbound-effort pin was.
 */

const BEARER = "claude-provider-error-test-secret";

/** The exact text the live lane returned inside a 200 response. */
const OBSERVED_PROVIDER_ERROR_TEXT =
  "API Error: 400 Claude Code 2.1.266 does not support this model; version 2.1.280 or newer is required. Run 'claude update' to update.";

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${BEARER}` };
}

/**
 * Stands in for the Claude adapter's `assistant` branch: whatever text the
 * provider put in the assistant turn is forwarded as the answer.
 */
class TextForwardingProvider implements ProviderAdapter {
  readonly id: "claude" = "claude";
  invocations = 0;

  constructor(private readonly reply: string) {}

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "claude/opus",
        provider: "claude",
        upstreamModel: "opus",
        displayName: "Opus",
        capability: "CHAT_AND_TOOLS",
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.invocations += 1;
    void request;
    yield { type: "text_delta", text: this.reply };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}

/** Stands in for the `result`-with-error branch, which the Router does map. */
class FailingProvider implements ProviderAdapter {
  readonly id: "claude" = "claude";

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "claude/opus",
        provider: "claude",
        upstreamModel: "opus",
        displayName: "Opus",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(_request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    yield {
      type: "error",
      error: new RouterError("provider_protocol_error", "runtime rejected the model"),
    };
  }

  async cancel(): Promise<void> {}
}

async function withServer(
  adapters: ProviderAdapter[],
  exercise: (
    post: (body: unknown) => Promise<{ status: number; json: Record<string, unknown> }>,
  ) => Promise<void>,
): Promise<void> {
  const registry = new ProviderRegistry();
  for (const adapter of adapters) registry.register(adapter);
  const server = buildServer({ host: "127.0.0.1", port: 0, bearerSecret: BEARER, registry });
  await server.ready();
  try {
    await exercise(async (body) => {
      const response = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(),
        payload: body as Record<string, unknown>,
      });
      return { status: response.statusCode, json: response.json() };
    });
  } finally {
    await server.close();
  }
}

function contentOf(json: Record<string, unknown>): string {
  const choices = json.choices as Array<{ message: { content: string } }>;
  return choices[0].message.content;
}

describe("a provider error delivered as assistant text", () => {
  it("OBSERVED DEFECT: comes back as HTTP 200 whose content is the error string", async () => {
    const provider = new TextForwardingProvider(OBSERVED_PROVIDER_ERROR_TEXT);
    await withServer([provider], async (post) => {
      const { status, json } = await post({
        model: "claude/opus",
        messages: [{ role: "user", content: "hi" }],
      });

      // The defect, pinned: a success status carrying an error as the answer.
      expect(status).toBe(200);
      expect(contentOf(json)).toBe(OBSERVED_PROVIDER_ERROR_TEXT);
      expect(provider.invocations).toBe(1);
    });
  });

  it("is indistinguishable, at the status level, from a real answer", async () => {
    // Two different worlds, one status code. Nothing above the Router can tell
    // them apart from the response status alone.
    const real = new TextForwardingProvider("ok");
    const broken = new TextForwardingProvider(OBSERVED_PROVIDER_ERROR_TEXT);

    await withServer([real], async (post) => {
      const good = await post({ model: "claude/opus", messages: [{ role: "user", content: "hi" }] });
      expect(good.status).toBe(200);
      expect(contentOf(good.json)).toBe("ok");
    });
    await withServer([broken], async (post) => {
      const bad = await post({ model: "claude/opus", messages: [{ role: "user", content: "hi" }] });
      expect(bad.status).toBe(200);
      expect(contentOf(bad.json)).toBe(OBSERVED_PROVIDER_ERROR_TEXT);
    });
  });

  it("an error raised as an event DOES fail the request, so only the text route leaks", async () => {
    await withServer([new FailingProvider()], async (post) => {
      const { status, json } = await post({
        model: "claude/opus",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(status).toBeGreaterThanOrEqual(400);
      expect(json).toMatchObject({ error: { type: "provider_protocol_error" } });
      // No choices at all: the caller cannot mistake this for an answer.
      expect(json.choices).toBeUndefined();
    });
  });
});