import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  buildServer,
  resolveConsumerId,
  type ServerOptions,
} from "../../src/http/server.js";
import { ProviderRegistry } from "../../src/registry/provider-registry.js";
import type {
  ProviderAdapter,
  DiscoveredModel,
  ProviderHealth,
  RouterRequest,
} from "../../src/core/provider.js";
import type { RouterEvent } from "../../src/core/events.js";
import {
  CONSUMER_CMMCHAT,
  CONSUMER_QODER,
  type ConsumerId,
} from "../../src/core/consumer-capability.js";
import {
  READ_ONLY_ROUTES,
  USAGE_READER_PRINCIPAL,
  isUsageReaderRequest,
  type PrincipalRequest,
} from "../../src/security/usage-reader-policy.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

const REPO = join(import.meta.dirname, "../..");

/**
 * Fake-only sentinel: an obvious label plus a fresh UUID, built here and only
 * here. It is never a real credential, never written into a tracked
 * config/doc/source file, and never printed into a snapshot.
 */
const READ_ONLY_SENTINEL = `read-only-test-token-not-a-secret-${randomUUID()}`;
const CMMCHAT_TOKEN = "usage-reader-test-cmmchat-token";
const QODER_TOKEN = "usage-reader-test-qoder-token";

function authHeader(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

/** Header-only double for the pure `resolveConsumerId` assertions. */
function requestWith(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

class ChatProvider implements ProviderAdapter {
  readonly id = "chatgpt" as const;
  invocations = 0;

  async discoverModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "chatgpt/usage-reader-model",
        provider: "chatgpt",
        upstreamModel: "usage-reader-model",
        displayName: "Usage Reader Model",
        capability: "CHAT_AND_TOOLS",
      },
    ];
  }

  async health(): Promise<ProviderHealth> {
    return { status: "ready" };
  }

  async *run(request: RouterRequest, _signal: AbortSignal): AsyncIterable<RouterEvent> {
    this.invocations += 1;
    void request;
    yield { type: "text_delta", text: "hi" };
    yield { type: "completed", finishReason: "stop" };
  }

  async cancel(): Promise<void> {}
}

/** What a probe handler observed about the authenticated principal. */
interface ObservedIdentity {
  readonly path: string;
  readonly consumerId: ConsumerId | undefined;
  readonly usageReader: boolean;
}

/**
 * What the request actually looked like to the router once the auth pre-handler
 * had finished with it. Recorded by an observer hook rather than by a handler,
 * because the two allowlisted routes are real production routes whose handlers
 * must not be changed just to echo an identity.
 */
interface AdmittedRequest {
  readonly method: string;
  readonly path: string;
  readonly consumerId: ConsumerId | undefined;
  readonly usageReader: boolean;
}

/**
 * Route identities the read-only client must never reach. These are mounted as
 * test-local stubs because this branch does not register them: the catalog
 * mutations land with the router-administration work, and only the
 * `GET /v1/cmm/catalog` read is ported. A stub gives each identity a real
 * handler that must never run, which is a stronger proof than the weaker "no
 * such route" fallback. If a future real route reuses one of these identities,
 * this registration throws loudly at test start instead of silently stopping
 * proving anything.
 */
const FORBIDDEN_MUTATIONS: ReadonlyArray<{
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
}> = [
  { method: "POST", path: "/v1/cmm/catalog/connections" },
  { method: "POST", path: "/v1/cmm/catalog/custom-endpoints" },
  { method: "POST", path: "/v1/cmm/catalog" },
  { method: "PUT", path: "/v1/cmm/catalog" },
  { method: "PATCH", path: "/v1/cmm/catalog" },
  { method: "DELETE", path: "/v1/cmm/catalog" },
  { method: "DELETE", path: "/v1/cmm/catalog/connections" },
  { method: "POST", path: "/v1/cmm/routing/state" },
];

const ALLOWLISTED_PATHS = READ_ONLY_ROUTES.map((route) => route.path);

/**
 * Production server plus the throwaway routes this suite needs. Hooks apply to
 * routes registered before and after them on the same instance, so every stub
 * below passes through the real auth pre-handler, and the observer hook below
 * sees the real routes too.
 */
