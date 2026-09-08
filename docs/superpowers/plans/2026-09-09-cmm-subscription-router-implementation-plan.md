# CMM Subscription Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first OpenAI-compatible router that lets Qoder consume ChatGPT/Codex, Claude, Google AI Pro/Antigravity, and Command Code through one endpoint, with explicit model namespaces, machine-local credentials, and no silent PAYG or cross-provider fallback.

**Architecture:** A TypeScript service listens on `127.0.0.1:8790`, authenticates Qoder with a local bearer secret, resolves a namespaced model to one provider adapter, and translates provider-specific streaming/events into OpenAI-compatible Chat Completions and Responses APIs. Provider credentials remain under each provider's supported local authentication mechanism; the router never copies OAuth tokens. The same codebase runs independently on MacBook and iMac, while internal provider contracts are transport-neutral so a future remote-worker layer can be added without rewriting adapters.

**Tech Stack:** Node.js 26+, TypeScript 5.x, Fastify, Zod, Vitest, `tsx`, native `fetch`, Node child processes/readline, Claude Agent SDK, Codex `app-server` JSON-RPC over stdio, Antigravity `agy` headless NDJSON, Command Code Provider API.

**Spec:** `docs/superpowers/specs/2026-09-09-cmm-subscription-router-design.md`

## Global Constraints

- Bind standalone HTTP only to `127.0.0.1`.
- Default port is `8790`.
- Provider namespaces are exactly `chatgpt/*`, `claude/*`, `google/*`, and `command-code/*`.
- Qwen remains native in Qoder and is not routed in v1.
- No automatic provider selection.
- No cross-provider fallback.
- No API PAYG fallback.
- No OAuth token extraction, copying, synchronization, or logging.
- Qoder is the sole tool executor for routed requests.
- Unknown providers and models fail closed.
- Shared configuration contains no secrets.
- MacBook and iMac authenticate independently.
- Initial validation is manual; launchd is installed only after all four provider adapters pass integration acceptance.
- All provider adapters must implement one transport-neutral internal contract.
- Prompt/completion bodies are not logged by default.
- Every provider-specific PAYG environment variable must be rejected or explicitly ignored by policy, never silently consumed.
- Command Code may use its Provider API only against the user's GOAT subscription entitlement; before enabling it, auto top-up must be disabled and the account must have no on-demand/extra-credit balance intended for automatic fallback.

---

## File Map

The implementation should converge on this shape:

```text
CMM-Subscription-Router/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── .env.example
├── src/
│   ├── index.ts
│   ├── config/
│   │   ├── schema.ts
│   │   ├── load-config.ts
│   │   └── machine-id.ts
│   ├── core/
│   │   ├── provider.ts
│   │   ├── model.ts
│   │   ├── events.ts
│   │   ├── errors.ts
│   │   └── abort.ts
│   ├── security/
│   │   ├── bearer-auth.ts
│   │   ├── secret-redaction.ts
│   │   └── payg-guard.ts
│   ├── registry/
│   │   └── provider-registry.ts
│   ├── http/
│   │   ├── server.ts
│   │   ├── openai-chat.ts
│   │   ├── openai-responses.ts
│   │   ├── sse.ts
│   │   └── diagnostics.ts
│   ├── providers/
│   │   ├── codex/
│   │   │   ├── app-server-client.ts
│   │   │   ├── protocol.ts
│   │   │   └── adapter.ts
│   │   ├── claude/
│   │   │   ├── sdk-client.ts
│   │   │   └── adapter.ts
│   │   ├── antigravity/
│   │   │   ├── process-client.ts
│   │   │   ├── protocol.ts
│   │   │   └── adapter.ts
│   │   └── command-code/
│   │       ├── client.ts
│   │       └── adapter.ts
│   └── observability/
│       └── usage-store.ts
├── config/
│   └── shared.example.json
├── scripts/
│   ├── preflight.sh
│   ├── install-launchagent.sh
│   ├── uninstall-launchagent.sh
│   └── qoder-smoke.sh
├── tests/
│   ├── config/
│   ├── core/
│   ├── security/
│   ├── registry/
│   ├── http/
│   ├── providers/
│   ├── integration/
│   └── fixtures/
└── docs/
    └── superpowers/
        ├── specs/
        │   └── 2026-09-09-cmm-subscription-router-design.md
        └── plans/
            └── 2026-09-09-cmm-subscription-router-implementation-plan.md
```

---

### Task 1: Bootstrap the repository and pin the test toolchain

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `docs/superpowers/specs/2026-09-09-cmm-subscription-router-design.md`
- Create: `docs/superpowers/plans/2026-09-09-cmm-subscription-router-implementation-plan.md`
- Test: `tests/core/bootstrap.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: Node/TypeScript test/build commands used by all later tasks.

- [ ] **Step 1: Initialize Git and package metadata**

Run:

```bash
mkdir -p "$HOME/CMM-Subscription-Router"
cd "$HOME/CMM-Subscription-Router"
git init
npm init -y
```

Set `package.json` scripts to:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

- [ ] **Step 2: Install only the initial shared dependencies**

Run:

```bash
npm install fastify zod
npm install -D typescript tsx vitest @types/node
```

Do not install provider SDKs until the provider task that needs them.

- [ ] **Step 3: Add strict TypeScript configuration**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 4: Write the first failing bootstrap test**

Create `tests/core/bootstrap.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("bootstrap", () => {
  it("runs the TypeScript test toolchain", () => {
    expect(process.versions.node).toBeTruthy();
  });
});
```

- [ ] **Step 5: Run the baseline checks**

Run:

```bash
npm test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 6: Add ignore rules**

Create `.gitignore`:

```gitignore
node_modules/
dist/
.env
.env.local
config/local.json
runtime/
*.log
.DS_Store
```

- [ ] **Step 7: Copy the approved spec and this plan into the repository**

