import { describe, expect, it } from "vitest";
import {
  assertStableId,
  buildConnectionId,
  buildModelIdentityId,
  buildRouteId,
} from "../../src/catalog/ids.js";

describe("catalog stable IDs", () => {
  it("normalizes equivalent route identity input deterministically", () => {
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
        providerModelId: " Anthropic/Claude-Sonnet-4 ",
        executionProfile: " CHAT-ONLY ",
      }),
    ).toBe(normalized);
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

  it("builds stable identities without embedding credential or model values", () => {
    const credential = "sk-test-credential-that-must-not-appear";
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

    expect(connectionId).not.toContain(credential);
    expect(modelIdentityId).not.toContain("Claude Sonnet");
    expect(routeId).not.toContain("anthropic/claude-sonnet-4");
    expect(routeId).not.toContain(credential);
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
  });
});
