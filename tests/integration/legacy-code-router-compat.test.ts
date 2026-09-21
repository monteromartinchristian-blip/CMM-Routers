import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { buildServer, resolveConsumerId } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { PROFILE_CODE } from "../../src/core/router-profile.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");
const CMMCHAT = "legacy-compat-cmmchat";
const LEGACY = "legacy-compat-qoder";

class ToolProvider implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/legacy-model",
        provider: "chatgpt",
        upstreamModel: "legacy-model",
        displayName: "Legacy Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }
  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }
  async *run(_request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    yield { type: "text_delta", text: "ok" };
    yield { type: "completed", finishReason: "stop" };
  }
  async cancel(): Promise<void> {}
}

function read(rel: string): string {
  return readFileSync(join(REPO, rel), "utf-8");
}

describe("Phase 1 legacy compatibility lock", () => {
  it("the deprecated qoderToken server option still authenticates the Code profile", async () => {
    const registry = new ProviderRegistry();
    await registry.register(new ToolProvider());
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT,
      qoderToken: LEGACY,
      registry,
    });
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${LEGACY}` },
      payload: {
        model: "chatgpt/legacy-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(200);
    console.log("LEGACY_QODER_OPTION_STILL_WORKS=PASS");
  });

  it("the deprecated resolveConsumerId helper still resolves a profile", () => {
    const request = {
      headers: { authorization: `Bearer ${LEGACY}` },
    } as unknown as FastifyRequest;
    expect(resolveConsumerId(request, { bearerSecret: CMMCHAT, qoderToken: LEGACY })).toBe(PROFILE_CODE);
    const unknown = {
      headers: { authorization: "Bearer nope" },
    } as unknown as FastifyRequest;
    expect(resolveConsumerId(unknown, { bearerSecret: CMMCHAT, qoderToken: LEGACY })).toBeNull();
  });

  it("LEGACY_COMPAT_IDENTIFIERS_PRESERVED: persisted legacy names are untouched", () => {
    expect(read(".env.example")).toContain("CMM_QODER_TOKEN");
    expect(read("scripts/macos/run-router.sh")).toContain("CMM_QODER_TOKEN");
    expect(read("scripts/macos/run-router.sh")).toContain("qoder-bearer");
    expect(read("scripts/macos/install-router.sh")).toContain("qoder-bearer");
    expect(read("launchd/com.cmm.subscription-router.plist.template")).toContain("qoder-bearer");
    expect(read("launchd/com.cmm.subscription-router.plist.template")).toContain(
      "com.cmm.subscription-router",
    );
    expect(read("src/providers/antigravity/mcp-registration.ts")).toContain("cmm-qoder-tools");
    expect(read("src/providers/antigravity/adapter.ts")).toContain("cmm-qoder-tools");
    expect(read("src/bridge/mcp-bridge-launcher.ts")).toContain("cmm_qoder");
    expect(read("src/providers/claude/adapter.ts")).toContain("mcp__cmm_qoder__");
    expect(read("scripts/macos/provision-antigravity-mcp-permission.mjs")).toContain(
      "mcp(cmm-qoder-tools/*)",
    );
    console.log("LEGACY_COMPAT_IDENTIFIERS_PRESERVED=PASS");
  });

  it("no legacy identifier was deleted from the legacy scripts", () => {
    expect(read("scripts/qoder-smoke.sh")).toContain("QODER_SMOKE_OK");
    expect(read("docs/qoder-setup.md")).toContain("qoder-custom-cmm-router");
  });
});
