import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { providerWaveManifest } from "../../src/providers/manifests.js";
import { isActivatedModel } from "../../src/providers/manifest.js";
import { catalogFetch, routerRequest, sseFetch, waveAdapter } from "../helpers/wave-fixtures.js";
import type { RouterEvent } from "../../src/core/events.js";

const REPO = join(import.meta.dirname, "../..");

/** Hosted NVIDIA API base URL (exact). */
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

/** The one provider model id this wave activates, exactly as NVIDIA spells it. */
const KIMI_K3_ID = "moonshotai/kimi-k3";

/**
 * Catalog fixture: NVIDIA NIM exposes many models. The unrelated entries (one
 * of them a lookalike vendor-`k` moonshot name) must stay non-routable purely
 * because discovery returned them.
 */
const NVIDIA_CATALOG = {
  data: [
    { id: "vendor-a/model-alpha-instruct", name: "Model Alpha" },
    { id: "vendor-k/moonshot-family-large", name: "Moonshot Family Large" },
    { id: "vendor-b/model-beta-reasoning", name: "Model Beta" },
    { id: "meta/llama-3.1-405b-instruct", name: "Llama 3.1 405B" },
    { id: KIMI_K3_ID, name: "Kimi K3" },
  ],
};

const UNRELATED_IDS = NVIDIA_CATALOG.data
  .map((entry) => entry.id)
  .filter((id) => id !== KIMI_K3_ID);

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
    expect(manifest.baseUrl).toBe(NVIDIA_BASE_URL);
    expect(manifest.auth).toEqual({ scheme: "bearer", secretEnv: "NVIDIA_NIM_API_KEY" });
    expect(manifest.discovery).toEqual({ method: "GET", path: "/models" });
    expect(manifest.billingClass).toBe("api");
    expect(manifest.apiStyles).toEqual(["openai-chat-completions"]);
  });

  it("activates exactly the confirmed Kimi K3 provider model id", () => {
    const manifest = providerWaveManifest("nvidia-nim");

    expect(manifest.activation.mode).toBe("allowlist");
    expect(manifest.activation.models).toEqual([KIMI_K3_ID]);
    expect(manifest.activation.models).toHaveLength(1);

    expect(isActivatedModel(manifest, KIMI_K3_ID)).toBe(true);
    for (const unrelated of UNRELATED_IDS) {
      expect(isActivatedModel(manifest, unrelated), unrelated).toBe(false);
    }
    // Exact ids only: no case-folding, aliasing or prefix matching.
    expect(isActivatedModel(manifest, "moonshotai/KIMI-K3")).toBe(false);
    expect(isActivatedModel(manifest, "moonshotai/kimi-k3-preview")).toBe(false);
  });

  it("declares exactly one vendor model id and no others in the router sources", () => {
    const declared = providerWaveManifest("nvidia-nim").activation.models;
    expect(declared).toEqual([KIMI_K3_ID]);

    const otherVendors = ["meta", "nvidia", "mistralai", "qwen", "microsoft", "deepseek-ai"];
    for (const file of sourceFiles(join(REPO, "src"))) {
      const content = readFileSync(file, "utf-8");
      // Every moonshot-namespaced id literal in production source must be the
      // single activated id.
      for (const match of content.match(/moonshotai\/[A-Za-z0-9._:-]+/g) ?? []) {
        expect(match, `${file} declares an unexpected provider model id`).toBe(KIMI_K3_ID);
      }
      for (const vendor of otherVendors) {
        expect(content, `${file} must not hardcode another vendor's model id`).not.toMatch(
          new RegExp(`(?<![a-z0-9-])${vendor}\\/[a-z0-9]`),
        );
      }
    }
  });

  it("refuses every non-allowlisted route without an upstream request", async () => {
    const streaming = sseFetch([
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const adapter = waveAdapter("nvidia-nim", { fetchFn: streaming.fetchFn });

    for (const unrelated of UNRELATED_IDS) {
      const denied = routerRequest("nvidia-nim", unrelated);
      const deniedEvents = await collect(adapter.run(denied.request, denied.signal));
      expect(deniedEvents.some((event) => event.type === "completed"), unrelated).toBe(false);
      expect(
        (deniedEvents[0] as { error: { code: string } }).error.code,
        unrelated,
      ).toBe("unknown_model");
    }
    // Activation is exact and fail-closed: every non-allowlisted id is refused
    // before any upstream request, so none of them can spend.
    expect(streaming.requests).toHaveLength(0);

    const allowed = routerRequest("nvidia-nim", KIMI_K3_ID);
    const allowedEvents = await collect(adapter.run(allowed.request, allowed.signal));
    expect(allowedEvents.at(-1)).toEqual({ type: "completed", finishReason: "stop" });
    expect(streaming.requests).toHaveLength(1);
    expect(streaming.requests[0]!.url).toBe(`${NVIDIA_BASE_URL}/chat/completions`);
    expect(streaming.requests[0]!.body?.model).toBe(KIMI_K3_ID);
  });

  it("lets discovery return the whole catalog while activating only Kimi K3", async () => {
    const { fetchFn, requests } = catalogFetch(NVIDIA_CATALOG);
    const adapter = waveAdapter("nvidia-nim", { fetchFn });

    const discovered = await adapter.discoverModels();

    // Visibility: administrative discovery is not filtered by activation.
    expect(discovered.map((model) => model.upstreamModel)).toEqual(
      NVIDIA_CATALOG.data.map((entry) => entry.id),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${NVIDIA_BASE_URL}/models`);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.body).toBeNull();

    // Activation: exactly one of the discovered routes is routable.
    const routable = discovered.filter((model) =>
      isActivatedModel(providerWaveManifest("nvidia-nim"), model.upstreamModel),
    );
    expect(routable.map((model) => model.upstreamModel)).toEqual([KIMI_K3_ID]);
  });

  it("keeps unrelated discovered routes non-routable through the registry", async () => {
    const registry = new ProviderRegistry();
    const discovery = catalogFetch(NVIDIA_CATALOG);
    const adapter = waveAdapter("nvidia-nim", { fetchFn: discovery.fetchFn });
    await registry.register(adapter);
    await registry.refresh();

    // The catalog is visible for every discovered id...
    for (const id of NVIDIA_CATALOG.data.map((entry) => entry.id)) {
      await expect(registry.resolve(`nvidia-nim/${id}`), id).resolves.toMatchObject({
        upstreamModel: id,
      });
    }

    // ...but resolving a route is not activation: a non-allowlisted id is
    // refused, and the only request ever made is the administrative discovery.
    const unrelated = await registry.resolve("nvidia-nim/meta/llama-3.1-405b-instruct");
    const denied = routerRequest("nvidia-nim", unrelated.upstreamModel);
    const deniedEvents = await collect(adapter.run(denied.request, denied.signal));
    expect((deniedEvents[0] as { error: { code: string } }).error.code).toBe("unknown_model");
    expect(discovery.requests).toHaveLength(1);
    expect(discovery.requests[0]!.url).toBe(`${NVIDIA_BASE_URL}/models`);

    // The activated id resolves to its exact provider model id; its routed
    // round-trip is proven against a streaming fixture in the test above.
    const allowed = await registry.resolve(`nvidia-nim/${KIMI_K3_ID}`);
    expect(allowed.upstreamModel).toBe(KIMI_K3_ID);
  });
});
