import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedConfigSchema } from "../../src/config/schema.js";
import { createProductionRegistry, createProductionServer } from "../../src/index.js";
import type { DiscoveredModel, RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import { AntigravityAdapter } from "../../src/providers/antigravity/adapter.js";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient, type FetchFn } from "../../src/providers/command-code/client.js";
import { CavotiAdapter } from "../../src/providers/cavoti/adapter.js";
import { CavotiClient, CAVOTI_PINNED_MODEL } from "../../src/providers/cavoti/client.js";

type DedicatedId = "chatgpt" | "claude" | "google";

function discovered(provider: DedicatedId, upstreamModel: string): DiscoveredModel {
  return {
    id: `${provider}/${upstreamModel}`,
    provider,
    upstreamModel,
    displayName: `${provider} route test`,
    capability: "CHAT_ONLY",
  };
}

class DeterministicCodexAdapter extends CodexAdapter {
  async discoverModels(): Promise<DiscoveredModel[]> {
    return [discovered("chatgpt", "codex-route-test")];
  }

  async *run(request: RouterRequest): AsyncIterable<RouterEvent> {
    yield { type: "text_delta", text: `chatgpt:${request.model.upstreamModel}` };
    yield { type: "completed", finishReason: "stop" };
  }
}

class DeterministicClaudeAdapter extends ClaudeAdapter {
  async discoverModels(): Promise<DiscoveredModel[]> {
    return [discovered("claude", "claude-route-test")];
  }

  async *run(request: RouterRequest): AsyncIterable<RouterEvent> {
    yield { type: "text_delta", text: `claude:${request.model.upstreamModel}` };
    yield { type: "completed", finishReason: "stop" };
  }
}

class DeterministicAntigravityAdapter extends AntigravityAdapter {
  async discoverModels(): Promise<DiscoveredModel[]> {
    return [discovered("google", "google-route-test")];
  }

  async *run(request: RouterRequest): AsyncIterable<RouterEvent> {
    yield { type: "text_delta", text: `google:${request.model.upstreamModel}` };
    yield { type: "completed", finishReason: "stop" };
  }
}

describe("production-composed dedicated route execution", () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-dedicated-route-"));
    process.env = { ...savedEnv };
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
      delete process.env[key];
    }
    process.env.COMMAND_CODE_SECRET = "route-command-code-secret";
    process.env.CAVOTI_API_KEY = "route-cavoti-secret";
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it("executes exact routeId bindings through all five dedicated adapters", async () => {
    const commandAck = join(dir, "command-code-ack.json");
    writeFileSync(
      commandAck,
      JSON.stringify({
        version: 1,
        plan: "GOAT",
        autoTopUpDisabled: true,
        allowOnDemandCredits: false,
      }),
    );
    const cavotiAck = join(dir, "cavoti-ack.json");
    writeFileSync(
      cavotiAck,
      JSON.stringify({
        version: 1,
        provider: "cavoti",
        billing: "PAYG",
        model: CAVOTI_PINNED_MODEL,
        automaticFallback: false,
      }),
    );

    const commandRequests: Array<{ url: string; authorization: string | undefined }> = [];
    const commandFetch: FetchFn = async (url, init) => {
      commandRequests.push({ url, authorization: init.headers.Authorization });
      if (init.method === "GET") {
        return {
          status: 200,
          text: async () => JSON.stringify({ data: [{ id: "command-route-test" }] }),
        };
      }
      return {
        status: 200,
        text: async () =>
          `data: ${JSON.stringify({
            choices: [
              {
                delta: { content: "command-code:command-route-test" },
                finish_reason: "stop",
              },
            ],
          })}\n\n`,
      };
    };
    const commandClient = new CommandCodeClient({
      baseUrl: "https://api.commandcode.ai/provider/v1",
      secret: "discovery-command-code-secret",
      fetchFn: commandFetch,
    });
    const commandAdapter = new CommandCodeAdapter({ ackPath: commandAck, client: commandClient });

    const cavotiRequests: Array<{ url: string; authorization: string | undefined }> = [];
    const cavotiClient = new CavotiClient({
      baseUrl: "https://cavoti.com/v1",
      secret: "discovery-cavoti-secret",
      fetchFn: async (input, init) => {
        const url = String(input);
        const headers = init?.headers as Record<string, string> | undefined;
        cavotiRequests.push({ url, authorization: headers?.authorization });
        if (url.endsWith("/models")) {
          return new Response(JSON.stringify({ data: [{ id: CAVOTI_PINNED_MODEL }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: { content: `cavoti:${CAVOTI_PINNED_MODEL}` },
                finish_reason: "stop",
              },
            ],
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const cavotiAdapter = new CavotiAdapter({ ackPath: cavotiAck, client: cavotiClient });

    const config = {
      ...sharedConfigSchema.parse({
        mode: "standalone",
        host: "127.0.0.1",
        providers: {
          chatgpt: { enabled: true },
          claude: { enabled: true },
          google: { enabled: true },
          "command-code": {
            enabled: true,
            baseUrl: "https://api.commandcode.ai/provider/v1",
            secretEnv: "COMMAND_CODE_SECRET",
          },
          cavoti: { enabled: true },
        },
      }),
      machineId: "dedicated-route-production-test",
    };

    const composition = await createProductionRegistry(config, {
      commandCodeAckPath: commandAck,
      cavotiAckPath: cavotiAck,
      dedicatedAdapterOverrides: {
        chatgpt: new DeterministicCodexAdapter(),
        claude: new DeterministicClaudeAdapter(),
        google: new DeterministicAntigravityAdapter(),
        "command-code": commandAdapter,
        cavoti: cavotiAdapter,
      },
    });
    const server = createProductionServer(composition, "admin-route-secret", "qoder-route-secret");

    try {
      const expected = new Map<string, string>([
        ["chatgpt", "chatgpt:codex-route-test"],
        ["claude", "claude:claude-route-test"],
        ["google", "google:google-route-test"],
        ["command-code", "command-code:command-route-test"],
        ["cavoti", `cavoti:${CAVOTI_PINNED_MODEL}`],
      ]);

      for (const [providerId, expectedText] of expected) {
        const route = composition.routeCatalog
          .list()
          .find((candidate) => candidate.providerId === providerId);
        expect(route, `${providerId} route`).toBeDefined();
        expect(route?.routable, `${providerId} routable`).toBe(true);
        expect(route?.visibility.visibleOn).toContain("cmmchat_model_picker");

        const response = await server.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: "Bearer admin-route-secret" },
          payload: {
            model: `route:${route!.routeId}`,
            messages: [{ role: "user", content: "route binding canary" }],
          },
        });
        expect(response.statusCode, providerId).toBe(200);
        expect(JSON.stringify(response.json()), providerId).toContain(expectedText);
      }
    } finally {
      await server.close();
    }

    expect(
      commandRequests.some(
        (request) =>
          request.url.endsWith("/chat/completions") &&
          request.authorization === "Bearer route-command-code-secret",
      ),
    ).toBe(true);
    expect(
      cavotiRequests.some(
        (request) =>
          request.url.endsWith("/chat/completions") &&
          request.authorization === "Bearer route-cavoti-secret",
      ),
    ).toBe(true);
  });
});
