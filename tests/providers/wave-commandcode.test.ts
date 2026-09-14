import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
import { PROVIDER_WAVE_MANIFESTS, providerWaveManifest } from "../../src/providers/manifests.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";

const BASE_URL = "https://api.commandcode.ai/provider/v1";

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

type FakeResponse = { status: number; body: string };

function fakeFetch(responses: Record<string, FakeResponse>, seen: string[]) {
  return async (url: string, init: { method: string; headers: Record<string, string>; body?: string | undefined; signal?: AbortSignal | undefined }) => {
    seen.push(`${init.method} ${url}`);
    const match = responses[`${init.method} ${url}`] ?? { status: 404, body: "not found" };
    return { status: match.status, text: async () => match.body };
  };
}

function request(upstreamModel: string): RouterRequest {
  return {
    requestId: `cc-wave-${upstreamModel}`,
    model: {
      id: `command-code/${upstreamModel}`,
      provider: "command-code",
      upstreamModel,
      displayName: upstreamModel,
      capability: "CHAT_AND_TOOLS",
    },
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    stream: true,
  };
}

async function collect(iterable: AsyncIterable<RouterEvent>): Promise<RouterEvent[]> {
  const events: RouterEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function openAiSse(text: string): string {
  return [
    `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`,
    "",
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

function anthropicSse(text: string): string {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
    "",
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
    "",
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    "",
    'event: message_stop\ndata: {"type":"message_stop"}',
    "",
  ].join("\n");
}

describe("Command Code in the provider wave", () => {
  let dir: string;
  let ackPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-wave-"));
    ackPath = validAck(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appears exactly once in the wave inventory with its subscription billing class", () => {
    const matches = PROVIDER_WAVE_MANIFESTS.filter(
      (manifest) => manifest.id === "command-code",
    );
    expect(matches).toHaveLength(1);

    const manifest = providerWaveManifest("command-code");
    expect(manifest.displayName).toBe("Command Code");
    expect(manifest.billingClass).toBe("subscription");
    expect(manifest.auth).toEqual({ scheme: "bearer", secretEnv: "COMMAND_CODE_SECRET" });
    // R8: the router's configured default is unchanged; config may override it.
    expect(manifest.baseUrl).toBe(BASE_URL);
    // Both upstream wires this provider actually speaks.
    expect([...manifest.apiStyles].sort()).toEqual([
      "anthropic-messages",
      "openai-chat-completions",
    ]);
    expect(manifest.toolCapability).toBe("CHAT_AND_TOOLS");
    expect(manifest.activation).toEqual({ mode: "all", models: [] });
  });

  it("normalizes its deterministic /models fixture without a live call", async () => {
    const seen: string[] = [];
    const catalog = {
      data: [
        { id: "deepseek/deepseek-v4-flash", included_plans: ["GOAT"] },
        { id: "claude-sonnet-4-5", included_plans: ["GOAT"] },
      ],
    };
    const adapter = new CommandCodeAdapter({
      ackPath,
      client: new CommandCodeClient({
        secret: "injected-command-code-secret",
        fetchFn: fakeFetch(
          { [`GET ${BASE_URL}/models`]: { status: 200, body: JSON.stringify(catalog) } },
          seen,
        ),
      }),
    });

    const models = await adapter.discoverModels();

    expect(seen).toEqual([`GET ${BASE_URL}/models`]);
    expect(models.map((model) => model.id)).toEqual([
      "command-code/deepseek/deepseek-v4-flash",
      "command-code/claude-sonnet-4-5",
    ]);
    expect(models.every((model) => model.provider === "command-code")).toBe(true);
  });

  it("routes deterministic fixtures on both wires it declares", async () => {
    const openAiSeen: string[] = [];
    const openAi = new CommandCodeAdapter({
      ackPath,
      client: new CommandCodeClient({
        secret: "injected-command-code-secret",
        fetchFn: fakeFetch(
          {
            [`POST ${BASE_URL}/chat/completions`]: {
              status: 200,
              body: openAiSse("openai-wire"),
            },
          },
          openAiSeen,
        ),
      }),
    });
    const openAiEvents = await collect(
      openAi.run(request("deepseek/deepseek-v4-flash"), new AbortController().signal),
    );
    expect(openAiSeen).toEqual([`POST ${BASE_URL}/chat/completions`]);
    expect(openAiEvents.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "openai-wire" },
    ]);
    expect(openAiEvents.at(-1)).toEqual({ type: "completed", finishReason: "stop" });

    const anthropicSeen: string[] = [];
    const anthropic = new CommandCodeAdapter({
      ackPath,
      client: new CommandCodeClient({
        secret: "injected-command-code-secret",
        fetchFn: fakeFetch(
          { [`POST ${BASE_URL}/messages`]: { status: 200, body: anthropicSse("anthropic-wire") } },
          anthropicSeen,
        ),
      }),
    });
    const anthropicEvents = await collect(
      anthropic.run(request("claude-sonnet-4-5"), new AbortController().signal),
    );
    expect(anthropicSeen).toEqual([`POST ${BASE_URL}/messages`]);
    expect(anthropicEvents.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "anthropic-wire" },
    ]);
    expect(anthropicEvents.at(-1)).toEqual({ type: "completed", finishReason: "stop" });

    // Deterministic implementation only: the live canary stays deferred.
    console.log("COMMANDCODE_IMPLEMENTATION=PASS");
    console.log(
      "COMMANDCODE_LIVE_CANARY=DEFERRED_UNTIL_USER_AUTHORIZATION_AFTER_QUOTA_RESET",
    );
  });

  it("keeps the machine-local GOAT spend acknowledgement mandatory", async () => {
    const adapter = new CommandCodeAdapter({
      ackPath: join(dir, "absent.json"),
      client: new CommandCodeClient({
        secret: "injected-command-code-secret",
        fetchFn: fakeFetch({}, []),
      }),
    });

    const events = await collect(
      adapter.run(request("deepseek/deepseek-v4-flash"), new AbortController().signal),
    );

    expect((events[0] as { error: { code: string } }).error.code).toBe(
      "provider_auth_required",
    );
  });
});