The repository copies must be byte-for-byte identical to the approved artifacts at the start of implementation.

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "chore: bootstrap CMM Subscription Router"
```

---

### Task 2: Define the transport-neutral provider contract and normalized event model

**Files:**
- Create: `src/core/model.ts`
- Create: `src/core/events.ts`
- Create: `src/core/provider.ts`
- Create: `src/core/errors.ts`
- Create: `tests/core/provider-contract.test.ts`

**Interfaces:**
- Consumes: none.
- Produces:
  - `ProviderId`
  - `DiscoveredModel`
  - `RouterRequest`
  - `RouterEvent`
  - `ProviderAdapter`
  - `RouterError`

- [ ] **Step 1: Write failing contract tests**

Create `tests/core/provider-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RouterError } from "../../src/core/errors.js";

describe("RouterError", () => {
  it("keeps stable error categories and safe metadata", () => {
    const error = new RouterError(
      "provider_quota_exhausted",
      "quota exhausted",
      { provider: "google", retryAfterMs: 5000 },
    );

    expect(error.code).toBe("provider_quota_exhausted");
    expect(error.meta.provider).toBe("google");
  });
});
```

Run:

```bash
npm test -- tests/core/provider-contract.test.ts
```

Expected: FAIL because modules do not exist.

- [ ] **Step 2: Define exact model and request types**

Create `src/core/model.ts` with:

```ts
export type ProviderId =
  | "chatgpt"
  | "claude"
  | "google"
  | "command-code";

export interface DiscoveredModel {
  id: string;
  provider: ProviderId;
  upstreamModel: string;
  displayName: string;
}

export interface RouterTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface RouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCallId?: string;
  name?: string;
}

export interface RouterRequest {
  requestId: string;
  model: DiscoveredModel;
  messages: RouterMessage[];
  tools: RouterTool[];
  stream: boolean;
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
}
```

- [ ] **Step 3: Define normalized streaming events**

Create `src/core/events.ts`:

```ts
export type RouterEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call_delta";
      index: number;
      id: string;
      name?: string;
      argumentsDelta?: string;
    }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      cacheReadTokens?: number;
    }
  | { type: "completed"; finishReason: "stop" | "tool_calls" | "length" }
  | { type: "error"; error: unknown };
```

- [ ] **Step 4: Define the provider interface**

Create `src/core/provider.ts`:

```ts
import type { DiscoveredModel, ProviderId, RouterRequest } from "./model.js";
import type { RouterEvent } from "./events.js";

export interface ProviderHealth {
  status: "ready" | "degraded" | "unavailable" | "auth_required";
  detail?: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  discoverModels(signal?: AbortSignal): Promise<DiscoveredModel[]>;
  health(signal?: AbortSignal): Promise<ProviderHealth>;
  run(
    request: RouterRequest,
    signal: AbortSignal,
  ): AsyncIterable<RouterEvent>;
  cancel(requestId: string): Promise<void>;
}
```

- [ ] **Step 5: Define stable router errors**

Create `src/core/errors.ts`:

```ts
export type RouterErrorCode =
  | "invalid_request"
  | "unknown_provider"
  | "unknown_model"
  | "provider_unavailable"
  | "provider_auth_required"
  | "provider_quota_exhausted"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_protocol_error"
  | "router_unauthorized"
  | "router_internal_error";

