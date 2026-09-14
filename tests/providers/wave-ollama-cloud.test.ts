import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { providerWaveManifest } from "../../src/providers/manifests.js";
import { isPrivateOrReservedHost } from "../../src/providers/manifest.js";
import { catalogFetch, waveAdapter } from "../helpers/wave-fixtures.js";

const REPO = join(import.meta.dirname, "../..");

const OLLAMA_CLOUD_CATALOG = {
  data: [
    { id: "gpt-oss:120b-cloud", name: "GPT-OSS 120B (cloud)" },
    { id: "deepseek-v3.2:cloud", name: "DeepSeek V3.2 (cloud)" },
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

describe("Ollama Cloud", () => {
  it("is a cloud API provider with its own identity and API-key auth", () => {
    const manifest = providerWaveManifest("ollama-cloud");

    expect(manifest.id).toBe("ollama-cloud");
    expect(manifest.displayName).toBe("Ollama Cloud");
    expect(manifest.auth).toEqual({ scheme: "bearer", secretEnv: "OLLAMA_CLOUD_API_KEY" });
    expect(manifest.baseUrl).toBe("https://ollama.com/v1");
    expect(manifest.discovery).toEqual({ method: "GET", path: "/models" });
    expect(manifest.billingClass).toBe("payg");
    expect(manifest.apiStyles).toEqual(["openai-chat-completions"]);
  });

  it("is distinguishable from a local Ollama runtime at every level", () => {
    const manifest = providerWaveManifest("ollama-cloud");
    expect(manifest.id).not.toBe("ollama");
    expect(manifest.baseUrl).not.toBeNull();
    expect(isPrivateOrReservedHost(new URL(manifest.baseUrl as string).hostname)).toBe(
      false,
    );
    expect(new URL(manifest.baseUrl as string).hostname).toBe("ollama.com");
  });

  it("introduces no localhost/local-runtime assumption for the cloud route", () => {
    // Line-scoped check: a line that mentions Ollama must not also reference a
    // local runtime endpoint or its environment variable. Unrelated loopback
    // literals elsewhere in the same file (e.g. the router's own listen host)
    // are not an Ollama local-runtime assumption.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(REPO, "src"))) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, index) => {
        if (!/ollama/i.test(line)) return;
        if (/localhost|127\.0\.0\.1|11434|OLLAMA_HOST/i.test(line)) {
          offenders.push(`${file}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);

    // Discovery and generation must target the cloud host only.
    const { fetchFn, requests } = catalogFetch(OLLAMA_CLOUD_CATALOG);
    const adapter = waveAdapter("ollama-cloud", { fetchFn });
    return adapter.discoverModels().then((models) => {
      expect(requests[0]!.url).toBe("https://ollama.com/v1/models");
      expect(requests.every((request) => request.url.startsWith("https://ollama.com/"))).toBe(
        true,
      );
      expect(models.map((model) => model.upstreamModel)).toEqual([
        "gpt-oss:120b-cloud",
        "deepseek-v3.2:cloud",
      ]);
    });
  });
});
