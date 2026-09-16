import { describe, expect, it } from "vitest";
import {
  supportsExactResolvedRouteExecution,
} from "../../src/catalog/runtime-bridge.js";
import type { ProviderConnection } from "../../src/catalog/types.js";
import type { ProviderAdapter, RouterRequest } from "../../src/core/provider.js";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import {
  AntigravityAdapter,
  type InferenceRunner,
} from "../../src/providers/antigravity/adapter.js";
import {
  CommandCodeAdapter,
  DEFAULT_BASE_URL as COMMAND_CODE_DEFAULT_BASE_URL,
} from "../../src/providers/command-code/adapter.js";
import {
  CavotiAdapter,
  CAVOTI_DEFAULT_BASE_URL,
  CAVOTI_PINNED_MODEL,
} from "../../src/providers/cavoti/adapter.js";

function requestFor(adapter: ProviderAdapter): RouterRequest {
  return {
    requestId: `exact-route-${adapter.id}`,
    model: {
      id: `${adapter.id}/route-model`,
      provider: adapter.id,
      upstreamModel: "route-model",
      displayName: "Route Model",
      capability: "CHAT_ONLY",
    },
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    stream: false,
  };
}

function mismatchedConnection(): ProviderConnection {
  return {
    connectionId: "connection:mismatch",
    providerId: "openrouter",
    accountId: "account:mismatch",
    productId: "product:mismatch",
    connectionKind: "openai-chat-completions",
    status: "configured",
  };
}

function dedicatedAdapters(): ProviderAdapter[] {
  return [
    new CodexAdapter(),
    new ClaudeAdapter(),
    new AntigravityAdapter(),
    new CommandCodeAdapter(),
    new CavotiAdapter(),
  ];
}

async function collectResolved(
  adapter: ProviderAdapter,
  connection: ProviderConnection,
  executionProfile = "default",
  credential = { value: `authorized:${adapter.id}` },
  request = requestFor(adapter),
) {
  expect(supportsExactResolvedRouteExecution(adapter)).toBe(true);
  if (!supportsExactResolvedRouteExecution(adapter)) return [];
  const events = [];
  for await (const event of adapter.runWithResolvedExecution(
    request,
    new AbortController().signal,
    connection,
    executionProfile,
    credential,
  )) {
    events.push(event);
  }
  return events;
}

function expectUnknownRoute(events: Awaited<ReturnType<typeof collectResolved>>) {
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "error",
    error: { code: "unknown_model" },
  });
}

function safeCodex(): CodexAdapter {
  return new CodexAdapter({
    transportFactory: () => {
      throw new Error("Codex native runtime must not be invoked for an invalid resolved route");
    },
  });
}

function safeClaude(): ClaudeAdapter {
  return new ClaudeAdapter({
    queryFn: (() => {
      throw new Error("Claude native runtime must not be invoked for an invalid resolved route");
    }) as never,
  });
}

function safeAntigravity(): AntigravityAdapter {
  const runner: InferenceRunner = {
    async runInference() {
      throw new Error("Antigravity native runtime must not be invoked for an invalid resolved route");
    },
    async streamInference() {
      throw new Error("Antigravity native runtime must not be invoked for an invalid resolved route");
    },
  };
  return new AntigravityAdapter(runner);
}

function connectionFor(adapter: ProviderAdapter): ProviderConnection {
  if (adapter.id === "chatgpt") {
    return {
      connectionId: "connection:chatgpt",
      providerId: "chatgpt",
      accountId: "account:chatgpt",
      productId: "product:chatgpt",
      connectionKind: "codex-app-server",
      status: "configured",
    };
  }
  if (adapter.id === "claude") {
    return {
      connectionId: "connection:claude",
      providerId: "claude",
      accountId: "account:claude",
      productId: "product:claude",
      connectionKind: "claude-code-sdk",
      status: "configured",
    };
  }
  if (adapter.id === "google") {
    return {
      connectionId: "connection:google",
      providerId: "google",
      accountId: "account:google",
      productId: "product:google",
      connectionKind: "antigravity",
      status: "configured",
    };
  }
  if (adapter.id === "command-code") {
    return {
      connectionId: "connection:command-code",
      providerId: "command-code",
      accountId: "account:command-code",
      productId: "product:command-code",
      connectionKind: "openai-chat-completions",
      endpointRef: COMMAND_CODE_DEFAULT_BASE_URL,
      status: "configured",
    };
  }
  return {
    connectionId: "connection:cavoti",
    providerId: "cavoti",
    accountId: "account:cavoti",
    productId: "product:cavoti",
    connectionKind: "openai-chat-completions",
    endpointRef: CAVOTI_DEFAULT_BASE_URL,
    status: "configured",
  };
}

