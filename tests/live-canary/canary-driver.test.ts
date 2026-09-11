import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type { ProviderAdapter } from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";
import {
  buildCanaryPolicy,
  buildCanaryPrompt,
  CANARY_ECHO_NAME,
  CANARY_ECHO_TOOL,
  expectedFinalToken,
  runCanary,
  synthesizeEchoResult,
  validateEchoArguments,
  type FetchLike,
  type HttpResult,
} from "../../scripts/live-canary/canary-driver.js";

const CONFIRM = "yes-i-accept-subscription-quota-spend";
const SENTINEL = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const NONCE = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
const QODER_TOKEN = "qoder-bearer-token";
const CMMCHAT_TOKEN = "cmmchat-bearer-token";
const BASE = "http://127.0.0.1:8790";
const MODEL = "command-code/canary-model";

interface FakeModel {
  id: string;
  ownedBy: string;
}

interface FakeConfig {
  provider?: string;
  models?: FakeModel[];
  healthStatus?: number;
  modelsStatus?: number;
  toolCall?: { id: string; name: string; args: string } | null;
  firstStatus?: number;
  firstErrorType?: string;
  firstErrorMessage?: string;
  continuationStatus?: number;
  finalOverride?: string | null;
  expectedContinuationId?: string;
  /**
   * Model a provider that OBEYS `tool_choice:required` on every request: the
   * continuation turn then requests another tool instead of terminating. This is
   * the real semantic the live canary must survive, and the deterministic suite
   * uses it to reject a driver that forces a tool on the final turn.
   */
  policyFaithful?: boolean;
  /**
   * Adversarial provider: never consumes the tool-result message and instead
   * fabricates the final text from information it already saw in the original
   * prompt. Used to prove the final proof requires truly result-only knowledge.
   */
  ignoreToolResult?: boolean;
  fabricatedFinal?: string;
  /** Append a second tool call to the final (supposedly terminal) response. */
  finalToolCall?: boolean;
  /** Override the final response finish_reason (e.g. a non-terminal value). */
  finalFinishReason?: string;
}

function completion(model: string, message: Record<string, unknown>, finishReason = "stop"): unknown {
  return {
    id: "chatcmpl-cmm-test",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "", ...message }, finish_reason: finishReason }],
  };
}

function errorBody(type: string, message: string): unknown {
  return { error: { type, message } };
}

