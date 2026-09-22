import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { assertNoPaygFallback } from "../../src/security/payg-guard.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const CMMCHAT_TOKEN = "fallback-cmmchat-secret";
const CODE_TOKEN = "fallback-code-secret";
const MODEL = "command-code/generic-echo";
const AUTH = { authorization: `Bearer ${CODE_TOKEN}` };

async function twoProviderHarness() {
  const registry = new ProviderRegistry();
  const primary = new GenericToolProvider({
    provider: "command-code",
    modelId: MODEL,
    steps: [
      { kind: "calls", calls: [{ id: "gcall_1", name: "cmm_echo", arguments: '{"text":"a"}' }] },
      { kind: "final", prefix: "answer=" },
    ],
    extraModels: [
      {
        id: "command-code/unverified",
        provider: "command-code",
        upstreamModel: "unverified",
        displayName: "Unverified Model",
        // capability deliberately absent: must never be promoted.
      },
      {
        id: "command-code/chat-only",
        provider: "command-code",
        upstreamModel: "chat-only",
        displayName: "Chat Only",
        capability: "CHAT_ONLY",
      },
    ],
  });
  // A second, different provider namespace that must never be substituted in.
  const other = new GenericToolProvider({
    provider: "claude",
    modelId: "claude/other-model",
    steps: [{ kind: "final", prefix: "other=" }],
  });
  await registry.register(primary);
  await registry.register(other);
  await registry.refresh();
  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: CMMCHAT_TOKEN,
    codeRouterToken: CODE_TOKEN,
    registry,
  });
  return { server, primary, other };
}

describe("generic Code Router client — no fallback of any kind", () => {
  it("NO_UNKNOWN_MODEL_FALLBACK: an unknown model is rejected, never substituted", async () => {
    const { server, primary, other } = await twoProviderHarness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload: {
        model: "command-code/ghost",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unknown_model");
    expect(primary.runCount).toBe(0);
    expect(other.runCount).toBe(0);
    console.log("NO_UNKNOWN_MODEL_FALLBACK=YES");
  });

  it("NO_CROSS_PROVIDER_FALLBACK: another provider is never called when resolution fails", async () => {
    const { server, primary, other } = await twoProviderHarness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload: {
        model: "command-code/not-a-model",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(primary.runCount).toBe(0);
    // The capable sibling provider is not consulted, not even for a plain chat.
    expect(other.runCount).toBe(0);
    console.log("NO_CROSS_PROVIDER_FALLBACK=YES");
  });

  it("an unknown provider namespace is rejected without touching any provider", async () => {
    const { server, primary, other } = await twoProviderHarness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload: { model: "nonexistent/model", messages: [{ role: "user", content: "hi" }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unknown_provider");
    expect(primary.runCount).toBe(0);
    expect(other.runCount).toBe(0);
  });

  it("an unverified model is never promoted to CHAT_AND_TOOLS for the Code profile", async () => {
    const { server, primary } = await twoProviderHarness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload: {
        model: "command-code/unverified",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(primary.runCount).toBe(0);
  });

  it("no silent downgrade: a CHAT_ONLY model with tools is rejected, not stripped", async () => {
    const { server, primary } = await twoProviderHarness();
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: AUTH,
      payload: {
        model: "command-code/chat-only",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    expect(primary.runCount).toBe(0);
    console.log("SILENT_TOOL_DOWNGRADE=NONE");
  });

  it("NO_PAYG_FALLBACK: PAYG credentials still abort runtime startup", () => {
    const poisoned = {
      OPENAI_API_KEY: "sk-test",
      ANTHROPIC_API_KEY: "sk-ant-test",
      GEMINI_API_KEY: "gm-test",
      GOOGLE_API_KEY: "goog-test",
    };
    expect(() => assertNoPaygFallback(poisoned)).toThrow(/PAYG fallback blocked/);
    expect(() => assertNoPaygFallback({ CMM_ROUTER_TOKEN: "unrelated" })).not.toThrow();
    console.log("NO_PAYG_FALLBACK=YES");
  });
});
