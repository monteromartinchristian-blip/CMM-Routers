import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { sharedConfigSchema } from "../../src/config/schema.js";
import { createProductionRegistry, createProductionServer } from "../../src/index.js";
import type {
  InferenceRunner,
  ParsedStreamEvent,
} from "../../src/providers/antigravity/adapter.js";
import { CommandCodeClient, type FetchFn } from "../../src/providers/command-code/client.js";
import { CavotiClient, CAVOTI_PINNED_MODEL } from "../../src/providers/cavoti/client.js";

function deterministicCodexTransport(onDiscovery: () => void): Duplex {
  const transport = new Duplex({
    read: () => {},
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const message = JSON.parse(chunk.toString()) as { id?: unknown; method?: string };
      const push = (value: object) => transport.push(`${JSON.stringify(value)}\n`);
      if (message.method === "initialize") {
        push({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if (message.method === "model/list") {
        onDiscovery();
        push({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            data: [
              {
                id: "codex-route-test",
                model: "codex-route-test",
                displayName: "Codex Route Test",
              },
            ],
          },
        });
      } else if (message.method === "thread/start") {
        push({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-route" } } });
      } else if (message.method === "thread/inject_items") {
        push({ jsonrpc: "2.0", id: message.id, result: {} });
      } else if (message.method === "turn/start") {
        push({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            turn: { id: "turn-route", status: "inProgress", items: [] },
          },
        });
        queueMicrotask(() => {
          push({
            jsonrpc: "2.0",
            method: "item/agentMessage/delta",
            params: {
              delta: "chatgpt:codex-route-test",
              itemId: "item-route",
              threadId: "thread-route",
              turnId: "turn-route",
            },
          });
          push({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: {
              threadId: "thread-route",
              turn: { id: "turn-route", status: "completed", items: [] },
            },
          });
        });
      }
      callback();
    },
  });
  return transport;
}

function deterministicClaudeQuery() {
  async function* stream() {
    yield {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "claude:claude-route-test" },
      },
    };
    yield {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  return {
    supportedModels: async () => [
      { value: "claude-route-test", displayName: "Claude Route Test" },
    ],
    interrupt: async () => {},
    [Symbol.asyncIterator]: () => stream(),
  };
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
    const discoveries = new Map<string, number>();
    const recordDiscovery = (providerId: string) => {
      discoveries.set(providerId, (discoveries.get(providerId) ?? 0) + 1);
    };
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
    process.env.CMM_COMMAND_CODE_ACK_PATH = commandAck;
    process.env.CMM_CAVOTI_ACK_PATH = cavotiAck;

    const commandRequests: Array<{ url: string; authorization: string | undefined }> = [];
    const commandFetch: FetchFn = async (url, init) => {
      commandRequests.push({ url, authorization: init.headers.Authorization });
      if (init.method === "GET") {
        recordDiscovery("command-code");
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
    const cavotiRequests: Array<{ url: string; authorization: string | undefined }> = [];
    const cavotiClient = new CavotiClient({
      baseUrl: "https://cavoti.com/v1",
      secret: "discovery-cavoti-secret",
      fetchFn: async (input, init) => {
        const url = String(input);
        const headers = init?.headers as Record<string, string> | undefined;
        cavotiRequests.push({ url, authorization: headers?.authorization });
        if (url.endsWith("/models")) {
          recordDiscovery("cavoti");
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
    const codexTransport = deterministicCodexTransport(() => recordDiscovery("chatgpt"));
    const googleInferenceRunner: InferenceRunner = {
      async runInference() {
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      async streamInference(_args, _options, onEvent) {
        onEvent({
          kind: "text",
          texts: ["google:google-route-test"],
        } satisfies ParsedStreamEvent);
        onEvent({ kind: "completed", finishReason: "stop" } satisfies ParsedStreamEvent);
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
    };
    const googleModelsRunner = {
      run: () => {
        recordDiscovery("google");
        return {
          status: 0,
          signal: null,
          stdout: "google-route-test     Google Route Test\n",
          stderr: "",
        };
      },
    };

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
      dedicatedAdapterDependencies: {
        chatgptTransportFactory: () => codexTransport,
        claudeQueryFn: ((args: { prompt?: unknown }) => {
          if (args.prompt === "") recordDiscovery("claude");
          return deterministicClaudeQuery();
        }) as never,
        googleInferenceRunner,
        googleModelsRunner,
        commandCodeClient: commandClient,
        cavotiClient,
      },
    });
    for (const providerId of ["chatgpt", "claude", "google", "command-code", "cavoti"]) {
      expect(discoveries.get(providerId), `${providerId} startup discovery count`).toBe(1);
    }
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