/** Minimal model of the Router wire, including the consumer capability gate. */
function fakeRouter(config: FakeConfig = {}): { fetchImpl: FetchLike; requests: Array<{ url: string; body: unknown; auth: string }> } {
  const requests: Array<{ url: string; body: unknown; auth: string }> = [];
  const provider = config.provider ?? "command-code";
  const models = config.models ?? [{ id: MODEL, ownedBy: "cmm:command-code" }];

  const fetchImpl: FetchLike = async (url, init) => {
    const auth = init.headers.authorization ?? "";
    let body: unknown = null;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    requests.push({ url, body, auth });

    if (url.endsWith("/health")) {
      return { status: config.healthStatus ?? 200, json: { status: "ok" } };
    }
    if (url.endsWith("/v1/models")) {
      if (config.modelsStatus !== undefined) {
        return { status: config.modelsStatus, json: errorBody("router_unauthorized", "nope") };
      }
      if (auth !== `Bearer ${QODER_TOKEN}` && auth !== `Bearer ${CMMCHAT_TOKEN}`) {
        return { status: 401, json: errorBody("router_unauthorized", "Invalid") };
      }
      return {
        status: 200,
        json: { object: "list", data: models.map((m) => ({ id: m.id, object: "model", owned_by: m.ownedBy })) },
      };
    }
    if (url.endsWith("/v1/chat/completions")) {
      const record = body as Record<string, unknown>;
      const resolved = models.find((m) => m.id === record.model);
      if (resolved === undefined) {
        return { status: 400, json: errorBody("unknown_model", "unknown") };
      }
      if (auth !== `Bearer ${QODER_TOKEN}`) {
        return {
          status: 400,
          json: errorBody("unsupported_capability", "Model supports chat only; tools are not supported on this route"),
        };
      }
      // Provider policy mirror.
      if ((provider === "claude" || provider === "google") && record.parallel_tool_calls !== undefined) {
        return { status: 400, json: errorBody("unsupported_capability", "parallel control unsupported") };
      }
      if (provider === "chatgpt" && record.parallel_tool_calls !== undefined) {
        return { status: 400, json: errorBody("unsupported_capability", "parallel control unsupported") };
      }
      const messages = record.messages as Array<Record<string, unknown>>;
      const toolMessage = messages.find((m) => m.role === "tool");
      if (toolMessage === undefined) {
        if (config.firstStatus !== undefined) {
          return {
            status: config.firstStatus,
            json: errorBody(config.firstErrorType ?? "provider_error", config.firstErrorMessage ?? "boom"),
          };
        }
        const toolCall = config.toolCall === undefined ? { id: "cmm_call_1", name: CANARY_ECHO_NAME, args: JSON.stringify({ text: SENTINEL }) } : config.toolCall;
        if (toolCall === null) {
          return { status: 200, json: completion(String(record.model), { content: "no tool call here" }) };
        }
        return {
          status: 200,
          json: completion(String(record.model), {
            tool_calls: [
              { id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: toolCall.args } },
            ],
          }),
        };
      }
      const assistant = messages.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls)) as
        | { tool_calls: Array<{ id: string }> }
        | undefined;
      const expectedId = config.expectedContinuationId ?? config.toolCall?.id ?? "cmm_call_1";
      const sentId = assistant?.tool_calls[0]?.id;
      if (assistant === undefined || sentId !== expectedId || toolMessage.tool_call_id !== expectedId) {
        return { status: 500, json: errorBody("provider_protocol_error", "wrong continuation id") };
      }
      if (config.policyFaithful !== false && record.tool_choice === "required") {
        // A provider that OBEYS the declared policy must request another tool
        // when told tool_choice=required, so this turn is NOT terminal. A canary
        // that forces a tool on the continuation would never reach final text.
        return {
          status: 200,
          json: completion(
            String(record.model),
            {
              tool_calls: [
                {
                  id: "cmm_call_2",
                  type: "function",
                  function: { name: CANARY_ECHO_NAME, arguments: JSON.stringify({ text: "again" }) },
                },
              ],
            },
            "tool_calls",
          ),
        };
      }
      if (config.continuationStatus !== undefined) {
        return { status: config.continuationStatus, json: errorBody("provider_protocol_error", "boom") };
      }
      if (config.ignoreToolResult === true) {
        // Deliberately ignore `toolMessage.content` and answer from the sentinel
        // the provider already saw in the original user prompt.
        return { status: 200, json: completion(String(record.model), { content: config.fabricatedFinal ?? "" }) };
      }
      const content = config.finalOverride ?? `FINAL ${String(toolMessage.content)}`;
      const extraCalls =
        config.finalToolCall === true
          ? [
              {
                id: "cmm_call_3",
                type: "function",
                function: { name: CANARY_ECHO_NAME, arguments: JSON.stringify({ text: "again" }) },
              },
            ]
          : undefined;
      return {
        status: 200,
        json: completion(
          String(record.model),
          { content, ...(extraCalls !== undefined ? { tool_calls: extraCalls } : {}) },
          config.finalFinishReason ?? "stop",
        ),
      };
    }
    return { status: 404, json: errorBody("not_found", "no route") };
  };
  return { fetchImpl, requests };
}

function makeEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CMM_LIVE_CANARY_CONFIRM: CONFIRM,
    CMM_QODER_TOKEN: QODER_TOKEN,
    CMM_LIVE_CANARY_MODEL: MODEL,
    CMM_LIVE_CANARY_BASE: BASE,
    ...overrides,
  };
}

function text(outcome: { lines: string[] }): string {
  return outcome.lines.join("\n");
}

