import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { providerWaveManifest } from "../../src/providers/manifests.js";
import { catalogFetch, routerRequest, sseFetch, waveAdapter } from "../helpers/wave-fixtures.js";
import type { RouterEvent } from "../../src/core/events.js";

const REPO = join(import.meta.dirname, "../..");

/** Catalog fixture: NVIDIA NIM exposes many models; the wave may not activate them all. */
const NVIDIA_CATALOG = {
  data: [
    { id: "vendor-a/model-alpha-instruct", name: "Model Alpha" },
    { id: "vendor-k/moonshot-family-large", name: "Moonshot Family Large" },
    { id: "vendor-b/model-beta-reasoning", name: "Model Beta" },
  ],
};

/** Stand-in for the exact provider model id an operator confirms administratively. */
const CONFIRMED_ID = "vendor-k/moonshot-family-large";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

async function collect(iterable: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const events: RouterEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("NVIDIA NIM with the initial activation scope", () => {
  it("registers the documented NVIDIA endpoint with its own credential namespace", () => {
    const manifest = providerWaveManifest("nvidia-nim");

    expect(manifest.id).toBe("nvidia-nim");
    expect(manifest.displayName).toBe("NVIDIA NIM");
    expect(manifest.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(manifest.auth).toEqual({ scheme: "bearer", secretEnv: "NVIDIA_NIM_API_KEY" });
    expect(manifest.discovery).toEqual({ method: "GET", path: "/models" });
    expect(manifest.billingClass).toBe("api");
    expect(manifest.apiStyles).toEqual(["openai-chat-completions"]);
  });

  it("does not invent the exact provider model id and stays non-activated until confirmation", async () => {
    const manifest = providerWaveManifest("nvidia-nim");

    expect(manifest.activation.mode).toBe("none");
    expect(manifest.activation.models).toEqual([]);

    // Non-activated means no routable route AND no upstream request at all.
    const { fetchFn, requests } = catalogFetch(NVIDIA_CATALOG);
    const adapter = waveAdapter("nvidia-nim", { fetchFn });
    expect(await adapter.discoverModels()).toEqual([]);
    expect(requests).toHaveLength(0);

    const health = await adapter.health();
    expect(health.status).toBe("degraded");
    expect(health.detail).toContain("not activated");
  });

  it("carries no vendor model id for the initial scope in the router sources", () => {
    const suspicious = [/kimi[-_ ]?k3/i, /moonshotai/i, /nvidia\/[a-z0-9]/i];
    const offenders = sourceFiles(join(REPO, "src")).filter((file) => {
      const content = readFileSync(file, "utf-8");
      return suspicious.some((pattern) => pattern.test(content));
    });
    expect(offenders).toEqual([]);
  });

  it("exposes the discovered catalog but refuses every non-allowlisted route without a request", async () => {
    const allowlisted = waveAdapter("nvidia-nim", {
      catalog: NVIDIA_CATALOG,
      activation: { mode: "allowlist", models: [CONFIRMED_ID] },
    });

    const discovered = await allowlisted.discoverModels();
    expect(discovered.map((model) => model.upstreamModel)).toEqual(
      NVIDIA_CATALOG.data.map((entry) => entry.id),
    );

    const streaming = sseFetch([
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const streamingAdapter = waveAdapter("nvidia-nim", {
      fetchFn: streaming.fetchFn,
      activation: { mode: "allowlist", models: [CONFIRMED_ID] },
    });

    const denied = routerRequest("nvidia-nim", "vendor-a/model-alpha-instruct");
    const deniedEvents = await collect(streamingAdapter.run(denied.request, denied.signal));
    expect(streaming.requests).toHaveLength(0);
    expect(deniedEvents.some((event) => event.type === "completed")).toBe(false);
    expect((deniedEvents[0] as { error: { code: string } }).error.code).toBe("unknown_model");

    const allowed = routerRequest("nvidia-nim", CONFIRMED_ID);
    const allowedEvents = await collect(streamingAdapter.run(allowed.request, allowed.signal));
    expect(allowedEvents.at(-1)).toEqual({ type: "completed", finishReason: "stop" });
    expect(streaming.requests).toHaveLength(1);
    expect(streaming.requests[0]!.body?.model).toBe(CONFIRMED_ID);
  });

  it("keeps the registry catalog empty while the manifest scope is still unconfirmed", async () => {
    const registry = new ProviderRegistry();
    await registry.register(
      waveAdapter("nvidia-nim", { catalog: NVIDIA_CATALOG }),
    );

    await expect(registry.resolve(`nvidia-nim/${CONFIRMED_ID}`)).rejects.toMatchObject({
      code: "unknown_model",
    });
    expect(registry.listModels()).toEqual([]);
  });
});