export class RouterError extends Error {
  constructor(
    public readonly code: RouterErrorCode,
    message: string,
    public readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RouterError";
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

```bash
npm test -- tests/core/provider-contract.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core tests/core
git commit -m "feat: define provider contract and normalized events"
```

---

### Task 3: Add shared/local configuration, machine identity, bearer authentication, and PAYG guards

**Files:**
- Create: `src/config/schema.ts`
- Create: `src/config/load-config.ts`
- Create: `src/config/machine-id.ts`
- Create: `src/security/bearer-auth.ts`
- Create: `src/security/secret-redaction.ts`
- Create: `src/security/payg-guard.ts`
- Create: `config/shared.example.json`
- Test: `tests/config/load-config.test.ts`
- Test: `tests/security/payg-guard.test.ts`
- Test: `tests/security/redaction.test.ts`

**Interfaces:**
- Produces:
  - `RouterConfig`
  - `loadConfig()`
  - `assertNoPaygFallback()`
  - `redactObject()`
  - `verifyBearer()`

- [ ] **Step 1: Write failing tests for forbidden PAYG variables**

Create `tests/security/payg-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertNoPaygFallback } from "../../src/security/payg-guard.js";

describe("PAYG guard", () => {
  it("rejects OpenAI PAYG fallback", () => {
    expect(() =>
      assertNoPaygFallback({ OPENAI_API_KEY: "set" }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it("rejects Anthropic PAYG fallback", () => {
    expect(() =>
      assertNoPaygFallback({ ANTHROPIC_API_KEY: "set" }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("rejects Gemini PAYG fallback", () => {
    expect(() =>
      assertNoPaygFallback({ GEMINI_API_KEY: "set" }),
    ).toThrow(/GEMINI_API_KEY/);
  });
});
```

- [ ] **Step 2: Implement PAYG guard**

Create `src/security/payg-guard.ts`:

```ts
const forbidden = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

export function assertNoPaygFallback(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  const present = forbidden.filter((key) => Boolean(env[key]));
  if (present.length > 0) {
    throw new Error(
      `PAYG fallback blocked; unset: ${present.join(", ")}`,
    );
  }
}
```

- [ ] **Step 3: Write config tests**

Test that:
- host other than `127.0.0.1` is rejected in standalone mode;
- provider namespaces are fixed;
- local config can reference profile names but not contain `apiKey`, `oauthToken`, or `accessToken`.

Use Zod refinements so secret-like keys fail validation.

- [ ] **Step 4: Implement config schema**

`RouterConfig` must include:

```ts
{
  mode: "standalone";
  host: "127.0.0.1";
  port: number;
  bearerSecretEnv: string;
  providers: {
    chatgpt: { enabled: boolean; codexHome?: string };
    claude: { enabled: boolean; profileDir?: string };
    google: { enabled: boolean; agyPath?: string };
    "command-code": {
      enabled: boolean;
      baseUrl: string;
      secretEnv: string;
    };
  };
}
```

Do not permit raw secret values in JSON.

- [ ] **Step 5: Implement machine ID**

`src/config/machine-id.ts` should:
1. read `CMM_MACHINE_ID` if set;
2. otherwise derive a stable non-secret local identifier from `scutil --get ComputerName`;
3. sanitize to lowercase `[a-z0-9-]`;
4. never embed username or home path.

- [ ] **Step 6: Implement constant-time bearer comparison**

Use `crypto.timingSafeEqual` in `verifyBearer()` and reject missing/incorrect `Authorization: Bearer ...`.

- [ ] **Step 7: Implement structural redaction**

At minimum redact keys matching:

```text
authorization
api_key
apikey
access_token
refresh_token
oauth
secret
cookie
```

recursively before diagnostic logging.

- [ ] **Step 8: Run tests**

```bash
npm test -- tests/config tests/security
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/config src/security config tests/config tests/security
git commit -m "feat: add secure configuration and PAYG guards"
```

---

### Task 4: Build the provider registry and dynamic model namespace resolver

**Files:**
- Create: `src/registry/provider-registry.ts`
- Test: `tests/registry/provider-registry.test.ts`

**Interfaces:**
- Consumes: `ProviderAdapter`, `DiscoveredModel`.
- Produces:
  - `ProviderRegistry.refresh()`
  - `ProviderRegistry.listModels()`
  - `ProviderRegistry.resolve(modelId)`

- [ ] **Step 1: Write failing tests with fake providers**

The tests must prove:
- `chatgpt/model-a` resolves only to ChatGPT.
- `claude/model-a` cannot resolve to ChatGPT even if upstream names collide.
- unknown prefix → `unknown_provider`.
- known provider + missing model → `unknown_model`.
- one provider failure during discovery does not erase healthy providers.
- no fallback occurs.

- [ ] **Step 2: Implement registry with short discovery cache**

Use a 30-second cache keyed by provider ID. A discovery failure records provider health as degraded but does not substitute models.

- [ ] **Step 3: Run tests**

```bash
npm test -- tests/registry/provider-registry.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/registry tests/registry
git commit -m "feat: add explicit provider and model registry"
```

---

### Task 5: Build the authenticated HTTP skeleton and diagnostic endpoints

**Files:**
- Create: `src/http/server.ts`
- Create: `src/http/diagnostics.ts`
- Create: `src/index.ts`
- Test: `tests/http/server.test.ts`

**Interfaces:**
- Consumes: config, auth, provider registry.
- Produces:
  - `buildServer()`
  - `GET /health`
  - `GET /ready`
  - `GET /v1/models`
  - `GET /v1/cmm/providers`
  - `GET /v1/cmm/health`

- [ ] **Step 1: Write failing Fastify injection tests**

Verify:
- no auth → `401`;
- wrong bearer → `401`;
- correct bearer → `/health` returns `{"status":"ok"}`;
- `/v1/models` emits OpenAI-style model objects with namespaced IDs;
- `/ready` is `503` if all enabled providers are unavailable;
- diagnostic responses contain no secrets.

- [ ] **Step 2: Implement `buildServer()`**

Never enable Fastify request-body logging. Register a pre-handler that validates bearer auth for `/v1/*`; `/health` may remain unauthenticated only on loopback.

- [ ] **Step 3: Map `/v1/models`**

Return:

```json
{
  "object": "list",
  "data": [
    {
      "id": "chatgpt/example",
      "object": "model",
      "owned_by": "cmm:chatgpt"
    }
  ]
}
```

- [ ] **Step 4: Run tests and build**

```bash
npm test -- tests/http/server.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http src/index.ts tests/http
git commit -m "feat: add authenticated router HTTP skeleton"
```

---

### Task 6: Implement the Codex App Server JSON-RPC client

**Files:**
- Create: `src/providers/codex/protocol.ts`
- Create: `src/providers/codex/app-server-client.ts`
- Test: `tests/providers/codex-app-server-client.test.ts`
- Fixture: `tests/fixtures/codex-app-server.jsonl`

**Interfaces:**
- Produces `CodexAppServerClient` with:
  - `start()`
  - `initialize()`
  - `startThread()`
  - `startTurn()`
  - `interruptTurn()`
  - async event stream
  - `stop()`

- [ ] **Step 1: Lock protocol assumptions in tests**

Tests must verify the wire sequence:

```text
spawn `codex app-server --stdio`
→ request `initialize`
→ notification `initialized`
→ request `thread/start`
→ request `turn/start`
→ notifications `item/agentMessage/delta`
→ notification `turn/completed`
```

Use a fake child process/duplex stream; do not invoke real Codex in unit tests.

- [ ] **Step 2: Implement a request ID correlator**

`app-server-client.ts` must keep:
- monotonically increasing numeric request IDs;
- a `Map<number, {resolve,reject}>`;
- a newline-delimited stdout parser;
- a separate notification async queue.

Malformed JSON from stdout must become `provider_protocol_error`.

- [ ] **Step 3: Implement the initialization handshake**

Send:

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": {
      "name": "cmm-subscription-router",
      "title": "CMM Subscription Router",
      "version": "0.1.0"
    }
  }
}
```

Then send the `initialized` notification before any thread call.

- [ ] **Step 4: Ensure turns cannot mutate the workspace**

For routed calls:
- create ephemeral threads;
- do not pass a project `cwd`;
- use the most restrictive supported sandbox/permission profile discovered from the installed app-server schema;
- reject any server-initiated command/file approval request rather than approving it.

The client must treat command/file approval requests as a policy violation and reply with a decline/cancel decision.

- [ ] **Step 5: Generate and archive the installed protocol schema during integration**

During real integration, run the installed Codex schema-generation command supported by `codex app-server` and store only non-secret protocol fixtures under `tests/fixtures/generated/codex/`. The implementation must use current accepted enum values from that schema rather than relying on stale examples.

- [ ] **Step 6: Run tests**

```bash
npm test -- tests/providers/codex-app-server-client.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/providers/codex tests/providers tests/fixtures
git commit -m "feat: add Codex app-server JSON-RPC client"
```

---

### Task 7: Implement the ChatGPT/Codex provider adapter

**Files:**
- Create: `src/providers/codex/adapter.ts`
- Test: `tests/providers/codex-adapter.test.ts`
- Integration: `tests/integration/codex.integration.test.ts`

**Interfaces:**
- Implements `ProviderAdapter`.
- Consumes `CodexAppServerClient`.
- Produces normalized text/usage/completion/error events.

- [ ] **Step 1: Write adapter tests from captured safe fixtures**

Tests must cover:
- model discovery;
- text deltas;
- token usage;
- completion;
- interruption;
- auth required;
- quota/rate-limit errors;
- attempted native command/file action is refused.

- [ ] **Step 2: Implement model discovery**

Prefer Codex app-server's model discovery endpoint/method if exposed by the installed schema. If the current app-server exposes model listing through the standard model APIs, use that exact method and namespace every returned upstream ID as `chatgpt/<id>`.

No hardcoded GPT model list is permitted.

- [ ] **Step 3: Translate one Qoder request into one ephemeral Codex turn**

The adapter must:
1. flatten supported system/user/assistant/tool history into Codex input/context without asking Codex to execute workspace tools;
2. select the exact upstream model;
3. map `reasoningEffort`;
4. stream `item/agentMessage/delta`;
5. map `thread/tokenUsage/updated`;
6. finish on `turn/completed`.

- [ ] **Step 4: Implement cancellation**

`cancel(requestId)` must map active request IDs to `(threadId, turnId)` and call `turn/interrupt`.

- [ ] **Step 5: Run mocked tests**

```bash
npm test -- tests/providers/codex-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run real subscription integration**

