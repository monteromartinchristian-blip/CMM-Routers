import { describe, expect, it } from "vitest";
import {
  assertStableId,
  buildConnectionId,
  buildModelIdentityId,
  buildRouteId,
  type ConnectionIdInput,
} from "../../src/catalog/ids.js";

describe("catalog stable IDs", () => {
  it("normalizes only canonical route identity fields deterministically", () => {
    const normalized = buildRouteId({
      providerId: "openrouter",
      connectionId: "conn_openrouter_main",
      providerModelId: "anthropic/claude-sonnet-4",
      executionProfile: "chat-only",
    });

    expect(
      buildRouteId({
        providerId: " OpenRouter ",
        connectionId: " CONN_OPENROUTER_MAIN ",
        providerModelId: "anthropic/claude-sonnet-4",
        executionProfile: " CHAT-ONLY ",
      }),
    ).toBe(normalized);
  });

  it("preserves provider-significant case in opaque route and connection references", () => {
    const route = {
      providerId: "openrouter",
      connectionId: "conn_openrouter_main",
      providerModelId: "Vendor/Model-A",
      executionProfile: "chat-only",
    } as const;

    expect(
      buildRouteId({ ...route, providerModelId: "Vendor/model-A" }),
    ).not.toBe(buildRouteId(route));

    const connection = {
      providerId: "openrouter",
      accountId: "account_main",
      productId: "product_api",
      connectionKind: "api-key",
    } as const;

    expect(
      buildConnectionId({ ...connection, profileRef: "ProfileMain" }),
    ).not.toBe(buildConnectionId({ ...connection, profileRef: "profileMain" }));
    expect(
      buildConnectionId({ ...connection, endpointRef: "EndpointMain" }),
    ).not.toBe(buildConnectionId({ ...connection, endpointRef: "endpointMain" }));
  });

  it("changes route identity when any route-defining field changes", () => {
    const base = {
      providerId: "openrouter",
      connectionId: "conn_openrouter_main",
      providerModelId: "anthropic/claude-sonnet-4",
      executionProfile: "chat-only",
    } as const;

    expect(buildRouteId({ ...base, providerId: "claude" })).not.toBe(
      buildRouteId(base),
    );
    expect(
      buildRouteId({ ...base, connectionId: "conn_openrouter_backup" }),
    ).not.toBe(buildRouteId(base));
    expect(
      buildRouteId({ ...base, providerModelId: "anthropic/claude-opus-4" }),
    ).not.toBe(buildRouteId(base));
    expect(
      buildRouteId({ ...base, executionProfile: "chat-and-tools" }),
    ).not.toBe(buildRouteId(base));
  });

  it("rejects raw-secret fields at the API boundary", () => {
    if (false) {
      buildConnectionId({
        providerId: "openrouter",
        // @ts-expect-error Raw secret material is intentionally absent from the ID API.
        secret: "sk-type-level-forbidden",
      });
    }

    const credential = "sk-runtime-forbidden-value";
    const unsafeInput = {
      providerId: "openrouter",
      accountId: "account_main",
      secret: credential,
    } as unknown as ConnectionIdInput;

    let thrown: unknown;
    try {
      buildConnectionId(unsafeInput);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(credential);
  });

  it("freezes representative stable-ID vectors without embedding identity values", () => {
    const connectionId = buildConnectionId({
      providerId: "openrouter",
      accountId: "account_main",
      productId: "product_api",
      connectionKind: "api-key",
    });
    const modelIdentityId = buildModelIdentityId({
      canonicalName: "Claude Sonnet",
    });
    const routeId = buildRouteId({
      providerId: "openrouter",
      connectionId,
      providerModelId: "anthropic/claude-sonnet-4",
      executionProfile: "chat-only",
    });

    expect(connectionId).toBe("conn_268efe3e9de8d57b");
    expect(modelIdentityId).toBe("model_43e25b52ba4a88e8");
    expect(routeId).toBe("route_f54254c698005bea");
    expect(modelIdentityId).not.toContain("Claude Sonnet");
    expect(routeId).not.toContain("anthropic/claude-sonnet-4");
    expect(connectionId).toMatch(/^conn_[a-f0-9]{16}$/);
    expect(modelIdentityId).toMatch(/^model_[a-f0-9]{16}$/);
    expect(routeId).toMatch(/^route_[a-f0-9]{16}$/);
  });

  it("rejects empty or unsafe stable-ID segments", () => {
    expect(() =>
      buildConnectionId({ providerId: "", accountId: "account_main" }),
    ).toThrow();
    expect(() =>
      buildRouteId({
        providerId: "openrouter",
        connectionId: "conn_openrouter_main",
        providerModelId: "../secret",
        executionProfile: "chat-only",
      }),
    ).toThrow();
    expect(() =>
      buildRouteId({
        providerId: "openrouter",
        connectionId: "conn_openrouter_main",
        providerModelId: "anthropic/claude-sonnet-4",
        executionProfile: "chat-only\nwith-control-character",
      }),
    ).toThrow();
    expect(() => assertStableId("route/unsafe", "route")).toThrow();
    expect(() => assertStableId("", "route")).toThrow();
    expect(() =>
      assertStableId("conn_0123456789abcdef", "route"),
    ).toThrow();
  });
});
