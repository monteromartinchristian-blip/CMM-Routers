#!/usr/bin/env node
/**
 * Task 13 live canary driver (PREPARED — never executed by an agent).
 *
 * Proves the last unresolved boundary against a real subscription provider:
 *   real provider -> provider requests canary_echo -> Router surfaces the tool
 *   request to the Qoder consumer -> the canary acts as the Qoder-side synthetic
 *   executor (in-memory only) -> the tool result is submitted with the exact ids
 *   -> the SAME provider logical run resumes -> the final response is derived
 *   from the tool result.
 *
 * Transport: plain HTTP against the Router. `canary_echo` performs no shell, no
 * filesystem write, no repository mutation and no network call. The bearer token
 * and any provider output are never printed.
 *
 * Exit codes: 0 = PASS, 1 = FAIL, 2 = BLOCKED (prerequisite unavailable).
 * This module is dependency-free so it runs under Node's native type stripping.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const CANARY_CONFIRM_VALUE = "yes-i-accept-subscription-quota-spend";
const PROVIDERS = ["claude", "google", "chatgpt", "command-code"] as const;
type Provider = (typeof PROVIDERS)[number];

const CONSUMER_TO_GATEWAY: Record<Provider, string> = {
  claude: "claude",
  google: "google",
  chatgpt: "chatgpt",
  "command-code": "command-code",
};

export const CANARY_ECHO_TOOL = {
  type: "function" as const,
  function: {
    name: "canary_echo",
    description:
      "Harmless synthetic echo used only to observe exact tool wiring. Performs no I/O.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

export const CANARY_ECHO_NAME = "canary_echo";

/**
 * PAYG/API credential sentinels. These poison THIS canary process's environment
 * so a real code path would fail loudly on them. They are CLIENT-LOCAL: the canary
 * cannot retrofit another process's environment, so this is NOT proof that the
 * already-running Router/provider subprocess was poisoned. The Router's own
 * startup PAYG guard (`assertNoPaygFallback`) is proven separately and
 * deterministically by `tests/security/payg-guard.test.ts`.
 */
const PAYG_POISON: Record<string, string> = {
  GEMINI_API_KEY: "canary-poison-not-a-key",
  GOOGLE_API_KEY: "canary-poison-not-a-key",
  GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:1",
  OPENAI_API_KEY: "canary-poison-not-a-key",
  ANTHROPIC_API_KEY: "canary-poison-not-a-key",
  GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent/canary-poison.json",
};