Preconditions:

```bash
codex login status
```

Expected: contains `Logged in using ChatGPT`.

Also verify:

```bash
test -z "${OPENAI_API_KEY:-}"
```

Expected exit: `0`.

Run only the Codex integration test:

```bash
CMM_RUN_LIVE=1 npm test -- tests/integration/codex.integration.test.ts
```

Expected:
- text response returned;
- no API key required;
- no repository mutation;
- provider health `ready`.

- [ ] **Step 7: Commit**

```bash
git add src/providers/codex tests/providers/codex-adapter.test.ts tests/integration/codex.integration.test.ts
git commit -m "feat: route ChatGPT subscription through Codex app-server"
```

---

### Task 8: Implement the isolated Claude subscription adapter

**Files:**
- Create: `src/providers/claude/sdk-client.ts`
- Create: `src/providers/claude/adapter.ts`
- Test: `tests/providers/claude-adapter.test.ts`
- Integration: `tests/integration/claude.integration.test.ts`

**Interfaces:**
- Implements `ProviderAdapter`.
- Must use a dedicated router Claude profile/config directory.
- Must never inherit the user's existing OmniRoute base URL or `ANTHROPIC_API_KEY`.

- [ ] **Step 1: Install the official Claude Agent SDK**

Use the current official TypeScript package documented by Anthropic at implementation time. Pin the exact installed version in `package-lock.json`.

- [ ] **Step 2: Write failing environment-isolation tests**

The child/SDK environment builder must:
- remove `ANTHROPIC_API_KEY`;
- remove `ANTHROPIC_BASE_URL`;
- point Claude configuration to the dedicated CMM Router profile directory;
- preserve only explicitly allowlisted environment variables.

Test that a parent environment containing `http://localhost:20128` cannot leak into the router Claude adapter.

- [ ] **Step 3: Implement the isolated SDK client**

The client must:
- select exact model;
- disable built-in filesystem/shell/web tools for Qoder-routed requests;
- accept only externally supplied model context;
- expose text/tool-request/usage events where the SDK provides them;
- cancel through the SDK's abort mechanism.

- [ ] **Step 4: Implement Claude model discovery**

Use the supported model listing/configuration mechanism exposed to the subscription-backed SDK/Claude Code installation. If the SDK has no authoritative dynamic list, discover through the installed Claude runtime and include only IDs confirmed usable by a zero-output/metadata probe; cache results for 30 seconds.

No static model list may be treated as authoritative.

- [ ] **Step 5: Map errors**

At minimum:
- unauthenticated → `provider_auth_required`;
- subscription limit / 429 → `provider_quota_exhausted` or `provider_rate_limited`;
- timeout → `provider_timeout`;
- malformed SDK event → `provider_protocol_error`.

- [ ] **Step 6: Run mocked tests**

```bash
npm test -- tests/providers/claude-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 7: Create and authenticate the dedicated profile manually**

The integration setup must not log out or rewrite the normal `~/.claude` profile.

Verify the adapter's process environment contains neither:

```text
ANTHROPIC_API_KEY
ANTHROPIC_BASE_URL=http://localhost:20128
```

- [ ] **Step 8: Run real subscription integration**

```bash
CMM_RUN_LIVE=1 npm test -- tests/integration/claude.integration.test.ts
```

Expected:
- text response succeeds through subscription authentication;
- OmniRoute is untouched;
- no Anthropic API key is present;
- provider-native filesystem/shell mutation is impossible.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/providers/claude tests/providers/claude-adapter.test.ts tests/integration/claude.integration.test.ts
git commit -m "feat: add isolated Claude subscription adapter"
```