describe("canary driver — deterministic fake Router", () => {
  it("proves the full Qoder tool round-trip (exit 0)", async () => {
    const { fetchImpl, requests } = fakeRouter();
    const env = makeEnv();
    const outcome = await runCanary({ provider: "command-code", env, fetchImpl, sentinel: SENTINEL, nonce: NONCE });

    expect(outcome.exitCode).toBe(0);
    const out = text(outcome);
    for (const marker of [
      "LIVE_CANARY_AUTH_CONSUMER=QODER",
      "LIVE_CANARY_CAPABILITY=CHAT_AND_TOOLS",
      "LIVE_CANARY_CMMCHAT_BEARER_USED=NO",
      "LIVE_CANARY_TOOL_REQUEST_RECEIVED=YES",
      `LIVE_CANARY_TOOL_NAME=${CANARY_ECHO_NAME}`,
      "LIVE_CANARY_QODER_SYNTHETIC_EXECUTION=YES",
      "LIVE_CANARY_TOOL_RESULT_SUBMITTED=YES",
      "LIVE_CANARY_SAME_PROVIDER_CONTINUATION=YES",
      "LIVE_CANARY_RESULT_NONCE_ONLY_AFTER_TOOL_CALL=YES",
      "LIVE_CANARY_TOOL_RESULT_IS_UNIQUE_INFORMATION=YES",
      "LIVE_CANARY_SECOND_RESPONSE_TERMINAL=YES",
      "LIVE_CANARY_FINAL_DERIVED_FROM_TOOL_RESULT=YES",
      "LIVE_CANARY_FULL_ROUNDTRIP=PASS",
      "LIVE_CANARY_PASS_EXIT=0",
      "LIVE_CANARY_CLIENT_PAYG_POISON=PASS",
      "LIVE_CANARY_REMOTE_ROUTER_PAYG_POISON_PROOF=NO",
      "LIVE_CANARY_NO_PROVIDER_NATIVE_TOOL=PASS",
      "LIVE_CANARY_NO_REPO_MUTATION=PASS",
      "LIVE_CANARY_EXACT_MODEL_SELECTION=PASS",
      "LIVE_CANARY_MODEL_FALLBACK=NONE",
      "LIVE_CANARY_SUBSCRIPTION_ROUTE_PREFLIGHT=PASS",
    ]) {
      expect(out).toContain(marker);
    }
    expect(env.GEMINI_API_KEY).toBe("canary-poison-not-a-key");

    // Exactly two inference requests; request 2 carries the in-memory result.
    const posts = requests.filter((r) => r.url.endsWith("/v1/chat/completions"));
    expect(posts).toHaveLength(2);
    const body2 = posts[1]?.body as { messages: Array<Record<string, unknown>> };
    const toolMessage = body2.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toBe(synthesizeEchoResult(NONCE, SENTINEL));
    expect(toolMessage?.content).toContain(expectedFinalToken(NONCE));
    // The result-only nonce must be unpredictable from request 1: it is generated
    // only after a valid tool call and appears nowhere before the tool result.
    expect(JSON.stringify(posts[0]?.body)).not.toContain(NONCE);
    // Only the one harmless synthetic tool is ever declared.
    const body1 = posts[0]?.body as { tools: Array<{ function: { name: string } }> };
    expect(body1.tools.map((t) => t.function.name)).toEqual([CANARY_ECHO_NAME]);
    console.log("LIVE_CANARY_FULL_ROUNDTRIP=PASS");
    console.log("LIVE_CANARY_HARNESS_DETERMINISTIC_TESTS=PASS");
  });

  it("rejects the CMMChat bearer (exit 2) and never uses it", async () => {
    const { fetchImpl } = fakeRouter();
    const outcome = await runCanary({
      provider: "command-code",
      env: makeEnv({ CMM_QODER_TOKEN: CMMCHAT_TOKEN }),
      fetchImpl,
      sentinel: SENTINEL,
    });
    expect(outcome.exitCode).toBe(2);
    expect(text(outcome)).toContain("LIVE_CANARY=BLOCKED");
    expect(text(outcome)).toContain("LIVE_CANARY_BLOCKED_EXIT=2");
    console.log("LIVE_CANARY_CMMCHAT_BEARER_USED=NO");
    console.log("LIVE_CANARY_BLOCKED_EXIT_NONZERO=PASS");
  });

  it("blocks when no Qoder bearer is available and never falls back to CMM_ROUTER_TOKEN", async () => {
    const { fetchImpl, requests } = fakeRouter();
    const env = makeEnv({ CMM_QODER_TOKEN: undefined, CMM_ROUTER_TOKEN: CMMCHAT_TOKEN });
    const outcome = await runCanary({ provider: "command-code", env, fetchImpl, readKeychain: () => null });
    expect(outcome.exitCode).toBe(2);
    expect(text(outcome)).toContain("reason=missing-qoder-bearer");
    expect(requests).toHaveLength(0);
  });

  it("blocks a colliding Qoder/CMMChat bearer", async () => {
    const { fetchImpl } = fakeRouter();
    const outcome = await runCanary({
      provider: "command-code",
      env: makeEnv({ CMM_QODER_TOKEN: CMMCHAT_TOKEN, CMM_ROUTER_TOKEN: CMMCHAT_TOKEN }),
      fetchImpl,
    });
    expect(outcome.exitCode).toBe(2);
    expect(text(outcome)).toContain("reason=qoder-bearer-equals-cmmchat-bearer");
  });

  it("blocks an unrelated/wrong model", async () => {
    const { fetchImpl } = fakeRouter({ models: [{ id: "google/other", ownedBy: "cmm:google" }] });
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL });
    expect(outcome.exitCode).toBe(2);
    expect(text(outcome)).toContain("reason=exact-model-absent-or-wrong-provider");
  });

  it("selects the exact model out of several without ambiguity", async () => {
    const { fetchImpl } = fakeRouter({
      models: [
        { id: "command-code/other", ownedBy: "cmm:command-code" },
        { id: MODEL, ownedBy: "cmm:command-code" },
      ],
    });
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL });
    expect(outcome.exitCode).toBe(0);
    expect(text(outcome)).toContain("LIVE_CANARY_PROVIDER_MODEL_COUNT=2");
    expect(text(outcome)).toContain("LIVE_CANARY_ROUTE_AMBIGUITY=NONE");
  });

  it("fails when the provider emits no tool call (exit 1)", async () => {
    const { fetchImpl } = fakeRouter({ toolCall: null });
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL });
    expect(outcome.exitCode).toBe(1);
    expect(text(outcome)).toContain("reason=no-tool-call");
    console.log("LIVE_CANARY_FAIL_EXIT_NONZERO=PASS");
  });

  it("fails on an unknown/undeclared tool", async () => {
    const { fetchImpl } = fakeRouter({ toolCall: { id: "c1", name: "rm_rf", args: "{}" } });
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL });
    expect(outcome.exitCode).toBe(1);
    expect(text(outcome)).toContain("reason=unknown-tool:rm_rf");
  });

  it("fails on malformed tool arguments", async () => {
    const { fetchImpl } = fakeRouter({ toolCall: { id: "c1", name: CANARY_ECHO_NAME, args: '{"nope":1}' } });
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL });
    expect(outcome.exitCode).toBe(1);
    expect(text(outcome)).toContain("reason=tool-arguments-missing-text");
  });

  it("fails when the tool result is rejected for a wrong continuation id", async () => {
    const { fetchImpl } = fakeRouter({ expectedContinuationId: "different-id" });
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL });
    expect(outcome.exitCode).toBe(1);
    expect(text(outcome)).toContain("reason=continuation-http-500");
  });

  it("fails when the final response is unrelated to the tool result", async () => {
    const { fetchImpl } = fakeRouter({ finalOverride: "I have no idea what you asked." });
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL });
    expect(outcome.exitCode).toBe(1);
    expect(text(outcome)).toContain("reason=final-not-derived-from-tool-result");
  });

  it("rejects a continuation that ignores the tool result and fabricates from the prompt sentinel", async () => {
    // The adversarial provider never reads the tool-result message; it answers
    // using only the call sentinel it already saw in the original user prompt.
    // The pre-fix proof (final must contain `RESULT=<call-sentinel>|echo=`) is
    // satisfiable by this fabrication, so this test is RED before the result-only
    // nonce is required.
    const { fetchImpl } = fakeRouter({
      ignoreToolResult: true,
      fabricatedFinal: `RESULT=${SENTINEL}|echo=${SENTINEL}`,
    });
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL, nonce: NONCE });
    expect(outcome.exitCode).toBe(1);
    expect(text(outcome)).toContain("reason=final-not-derived-from-tool-result");
    console.log("LIVE_CANARY_FINAL_CAUSALITY_PROOF=PASS");
  });

  it("rejects a fabricated final that merely guesses the nonce as the call sentinel", async () => {
    const { fetchImpl } = fakeRouter({
      ignoreToolResult: true,
      fabricatedFinal: `RESULT_NONCE=${SENTINEL}|echo=${SENTINEL}`,
    });
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL, nonce: NONCE });
    expect(outcome.exitCode).toBe(1);
    expect(text(outcome)).toContain("reason=final-not-derived-from-tool-result");
  });

  it("requires the echo tool argument to equal the call sentinel", async () => {
    const { fetchImpl } = fakeRouter({
      toolCall: { id: "c1", name: CANARY_ECHO_NAME, args: JSON.stringify({ text: "not-the-sentinel" }) },
    });
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL, nonce: NONCE });
    expect(outcome.exitCode).toBe(1);
    expect(text(outcome)).toContain("reason=tool-argument-not-call-sentinel");
  });

  it("refuses a result nonce that equals the call sentinel (no independent information)", async () => {
    const { fetchImpl } = fakeRouter();
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL, nonce: SENTINEL });
    expect(outcome.exitCode).toBe(1);
    expect(text(outcome)).toContain("reason=result-nonce-not-independent");
  });

  it("rejects a final response that also requests another tool call", async () => {
    const { fetchImpl } = fakeRouter({ finalToolCall: true });
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL, nonce: NONCE });
    expect(outcome.exitCode).toBe(1);
    expect(text(outcome)).toContain("reason=continuation-extra-tool-call");
    console.log("LIVE_CANARY_SECOND_RESPONSE_REJECTS_EXTRA_TOOL_CALLS=YES");
  });

  it("rejects a final response whose finish_reason is not terminal", async () => {
    const { fetchImpl } = fakeRouter({ finalFinishReason: "length" });
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL, nonce: NONCE });
    expect(outcome.exitCode).toBe(1);
    expect(text(outcome)).toContain("reason=continuation-non-terminal-finish:length");
  });

  it("maps Router 401 to BLOCKED, 429 to BLOCKED and 500 to FAIL", async () => {
    const unauthorized = fakeRouter({ modelsStatus: 401 });
    const b1 = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl: unauthorized.fetchImpl, sentinel: SENTINEL });
    expect(b1.exitCode).toBe(2);

    const limited = fakeRouter({ firstStatus: 429, firstErrorType: "provider_rate_limited", firstErrorMessage: "quota" });
    const b2 = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl: limited.fetchImpl, sentinel: SENTINEL });
    expect(b2.exitCode).toBe(2);
    expect(text(b2)).toContain("reason=quota-or-rate-limited");

    const broken = fakeRouter({ firstStatus: 500, firstErrorType: "provider_unavailable", firstErrorMessage: "down" });
    const b3 = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl: broken.fetchImpl, sentinel: SENTINEL });
    expect(b3.exitCode).toBe(1);
  });

  it("blocks on missing operator opt-in, non-loopback base and unknown provider", async () => {
    const { fetchImpl } = fakeRouter();
    expect((await runCanary({ provider: "command-code", env: makeEnv({ CMM_LIVE_CANARY_CONFIRM: "" }), fetchImpl })).exitCode).toBe(2);
    expect((await runCanary({ provider: "command-code", env: makeEnv({ CMM_LIVE_CANARY_BASE: "https://example.com" }), fetchImpl })).exitCode).toBe(2);
    expect((await runCanary({ provider: "nonsense", env: makeEnv(), fetchImpl })).exitCode).toBe(2);
    const missingModel = makeEnv();
    delete missingModel.CMM_LIVE_CANARY_MODEL;
    expect((await runCanary({ provider: "command-code", env: missingModel, fetchImpl })).exitCode).toBe(2);
  });

  it("uses a phase-specific Command Code policy: required on request 1, none on the final turn", async () => {
    const { fetchImpl, requests } = fakeRouter();
    const outcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl, sentinel: SENTINEL });
    expect(outcome.exitCode).toBe(0);
    const posts = requests.filter((r) => r.url.endsWith("/v1/chat/completions"));
    expect(posts).toHaveLength(2);
    const body1 = posts[0]?.body as { tool_choice?: unknown };
    const body2 = posts[1]?.body as { tool_choice?: unknown };
    expect(body1.tool_choice).toBe("required");
    expect(body2.tool_choice).toBe("none");
    expect(text(outcome)).toContain("LIVE_CANARY_COMMAND_CODE_PHASE_POLICY=PASS");
    console.log("COMMAND_CODE_CANARY_REQUEST1_POLICY=REQUIRED");
    console.log("COMMAND_CODE_CANARY_REQUEST2_POLICY=NONE");
  });

  it("sends provider-specific policy bodies that the Router accepts", async () => {
    for (const provider of ["claude", "google", "chatgpt", "command-code"]) {
      for (const phase of ["initial", "continuation"] as const) {
        const policy = buildCanaryPolicy(provider, phase);
        if (provider === "command-code") {
          expect(policy).toEqual(phase === "initial" ? { tool_choice: "required" } : { tool_choice: "none" });
        } else {
          expect(policy).toEqual({});
          expect(policy.tool_choice).toBeUndefined();
        }
        expect(policy.parallel_tool_calls).toBeUndefined();
      }
    }

    // Each provider's body is accepted by the policy mirror (no spend for a
    // rejection) and completes the round trip.
    for (const provider of ["claude", "google", "chatgpt"]) {
      const modelId = `${provider}/canary-model`;
      const router = fakeRouter({ provider, models: [{ id: modelId, ownedBy: `cmm:${provider}` }] });
      const env = makeEnv({ CMM_LIVE_CANARY_MODEL: modelId, CMM_QODER_TOKEN: QODER_TOKEN });
      const outcome = await runCanary({ provider, env, fetchImpl: router.fetchImpl, sentinel: SENTINEL });
      expect(outcome.exitCode).toBe(0);
    }
    const cc = fakeRouter({ models: [{ id: MODEL, ownedBy: "cmm:command-code" }] });
    const ccOutcome = await runCanary({ provider: "command-code", env: makeEnv(), fetchImpl: cc.fetchImpl, sentinel: SENTINEL });
    expect(ccOutcome.exitCode).toBe(0);

    // Negative control: the mirror really enforces the production constraint, so
    // the "accepted" markers above are not vacuous.
    const strict = fakeRouter({ provider: "claude", models: [{ id: "claude/canary-model", ownedBy: "cmm:claude" }] });
    const rejected = await strict.fetchImpl(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${QODER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude/canary-model",
        messages: [{ role: "user", content: "x" }],
        tools: [CANARY_ECHO_TOOL],
        parallel_tool_calls: false,
      }),
    });
    expect(rejected.status).toBe(400);

    console.log("CLAUDE_CANARY_POLICY_ACCEPTED=PASS_DETERMINISTIC");
    console.log("GOOGLE_CANARY_POLICY_ACCEPTED=PASS_DETERMINISTIC");
    console.log("CODEX_CANARY_POLICY_ACCEPTED=PASS_DETERMINISTIC");
    console.log("COMMAND_CODE_CANARY_POLICY_ACCEPTED=PASS_DETERMINISTIC");
    console.log("LIVE_CANARY_MODEL_FALLBACK=NONE");
  });
});

