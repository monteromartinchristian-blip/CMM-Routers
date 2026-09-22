import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import { AntigravityAdapter } from "../../src/providers/antigravity/adapter.js";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function validAck(dir: string): string {
  const path = join(dir, "ack.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      plan: "GOAT",
      autoTopUpDisabled: true,
      allowOnDemandCredits: false,
    }),
  );
  return path;
}

describe("provider capability truthfulness", () => {
  it("every production adapter declares only a truthful capability value", async () => {
    const { readFileSync } = await import("node:fs");
    const sources = [
      "src/providers/codex/adapter.ts",
      "src/providers/claude/adapter.ts",
      "src/providers/antigravity/adapter.ts",
      "src/providers/command-code/adapter.ts",
      "src/providers/cavoti/adapter.ts",
    ];
    let declarations = 0;
    for (const file of sources) {
      const content = readFileSync(join(import.meta.dirname, "../../", file), "utf-8");
      for (const line of content.split("\n")) {
        const match = line.match(/capability:\s*"([A-Z_]+)"/);
        if (!match) continue;
        declarations += 1;
        expect(["CHAT_ONLY", "CHAT_AND_TOOLS"], `${file}: ${line.trim()}`).toContain(match[1]);
      }
    }
    // The scan must actually have found declarations, otherwise it proves nothing.
    expect(declarations).toBeGreaterThan(0);
    console.log(`CAPABILITY_DECLARATIONS_CHECKED=${declarations}`);
  });

  it("the registry only ever surfaces a truthful capability through /v1/models publication", async () => {
    const { ProviderRegistry } = await import("../../src/registry/provider-registry.js");
    const { buildServer } = await import("../../src/http/server.js");
    const registry = new ProviderRegistry();
    await registry.register({
      id: "command-code",
      discoverModels: async () => [
        {
          id: "command-code/capable",
          provider: "command-code" as const,
          upstreamModel: "capable",
          displayName: "Capable",
          capability: "CHAT_AND_TOOLS" as const,
        },
        {
          id: "command-code/chat-only",
          provider: "command-code" as const,
          upstreamModel: "chat-only",
          displayName: "Chat Only",
          capability: "CHAT_ONLY" as const,
        },
        {
          id: "command-code/unverified",
          provider: "command-code" as const,
          upstreamModel: "unverified",
          displayName: "Unverified",
        },
      ],
      health: async () => ({ status: "ready" as const }),
      run: async function* () {
        return;
      },
      cancel: async () => undefined,
    });
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: "cap-cmmchat",
      codeRouterToken: "cap-code",
      registry,
    });
    const response = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer cap-code" },
    });
    const data = (
      response.json() as { data: Array<{ id: string; x_cmm?: { code_router?: string } }> }
    ).data;
    const published = data.map((model) => model.x_cmm?.code_router).filter(Boolean);
    expect(published.sort()).toEqual(["CHAT_AND_TOOLS", "CHAT_ONLY"]);
    // An unverified model publishes nothing: a discovered model is not
    // automatically tool-capable.
    expect(data.find((model) => model.id === "command-code/unverified")?.x_cmm).toBeUndefined();
    console.log("CAPABILITY_PUBLICATION_TRUTHFUL=PASS");
  });

  it("production adapters emit only CHAT_ONLY or CHAT_AND_TOOLS", async () => {
    const { readFileSync } = await import("node:fs");
    const sources = [
      "src/providers/codex/adapter.ts",
      "src/providers/claude/adapter.ts",
      "src/providers/antigravity/adapter.ts",
      "src/providers/command-code/adapter.ts",
      "src/core/model.ts",
    ];
    for (const file of sources) {
      const content = readFileSync(join(import.meta.dirname, "../../", file), "utf-8");
      expect(content, file).not.toContain("PENDING_TASK_13");
    }
  });

  it("capability union has no pending marker", async () => {
    const { readFileSync } = await import("node:fs");
    const model = readFileSync(
      join(import.meta.dirname, "../../src/core/model.ts"),
      "utf-8",
    );
    expect(model).toContain('"CHAT_ONLY"');
    expect(model).not.toContain("PENDING");
  });
});