describe("dedicated exact resolved-route execution", () => {
  it("declares the exact-route execution contract on every dedicated production adapter", () => {
    for (const adapter of dedicatedAdapters()) {
      expect(
        supportsExactResolvedRouteExecution(adapter),
        `${adapter.id} exact-route capability`,
      ).toBe(true);
    }
  });

  it("fails closed on a mismatched resolved provider before invoking the native runtime", async () => {
    for (const adapter of dedicatedAdapters()) {
      expect(supportsExactResolvedRouteExecution(adapter)).toBe(true);
      if (!supportsExactResolvedRouteExecution(adapter)) continue;

      const events = [];
      for await (const event of adapter.runWithResolvedExecution(
        requestFor(adapter),
        new AbortController().signal,
        mismatchedConnection(),
        "default",
        { value: `authorized:${adapter.id}` },
      )) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "error",
        error: { code: "unknown_model" },
      });
    }
  });

  it("fails closed field-by-field for dedicated subscription route bindings", async () => {
    for (const adapter of [safeCodex(), safeClaude(), safeAntigravity()]) {
      const valid = connectionFor(adapter);

      expectUnknownRoute(
        await collectResolved(adapter, { ...valid, connectionKind: "openai-chat-completions" }),
      );
      expectUnknownRoute(
        await collectResolved(adapter, { ...valid, profileRef: "/wrong/profile" }),
      );
      expectUnknownRoute(
        await collectResolved(adapter, { ...valid, endpointRef: "https://unsupported.invalid/v1" }),
      );
      expectUnknownRoute(await collectResolved(adapter, valid, "unsupported-profile"));
      expectUnknownRoute(await collectResolved(adapter, valid, "default", { value: "wrong" }));
      expectUnknownRoute(
        await collectResolved(adapter, valid, "default", { value: `authorized:${adapter.id}` }, {
          ...requestFor(adapter),
          model: { ...requestFor(adapter).model, provider: "deepseek" },
        }),
      );
    }
  });

  it("fails closed field-by-field for Command Code resolved routes", async () => {
    const adapter = new CommandCodeAdapter();
    const valid = connectionFor(adapter);

    expectUnknownRoute(
      await collectResolved(adapter, { ...valid, connectionKind: "claude-code-sdk" }),
    );
    expectUnknownRoute(await collectResolved(adapter, { ...valid, profileRef: "unexpected-profile" }));
    expectUnknownRoute(
      await collectResolved(adapter, { ...valid, endpointRef: "https://wrong.example/v1" }),
    );
    expectUnknownRoute(await collectResolved(adapter, valid, "unsupported-profile"));
    expectUnknownRoute(await collectResolved(adapter, valid, "default", { value: "" }));
    expectUnknownRoute(
      await collectResolved(adapter, valid, "default", { value: "route-secret" }, {
        ...requestFor(adapter),
        model: { ...requestFor(adapter).model, provider: "deepseek" },
      }),
    );
  });

  it("fails closed field-by-field for Cavoti resolved routes", async () => {
    const adapter = new CavotiAdapter();
    const valid = connectionFor(adapter);

    expectUnknownRoute(
      await collectResolved(adapter, { ...valid, connectionKind: "claude-code-sdk" }),
    );
    expectUnknownRoute(await collectResolved(adapter, { ...valid, profileRef: "unexpected-profile" }));
    expectUnknownRoute(
      await collectResolved(adapter, { ...valid, endpointRef: "https://wrong.example/v1" }),
    );
    expectUnknownRoute(await collectResolved(adapter, valid, "unsupported-profile"));
    expectUnknownRoute(await collectResolved(adapter, valid, "default", { value: "" }));
    expectUnknownRoute(
      await collectResolved(adapter, valid, "default", { value: "route-secret" }, {
        ...requestFor(adapter),
        model: { ...requestFor(adapter).model, provider: "deepseek" },
      }),
    );
    expectUnknownRoute(
      await collectResolved(adapter, valid, "default", { value: "route-secret" }, {
        ...requestFor(adapter),
        model: { ...requestFor(adapter).model, upstreamModel: `${CAVOTI_PINNED_MODEL}-wrong` },
      }),
    );
  });
});