describe("canary driver — the prompt must not forbid the Codex final answer", () => {
  // Task 14 root cause: the Task 13 prompt ordered the model to call the tool
  // and then "Do not answer in plain text". On the Codex route the continuation
  // reuses the SAME provider turn, so that prohibition is still in context when
  // the tool result arrives and the model answers with an EMPTY final
  // agentMessage. The empty answer is therefore a harness artifact, not a
  // provider emission defect.
  it("requires the tool call AND a visible plain-text answer for the Codex route", () => {
    const prompt = buildCanaryPrompt("chatgpt", SENTINEL);
    expect(prompt).toContain(CANARY_ECHO_NAME);
    expect(prompt).toContain(SENTINEL);
    // No instruction may suppress the user-visible final answer.
    expect(prompt).not.toMatch(/do not answer in plain text/i);
    expect(prompt).not.toMatch(/do not reply/i);
    // The continuation must be told to produce the plain-text answer.
    expect(prompt).toMatch(/plain[- ]?text/i);
    expect(prompt).toMatch(/tool/i);
  });

  it("keeps the other providers' prompt byte-for-byte (their live evidence stays valid)", () => {
    const original =
      `You must call the tool ${CANARY_ECHO_NAME} exactly once with ` +
      `{"text":"${SENTINEL}"}. Do not answer in plain text. Do not call any other tool.`;
    for (const provider of ["claude", "google", "command-code"]) {
      expect(buildCanaryPrompt(provider, SENTINEL)).toBe(original);
    }
  });

  it("sends the corrected prompt on BOTH ChatGPT requests", async () => {
    const modelId = "chatgpt/canary-model";
    const router = fakeRouter({ provider: "chatgpt", models: [{ id: modelId, ownedBy: "cmm:chatgpt" }] });
    const outcome = await runCanary({
      provider: "chatgpt",
      env: makeEnv({ CMM_LIVE_CANARY_MODEL: modelId }),
      fetchImpl: router.fetchImpl,
      sentinel: SENTINEL,
    });
    expect(outcome.exitCode).toBe(0);
    const posts = router.requests.filter((r) => r.url.endsWith("/v1/chat/completions"));
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      const messages = (post.body as { messages: Array<{ role: string; content: string | null }> }).messages;
      const userPrompt = messages.find((m) => m.role === "user")?.content ?? "";
      expect(userPrompt).not.toMatch(/do not answer in plain text/i);
      expect(userPrompt).toMatch(/plain[- ]?text/i);
    }
    console.log("LIVE_CANARY_PROMPT_ALLOWS_FINAL_ANSWER=YES");
  });
});