---

### Task 9: Implement the Google AI Pro / Antigravity adapter

**Files:**
- Create: `src/providers/antigravity/protocol.ts`
- Create: `src/providers/antigravity/process-client.ts`
- Create: `src/providers/antigravity/adapter.ts`
- Test: `tests/providers/antigravity-adapter.test.ts`
- Fixture: `tests/fixtures/antigravity-stream.ndjson`
- Integration: `tests/integration/antigravity.integration.test.ts`

**Interfaces:**
- Implements `ProviderAdapter`.
- Uses official `agy` headless machine-readable output.

- [ ] **Step 1: Write parser tests from NDJSON fixtures**

Fixture must include:
- `init`;
- `step_update` with `agent_response.text_delta`;
- usage;
- terminal `result` with `SUCCESS`;
- a second fixture with `ERROR`.

Test parser output into `RouterEvent`.

- [ ] **Step 2: Implement safe process spawning**

Spawn exact model using:

```text
agy --model <upstream-model> --input-format stream-json --output-format stream-json
```

Feed one JSON `user` event per routed turn via stdin.

Never pass:
- `--dangerously-skip-permissions`;
- a PAYG provider setting;
- `GEMINI_API_KEY`;
- `GOOGLE_API_KEY`.

- [ ] **Step 3: Implement model discovery**

Invoke:

```bash
agy models
```

Parse the authoritative model slugs from stdout. Namespace them `google/<slug>`.

Unknown pinned models must remain errors; never allow Antigravity to silently substitute another model.

- [ ] **Step 4: Implement cancellation**

On abort:
1. close stdin;
2. send `SIGINT`;
3. after a bounded grace period, send `SIGTERM`;
4. record `provider_timeout` only if the process fails to terminate.

- [ ] **Step 5: Block provider-native actions**

Use Antigravity's restrictive permission/sandbox controls in headless mode. If an event indicates an unapproved command/write action, normalize it as a policy failure rather than granting permission.

- [ ] **Step 6: Run mocked tests**

