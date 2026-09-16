import { describe, expect, it } from "vitest";
import {
  OpenAiCompatibleAdapter,
  OpenAiCompatibleClient,
  type ProviderFetchFn,
  type ProviderHttpResponse,
} from "../../src/providers/openai-compatible/adapter.js";
import { defineProviderManifest, type ProviderManifest } from "../../src/providers/manifest.js";
import { RouterError } from "../../src/core/errors.js";

const TEST_SECRET = "injected-test-secret";

function manifest(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return defineProviderManifest({
    id: "openrouter",
    displayName: "OpenRouter",
    billingClass: "payg",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { scheme: "bearer", secretEnv: "OPENROUTER_API_KEY" },
    discovery: { method: "GET", path: "/models" },
    apiStyles: ["openai-chat-completions"],
    toolCapability: "CHAT_AND_TOOLS",
    activation: { mode: "all", models: [] },
    ...overrides,
  });
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  hasBody: boolean;
}

function recordingFetch(
  respond: () => ProviderHttpResponse,
): { fetchFn: ProviderFetchFn; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn: ProviderFetchFn = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: init.headers,
      hasBody: init.body !== undefined,
    });
    return respond();
  };
  return { fetchFn, requests };
}

function jsonResponse(status: number, payload: unknown): ProviderHttpResponse {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return { status, text: async () => text };
}

function adapterWith(
  fetchFn: ProviderFetchFn,
  options: {
    manifest?: ProviderManifest;
    discoveryPath?: string;
    timeoutMs?: number;
    secret?: string | undefined;
  } = {},
) {
  const effectiveManifest = options.manifest ?? manifest();
  return new OpenAiCompatibleAdapter({
    manifest: effectiveManifest,
    discoveryPath: options.discoveryPath,
    client: new OpenAiCompatibleClient({
      baseUrl: effectiveManifest.baseUrl as string,
      secretEnv: effectiveManifest.auth.secretEnv,
      ...(options.secret !== undefined
        ? { secret: options.secret }
        : { secret: TEST_SECRET }),
      providerLabel: effectiveManifest.displayName,
      fetchFn,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }),
  });
}

