import { describe, expect, it, beforeEach } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import { UsageStore, type UsageRecord } from "../../src/observability/usage-store.js";
import { GenericToolProvider } from "../helpers/generic-tool-provider.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

/**
 * Subphase A — the opaque application label is observability only.
 *
 * It must be visible in usage diagnostics so operators can see who connects,
 * while remaining incapable of changing authorization or routing.
 */

const CMMCHAT_TOKEN = "label-diag-cmmchat-secret";
const CODE_TOKEN = "label-diag-code-secret";
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
  label?: string,
): Promise<UsageRecord> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (label !== undefined) headers["x-cmm-client"] = label;
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
  return (usage.json() as { recent: UsageRecord[] }).recent[0]!;
}

describe("application label in usage diagnostics", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => {
    h = await harness();
  });

  it("records the authenticated profile and any arbitrary label", async () => {
    const record = await recentRecord(h.server, CODE_TOKEN, "deepseek-harness");
    expect(record.profile).toBe("code");
    expect(record.clientLabel).toBe("deepseek-harness");
    console.log("ARBITRARY_CLIENT_LABEL_RECORDED=PASS");
  });

  it("an unidentified Code Router client simply has no label", async () => {
    const record = await recentRecord(h.server, CODE_TOKEN);
    expect(record.profile).toBe("code");
    expect(record.clientLabel).toBeUndefined();
    console.log("ABSENT_CLIENT_LABEL_RECORDED=PASS");
  });

  it("bounds a hostile label onto a safe alphabet", async () => {
    const record = await recentRecord(h.server, CODE_TOKEN, "qoder; rm -rf / && curl evil");
    expect(record.clientLabel).toMatch(/^[a-z0-9._-]+$/);
    expect(record.clientLabel!.length).toBeLessThanOrEqual(64);
    console.log("CLIENT_LABEL_BOUNDED=PASS");
    console.log("CLIENT_LABEL_SANITIZED=PASS");
  });

  it("never records a credential value", async () => {
    const record = await recentRecord(h.server, CODE_TOKEN, "hermes");
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(CODE_TOKEN);
    expect(serialized).not.toContain(CMMCHAT_TOKEN);
  });

  it("CLIENT_LABEL_NOT_AUTHORIZATION: the label cannot grant tools to CMMChat", async () => {
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
    console.log("CLIENT_LABEL_NOT_AUTHORIZATION=PASS");
  });

  it("CLIENT_LABEL_NOT_ROUTING: the label cannot select or substitute a model", async () => {
    const bogus = await h.server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${CODE_TOKEN}`, "x-cmm-client": "codex-client" },
      payload: { model: "command-code/not-a-model", messages: [{ role: "user", content: "hi" }] },
    });
    expect(bogus.statusCode).toBe(400);
    expect(bogus.json().error.type).toBe("unknown_model");

    const exact = await h.server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${CODE_TOKEN}`, "x-cmm-client": "codex-client" },
      payload: { model: MODEL, messages: [{ role: "user", content: "hi" }] },
    });
    expect(exact.statusCode).toBe(200);
    expect((exact.json() as { model: string }).model).toBe(MODEL);
    console.log("CLIENT_LABEL_NOT_ROUTING=PASS");
  });
});

describe("usage store label fields are optional and additive", () => {
  it("records a request with no label exactly as before", () => {
    const store = new UsageStore();
    store.beginRequest("req-plain", "chatgpt", "chatgpt/m");
    const record = store.endRequest("req-plain", { status: "success" });
    expect(record.profile).toBeUndefined();
    expect(record.clientLabel).toBeUndefined();
    expect(record).toMatchObject({ requestId: "req-plain", provider: "chatgpt", model: "chatgpt/m" });
  });

  it("records identity when supplied", () => {
    const store = new UsageStore();
    store.beginRequest("req-id", "chatgpt", "chatgpt/m", { profile: "code", clientLabel: "cline" });
    const record = store.endRequest("req-id", { status: "success" });
    expect(record.profile).toBe("code");
    expect(record.clientLabel).toBe("cline");
  });

  it("records a profile with no label", () => {
    const store = new UsageStore();
    store.beginRequest("req-nolabel", "chatgpt", "chatgpt/m", { profile: "code" });
    const record = store.endRequest("req-nolabel", { status: "success" });
    expect(record.profile).toBe("code");
    expect(record.clientLabel).toBeUndefined();
  });
});
