import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";

/**
 * F2, end to end through the real route.
 *
 * The unit tests in `inbound-effort-model-ladder.test.ts` prove the validator
 * works in isolation. This proves the thing that actually broke: the request
 * used to reach the provider and come back as a 500. The only way to know the
 * rejection happens BEFORE dispatch is to count provider invocations, so this
 * test asserts the count is zero as well as the status code.
 *
 * Both surfaces are covered because each parses and resolves independently, and
 * a fix applied to only one would leave the other forwarding bad levels.
 */

const BEARER = "effort-ladder-test-secret";

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${BEARER}` };
}

/**
 * Publishes a three-level ladder. This is the exact model from the original
 * reproduction: it advertises `low, medium, high`, so `max` is a caller error.
 */
class ThreeLevelProvider implements ProviderAdapter {
  readonly id: "chatgpt" = "chatgpt";
  invocations = 0;
  /** Every request this provider was actually asked to run. */
  readonly seen: RouterRequest[] = [];

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/three-level",
        provider: "chatgpt",
        upstreamModel: "three-level",
        displayName: "Three Level",
        capability: "CHAT_AND_TOOLS",
        reasoningEfforts: ["low", "medium", "high"],
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.invocations += 1;
    this.seen.push(request);
    yield { type: "text_delta", text: "ok" };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}

/** Publishes a five-level ladder, so the same request is legitimate here. */
class FiveLevelProvider implements ProviderAdapter {
  readonly id: "claude" = "claude";
  invocations = 0;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "claude/five-level",
        provider: "claude",
        upstreamModel: "five-level",
        displayName: "Five Level",
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
    yield { type: "text_delta", text: "ok" };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}

/** Publishes no ladder at all, like the real ChatGPT lane does today. */
class UndeclaredProvider implements ProviderAdapter {
  readonly id: "command-code" = "command-code";
  invocations = 0;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "command-code/undeclared",
        provider: "command-code",
        upstreamModel: "undeclared",
        displayName: "Undeclared",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.invocations += 1;
    void request;
    yield { type: "text_delta", text: "ok" };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}

/**
 * Publishes an EMPTY ladder, the state that says "this model is known to expose
 * no effort control" rather than "nobody said".
 */
class KnownNoneProvider implements ProviderAdapter {
  readonly id = "claude" as const;
  invocations = 0;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "claude/known-none",
        provider: "claude",
        upstreamModel: "known-none",
        displayName: "Known None",
        capability: "CHAT_AND_TOOLS",
        reasoningEfforts: [],
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.invocations += 1;
    void request;
    yield { type: "text_delta", text: "ok" };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}

async function withServer(
  adapters: ProviderAdapter[],
  exercise: (
    post: (path: string, body: unknown) => Promise<{ status: number; json: unknown }>,
  ) => Promise<void>,
): Promise<void> {
  const registry = new ProviderRegistry();
  for (const adapter of adapters) registry.register(adapter);
  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: BEARER,
    registry,
  });
  await server.ready();
  try {
    await exercise(async (path, body) => {
      const response = await server.inject({
        method: "POST",
        url: path,
        headers: authHeader(),
        payload: body as Record<string, unknown>,
      });
      return { status: response.statusCode, json: response.json() };
    });
  } finally {
    await server.close();
  }
}

describe("unsupported effort is refused before provider dispatch", () => {
  it("returns 400 for a level outside the model's ladder, without invoking the provider", async () => {
    const provider = new ThreeLevelProvider();
    await withServer([provider], async (post) => {
      const { status, json } = await post("/v1/chat/completions", {
        model: "chatgpt/three-level",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "max",
      });

      expect(status).toBe(400);
      expect(json).toMatchObject({ error: { type: "invalid_request" } });
      expect(String((json as { error: { message: string } }).error.message)).toContain("max");

      // The behaviour that changed: no provider dispatch at all. A 500 came
      // from the provider faulting on a request it should never have received.
      expect(provider.invocations).toBe(0);
    });
  });

  it("names the model's supported levels in the refusal", async () => {
    const provider = new ThreeLevelProvider();
    await withServer([provider], async (post) => {
      const { status, json } = await post("/v1/chat/completions", {
        model: "chatgpt/three-level",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "xhigh",
      });
      expect(status).toBe(400);
      expect(String((json as { error: { message: string } }).error.message)).toContain(
        "low, medium, high",
      );
      expect(provider.invocations).toBe(0);
    });
  });

  it("still allows a level that model does publish", async () => {
    const provider = new ThreeLevelProvider();
    await withServer([provider], async (post) => {
      const { status } = await post("/v1/chat/completions", {
        model: "chatgpt/three-level",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "high",
      });
      expect(status).toBe(200);
      expect(provider.invocations).toBe(1);
    });
  });

  it("forwards `max` when the selected model publishes it", async () => {
    // The rejection is per concrete model, not a global clamp: the same level
    // that is refused above must be allowed for a five-level model, otherwise
    // the fix would be quietly dropping capability instead of validating it.
    const provider = new FiveLevelProvider();
    await withServer([provider], async (post) => {
      const { status } = await post("/v1/chat/completions", {
        model: "claude/five-level",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "max",
      });
      expect(status).toBe(200);
      expect(provider.invocations).toBe(1);
    });
  });

  it("does not constrain a model that publishes no ladder", async () => {
    // A model with no declared ladder expressed no opinion. Refusing a level
    // here would break every such model outright, so the request proceeds.
    const provider = new UndeclaredProvider();
    await withServer([provider], async (post) => {
      const { status } = await post("/v1/chat/completions", {
        model: "command-code/undeclared",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "max",
      });
      expect(status).toBe(200);
      expect(provider.invocations).toBe(1);
    });
  });

  it("applies the same rule on the responses surface", async () => {
    // Each surface parses and resolves independently, so fixing only chat would
    // leave responses forwarding levels the model does not support.
    const provider = new ThreeLevelProvider();
    await withServer([provider], async (post) => {
      const { status, json } = await post("/v1/responses", {
        model: "chatgpt/three-level",
        input: "hi",
        reasoning: { effort: "max" },
      });
      expect(status).toBe(400);
      expect(json).toMatchObject({ error: { type: "invalid_request" } });
      expect(provider.invocations).toBe(0);
    });
  });
  // ---------------------------------------------------------------------------
  // KNOWN_NONE: an empty ladder is a statement, not an absence of one.
  // ---------------------------------------------------------------------------

  describe("a model that declares an empty ladder", () => {
    for (const effort of ["low", "high", "xhigh", "max"] as const) {
      it(`refuses '${effort}' with 400 and never invokes the provider`, async () => {
        const provider = new KnownNoneProvider();
        await withServer([provider], async (post) => {
          const { status, json } = await post("/v1/chat/completions", {
            model: "claude/known-none",
            messages: [{ role: "user", content: "hi" }],
            reasoning_effort: effort,
          });
          expect(status).toBe(400);
          expect(json).toMatchObject({ error: { type: "invalid_request" } });
          // The whole point: the Router already knew, so nothing was dispatched.
          expect(provider.invocations).toBe(0);
        });
      });
    }

    it("still accepts a request that expresses no preference", async () => {
      const provider = new KnownNoneProvider();
      await withServer([provider], async (post) => {
        const { status } = await post("/v1/chat/completions", {
          model: "claude/known-none",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(status).toBe(200);
        expect(provider.invocations).toBe(1);
      });
    });

    it("applies the same rule on the responses surface", async () => {
      const provider = new KnownNoneProvider();
      await withServer([provider], async (post) => {
        const { status, json } = await post("/v1/responses", {
          model: "claude/known-none",
          input: "hi",
          reasoning: { effort: "max" },
        });
        expect(status).toBe(400);
        expect(json).toMatchObject({ error: { type: "invalid_request" } });
        expect(provider.invocations).toBe(0);
      });
    });

    it("is distinct from a model that declared nothing", async () => {
      // Same effort, same syntax: refused for a model known to have none,
      // forwarded for a model nobody has said anything about. Conflating them
      // is what made an unknown ladder look like a permission slip.
      const knownNone = new KnownNoneProvider();
      const undeclared = new UndeclaredProvider();
      await withServer([knownNone, undeclared], async (post) => {
        const refused = await post("/v1/chat/completions", {
          model: "claude/known-none",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "max",
        });
        const forwarded = await post("/v1/chat/completions", {
          model: "command-code/undeclared",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "max",
        });
        expect(refused.status).toBe(400);
        expect(forwarded.status).toBe(200);
        expect(knownNone.invocations).toBe(0);
        expect(undeclared.invocations).toBe(1);
      });
    });
  });
});