```bash
npm test -- tests/providers/antigravity-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run live preflight**

```bash
command -v agy
agy --version
agy models
test -z "${GEMINI_API_KEY:-}"
test -z "${GOOGLE_API_KEY:-}"
```

Expected: CLI works and both API variables are absent.

- [ ] **Step 8: Run real subscription integration**

```bash
CMM_RUN_LIVE=1 npm test -- tests/integration/antigravity.integration.test.ts
```

Expected:
- response succeeds using cached account credentials;
- exact model pinning works;
- no PAYG variables;
- no autonomous repo mutation.

- [ ] **Step 9: Commit**

```bash
git add src/providers/antigravity tests/providers/antigravity-adapter.test.ts tests/fixtures/antigravity-stream.ndjson tests/integration/antigravity.integration.test.ts
git commit -m "feat: add Google AI Pro Antigravity adapter"
```

---

### Task 10: Implement the Command Code GOAT adapter with hard spending guard

**Files:**
- Create: `src/providers/command-code/client.ts`
- Create: `src/providers/command-code/adapter.ts`
- Create: `src/providers/command-code/spend-guard.ts`
- Test: `tests/providers/command-code-adapter.test.ts`
- Test: `tests/providers/command-code-spend-guard.test.ts`
- Integration: `tests/integration/command-code.integration.test.ts`

**Interfaces:**
- Implements `ProviderAdapter`.
- Uses the Command Code Provider API because GOAT officially includes API access and Provider API requests are metered against GOAT plan credits.
- Consumes only the same Command Code account/API credential used by the subscribed account.
- Must not be enabled until the user has explicitly confirmed that Command Code Studio auto top-up is disabled and that no on-demand credit balance should be consumed after GOAT window exhaustion.

- [ ] **Step 1: Write the spending-guard tests first**

`spend-guard.ts` must require a local, non-synchronized acknowledgement file such as:

```json
{
  "version": 1,
  "plan": "GOAT",
  "autoTopUpDisabled": true,
  "allowOnDemandCredits": false
}
```

The router must refuse to enable `command-code/*` if:
- the file is missing;
- `plan !== "GOAT"`;
- `autoTopUpDisabled !== true`;
- `allowOnDemandCredits !== false`.

This does not claim to introspect Command Code billing; it forces the account-side safety check to be an explicit prerequisite rather than an implicit assumption.

- [ ] **Step 2: Write HTTP-client tests with a fake server**

Verify:
- `GET /provider/v1/models` discovery;
- `POST /provider/v1/chat/completions` streaming;
- bearer header added;
- header redacted from logs;
- 401 → `provider_auth_required`;
- 429 / rolling-window exhaustion → `provider_rate_limited` or `provider_quota_exhausted`;
- insufficient credits → `provider_quota_exhausted`;
- never switches to another provider;
- adapter is disabled if the spending acknowledgement is absent.

- [ ] **Step 3: Implement the client**

Default base URL:

```text
https://api.commandcode.ai/provider/v1
```

The secret is read from the configured environment variable name, not from JSON config.

No code may purchase credits, invoke `/extra`, enable auto top-up, or retry through a separate Provider-plan balance.

- [ ] **Step 4: Implement exact model discovery**

Namespace returned IDs:

```text
command-code/<upstream-id>
```

Preserve upstream metadata only if non-secret. Prefer only models currently included in the GOAT account's available catalog.

- [ ] **Step 5: Implement streaming passthrough normalization**

Convert OpenAI-compatible deltas to `RouterEvent`, including tool-call deltas and usage when present.

- [ ] **Step 6: Verify the account-side guard before the live test**

Manually confirm in Command Code Studio:
1. plan is GOAT;
2. auto top-up / auto-reload is OFF;
3. no on-demand credits are intended for fallback.

Then create the local acknowledgement file. It must be ignored by Git and never synchronized.

The official Command Code behavior is important here: GOAT API calls consume GOAT plan credits, but on-demand credits can bypass rolling limits if they exist. Therefore this precondition is part of the security boundary.

- [ ] **Step 7: Run mocked tests**

```bash
npm test -- tests/providers/command-code-adapter.test.ts tests/providers/command-code-spend-guard.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run real GOAT integration**

Load the Command Code key from the existing secure local source into the process environment without printing it, then run:

```bash
CMM_RUN_LIVE=1 npm test -- tests/integration/command-code.integration.test.ts
```

Expected:
- request succeeds against the subscribed GOAT account;
- model is from the GOAT-accessible catalog;
- no extra-credit purchase or top-up action occurs;
- limit exhaustion surfaces as an error rather than cross-provider fallback.

- [ ] **Step 9: Commit**

```bash
git add src/providers/command-code tests/providers/command-code-adapter.test.ts tests/providers/command-code-spend-guard.test.ts tests/integration/command-code.integration.test.ts
git commit -m "feat: add guarded Command Code GOAT adapter"
```

---

### Task 11: Implement OpenAI Chat Completions compatibility and SSE streaming

**Files:**
- Create: `src/http/openai-chat.ts`
- Create: `src/http/sse.ts`
- Test: `tests/http/openai-chat.test.ts`
- Test: `tests/http/sse.test.ts`

**Interfaces:**
- Produces `POST /v1/chat/completions`.
- Consumes `ProviderRegistry.resolve()` and `ProviderAdapter.run()`.

- [ ] **Step 1: Write request-validation tests**

Require:
- valid namespaced `model`;
- `messages` array;
- supported tool schema;
- `stream` boolean if supplied.

Reject unknown fields only when they would create unsafe ambiguity; otherwise preserve OpenAI compatibility.

- [ ] **Step 2: Write non-streaming response tests**

Aggregate normalized events into:

```json
{
  "id": "chatcmpl-cmm-...",
  "object": "chat.completion",
  "model": "chatgpt/...",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "..."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

Tool calls must use OpenAI `tool_calls` shape.

- [ ] **Step 3: Write SSE tests**

Each chunk must be:

```text
data: <json>\n\n
```

and terminate with:

```text
data: [DONE]\n\n
```

Abort the provider request if the client disconnects.

- [ ] **Step 4: Implement endpoint and SSE encoder**

Do not buffer a streaming response.

- [ ] **Step 5: Run tests**

```bash
npm test -- tests/http/openai-chat.test.ts tests/http/sse.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/http tests/http
git commit -m "feat: expose OpenAI Chat Completions API"
```

---

### Task 12: Implement Responses API compatibility

**Files:**
- Create: `src/http/openai-responses.ts`
- Test: `tests/http/openai-responses.test.ts`

**Interfaces:**
- Produces `POST /v1/responses`.
- Uses the same `RouterRequest` and `RouterEvent` contract as Chat Completions.

- [ ] **Step 1: Write translation tests**

Support the subset Qoder needs:
- string `input`;
- message-style input;
- tool definitions;
- streaming;
- exact model;
- reasoning effort;
- max output tokens.

- [ ] **Step 2: Write streaming event tests**

Emit Responses-style events for:
- response creation;
- output text delta;
- function-call argument delta;
- completed response;
- error.

- [ ] **Step 3: Implement translator**

No provider-specific code may appear in this file.

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/http/openai-responses.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/openai-responses.ts tests/http/openai-responses.test.ts
git commit -m "feat: expose OpenAI Responses API"
```

---

### Task 13: Prove Qoder-owned tool round trips and block native provider mutation

**Files:**
- Create: `tests/integration/tool-roundtrip.integration.test.ts`
- Create: `tests/fixtures/tool-contract.ts`
- Modify: provider adapters as required by discovered live behavior.

**Interfaces:**
- Consumes the complete HTTP API.
- Proves tool ownership invariant.

- [ ] **Step 1: Define one harmless deterministic test tool**

Use:

```ts
{
  type: "function",
  function: {
    name: "cmm_echo",
    description: "Return the supplied text unchanged.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" }
      },
      required: ["text"],
      additionalProperties: false
    }
  }
}
```

- [ ] **Step 2: Test each provider with a forced tool-call prompt**

The test must verify:
1. router returns a tool call to Qoder/test client;
2. router does not execute it;
3. test client supplies tool result;
4. provider produces final text.

- [ ] **Step 3: Add a mutation canary**

Run live tests from a temporary read-only fixture directory and assert its file hashes are unchanged before/after routed requests.

- [ ] **Step 4: Run all tool tests**

```bash
CMM_RUN_LIVE=1 npm test -- tests/integration/tool-roundtrip.integration.test.ts
```

Expected: PASS for every enabled provider.

If a provider cannot represent externally-owned tool calls through its subscription-backed runtime, mark that provider `chat_only` in discovered capabilities and do not expose it to Qoder Agent mode until a supported path is implemented. Do not fake tool support.

- [ ] **Step 5: Commit**

```bash
git add src/providers tests/integration tests/fixtures
git commit -m "test: prove Qoder-owned tool execution boundaries"
```

---

### Task 14: Add local-only observability and stable error mapping

**Files:**
- Create: `src/observability/usage-store.ts`
- Modify: `src/http/diagnostics.ts`
- Test: `tests/http/diagnostics.test.ts`
- Test: `tests/observability/usage-store.test.ts`

**Interfaces:**
- Produces `GET /v1/cmm/usage`.
- Tracks only safe metadata.

- [ ] **Step 1: Write tests proving no content retention**

The usage record may contain:

```ts
{
  requestId,
  provider,
  model,
  startedAt,
  durationMs,
  status,
  inputTokens?,
  outputTokens?
}
```

It must not contain:
- prompts;
- completions;
- file paths;
- tool arguments/results;
- Authorization headers;
- provider secrets.

- [ ] **Step 2: Implement bounded in-memory usage store**

Use a fixed-size ring buffer, e.g. last 500 requests. No persistence in v1.

- [ ] **Step 3: Implement stable HTTP error mapping**

Map:
- router unauthorized → 401;
- invalid request / unknown model → 400;
- provider auth required → 401 or 503 with safe provider code;
- quota/rate limit → 429;
- timeout → 504;
- provider unavailable → 503;
- internal → 500.

Body:

```json
{
  "error": {
    "type": "provider_rate_limited",
    "message": "Provider rate limited",
    "provider": "google"
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/http/diagnostics.test.ts tests/observability/usage-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/observability src/http/diagnostics.ts tests
git commit -m "feat: add privacy-preserving diagnostics and usage"
```

---

### Task 15: Add a preflight that proves authentication mode without printing secrets

**Files:**
- Create: `scripts/preflight.sh`
- Test: `tests/integration/preflight.test.ts`

**Interfaces:**
- Produces one safe readiness report before router startup.

- [ ] **Step 1: Write the shell script**

It must print only boolean/status information:

```text
NODE=PASS
CODEX_BINARY=PASS
CODEX_CHATGPT_AUTH=PASS
CLAUDE_BINARY=PASS
CLAUDE_ROUTER_PROFILE=PASS
CLAUDE_PAYG_ENV=UNSET
AGY_BINARY=PASS
GOOGLE_PAYG_ENV=UNSET
COMMAND_CODE_SECRET=SET
```

Never print secret values.

- [ ] **Step 2: Explicitly detect the user's existing Claude configuration**

The script may report:

```text
CLAUDE_DEFAULT_BASE_URL=NONDEFAULT
```

but must not rewrite it. This protects the existing OmniRoute configuration.

- [ ] **Step 3: Test output redaction**

The test runs with dummy secrets and asserts no dummy secret string appears in stdout/stderr.

- [ ] **Step 4: Run**

```bash
bash scripts/preflight.sh
npm test -- tests/integration/preflight.test.ts
```

Expected: safe report and PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/preflight.sh tests/integration/preflight.test.ts
git commit -m "feat: add safe provider authentication preflight"
```

---

### Task 16: Perform Qoder acceptance against one local endpoint

**Files:**
- Create: `scripts/qoder-smoke.sh`
- Create: `docs/qoder-setup.md`
- Test: manual acceptance evidence recorded in `docs/qoder-acceptance.md`

**Interfaces:**
- Validates `http://127.0.0.1:8790/v1`.

- [ ] **Step 1: Start router manually**

Before start:

```bash
bash scripts/preflight.sh
npm run build
npm start
```

Expected bind:

```text
127.0.0.1:8790
```

Never `0.0.0.0`.

- [ ] **Step 2: Verify models**

```bash
curl -s \
  -H "Authorization: Bearer $CMM_ROUTER_TOKEN" \
  http://127.0.0.1:8790/v1/models | python3 -m json.tool
```

Expected models are namespaced and dynamically discovered.

- [ ] **Step 3: Configure Qoder once**

Document:

```text
Provider: CMM Subscription Router
Type: OpenAI Compatible
Base URL: http://127.0.0.1:8790/v1
API key: local router bearer token
```

Try Chat Completions first. Add Responses only after the Chat surface passes Qoder validation.

- [ ] **Step 4: Validate every provider model family**

For each enabled provider:
1. simple chat;
2. streaming;
3. reasoning setting if supported;
4. tool call;
5. Qoder-owned file edit;
6. cancel mid-stream;
7. verify no native provider mutation;
8. verify no PAYG variable/fallback.

- [ ] **Step 5: Simulate provider outage**

Stop/disable one provider transport and verify:
- that model fails;
- router stays healthy for other providers;
- no substitute model/provider is used.

- [ ] **Step 6: Record acceptance**

`docs/qoder-acceptance.md` must contain PASS/FAIL and exact tested model IDs, but no tokens or prompt contents.

- [ ] **Step 7: Commit**

```bash
git add scripts/qoder-smoke.sh docs/qoder-setup.md docs/qoder-acceptance.md
git commit -m "docs: record Qoder router acceptance"
```

---

### Task 17: Add reproducible MacBook/iMac installation with machine-local secrets

**Files:**
- Create: `scripts/install-launchagent.sh`
- Create: `scripts/uninstall-launchagent.sh`
- Create: `docs/macos-install.md`
- Test: `tests/integration/launchagent.test.ts`

**Interfaces:**
- Produces a macOS LaunchAgent only after manual acceptance passes.

- [ ] **Step 1: Generate a launchd plist from a template**

Requirements:
- label: `com.cmm.subscription-router`;
- runs compiled `dist/index.js`;
- working directory is the local clone;
- starts at login;
- restarts only on unexpected failure with bounded throttle;
- stdout/stderr go to local `~/Library/Logs/CMM-Subscription-Router/`;
- secrets are not embedded in the plist.

- [ ] **Step 2: Resolve secrets through machine-local secure storage**

For the router bearer token and Command Code secret, use macOS Keychain service/account identifiers. The wrapper process reads them at startup without echoing them.

Do not synchronize Keychain exports.

- [ ] **Step 3: Test plist safety**

Assert generated plist:
- contains no bearer token;
- contains no Command Code key;
- binds only loopback;
- refers to the current machine's clone path.

- [ ] **Step 4: Install on MacBook and verify**

```bash
bash scripts/install-launchagent.sh
launchctl print "gui/$(id -u)/com.cmm.subscription-router"
curl -s http://127.0.0.1:8790/health
```

Expected: service active.

- [ ] **Step 5: Reproduce on iMac**

Clone/pull the same Git revision, then authenticate each provider locally. Do not copy:
- `~/.codex` auth;
- Claude OAuth/profile data;
- Antigravity credentials;
- Keychain secrets;
- local config.

Run the same acceptance suite on iMac.

- [ ] **Step 6: Commit**

```bash
git add scripts/install-launchagent.sh scripts/uninstall-launchagent.sh docs/macos-install.md tests/integration/launchagent.test.ts
git commit -m "feat: add reproducible macOS service installation"
```

---

### Task 18: Freeze a remote-worker-compatible internal wire contract without deploying cloud mode

**Files:**
- Create: `src/core/wire.ts`
- Test: `tests/core/wire.test.ts`
- Create: `docs/remote-worker-contract.md`

**Interfaces:**
- Produces JSON-serializable versions of:
  - provider request;
  - normalized events;
  - health;
  - cancellation;
  - model discovery.

- [ ] **Step 1: Define versioned envelopes**

Example:

```ts
export interface WorkerRequestEnvelope {
  version: 1;
  requestId: string;
  provider: "chatgpt" | "claude" | "google" | "command-code";
  operation: "run";
  payload: RouterRequest;
}

export interface WorkerEventEnvelope {
  version: 1;
  requestId: string;
  event: RouterEvent;
}
```

No secrets may appear in either envelope.

- [ ] **Step 2: Write round-trip serialization tests**

Serialize/parse all event variants and requests through JSON. Reject unknown protocol versions.

- [ ] **Step 3: Document future topology only**

`docs/remote-worker-contract.md` must explicitly state v1 does **not**:
- open a remote listener;
- upload OAuth;
- implement cloud routing.

It only freezes a clean boundary so future workers can reuse existing adapters.

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/core/wire.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/wire.ts tests/core/wire.test.ts docs/remote-worker-contract.md
git commit -m "feat: freeze remote-worker-compatible wire contract"
```

---

### Task 19: Final security and regression gate

**Files:**
- Create: `scripts/security-audit.sh`
- Create: `docs/final-audit.md`
- Modify: any files required to remediate actual findings.

**Interfaces:**
- Final closure gate.

- [ ] **Step 1: Run complete automated suite**

```bash
npm test
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 2: Run secret scans**

At minimum search tracked content for:

```text
sk-
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
GOOGLE_API_KEY=
Authorization: Bearer
refresh_token
access_token
localhost:20128
```

Occurrences in tests/docs must be reviewed; no real credential or accidental OmniRoute dependency is allowed.

- [ ] **Step 3: Verify network binding**

With the router running:

```bash
lsof -nP -iTCP:8790 -sTCP:LISTEN
```

Expected: loopback only.

- [ ] **Step 4: Verify PAYG fail-closed behavior**

Start the router separately with each forbidden variable set to a dummy value. Expected: startup fails with a safe message before any provider request is made.

- [ ] **Step 5: Verify provider isolation**

For each provider:
- disable it;
- request one of its models;
- expect provider-specific failure;
- assert zero calls to the other three adapters.

- [ ] **Step 6: Verify both Macs independently**

Record:
- commit SHA;
- Node version;
- provider health;
- `/v1/models` output schema parity;
- local authentication mode;
- no shared secrets.

- [ ] **Step 7: Write final audit**

`docs/final-audit.md` must state explicit PASS/FAIL for:
- ChatGPT subscription path;
- Claude subscription path;
- Google AI Pro path;
- Command Code path;
- Qoder chat;
- Qoder streaming;
- Qoder tool calls;
- no provider-native mutation;
- no PAYG fallback;
- no cross-provider fallback;
- MacBook standalone;
- iMac standalone;
- remote-worker contract serialization.

- [ ] **Step 8: Commit closure**

```bash
git add .
git commit -m "chore: close CMM Subscription Router v1 audit"
```

Then verify:

```bash
git status --short
git log -1 --oneline --decorate
```

Expected: clean worktree and closure commit at HEAD.

---

## Execution Order and Review Gates

Do not parallelize tasks that change the shared provider contract or HTTP compatibility surface.

Safe sequence:

```text
1 → 2 → 3 → 4 → 5
              ↓
        6 → 7 Codex
              ↓
        8 Claude
              ↓
        9 Antigravity
              ↓
       10 Command Code
              ↓
       11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19
```

Provider Tasks 6–10 may be developed with isolated fixtures, but live acceptance must remain sequential so authentication/rate-limit failures are attributable to one provider.

## Mandatory Checkpoints

Pause for review after:

1. **Task 5:** router core/API skeleton is stable.
2. **Task 7:** first real subscription path (ChatGPT/Codex) works.
3. **Task 10:** all four provider adapters work independently.
4. **Task 13:** Qoder tool ownership is proven.
5. **Task 16:** Qoder end-to-end acceptance passes.
6. **Task 17:** both Mac deployment procedure is reproducible.
7. **Task 19:** final closure audit.

## Definition of Done

The implementation is not complete until all of these are true:

```text
ONE_QODER_ENDPOINT=PASS
CHATGPT_CODEX_SUBSCRIPTION=PASS
CLAUDE_SUBSCRIPTION=PASS
GOOGLE_AI_PRO_ANTIGRAVITY=PASS
COMMAND_CODE=PASS
QWEN_NATIVE_UNCHANGED=PASS

DYNAMIC_MODEL_DISCOVERY=PASS
STRICT_MODEL_NAMESPACE=PASS
CHAT_COMPLETIONS=PASS
RESPONSES_API=PASS
STREAMING=PASS
QODER_TOOL_ROUNDTRIP=PASS
PROVIDER_NATIVE_MUTATION=BLOCKED

API_PAYG_FALLBACK=BLOCKED
CROSS_PROVIDER_FALLBACK=BLOCKED
OAUTH_COPYING=NONE
SECRET_LOGGING=NONE
LOOPBACK_ONLY=PASS

MACBOOK_STANDALONE=PASS
IMAC_REPRODUCIBLE=PASS
REMOTE_WORKER_CONTRACT=VERSIONED
WORKTREE=CLEAN
```