describe("canary driver — exact argument schema", () => {
  it("accepts exactly {text:string} and rejects everything else", () => {
    expect(validateEchoArguments('{"text":"x"}')).toEqual({ text: "x" });
    expect(validateEchoArguments("not json")).toEqual({ fail: "tool-arguments-not-json" });
    expect(validateEchoArguments("[]")).toEqual({ fail: "tool-arguments-not-object" });
    expect(validateEchoArguments('{"other":1}')).toEqual({ fail: "tool-arguments-missing-text" });
    expect(validateEchoArguments('{"text":"x","extra":1}')).toEqual({ fail: "tool-arguments-unknown-key" });
    expect(validateEchoArguments('{"text":5}')).toEqual({ fail: "tool-arguments-text-not-string" });
  });
});

describe("canary driver — real Router integration (no provider inference)", () => {
  class CanaryAdapter implements ProviderAdapter {
    readonly id = "command-code" as const;
    async discoverModels() {
      return [
        {
          id: MODEL,
          provider: "command-code" as const,
          upstreamModel: "canary-model",
          displayName: "Canary Model",
          capability: "CHAT_AND_TOOLS" as const,
        },
      ];
    }
    async health() {
      return { status: "ready" as const };
    }
    async *run(request: { messages: Array<{ role: string; content: string | null }> }): AsyncIterable<RouterEvent> {
      const toolMessage = request.messages.find((m) => m.role === "tool");
      if (toolMessage !== undefined) {
        yield { type: "text_delta", text: `FINAL ${toolMessage.content ?? ""}` };
        yield { type: "completed", finishReason: "stop" };
        return;
      }
      const userText = request.messages.find((m) => m.role === "user")?.content ?? "";
      const sentinel = /"text":"([0-9a-f]+)"/.exec(userText)?.[1] ?? "";
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "cmm_command-code_canary_call",
        name: CANARY_ECHO_NAME,
        argumentsDelta: JSON.stringify({ text: sentinel }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
    }
    async cancel(): Promise<void> {}
  }

  async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
    const registry = new ProviderRegistry();
    await registry.register(new CanaryAdapter());
    await registry.refresh();
    const server = buildServer({
      host: "127.0.0.1",
      port: 0,
      bearerSecret: CMMCHAT_TOKEN,
      qoderToken: QODER_TOKEN,
      registry,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      return await run(`http://127.0.0.1:${port}`);
    } finally {
      await server.close();
    }
  }

  const realFetch: FetchLike = async (url, init): Promise<HttpResult> => {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };

  it("completes the round trip through the real Fastify Router as Qoder", async () => {
    await withServer(async (base) => {
      const env = makeEnv({ CMM_LIVE_CANARY_BASE: base });
      const outcome = await runCanary({ provider: "command-code", env, fetchImpl: realFetch, sentinel: SENTINEL });
      expect(outcome.exitCode).toBe(0);
      expect(text(outcome)).toContain("LIVE_CANARY_FULL_ROUNDTRIP=PASS");
    });
  });

  it("is rejected by the real Router when authenticated as CMMChat", async () => {
    await withServer(async (base) => {
      const outcome = await runCanary({
        provider: "command-code",
        env: makeEnv({ CMM_LIVE_CANARY_BASE: base, CMM_QODER_TOKEN: CMMCHAT_TOKEN }),
        fetchImpl: realFetch,
        sentinel: SENTINEL,
      });
      expect(outcome.exitCode).toBe(2);
      expect(text(outcome)).toContain("capability-or-policy-rejected");
    });
  });
});
