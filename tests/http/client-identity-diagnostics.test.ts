import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { UsageStore, type UsageRecord } from "../../src/observability/usage-store.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * Phase 4E — client metadata is observability only.
 *
 * The optional `X-CMM-Client` identifier must be visible in usage diagnostics so
 * operators can see which harnesses connect, while remaining incapable of
 * changing authorization or capability.
 */

const CMMCHAT_TOKEN = "identity-diag-cmmchat-secret";
const CODE_TOKEN = "identity-diag-code-secret";
const MODEL = "command-code/generic-echo";

async function harness() {
  const registry = new ProviderRegistry();
  await registry.register(
    new GenericToolProvider({
      provider: "command-code",
      modelId: MODEL,
      steps: [
        { kind: "calls", calls: [{ id: "gcall_1", name: "cmm_echo", arguments: '{"text":"a"}' }] },
        { kind: "final", prefix: "answer=" },
      ],
    }),
  );
  await registry.refresh();
  const usageStore = new UsageStore();
  const server = buildServer({
    host: "127.0.0.1",
    port: 0,
    bearerSecret: CMMCHAT_TOKEN,
    codeRouterToken: CODE_TOKEN,
    registry,
    usageStore,
  });
  return { server, usageStore };
}

async function recentRecord(
  server: ReturnType<typeof buildServer>,
  token: string,
  client?: string,
): Promise<UsageRecord> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (client !== undefined) headers["x-cmm-client"] = client;
  const response = await server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers,
    payload: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
  });
  expect(response.statusCode).toBe(200);
  const usage = await server.inject({
    method: "GET",
    url: "/v1/cmm/usage",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(usage.statusCode).toBe(200);
  const body = usage.json() as { recent: UsageRecord[] };
  return body.recent[0]!;
}

describe("client metadata in usage diagnostics", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => {
    h = await harness();
  });

  it("records the authenticated profile and the normalized client id", async () => {
    const record = await recentRecord(h.server, CODE_TOKEN, "hermes");
    expect(record.profile).toBe("code");
    expect(record.clientId).toBe("hermes");
    console.log("CLIENT_METADATA_RECORDED=PASS");
  });

  it("defaults an unidentified Code Router client to generic-openai", async () => {
    const record = await recentRecord(h.server, CODE_TOKEN);
    expect(record.profile).toBe("code");
    expect(record.clientId).toBe("generic-openai");
  });

  it("records the CMMChat profile with its fixed identifier even when spoofed", async () => {
    const record = await recentRecord(h.server, CMMCHAT_TOKEN, "qoder");
    expect(record.profile).toBe("cmmchat");
    expect(record.clientId).toBe("cmmchat");
    console.log("CMMCHAT_IDENTITY_NOT_SPOOFABLE=PASS");
  });

  it("bounds a hostile identifier onto the closed set", async () => {
    const record = await recentRecord(h.server, CODE_TOKEN, "qoder; rm -rf / && curl evil");
    expect(record.clientId).toBe("other");
  });

  it("never records a credential value", async () => {
    const record = await recentRecord(h.server, CODE_TOKEN, "hermes");
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(CODE_TOKEN);
    expect(serialized).not.toContain(CMMCHAT_TOKEN);
    console.log("CLIENT_METADATA_NO_SECRETS=PASS");
  });

  it("CLIENT_METADATA_NOT_AUTHORIZATION: the header cannot grant tools to CMMChat", async () => {
    const response = await h.server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${CMMCHAT_TOKEN}`, "x-cmm-client": "qoder" },
      payload: {
        model: MODEL,
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("unsupported_capability");
    console.log("CLIENT_METADATA_NOT_AUTHORIZATION=PASS");
  });
});

describe("usage store identity fields are optional and additive", () => {
  it("records a request with no identity exactly as before", () => {
    const store = new UsageStore();
    store.beginRequest("req-plain", "chatgpt", "chatgpt/m");
    const record = store.endRequest("req-plain", { status: "success" });
    expect(record.profile).toBeUndefined();
    expect(record.clientId).toBeUndefined();
    expect(record).toMatchObject({ requestId: "req-plain", provider: "chatgpt", model: "chatgpt/m" });
  });

  it("records identity when supplied", () => {
    const store = new UsageStore();
    store.beginRequest("req-id", "chatgpt", "chatgpt/m", { profile: "code", clientId: "qoder" });
    const record = store.endRequest("req-id", { status: "success" });
    expect(record.profile).toBe("code");
    expect(record.clientId).toBe("qoder");
  });
});