async function serverWithProbes(
  usageReaderToken: string | undefined,
  options: { qoderToken?: string; provider?: ChatProvider; bearerSecret?: string } = {},
): Promise<{
  server: ReturnType<typeof buildServer>;
  observed: ObservedIdentity[];
  admitted: AdmittedRequest[];
}> {
  const registry = new ProviderRegistry();
  if (options.provider) {
    await registry.register(options.provider);
    await registry.refresh();
  }
  const serverOptions: ServerOptions = {
    host: "127.0.0.1",
    port: 0,
    bearerSecret: options.bearerSecret ?? CMMCHAT_TOKEN,
    registry,
  };
  if (usageReaderToken !== undefined) serverOptions.usageReaderToken = usageReaderToken;
  if (options.qoderToken !== undefined) serverOptions.qoderToken = options.qoderToken;
  const server = buildServer(serverOptions);

  const observed: ObservedIdentity[] = [];
  const probe =
    (path: string) =>
    (request: FastifyRequest): { path: string } => {
      const tagged = request as PrincipalRequest;
      observed.push({
        path,
        consumerId: tagged.consumerId,
        usageReader: isUsageReaderRequest(request),
      });
      return { path };
    };

  const admitted: AdmittedRequest[] = [];
  // A second pre-handler, registered after the real routes. Fastify stops the
  // hook chain as soon as a reply has been sent, so this records exactly the
  // requests the auth pre-handler let through — which is how the two real
  // allowlisted routes (GET /v1/cmm/health, GET /v1/cmm/catalog) can be
  // asserted for principal tagging without touching their handlers. Requests
  // with no resolved route identity are the not-found context (an unmatched URL
  // never enters the authenticated surface at all) and are proven by their
  // status code instead.
  server.addHook("preHandler", async (request) => {
    const routePath = request.routeOptions?.url;
    if (routePath === undefined) return;
    const tagged = request as PrincipalRequest;
    admitted.push({
      method: request.method,
      path: routePath,
      consumerId: tagged.consumerId,
      usageReader: isUsageReaderRequest(request),
    });
  });

  // Mounted AFTER the boundary existed: the shape of "someone added a route".
  server.get("/v1/cmm/zzz-probe", probe("/v1/cmm/zzz-probe"));
  // Same namespace, different route identities.
  server.get("/v1/cmm/catalog/detail", probe("/v1/cmm/catalog/detail"));
  server.get("/v1/cmm/catalog/:id", probe("/v1/cmm/catalog/:id"));
  for (const mutation of FORBIDDEN_MUTATIONS) {
    server.route({ method: mutation.method, url: mutation.path, handler: probe(mutation.path) });
  }

  await server.ready();
  return { server, observed, admitted };
}

