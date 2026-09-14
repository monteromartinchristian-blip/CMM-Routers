import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CavotiClient } from "../../src/providers/cavoti/client.js";
import { CavotiAdapter } from "../../src/providers/cavoti/adapter.js";
import { CAVOTI_PINNED_MODEL } from "../../src/providers/cavoti/spend-guard.js";
import { RouterError } from "../../src/core/errors.js";
import { mapRouterErrorToHttp } from "../../src/http/openai-chat.js";
import { usageStatusForRouterErrorCode } from "../../src/http/usage-tracking.js";
import { UsageStore } from "../../src/observability/usage-store.js";
import { PROVIDER_WAVE_MANIFESTS, providerWaveManifest } from "../../src/providers/manifests.js";
import type { RouterEvent } from "../../src/core/events.js";

const REPO = join(import.meta.dirname, "../..");
const TEST_SECRET = "injected-cavoti-secret";

const UNSETTLED_BODY = JSON.stringify({
  error: {
    message: "Account has unsettled usage, settle the outstanding balance before retrying",
    type: "insufficient_quota",
  },
});

function client(fetchFn: typeof fetch): CavotiClient {
  return new CavotiClient({
    baseUrl: "https://cavoti.com/v1",
    secretEnv: "CAVOTI_API_KEY",
    secret: TEST_SECRET,
    fetchFn,
  });
}

function statusFetch(status: number, body: string): typeof fetch {
  return async () => new Response(body, { status, headers: { "content-type": "application/json" } });
}

async function collect(iterable: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const events: RouterEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Cavoti billing/account state", () => {
  it("classifies an unsettled-usage 402 as billing blocked, not as zero balance", async () => {
    const rejected = client(statusFetch(402, UNSETTLED_BODY));

    await expect(rejected.listModels()).rejects.toMatchObject({
      code: "provider_billing_blocked",
    });
    const error = await rejected.listModels().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RouterError);
    expect((error as RouterError).code).not.toBe("provider_quota_exhausted");
    expect((error as RouterError).message.toLowerCase()).toContain("unsettled");
    expect((error as RouterError).meta).toMatchObject({ billingState: "unsettled" });
  });

  it("classifies an unsettled-usage 402 on the generation path the same way", async () => {
    const rejected = client(statusFetch(402, UNSETTLED_BODY));

    const stream = rejected.streamChatCompletion(CAVOTI_PINNED_MODEL, []);
    await expect(stream.next()).rejects.toMatchObject({
      code: "provider_billing_blocked",
    });
  });

  it("keeps a plain exhausted-balance 402 as quota exhaustion", async () => {
    const exhausted = client(statusFetch(402, '{"error":{"message":"Insufficient balance"}}'));

    await expect(exhausted.listModels()).rejects.toMatchObject({
      code: "provider_quota_exhausted",
    });
  });

  it("maps the blocked state to HTTP 402 with a stable type", () => {
    const mapped = mapRouterErrorToHttp(
      new RouterError("provider_billing_blocked", "Cavoti account billing is blocked"),
    );
    expect(mapped).toEqual({
      status: 402,
      type: "provider_billing_blocked",
      message: "Cavoti account billing is blocked",
    });
  });

  it("tracks unsettled billing as its own usage state, separate from quota and rate limits", () => {
    expect(usageStatusForRouterErrorCode("provider_billing_blocked")).toBe("billing_blocked");

    const store = new UsageStore();
    store.beginRequest("cavoti-blocked", "cavoti", `cavoti/${CAVOTI_PINNED_MODEL}`);
    store.endRequest("cavoti-blocked", {
      status: "billing_blocked",
      errorCode: "provider_billing_blocked",
    });
    store.beginRequest("cavoti-quota", "cavoti", `cavoti/${CAVOTI_PINNED_MODEL}`);
    store.endRequest("cavoti-quota", {
      status: "quota_error",
      errorCode: "provider_quota_exhausted",
    });

    const aggregates = store.aggregates();
    expect(aggregates.billingBlockedEvents).toBe(1);
    expect(aggregates.quotaEvents).toBe(1);
    expect(store.listRecent(1)[0]?.status).toBe("quota_error");
  });
});

describe("Cavoti historical recovery", () => {
  it("reuses the existing in-tree implementation instead of a rewritten adapter", () => {
    for (const file of [
      "src/providers/cavoti/adapter.ts",
      "src/providers/cavoti/client.ts",
      "src/providers/cavoti/spend-guard.ts",
      "tests/providers/cavoti-provider.test.ts",
    ]) {
      expect(existsSync(join(REPO, file)), file).toBe(true);
    }
    const adapter = new CavotiAdapter({ client: undefined as never });
    expect(adapter.id).toBe("cavoti");
    expect(CAVOTI_PINNED_MODEL).toBe("deepseek-v4.1-flash");
  });

  it("keeps the pinned-route refusal and the PAYG spend acknowledgement", async () => {
    const adapter = new CavotiAdapter({
      ackPath: join(REPO, "tests", "fixtures", "does-not-exist-ack.json"),
      client: {
        readSecret: () => TEST_SECRET,
        listModels: async () => [{ id: CAVOTI_PINNED_MODEL }],
        streamChatCompletion: async function* () {
          yield { choices: [{ delta: {}, finish_reason: "stop" }] };
        },
      },
    });

    const refused = await collect(
      adapter.run(
        {
          requestId: "cavoti-alias",
          model: {
            id: "cavoti/deepseek-v4.1-flash-0910",
            provider: "cavoti",
            upstreamModel: "deepseek-v4.1-flash-0910",
            displayName: "alias",
            capability: "CHAT_AND_TOOLS",
          },
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          stream: true,
        },
        new AbortController().signal,
      ),
    );
    expect((refused[0] as { error: RouterError }).error.code).toBe("unknown_model");

    // The spend acknowledgement is still required before anything runs.
    const gated = await collect(
      adapter.run(
        {
          requestId: "cavoti-ack",
          model: {
            id: `cavoti/${CAVOTI_PINNED_MODEL}`,
            provider: "cavoti",
            upstreamModel: CAVOTI_PINNED_MODEL,
            displayName: "pinned",
            capability: "CHAT_AND_TOOLS",
          },
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          stream: true,
        },
        new AbortController().signal,
      ),
    );
    expect((gated[0] as { error: RouterError }).error.code).toBe("provider_auth_required");
    expect((gated[0] as { error: RouterError }).error.message).toContain("acknowledgement");
  });

  it("appears exactly once in the wave inventory with its pinned activation", () => {
    const matches = PROVIDER_WAVE_MANIFESTS.filter((manifest) => manifest.id === "cavoti");
    expect(matches).toHaveLength(1);

    const manifest = providerWaveManifest("cavoti");
    expect(manifest.billingClass).toBe("payg");
    expect(manifest.baseUrl).toBe("https://cavoti.com/v1");
    expect(manifest.auth).toEqual({ scheme: "bearer", secretEnv: "CAVOTI_API_KEY" });
    expect(manifest.activation).toEqual({
      mode: "allowlist",
      models: [CAVOTI_PINNED_MODEL],
    });
  });
});
