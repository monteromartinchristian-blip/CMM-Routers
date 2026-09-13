import { describe, expect, it } from "vitest";
import type { RouterEvent } from "../../../src/core/events.js";
import { trackProviderStream } from "../../../src/http/usage-tracking.js";
import {
  RouterTelemetryBridge,
  type RouterTelemetryDiagnostic,
} from "../../../src/usage/service/router-telemetry-bridge.js";
import { SqliteUsageStore } from "../../../src/usage/storage/sqlite-usage-store.js";
import type { UsageStore } from "../../../src/usage/storage/usage-store.js";

const identity = {
  providerId: "provider:chatgpt",
  accountId: "account:chatgpt-plus",
  productId: "product:chatgpt-plus",
  accessRouteId: "route:codex:gpt",
  modelIdentityId: "model:gpt",
};

function bridge(store: UsageStore, diagnostics: RouterTelemetryDiagnostic[] = []): RouterTelemetryBridge {
  return new RouterTelemetryBridge(store, {
    resolveIdentity: async ({ routerProviderId, routerModelId }) => {
      expect(routerProviderId).toBe("chatgpt");
      expect(routerModelId).toBe("chatgpt/gpt-test");
      return identity;
    },
    now: () => new Date("2026-09-13T12:00:00.000Z"),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
}

async function seedIdentity(store: UsageStore): Promise<void> {
  const timestamp = "2026-09-13T11:00:00.000Z";
  await store.upsertProvider({
    id: identity.providerId,
    displayName: "ChatGPT",
    kind: "first_party",
    status: "enabled",
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await store.upsertAccount({
    id: identity.accountId,
    providerId: identity.providerId,
    label: "Plus",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await store.upsertProduct({
    id: identity.productId,
    providerId: identity.providerId,
    displayName: "ChatGPT Plus",
    kind: "subscription",
    metadata: {},
  });
  await store.upsertModelIdentity({
    id: identity.modelIdentityId,
    canonicalName: "GPT",
    vendor: "OpenAI",
    lifecycle: "active",
    aliases: [],
    metadata: {},
  });
  await store.upsertAccessRoute({
    id: identity.accessRouteId,
    accountId: identity.accountId,
    productId: identity.productId,
    modelIdentityId: identity.modelIdentityId,
    providerModelId: "chatgpt/gpt-test",
    displayName: "Codex GPT",
    status: "available",
    metadata: {},
  });
}

describe("RouterTelemetryBridge", () => {
  it("preserves token, cost, provider, model and access-route correlation without persisting content", async () => {
    const store = new SqliteUsageStore(":memory:");
    await store.initialize();
    await seedIdentity(store);
    const telemetry = bridge(store);

    const result = await telemetry.capture({
      requestId: "req-safe-1",
      routerProviderId: "chatgpt",
      routerModelId: "chatgpt/gpt-test",
      status: "success",
      inputTokens: 120,
      outputTokens: 40,
      reasoningTokens: 7,
      cacheReadTokens: 25,
      costUsd: 0.012,
      finishReason: "stop",
    });

    expect(result.status).toBe("recorded");
    const [event] = await store.listUsageEvents();
    expect(event).toMatchObject({
      providerId: identity.providerId,
      accountId: identity.accountId,
      productId: identity.productId,
      accessRouteId: identity.accessRouteId,
      modelIdentityId: identity.modelIdentityId,
      requestCorrelationId: "req-safe-1",
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: 25,
      requests: 1,
      costAmount: 0.012,
      costCurrency: "USD",
      source: "router_measured",
      confidence: "measured",
      metadata: {
        routerProviderId: "chatgpt",
        routerModelId: "chatgpt/gpt-test",
        routerStatus: "success",
        finishReason: "stop",
        reasoningTokens: 7,
      },
    });
    expect(JSON.stringify(event)).not.toMatch(/prompt|response|secret|text_delta/i);

    const [cost] = await store.listCostEvents();
    expect(cost).toMatchObject({
      providerId: identity.providerId,
      accountId: identity.accountId,
      productId: identity.productId,
      accessRouteId: identity.accessRouteId,
      amount: 0.012,
      currency: "USD",
      kind: "usage",
      source: "router_measured",
      confidence: "measured",
    });

    await store.close();
  });

  it("reports persistence failure diagnostically without throwing", async () => {
    const diagnostics: RouterTelemetryDiagnostic[] = [];
    const failingStore = {
      appendUsageEvents: async () => {
        throw new Error("disk unavailable");
      },
      appendCostEvents: async () => undefined,
    } as unknown as UsageStore;

    const result = await bridge(failingStore, diagnostics).capture({
      requestId: "req-failure",
      routerProviderId: "chatgpt",
      routerModelId: "chatgpt/gpt-test",
      status: "success",
      inputTokens: 10,
      outputTokens: 5,
    });

    expect(result.status).toBe("error");
    expect(diagnostics).toEqual([
      {
        kind: "persistence_error",
        requestId: "req-failure",
        message: "disk unavailable",
      },
    ]);
  });

  it("cannot turn a correct provider stream into failure when telemetry observation throws", async () => {
    async function* events(): AsyncGenerator<RouterEvent> {
      yield { type: "text_delta", text: "private answer content" };
      yield {
        type: "usage",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
      };
      yield { type: "completed", finishReason: "stop" };
    }

    const observed: RouterEvent[] = [];
    const tracked = trackProviderStream(
      undefined,
      "req-stream",
      "chatgpt",
      "chatgpt/gpt-test",
      events(),
      undefined,
      {
        observe() {
          throw new Error("telemetry sink exploded");
        },
      },
    );

    for await (const event of tracked) observed.push(event);

    expect(observed).toEqual([
      { type: "text_delta", text: "private answer content" },
      { type: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
      { type: "completed", finishReason: "stop" },
    ]);
  });
});