describe("Read-only usage principal (CMM Usage) HTTP boundary", () => {
  describe("existing principals authenticate exactly as before", () => {
    it("missing bearer is 401 router_unauthorized", async () => {
      const { server } = await serverWithProbes(READ_ONLY_SENTINEL);
      for (const url of ["/v1/cmm/health", "/v1/cmm/catalog", "/v1/chat/completions"]) {
        const response = await server.inject({ method: "GET", url });
        expect(`${url} -> ${response.statusCode}`).toBe(`${url} -> 401`);
        expect(response.json().error.type).toBe("router_unauthorized");
      }
    });

    it("invalid bearer is 401 router_unauthorized, including near-misses of the read-only token", async () => {
      const { server } = await serverWithProbes(READ_ONLY_SENTINEL);
      for (const token of ["totally-unknown-token", `${READ_ONLY_SENTINEL}-tampered`]) {
        const response = await server.inject({
          method: "GET",
          url: "/v1/cmm/health",
          headers: authHeader(token),
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().error.type).toBe("router_unauthorized");
      }
    });

    it("resolveConsumerId keeps resolving exactly the two consumers it always did", () => {
      const options = { bearerSecret: CMMCHAT_TOKEN, qoderToken: QODER_TOKEN };
      expect(resolveConsumerId(requestWith(authHeader(CMMCHAT_TOKEN)), options)).toBe(
        CONSUMER_CMMCHAT,
      );
      expect(resolveConsumerId(requestWith(authHeader(QODER_TOKEN)), options)).toBe(CONSUMER_QODER);
      // The read-only bearer is not a consumer and never becomes one.
      expect(resolveConsumerId(requestWith(authHeader(READ_ONLY_SENTINEL)), options)).toBeNull();
      // No bearer and an unknown bearer stay unauthenticated.
      expect(resolveConsumerId(requestWith({}), options)).toBeNull();
      expect(resolveConsumerId(requestWith(authHeader("nope")), options)).toBeNull();
      // Without a configured Qoder secret there is no Qoder consumer at all.
      expect(
        resolveConsumerId(requestWith(authHeader(QODER_TOKEN)), { bearerSecret: CMMCHAT_TOKEN }),
      ).toBeNull();
    });

    it("an existing consumer still reaches every route it reached before", async () => {
      const provider = new ChatProvider();
      const { server } = await serverWithProbes(READ_ONLY_SENTINEL, {
        qoderToken: QODER_TOKEN,
        provider,
      });

      for (const url of ["/v1/models", "/v1/cmm/providers", "/v1/cmm/health", "/v1/cmm/usage"]) {
        const response = await server.inject({ method: "GET", url, headers: authHeader(CMMCHAT_TOKEN) });
        expect(`${url} -> ${response.statusCode}`).toBe(`${url} -> 200`);
      }

      const chat = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(CMMCHAT_TOKEN),
        payload: { model: "chatgpt/usage-reader-model", messages: [{ role: "user", content: "hi" }] },
      });
      expect(chat.statusCode).toBe(200);
      expect(chat.json().choices[0].message.content).toBe("hi");
      expect(provider.invocations).toBe(1);
    });

    it("CMMChat stays CHAT_ONLY and Qoder stays tool-capable on a capable model", async () => {
      const provider = new ChatProvider();
      const { server } = await serverWithProbes(READ_ONLY_SENTINEL, {
        qoderToken: QODER_TOKEN,
        provider,
      });
      const payload = {
        model: "chatgpt/usage-reader-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [CMM_ECHO_TOOL],
      };
      const cmmchat = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(CMMCHAT_TOKEN),
        payload,
      });
      expect(cmmchat.statusCode).toBe(400);
      expect(cmmchat.json().error.type).toBe("unsupported_capability");

      const qoder = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(QODER_TOKEN),
        payload,
      });
      expect(qoder.statusCode).toBe(200);
      expect(provider.invocations).toBe(1);
    });

    it("a consumer bearer still serves the throwaway /v1/cmm/* probe routes", async () => {
      const { server, observed } = await serverWithProbes(READ_ONLY_SENTINEL);
      for (const url of [
        "/v1/cmm/zzz-probe",
        "/v1/cmm/catalog/detail",
        "/v1/cmm/catalog/abc123",
      ]) {
        const response = await server.inject({ method: "GET", url, headers: authHeader(CMMCHAT_TOKEN) });
        expect(`${url} -> ${response.statusCode}`).toBe(`${url} -> 200`);
      }
      // The real catalog read answers a consumer too, exactly as it did before
      // this boundary existed: the read is authenticated, not reader-only.
      const catalog = await server.inject({
        method: "GET",
        url: "/v1/cmm/catalog",
        headers: authHeader(CMMCHAT_TOKEN),
      });
      expect(catalog.statusCode).toBe(200);
      expect(Array.isArray(catalog.json().providers)).toBe(true);

      const post = await server.inject({
        method: "POST",
        url: "/v1/cmm/catalog/connections",
        headers: authHeader(CMMCHAT_TOKEN),
        payload: {},
      });
      expect(post.statusCode).toBe(200);

      // Those handlers ran as the CMMChat consumer and never as a reader. The
      // parameterised route reports its registered pattern, not the raw id.
      expect(observed.map((entry) => [entry.path, entry.consumerId])).toEqual([
        ["/v1/cmm/zzz-probe", CONSUMER_CMMCHAT],
        ["/v1/cmm/catalog/detail", CONSUMER_CMMCHAT],
        ["/v1/cmm/catalog/:id", CONSUMER_CMMCHAT],
        ["/v1/cmm/catalog/connections", CONSUMER_CMMCHAT],
      ]);
      expect(observed.every((entry) => entry.usageReader === false)).toBe(true);
    });
  });

  describe("the read-only principal is a distinct kind, not a consumer", () => {
    it("USAGE_READER_PRINCIPAL is not assignable to ConsumerId", () => {
      // Compile-time proof that the read-only kind cannot be threaded into a
      // consumer-typed value: `npm run typecheck` fails if this stops erroring.
      // @ts-expect-error the read-only principal is not a ConsumerId
      const notAConsumer: ConsumerId = USAGE_READER_PRINCIPAL;
      expect(notAConsumer).toBe("usage-reader");
      expect(notAConsumer).not.toBe(CONSUMER_CMMCHAT);
      expect(notAConsumer).not.toBe(CONSUMER_QODER);
    });

    it("an allowed read-only request is tagged and carries no consumerId", async () => {
      const { server, admitted } = await serverWithProbes(READ_ONLY_SENTINEL);
      const response = await server.inject({
        method: "GET",
        url: "/v1/cmm/catalog",
        headers: authHeader(READ_ONLY_SENTINEL),
      });
      expect(response.statusCode).toBe(200);
      // Observed on the real route, not on a stand-in for it.
      expect(admitted).toHaveLength(1);
      expect(admitted[0]).toEqual({
        method: "GET",
        path: "/v1/cmm/catalog",
        consumerId: undefined,
        usageReader: true,
      });
    });
  });

  describe("allowlist: exactly the two allowlisted GET routes", () => {
    it("the allowlist itself is exactly GET /v1/cmm/health and GET /v1/cmm/catalog", () => {
      expect(READ_ONLY_ROUTES.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
        "GET /v1/cmm/catalog",
        "GET /v1/cmm/health",
      ]);
    });

    it("200 on GET /v1/cmm/health (the real diagnostics route)", async () => {
      const { server } = await serverWithProbes(READ_ONLY_SENTINEL);
      const response = await server.inject({
        method: "GET",
        url: "/v1/cmm/health",
        headers: authHeader(READ_ONLY_SENTINEL),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("ok");
    });

    it("200 on GET /v1/cmm/catalog and nothing else is invoked", async () => {
      const { server, observed, admitted } = await serverWithProbes(READ_ONLY_SENTINEL);
      const response = await server.inject({
        method: "GET",
        url: "/v1/cmm/catalog",
        headers: authHeader(READ_ONLY_SENTINEL),
      });
      expect(response.statusCode).toBe(200);
      // The allowlisted read is the real route, and it is the only thing this
      // request touched: no probe handler ran, and no other route identity was
      // admitted.
      expect(observed).toHaveLength(0);
      expect(admitted).toEqual([
        { method: "GET", path: "/v1/cmm/catalog", consumerId: undefined, usageReader: true },
      ]);
      // The projection is the six-array catalog contract, not an error envelope.
      const body = response.json();
      expect(Object.keys(body).sort()).toEqual([
        "accounts",
        "connections",
        "models",
        "products",
        "providers",
        "routes",
      ]);
    });

    it("200 on GET /v1/cmm/health and GET /v1/cmm/catalog in one session", async () => {
      const { server, admitted } = await serverWithProbes(READ_ONLY_SENTINEL);
      const health = await server.inject({
        method: "GET",
        url: "/v1/cmm/health",
        headers: authHeader(READ_ONLY_SENTINEL),
      });
      const catalog = await server.inject({
        method: "GET",
        url: "/v1/cmm/catalog",
        headers: authHeader(READ_ONLY_SENTINEL),
      });
      expect(health.statusCode).toBe(200);
      expect(catalog.statusCode).toBe(200);
      expect(admitted.map((entry) => entry.path)).toEqual([
        "/v1/cmm/health",
        "/v1/cmm/catalog",
      ]);
      expect(admitted.every((entry) => entry.usageReader && entry.consumerId === undefined)).toBe(
        true,
      );
    });

    it("allowlisted reads keep working with a query string", async () => {
      const { server } = await serverWithProbes(READ_ONLY_SENTINEL);
      const response = await server.inject({
        method: "GET",
        url: "/v1/cmm/health?fresh=1",
        headers: authHeader(READ_ONLY_SENTINEL),
      });
      expect(response.statusCode).toBe(200);
    });

    it("only GET is allowed: a non-GET verb on an allowlisted path is 403", async () => {
      const { server } = await serverWithProbes(READ_ONLY_SENTINEL);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const response = await server.inject({
          method,
          url: "/v1/cmm/health",
          headers: authHeader(READ_ONLY_SENTINEL),
          payload: {},
        });
        expect(`${method} -> ${response.statusCode}`).toBe(`${method} -> 403`);
        expect(response.json().error.type).toBe("router_forbidden");
      }
    });
  });

  describe("deny: inference, mutations and every other /v1 route", () => {
    it("403 on POST /v1/chat/completions without touching a provider", async () => {
      const provider = new ChatProvider();
      const { server } = await serverWithProbes(READ_ONLY_SENTINEL, { provider });
      const response = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(READ_ONLY_SENTINEL),
        payload: { model: "chatgpt/usage-reader-model", messages: [{ role: "user", content: "hi" }] },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.type).toBe("router_forbidden");
      expect(provider.invocations).toBe(0);
    });

    it("403 on POST /v1/responses without touching a provider", async () => {
      const provider = new ChatProvider();
      const { server } = await serverWithProbes(READ_ONLY_SENTINEL, { provider });
      const response = await server.inject({
        method: "POST",
        url: "/v1/responses",
        headers: authHeader(READ_ONLY_SENTINEL),
        payload: { model: "chatgpt/usage-reader-model", input: "hi" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.type).toBe("router_forbidden");
      expect(provider.invocations).toBe(0);
    });

    it("403 on every management, configuration, credential and routing-state mutation", async () => {
      const { server, observed } = await serverWithProbes(READ_ONLY_SENTINEL);
      for (const mutation of FORBIDDEN_MUTATIONS) {
        const response = await server.inject({
          method: mutation.method,
          url: mutation.path,
          headers: authHeader(READ_ONLY_SENTINEL),
          payload: { connectionId: "c1", bearerToken: "material", enabled: true },
        });
        const label = `${mutation.method} ${mutation.path}`;
        expect(`${label} -> ${response.statusCode}`).toBe(`${label} -> 403`);
        expect(response.json().error.type).toBe("router_forbidden");
      }
      // Not one forbidden handler ran, not even with a null identity.
      expect(observed).toHaveLength(0);
    });

    it("403 on the reads that are not in the allowlist", async () => {
      const { server, observed } = await serverWithProbes(READ_ONLY_SENTINEL);
      for (const url of [
        "/v1/models",
        "/v1/cmm/providers",
        "/v1/cmm/usage",
        "/v1/cmm/zzz-probe",
        "/v1/cmm/catalog/detail",
        "/v1/cmm/catalog/abc123",
      ]) {
        const response = await server.inject({ method: "GET", url, headers: authHeader(READ_ONLY_SENTINEL) });
        expect(`${url} -> ${response.statusCode}`).toBe(`${url} -> 403`);
        expect(response.json().error.type).toBe("router_forbidden");
      }
      expect(observed).toHaveLength(0);
    });
  });

  describe("opt-in by explicit list: a new /v1/cmm/* route grants nothing", () => {
    it("403 for the read-only principal on a route added after the boundary existed", async () => {
      const { server, observed } = await serverWithProbes(READ_ONLY_SENTINEL);
      const response = await server.inject({
        method: "GET",
        url: "/v1/cmm/zzz-probe",
        headers: authHeader(READ_ONLY_SENTINEL),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.type).toBe("router_forbidden");
      expect(observed).toHaveLength(0);
    });

    it("the same new route still works for a normal consumer", async () => {
      const { server, observed } = await serverWithProbes(READ_ONLY_SENTINEL);
      const response = await server.inject({
        method: "GET",
        url: "/v1/cmm/zzz-probe",
        headers: authHeader(CMMCHAT_TOKEN),
      });
      expect(response.statusCode).toBe(200);
      expect(observed).toEqual([
        { path: "/v1/cmm/zzz-probe", consumerId: CONSUMER_CMMCHAT, usageReader: false },
      ]);
    });
  });

  describe("401 and 403 stay distinguishable", () => {
    it("unauthenticated is 401 on both an allowlisted and a forbidden route", async () => {
      const { server } = await serverWithProbes(READ_ONLY_SENTINEL);
      const allowed = await server.inject({ method: "GET", url: "/v1/cmm/health" });
      const forbidden = await server.inject({ method: "POST", url: "/v1/chat/completions", payload: {} });
      expect(allowed.statusCode).toBe(401);
      expect(allowed.json().error.type).toBe("router_unauthorized");
      expect(forbidden.statusCode).toBe(401);
      expect(forbidden.json().error.type).toBe("router_unauthorized");
    });

    it("authenticated-but-refused is 403 with router_forbidden", async () => {
      const { server } = await serverWithProbes(READ_ONLY_SENTINEL);
      const response = await server.inject({
        method: "GET",
        url: "/v1/models",
        headers: authHeader(READ_ONLY_SENTINEL),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.type).toBe("router_forbidden");
      expect(response.json().error.type).not.toBe("router_unauthorized");
    });

    it("a consumer is never answered with router_forbidden", async () => {
      const { server } = await serverWithProbes(READ_ONLY_SENTINEL);
      const response = await server.inject({
        method: "GET",
        url: "/v1/cmm/zzz-probe",
        headers: authHeader(CMMCHAT_TOKEN),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().error).toBeUndefined();
    });
  });

  describe("without a configured read-only secret the principal cannot authenticate", () => {
    it("401 everywhere when usageReaderToken is absent, and nothing changes", async () => {
      const provider = new ChatProvider();
      const { server } = await serverWithProbes(undefined, { provider });
      for (const url of ["/v1/cmm/health", "/v1/cmm/catalog"]) {
        const response = await server.inject({
          method: "GET",
          url,
          headers: authHeader(READ_ONLY_SENTINEL),
        });
        expect(`${url} -> ${response.statusCode}`).toBe(`${url} -> 401`);
        expect(response.json().error.type).toBe("router_unauthorized");
      }
      const chat = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(READ_ONLY_SENTINEL),
        payload: { model: "chatgpt/usage-reader-model", messages: [{ role: "user", content: "hi" }] },
      });
      expect(chat.statusCode).toBe(401);
      expect(provider.invocations).toBe(0);
    });

    it("a blank read-only secret authenticates nobody", async () => {
      const { server } = await serverWithProbes("");
      for (const url of ["/v1/cmm/health", "/v1/cmm/catalog"]) {
        const response = await server.inject({ method: "GET", url, headers: authHeader("") });
        expect(`${url} -> ${response.statusCode}`).toBe(`${url} -> 401`);
      }
    });

    it("if a secret is ever shared with a consumer, the narrower read-only grant wins", async () => {
      // Fail-closed ordering: a bearer that is both the read-only and the
      // CMMChat secret must not be able to reach inference.
      const provider = new ChatProvider();
      const shared = CMMCHAT_TOKEN;
      const { server } = await serverWithProbes(shared, { provider, bearerSecret: shared });
      const health = await server.inject({
        method: "GET",
        url: "/v1/cmm/health",
        headers: authHeader(shared),
      });
      expect(health.statusCode).toBe(200);
      const chat = await server.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(shared),
        payload: { model: "chatgpt/usage-reader-model", messages: [{ role: "user", content: "hi" }] },
      });
      expect(chat.statusCode).toBe(403);
      expect(chat.json().error.type).toBe("router_forbidden");
      expect(provider.invocations).toBe(0);
    });
  });

  describe("route identity, not URL shape, decides the boundary", () => {
    it("encoded, cased and dot-segment variants never widen the read-only grant", async () => {
      const provider = new ChatProvider();
      const { server, observed, admitted } = await serverWithProbes(READ_ONLY_SENTINEL, { provider });
      const outcomes: Record<string, number> = {};
      for (const url of [
        "/%761/cmm/health",
        "/v1/%63mm/health",
        "//v1/cmm/health",
        "/v1//cmm//health",
        "/v1/cmm/health/",
        "/V1/cmm/health",
        "/v1/cmm/health/../catalog",
        "/v1/cmm/health/../models",
        "/v1/cmm/catalog/../health",
        "/v1/cmm/zzz-probe",
        "/v1/cmm/catalog/connections",
      ]) {
        const response = await server.inject({ method: "GET", url, headers: authHeader(READ_ONLY_SENTINEL) });
        outcomes[url] = response.statusCode;
      }
      // A variant is only served (200) when the router resolved it to an
      // allowlisted GET identity; anything else is refused or has no route.
      expect(outcomes["/v1/cmm/zzz-probe"]).toBe(403);
      expect(outcomes["//v1/cmm/health"]).not.toBe(200);
      expect(outcomes["/V1/cmm/health"]).not.toBe(200);
      expect(outcomes["/v1/cmm/health/../models"]).not.toBe(200);
      expect(outcomes["/v1/cmm/catalog/connections"]).not.toBe(200);
      // The route the catalog read now actually owns must not be reachable
      // through a dot-segment spelling of the health route either way: if the
      // router resolves it, it resolves to the allowlisted catalog identity.
      expect([200, 403, 404]).toContain(outcomes["/v1/cmm/health/../catalog"]);
      expect([200, 403, 404]).toContain(outcomes["/v1/cmm/catalog/../health"]);
      // Whatever was served, it was only ever an allowlisted identity, tagged
      // as the read-only principal, and never carried a consumerId. This is
      // asserted on the admitted requests (which include the two real routes),
      // so the proof cannot be satisfied by a stand-in handler.
      expect(admitted.length).toBeGreaterThan(0);
      for (const entry of admitted) {
        expect(entry.method).toBe("GET");
        expect(ALLOWLISTED_PATHS).toContain(entry.path);
        expect(entry.usageReader).toBe(true);
        expect(entry.consumerId).toBeUndefined();
      }
      expect(observed).toHaveLength(0);
      expect(provider.invocations).toBe(0);
    });

    it("an encoded inference path is authenticated as the inference route", async () => {
      const provider = new ChatProvider();
      const { server } = await serverWithProbes(READ_ONLY_SENTINEL, { provider });
      // The router percent-decodes before matching, so "/%761/chat/completions"
      // IS the inference route. It must never be served unauthenticated and
      // never be served to the read-only principal.
      for (const url of ["/%761/chat/completions", "/v1/%63hat/completions"]) {
        const anonymous = await server.inject({
          method: "POST",
          url,
          payload: { model: "chatgpt/usage-reader-model", messages: [{ role: "user", content: "hi" }] },
        });
        expect(`${url} anonymous -> ${anonymous.statusCode}`).toBe(`${url} anonymous -> 401`);
        expect(anonymous.json().error.type).toBe("router_unauthorized");

        const reader = await server.inject({
          method: "POST",
          url,
          headers: authHeader(READ_ONLY_SENTINEL),
          payload: { model: "chatgpt/usage-reader-model", messages: [{ role: "user", content: "hi" }] },
        });
        expect(`${url} reader -> ${reader.statusCode}`).not.toBe(`${url} reader -> 200`);
        expect([403, 404]).toContain(reader.statusCode);
      }
      expect(provider.invocations).toBe(0);
    });
  });

  describe("secret hygiene", () => {
    it("the read-only sentinel appears only in this test file", () => {
      const tracked = [
        ".env.example",
        "README.md",
        "config/shared.example.json",
        "config/shared.json",
        "docs/macos-install.md",
        "launchd/com.cmm.subscription-router.plist.template",
        "scripts/macos/run-router.sh",
        "scripts/macos/install-router.sh",
        "src/http/server.ts",
        "src/index.ts",
        "src/security/usage-reader-policy.ts",
        "src/core/errors.ts",
      ]
        .filter((rel) => existsSync(join(REPO, rel)))
        .map((rel) => readFileSync(join(REPO, rel), "utf-8"));
      expect(tracked.length).toBeGreaterThan(8);
      const corpus = tracked.join("\n");
      expect(corpus).not.toContain(READ_ONLY_SENTINEL);
      expect(corpus).not.toContain("read-only-test-token");
      expect(corpus).not.toContain(CMMCHAT_TOKEN);
      expect(corpus).not.toContain(QODER_TOKEN);
    });

    it("the runtime input is an env var NAME whose value stays out of tracked files", () => {
      const example = readFileSync(join(REPO, ".env.example"), "utf-8");
      expect(example).toContain("CMM_USAGE_READER_TOKEN");
      expect(example).toMatch(/^CMM_USAGE_READER_TOKEN=$/m);
      // Nothing assigns a literal token value in the wrapper or the docs: the
      // value only ever comes from the environment or an interactive prompt.
      for (const rel of [
        "scripts/macos/run-router.sh",
        "docs/macos-install.md",
        "launchd/com.cmm.subscription-router.plist.template",
      ]) {
        const text = readFileSync(join(REPO, rel), "utf-8");
        // The repository's own established idiom: a provisioning command must
        // never be followed by a literal value (it is typed interactively).
        expect(text).not.toMatch(/add-generic-password[^\n]*-w\s+["']/);
        // The env var is only ever assigned an indirect reference or left empty.
        expect(text).not.toMatch(/CMM_USAGE_READER_TOKEN=["'](?!\$)[^"']{8,}["']/);
      }
    });
  });
});