describe("administrative model discovery", () => {
  it("reads GET /models once and never touches a generation endpoint", async () => {
    const { fetchFn, requests } = recordingFetch(() =>
      jsonResponse(200, { data: [{ id: "vendor/model-a", name: "Model A" }] }),
    );
    const adapter = adapterWith(fetchFn);

    await adapter.discoverModels();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe("https://openrouter.ai/api/v1/models");
    expect(requests[0]!.hasBody).toBe(false);
    for (const request of requests) {
      expect(request.url).not.toContain("/chat/completions");
      expect(request.url).not.toContain("/messages");
      expect(request.url).not.toContain("/responses");
    }
    console.log("ADMIN_MODEL_DISCOVERY_GET_ONLY=PASS");
    console.log("ADMIN_MODEL_DISCOVERY_NO_INFERENCE=PASS");
  });

  it("preserves exact provider model ids and exposes the manifest capability", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(200, {
        data: [
          { id: "anthropic/claude-sonnet-4.5:1", name: "Claude Sonnet 4.5" },
          { id: "google/gemini-2.5-pro", display_name: "Gemini 2.5 Pro" },
          { id: "plain-id" },
        ],
      }),
    );
    const adapter = adapterWith(fetchFn);

    const models = await adapter.discoverModels();

    expect(models.map((model) => model.upstreamModel)).toEqual([
      "anthropic/claude-sonnet-4.5:1",
      "google/gemini-2.5-pro",
      "plain-id",
    ]);
    expect(models.map((model) => model.id)).toEqual([
      "openrouter/anthropic/claude-sonnet-4.5:1",
      "openrouter/google/gemini-2.5-pro",
      "openrouter/plain-id",
    ]);
    expect(models.map((model) => model.displayName)).toEqual([
      "Claude Sonnet 4.5",
      "Gemini 2.5 Pro",
      "plain-id",
    ]);
    expect(models.every((model) => model.provider === "openrouter")).toBe(true);
    expect(models.every((model) => model.capability === "CHAT_AND_TOOLS")).toBe(true);
  });

  it("publishes CHAT_ONLY for a manifest that does not claim tool calling", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(200, { data: [{ id: "vendor/model-a" }] }),
    );
    const adapter = adapterWith(fetchFn, {
      manifest: manifest({ toolCapability: "CHAT_ONLY" }),
    });

    const models = await adapter.discoverModels();

    expect(models[0]!.capability).toBe("CHAT_ONLY");
  });

  it("de-duplicates repeated ids by first occurrence", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(200, {
        data: [
          { id: "vendor/model-a", name: "First" },
          { id: "vendor/model-b" },
          { id: "vendor/model-a", name: "Duplicate" },
        ],
      }),
    );
    const adapter = adapterWith(fetchFn);

    const models = await adapter.discoverModels();

    expect(models.map((model) => model.upstreamModel)).toEqual([
      "vendor/model-a",
      "vendor/model-b",
    ]);
    expect(models[0]!.displayName).toBe("First");
  });

  it("skips entries that carry no usable id and rejects a malformed payload", async () => {
    const skipped = adapterWith(
      recordingFetch(() =>
        jsonResponse(200, {
          data: [null, 42, "nope", {}, { id: "" }, { id: "vendor/ok" }],
        }),
      ).fetchFn,
    );
    expect((await skipped.discoverModels()).map((model) => model.upstreamModel)).toEqual([
      "vendor/ok",
    ]);

    for (const payload of [
      "not json at all",
      { models: [] },
      [],
      { data: {} },
    ]) {
      const adapter = adapterWith(recordingFetch(() => jsonResponse(200, payload)).fetchFn);
      await expect(adapter.discoverModels()).rejects.toMatchObject({
        code: "provider_protocol_error",
      });
    }
  });

  it("honors a configured administrative path override", async () => {
    const { fetchFn, requests } = recordingFetch(() =>
      jsonResponse(200, { data: [{ id: "vendor/model-a" }] }),
    );
    const adapter = adapterWith(fetchFn, { discoveryPath: "/v1/models" });

    await adapter.discoverModels();

    expect(requests[0]!.url).toBe("https://openrouter.ai/api/v1/v1/models");
  });

  it("makes no request at all when no route is activated", async () => {
    const { fetchFn, requests } = recordingFetch(() =>
      jsonResponse(200, { data: [{ id: "vendor/model-a" }] }),
    );
    const adapter = adapterWith(fetchFn, {
      manifest: manifest({ activation: { mode: "none", models: [] } }),
    });

    expect(await adapter.discoverModels()).toEqual([]);
    expect(requests).toHaveLength(0);
    const health = await adapter.health();
    expect(health.status).toBe("degraded");
    expect(health.detail).toContain("not activated");
  });

  it("reports missing credentials and transport failures without a catalog", async () => {
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const unauthenticated = adapterWith(
        recordingFetch(() => jsonResponse(200, { data: [] })).fetchFn,
        { secret: "" },
      );
      await expect(unauthenticated.discoverModels()).rejects.toBeInstanceOf(RouterError);
      await expect(unauthenticated.discoverModels()).rejects.toMatchObject({
        code: "provider_auth_required",
      });

      const rejected = adapterWith(
        recordingFetch(() => jsonResponse(401, "invalid api key")).fetchFn,
      );
      await expect(rejected.discoverModels()).rejects.toMatchObject({
        code: "provider_auth_required",
      });

      const unreachable = adapterWith(() =>
        Promise.reject(new Error("getaddrinfo ENOTFOUND")),
      );
      await expect(unreachable.discoverModels()).rejects.toMatchObject({
        code: "provider_unavailable",
      });

      const stalled = adapterWith(() => new Promise<ProviderHttpResponse>(() => undefined), {
        timeoutMs: 20,
      });
      await expect(stalled.discoverModels()).rejects.toMatchObject({
        code: "provider_timeout",
      });
    } finally {
      if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
    }
  });
});
