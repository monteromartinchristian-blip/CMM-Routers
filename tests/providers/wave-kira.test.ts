import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { providerWaveManifest } from "../../src/providers/manifests.js";
import { createProductionRegistry } from "../../src/index.js";
import { loadConfig } from "../../src/config/load-config.js";
import { catalogFetch, testBaseUrl, waveAdapter } from "../helpers/wave-fixtures.js";

const REPO = join(import.meta.dirname, "../..");

/**
 * User-supplied free-model expectations for Kira AI. These are FIXTURES: the
 * provider's own `GET /models` remains authoritative, so the test also proves
 * the router does not carry this list as a catalog.
 */
const KIRA_FREE_MODEL_EXPECTATIONS = [
  "qwen3.8-flash-free",
  "qwen3.8-27b-free",
  "glm-5.3-flash-free",
  "glm-5.3-free",
];

const KIRA_CATALOG = {
  data: [
    ...KIRA_FREE_MODEL_EXPECTATIONS.map((id) => ({ id, name: `${id} (Kira)` })),
    // A model the expectation list does not mention: discovery, not the list,
    // decides what the router exposes.
    { id: "glm-5.3-pro-free", name: "GLM 5.3 Pro (Kira)" },
  ],
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("Kira AI", () => {
  it("registers the canonical Kira endpoint with its own credential namespace", () => {
    const manifest = providerWaveManifest("kira");

    expect(manifest.id).toBe("kira");
    expect(manifest.displayName).toBe("Kira AI");
    expect(manifest.baseUrl).toBe("https://kiraai.vn/api/v1");
    expect(manifest.auth).toEqual({ scheme: "bearer", secretEnv: "KIRA_API_KEY" });
    expect(manifest.discovery).toEqual({ method: "GET", path: "/models" });
    expect(manifest.apiStyles).toEqual(["openai-chat-completions"]);
  });

  it("keeps discovery authoritative and does not carry the free-model list as a catalog", async () => {
    const manifest = providerWaveManifest("kira");
    expect(manifest.activation.mode).toBe("all");
    expect(manifest.activation.models).toEqual([]);

    const adapter = waveAdapter("kira", { catalog: KIRA_CATALOG });
    const discovered = (await adapter.discoverModels()).map((model) => model.upstreamModel);
    expect(discovered).toEqual([...KIRA_FREE_MODEL_EXPECTATIONS, "glm-5.3-pro-free"]);

    // No source file may embed the expectation list: it is provider metadata,
    // not a router-side catalog.
    const offenders = sourceFiles(join(REPO, "src")).filter(
      (file) => !file.startsWith(`${join(REPO, "src", "usage")}${sep}`),
    ).filter((file) => {
      const content = readFileSync(file, "utf-8");
      return KIRA_FREE_MODEL_EXPECTATIONS.some((id) => content.includes(id));
    });
    expect(offenders).toEqual([]);
  });

  it("infers no pricing or free status beyond the provider's own metadata", () => {
    const manifest = providerWaveManifest("kira");

    // Neutral canonical billing kind: the free-model expectations are not
    // pricing evidence, so the router must not claim free/subscription billing.
    expect(manifest.billingClass).toBe("api");
    const manifestKeys = Object.keys(manifest);
    expect(manifestKeys.filter((key) => /price|cost|free|quota/i.test(key))).toEqual([]);
  });

  it("publishes CHAT_ONLY until a tool-calling round-trip is proven for Kira", () => {
    expect(providerWaveManifest("kira").toolCapability).toBe("CHAT_ONLY");
  });

  it("serves Kira from the generic adapter with exact model ids", async () => {
    const adapter = waveAdapter("kira", { catalog: KIRA_CATALOG });

    const models = await adapter.discoverModels();

    expect(models.map((model) => model.id)).toEqual([
      "kira/qwen3.8-flash-free",
      "kira/qwen3.8-27b-free",
      "kira/glm-5.3-flash-free",
      "kira/glm-5.3-free",
      "kira/glm-5.3-pro-free",
    ]);
    expect(models[0]!.upstreamModel).toBe("qwen3.8-flash-free");
    expect(models[0]!.capability).toBe("CHAT_ONLY");
  });
});

describe("Kira AI production composition", () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-kira-"));
    process.env = { ...savedEnv };
    process.env.KIRA_API_KEY = "injected-kira-secret";
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers Kira from config and discovers through the injected transport", async () => {
    writeFileSync(
      join(dir, "shared.json"),
      JSON.stringify({
        mode: "standalone",
        host: "127.0.0.1",
        port: 8790,
        bearerSecretEnv: "CMM_ROUTER_TOKEN",
        providers: {
          chatgpt: { enabled: false },
          claude: { enabled: false },
          google: { enabled: false },
          "command-code": { enabled: false, secretEnv: "COMMAND_CODE_SECRET" },
          kira: { enabled: true },
        },
      }),
    );

    const composition = await createProductionRegistry(loadConfig(dir), {
      fetchFn: catalogFetch(KIRA_CATALOG).fetchFn,
    });

    expect(composition.registeredProviders).toContain("kira");
    expect(testBaseUrl(providerWaveManifest("kira"))).toBe("https://kiraai.vn/api/v1");
    expect(composition.registry.listModels().map((model) => model.id)).toContain(
      "kira/glm-5.3-free",
    );
  });
});