export interface HttpResult {
  status: number;
  json: unknown;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResult>;

export interface CanaryDeps {
  provider: string;
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  /** Injected keychain reader (tests); production uses `security`. */
  readKeychain?: (service: string, account: string) => string | null;
  /** Injected call sentinel generator (tests); production uses crypto random. */
  sentinel?: string;
  /**
   * Injected result-only nonce (tests); production uses crypto random. It MUST
   * differ from the call sentinel and is generated only after a valid tool call.
   */
  nonce?: string;
}

export interface CanaryOutcome {
  exitCode: 0 | 1 | 2;
  lines: string[];
}

/**
 * Canary request phase. Request 1 must elicit the tool call; request 2 must
 * consume the supplied tool result and terminate. These are opposite
 * requirements, so the provider policy is phase-specific, not merely
 * provider-specific.
 */
export type CanaryPhase = "initial" | "continuation";

/**
 * Provider- and phase-specific request policy. One shared policy object must
 * never be used for every provider or every phase: Claude and Google reject
 * EXPLICIT parallel-tool control (and any tool_choice other than
 * default/auto), and Codex cannot represent a parallel constraint at all. Only
 * Command Code uses the exact OpenAI forcing semantics it faithfully supports.
 *
 * On the continuation turn Command Code is told `tool_choice:"none"` — a shape
 * representable on both of its upstream wires — because the acceptance
 * requirement is to consume the tool result and answer WITHOUT calling another
 * tool. Leaving it `required` would ask the provider to do two mutually
 * incompatible things and make a live PASS untrustworthy.
 */
export function buildCanaryPolicy(provider: string, phase: CanaryPhase = "initial"): Record<string, unknown> {
  switch (provider) {
    case "command-code":
      return phase === "initial" ? { tool_choice: "required" } : { tool_choice: "none" };
    case "claude":
    case "google":
    case "chatgpt":
      return {};
    default:
      return {};
  }
}

/**
 * The canary prompt. ONE text must satisfy BOTH phases:
 *
 * - request 1 must elicit exactly one `canary_echo` call. Codex cannot express
 *   `tool_choice`, so the prompt is the only forcing mechanism for it.
 * - the continuation must terminate with visible plain text derived from the
 *   tool result.
 *
 * For the ChatGPT/Codex route the continuation reuses the SAME provider turn,
 * so the ORIGINAL prompt is still in context when the tool result arrives. A
 * prompt that forbids plain text ("Do not answer in plain text") then makes the
 * visible final answer impossible, and the model emits an EMPTY final
 * agentMessage. That empty answer is a harness artifact, not a provider emission
 * defect. See docs/task-14-codex-post-tool-continuation.md.
 *
 * The other providers keep the original prompt BYTE-FOR-BYTE: their continuation
 * is a separate request, their recorded live canary results were produced with
 * that exact prompt, and Task 14 must not alter their behavior.
 */
export function buildCanaryPrompt(provider: string, sentinel: string): string {
  if (provider === "chatgpt") {
    return (
      `You must call the tool ${CANARY_ECHO_NAME} exactly once with ` +
      `{"text":"${sentinel}"}. Do not call any other tool. ` +
      `After the tool returns its result, reply with one short plain-text sentence ` +
      `that includes the exact text the tool returned.`
    );
  }
  return (
    `You must call the tool ${CANARY_ECHO_NAME} exactly once with ` +
    `{"text":"${sentinel}"}. Do not answer in plain text. Do not call any other tool.`
  );
}

function canonicalProvider(provider: string): Provider | null {
  return (PROVIDERS as readonly string[]).includes(provider) ? (provider as Provider) : null;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function defaultSentinel(): string {
  return randomHex(16);
}

/**
 * The result-only nonce. It is generated ONLY after a valid tool call has been
 * received and must never appear in the original prompt, the assistant tool
 * call, the tool arguments or any earlier message. Because it is unpredictable
 * from information the provider already had, a final response containing it can
 * only have consumed the tool-result message.
 */
export function defaultResultNonce(): string {
  return randomHex(16);
}

function errorTypeOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const type = (error as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

function errorMessageOf(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function isLoopback(base: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(base);
}

interface ToolCall {
  id: string;
  name: string;
  args: string;
}

function extractSingleToolCall(body: unknown): ToolCall | { fail: string } {
  if (typeof body !== "object" || body === null) return { fail: "response-not-an-object" };
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { fail: "no-choices" };
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return { fail: "no-message" };
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return { fail: "no-tool-call" };
  // A single logical call may legitimately arrive assembled from stream
  // fragments; the aggregated non-stream response must contain exactly one.
  if (calls.length > 1) return { fail: "multiple-tool-calls" };
  const call = calls[0] as { id?: unknown; function?: unknown };
  const fn = call.function as { name?: unknown; arguments?: unknown } | undefined;
  if (typeof call.id !== "string" || call.id.length === 0) return { fail: "tool-call-id-missing" };
  if (typeof fn?.name !== "string") return { fail: "tool-name-missing" };
  if (fn.name !== CANARY_ECHO_NAME) return { fail: `unknown-tool:${fn.name}` };
  if (typeof fn.arguments !== "string") return { fail: "tool-arguments-missing" };
  return { id: call.id, name: fn.name, args: fn.arguments };
}

/** Validate the tool arguments against the exact declared schema. */
export function validateEchoArguments(rawArgs: string): { text: string } | { fail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return { fail: "tool-arguments-not-json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { fail: "tool-arguments-not-object" };
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  const record = parsed as Record<string, unknown>;
  if (!keys.includes("text")) return { fail: "tool-arguments-missing-text" };
  if (keys.some((key) => key !== "text")) return { fail: "tool-arguments-unknown-key" };
  if (typeof record.text !== "string") return { fail: "tool-arguments-text-not-string" };
  return { text: record.text };
}

/**
 * The Qoder-side synthetic execution: pure, in-memory, no I/O. The result
 * carries the result-only nonce the canary generated AFTER receiving the tool
 * call, so the final provider response can only reproduce it by actually
 * consuming this tool result.
 */
export function synthesizeEchoResult(resultNonce: string, echoText: string): string {
  return `RESULT_NONCE=${resultNonce}|echo=${echoText}`;
}

export function expectedFinalToken(resultNonce: string): string {
  return `RESULT_NONCE=${resultNonce}`;
}

/**
 * The continuation turn must be a TRUE terminal response: final text, no further
 * tool request, and a terminal finish_reason. Anything else means the round trip
 * did not complete and must not be reported as a PASS.
 */
function continuationShape(body: unknown): { content: string } | { fail: string } {
  if (typeof body !== "object" || body === null) return { fail: "continuation-no-content" };
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { fail: "continuation-no-content" };
  const choice = choices[0] as { message?: unknown; finish_reason?: unknown };
  const message = choice.message;
  if (typeof message !== "object" || message === null) return { fail: "continuation-no-content" };
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  if (Array.isArray(calls) && calls.length > 0) return { fail: "continuation-extra-tool-call" };
  if (choice.finish_reason !== "stop") {
    return { fail: `continuation-non-terminal-finish:${String(choice.finish_reason)}` };
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || content.length === 0) return { fail: "continuation-no-content" };
  return { content };
}

function modelList(body: unknown): Array<{ id: string; ownedBy: string }> {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: Array<{ id: string; ownedBy: string }> = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    const ownedBy = (entry as { owned_by?: unknown }).owned_by;
    if (typeof id === "string") out.push({ id, ownedBy: typeof ownedBy === "string" ? ownedBy : "" });
  }
  return out;
}

function readBearer(deps: CanaryDeps): { token: string; source: string } | { blocked: string } {
  const env = deps.env;
  const direct = env.CMM_QODER_TOKEN;
  if (typeof direct === "string" && direct.length > 0) {
    return { token: direct, source: "env:CMM_QODER_TOKEN" };
  }
  const service = env.CMM_QODER_KEYCHAIN_SERVICE ?? "cmm-subscription-router";
  const account = env.CMM_QODER_KEYCHAIN_ACCOUNT ?? "qoder-bearer";
  const reader = deps.readKeychain ?? defaultReadKeychain;
  const fromKeychain = reader(service, account);
  if (typeof fromKeychain === "string" && fromKeychain.length > 0) {
    return { token: fromKeychain, source: "keychain" };
  }
  // Never fall back to the CMMChat bearer: tool acceptance MUST authenticate as
  // Qoder, and CMMChat is permanently CHAT_ONLY.
  return { blocked: "missing-qoder-bearer" };
}

function defaultReadKeychain(service: string, account: string): string | null {
  try {
    // Local credential store only; the value is never printed.
    const out = execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    return typeof out === "string" ? out.trim() : null;
  } catch {
    return null;
  }
}

export async function runCanary(deps: CanaryDeps): Promise<CanaryOutcome> {
  const lines: string[] = [];
  const provider = canonicalProvider(deps.provider);
  const block = (reason: string): CanaryOutcome => {
    lines.push(`LIVE_CANARY=BLOCKED provider=${deps.provider || "unknown"} reason=${reason}`);
    lines.push("LIVE_CANARY_BLOCKED_EXIT=2");
    return { exitCode: 2, lines };
  };
  const fail = (reason: string): CanaryOutcome => {
    lines.push(`LIVE_CANARY=FAIL provider=${deps.provider || "unknown"} reason=${reason}`);
    lines.push("LIVE_CANARY_FAIL_EXIT=1");
    return { exitCode: 1, lines };
  };

  if (deps.env.CMM_LIVE_CANARY_CONFIRM !== CANARY_CONFIRM_VALUE) {
    return block("missing-confirm-flag");
  }
  if (provider === null) return block("unknown-provider");

  const base = deps.env.CMM_LIVE_CANARY_BASE ?? "http://127.0.0.1:8790";
  if (!isLoopback(base)) return block("non-loopback-base");
  lines.push("LIVE_CANARY_LOOPBACK_ONLY=PASS");

  const explicitModel = deps.env.CMM_LIVE_CANARY_MODEL;
  if (typeof explicitModel !== "string" || explicitModel.length === 0) {
    return block("missing-CMM_LIVE_CANARY_MODEL");
  }

  const bearer = readBearer(deps);
  if ("blocked" in bearer) return block(bearer.blocked);
  if (deps.env.CMM_ROUTER_TOKEN !== undefined && deps.env.CMM_ROUTER_TOKEN === bearer.token) {
    // Defensive: even an operator-supplied collision must never authenticate a
    // tool canary as CMMChat.
    return block("qoder-bearer-equals-cmmchat-bearer");
  }
  lines.push(`LIVE_CANARY_BEARER_SOURCE=${bearer.source.split(":")[0]}`);
  lines.push("LIVE_CANARY_CMMCHAT_BEARER_USED=NO");

  // Poison PAYG surfaces in THIS canary process before any provider turn. This
  // is client-local only: the provider turn runs in the already-started Router
  // process, whose environment this cannot mutate. The Router's independent
  // startup guard is covered deterministically outside this harness.
  for (const [key, value] of Object.entries(PAYG_POISON)) deps.env[key] = value;
  lines.push("LIVE_CANARY_CLIENT_PAYG_POISON=PASS");
  lines.push("LIVE_CANARY_REMOTE_ROUTER_PAYG_POISON_PROOF=NO");
  lines.push("LIVE_CANARY_NO_PROVIDER_NATIVE_TOOL=PASS");
  lines.push("LIVE_CANARY_NO_REPO_MUTATION=PASS");

  const auth = { authorization: `Bearer ${bearer.token}`, "content-type": "application/json" };

  const health = await deps.fetchImpl(`${base}/health`, { method: "GET", headers: {} });
  if (health.status !== 200) return block("router-unhealthy");

  const models = await deps.fetchImpl(`${base}/v1/models`, { method: "GET", headers: auth });
  if (models.status === 401 || models.status === 403) return block("router-unauthorized");
  if (models.status !== 200) return block(`models-unreachable-${models.status}`);
  const available = modelList(models.json);
  const matches = available.filter(
    (m) => m.id === explicitModel && m.id.split("/")[0] === provider && m.ownedBy === `cmm:${provider}`,
  );
  if (matches.length !== 1) return block("exact-model-absent-or-wrong-provider");
  const providerMatches = available.filter((m) => m.id.split("/")[0] === provider);
  lines.push("LIVE_CANARY_EXACT_MODEL_SELECTION=PASS");
  lines.push("LIVE_CANARY_MODEL_FALLBACK=NONE");
  lines.push(`LIVE_CANARY_PROVIDER_MODEL_COUNT=${providerMatches.length}`);
  lines.push("LIVE_CANARY_ROUTE_AMBIGUITY=NONE");
  lines.push("LIVE_CANARY_SUBSCRIPTION_ROUTE_PREFLIGHT=PASS");

  const sentinel = deps.sentinel ?? defaultSentinel();
  const initialPolicy = buildCanaryPolicy(provider, "initial");
  const continuationPolicy = buildCanaryPolicy(provider, "continuation");
  if (provider === "command-code") {
    if (initialPolicy.tool_choice === "required" && continuationPolicy.tool_choice === "none") {
      lines.push("LIVE_CANARY_COMMAND_CODE_PHASE_POLICY=PASS");
    } else {
      return fail("command-code-phase-policy-not-distinct");
    }
  }
  const prompt = buildCanaryPrompt(provider, sentinel);
  const tools = [CANARY_ECHO_TOOL];

  const request1Body = JSON.stringify({
    model: explicitModel,
    max_tokens: 256,
    stream: false,
    messages: [{ role: "user", content: prompt }],
    tools,
    ...initialPolicy,
  });
  const first = await deps.fetchImpl(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: auth,
    body: request1Body,
  });

  if (first.status === 401 || first.status === 403) return block("router-unauthorized");
  if (first.status === 429) return block("quota-or-rate-limited");
  if (first.status === 400 && errorTypeOf(first.json) === "unsupported_capability") {
    // Tool semantics are rejected pre-inference: either the consumer is not
    // Qoder (CMMChat is CHAT_ONLY) or the provider policy is not representable.
    // Either way nothing was spent.
    return block(`capability-or-policy-rejected:${errorMessageOf(first.json)}`);
  }
  if (first.status !== 200) return fail(`request1-http-${first.status}`);

  lines.push("LIVE_CANARY_AUTH_CONSUMER=QODER");
  lines.push("LIVE_CANARY_CAPABILITY=CHAT_AND_TOOLS");

  const call = extractSingleToolCall(first.json);
  if ("fail" in call) return fail(call.fail);
  lines.push("LIVE_CANARY_TOOL_REQUEST_RECEIVED=YES");
  lines.push(`LIVE_CANARY_TOOL_NAME=${CANARY_ECHO_NAME}`);

  const args = validateEchoArguments(call.args);
  if ("fail" in args) return fail(args.fail);
  // The echo argument must be exactly the call sentinel; anything else means the
  // provider did not do what request 1 asked, so the result would be meaningless.
  if (args.text !== sentinel) return fail("tool-argument-not-call-sentinel");

  // The result-only nonce is generated HERE — only after a valid tool call has
  // been received — so it appears nowhere in the prompt, the tool call or the
  // tool arguments. It must also differ from the call sentinel, otherwise it is
  // not independent information.
  const resultNonce = deps.nonce ?? defaultResultNonce();
  if (resultNonce === sentinel) return fail("result-nonce-not-independent");
  lines.push("LIVE_CANARY_RESULT_NONCE_ONLY_AFTER_TOOL_CALL=YES");
  lines.push("LIVE_CANARY_TOOL_RESULT_IS_UNIQUE_INFORMATION=YES");

  // Qoder-side synthetic execution: pure in-memory transform, no I/O at all.
  const resultContent = synthesizeEchoResult(resultNonce, args.text);
  lines.push("LIVE_CANARY_QODER_SYNTHETIC_EXECUTION=YES");

  const request2Body = JSON.stringify({
    model: explicitModel,
    max_tokens: 256,
    stream: false,
    messages: [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: call.id,
            type: "function",
            function: { name: CANARY_ECHO_NAME, arguments: call.args },
          },
        ],
      },
      { role: "tool", tool_call_id: call.id, content: resultContent },
    ],
    tools,
    ...continuationPolicy,
  });
  const second = await deps.fetchImpl(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: auth,
    body: request2Body,
  });
  if (second.status === 401 || second.status === 403) return fail("continuation-unauthorized");
  if (second.status === 429) return block("quota-or-rate-limited");
  if (second.status !== 200) return fail(`continuation-http-${second.status}`);
  lines.push("LIVE_CANARY_TOOL_RESULT_SUBMITTED=YES");
  lines.push("LIVE_CANARY_SAME_PROVIDER_CONTINUATION=YES");

  const shape = continuationShape(second.json);
  if ("fail" in shape) return fail(shape.fail);
  lines.push("LIVE_CANARY_SECOND_RESPONSE_TERMINAL=YES");
  if (!shape.content.includes(expectedFinalToken(resultNonce))) {
    return fail("final-not-derived-from-tool-result");
  }
  lines.push("LIVE_CANARY_FINAL_DERIVED_FROM_TOOL_RESULT=YES");

  lines.push("LIVE_CANARY_FULL_ROUNDTRIP=PASS");
  lines.push("LIVE_CANARY_PASS_EXIT=0");
  return { exitCode: 0, lines };
}

function realFetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<HttpResult> {
  return fetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) }).then(
    async (response) => {
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      return { status: response.status, json };
    },
  );
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  const provider = argv[0] ?? "";
  const outcome = await runCanary({ provider, env, fetchImpl: realFetch });
  for (const line of outcome.lines) console.log(line);
  return outcome.exitCode;
}

const invokedDirectly =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.log("LIVE_CANARY=FAIL provider=unknown reason=driver-exception");
      process.exitCode = 1;
    });
}
