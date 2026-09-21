import { describe, expect, it } from "vitest";
import { RouterError } from "../../src/core/errors.js";
import { PROFILE_CMMCHAT, PROFILE_CODE } from "../../src/core/router-profile.js";
import {
  CLIENT_CODEX,
  CLIENT_GENERIC,
  CLIENT_QODER,
} from "../../src/core/client-identity.js";
import {
  assertDistinctServerTokens,
  resolveRequestIdentity,
  type ServerTokens,
} from "../../src/http/identity.js";

const CMMCHAT = "cmmchat-secret-value";
const CODE = "code-router-secret-value";
const LEGACY = "legacy-qoder-secret-value";

function bearer(secret: string): string {
  return `Bearer ${secret}`;
}

function tokens(overrides: Partial<ServerTokens> = {}): ServerTokens {
  return { cmmchatToken: CMMCHAT, ...overrides };
}

describe("code router identity resolution", () => {
  it("the canonical Code Router bearer authenticates the CODE profile", () => {
    const identity = resolveRequestIdentity(bearer(CODE), tokens({ codeRouterToken: CODE }), undefined);
    expect(identity).toEqual({ profile: PROFILE_CODE, clientId: CLIENT_GENERIC });
  });

  it("LEGACY_QODER_BEARER_STILL_AUTHENTICATES_CODE: the legacy bearer authenticates CODE", () => {
    const identity = resolveRequestIdentity(bearer(LEGACY), tokens({ legacyQoderToken: LEGACY }), undefined);
    expect(identity).toEqual({ profile: PROFILE_CODE, clientId: CLIENT_QODER });
    console.log("LEGACY_QODER_BEARER_STILL_AUTHENTICATES_CODE=PASS");
  });

  it("only the legacy bearer configured still yields a working CODE profile", () => {
    const only = tokens({ legacyQoderToken: LEGACY });
    expect(resolveRequestIdentity(bearer(LEGACY), only, undefined)?.profile).toBe(PROFILE_CODE);
    expect(resolveRequestIdentity(bearer(CODE), only, undefined)).toBeNull();
  });

  it("only the canonical bearer configured still yields a working CODE profile", () => {
    const only = tokens({ codeRouterToken: CODE });
    expect(resolveRequestIdentity(bearer(CODE), only, undefined)?.profile).toBe(PROFILE_CODE);
    expect(resolveRequestIdentity(bearer(LEGACY), only, undefined)).toBeNull();
  });

  it("both bearers configured and distinct: either authenticates CODE", () => {
    const both = tokens({ codeRouterToken: CODE, legacyQoderToken: LEGACY });
    expect(resolveRequestIdentity(bearer(CODE), both, undefined)).toEqual({
      profile: PROFILE_CODE,
      clientId: CLIENT_GENERIC,
    });
    expect(resolveRequestIdentity(bearer(LEGACY), both, undefined)).toEqual({
      profile: PROFILE_CODE,
      clientId: CLIENT_QODER,
    });
  });

  it("neither Code bearer configured: no CODE authentication is available", () => {
    const only = tokens();
    expect(resolveRequestIdentity(bearer(CODE), only, undefined)).toBeNull();
    expect(resolveRequestIdentity(bearer(LEGACY), only, undefined)).toBeNull();
    // CMMChat still works and stays CHAT_ONLY.
    expect(resolveRequestIdentity(bearer(CMMCHAT), only, undefined)).toEqual({
      profile: PROFILE_CMMCHAT,
      clientId: "cmmchat",
    });
  });

  it("the CMMChat bearer authenticates CMMCHAT", () => {
    const both = tokens({ codeRouterToken: CODE, legacyQoderToken: LEGACY });
    expect(resolveRequestIdentity(bearer(CMMCHAT), both, undefined)).toEqual({
      profile: PROFILE_CMMCHAT,
      clientId: "cmmchat",
    });
  });

  it("CMMCHAT_BEARER_CANNOT_ELEVATE: client metadata cannot change the CMMChat profile", () => {
    const both = tokens({ codeRouterToken: CODE, legacyQoderToken: LEGACY });
    for (const header of ["qoder", "hermes", "codex-client", "generic-openai", "anything"]) {
      const identity = resolveRequestIdentity(bearer(CMMCHAT), both, header);
      expect(identity?.profile).toBe(PROFILE_CMMCHAT);
      expect(identity?.clientId).toBe("cmmchat");
    }
    console.log("CMMCHAT_BEARER_CANNOT_ELEVATE=PASS");
  });

  it("client metadata is normalized but never changes the CODE profile", () => {
    const both = tokens({ codeRouterToken: CODE, legacyQoderToken: LEGACY });
    expect(resolveRequestIdentity(bearer(CODE), both, "hermes")?.clientId).toBe("hermes");
    expect(resolveRequestIdentity(bearer(CODE), both, "codex-client")?.clientId).toBe(CLIENT_CODEX);
    expect(resolveRequestIdentity(bearer(CODE), both, "hostile;value")?.clientId).toBe("other");
    expect(resolveRequestIdentity(bearer(CODE), both, "hermes")?.profile).toBe(PROFILE_CODE);
  });

  it("the legacy bearer defaults its diagnostic client id to qoder but honors the header", () => {
    const both = tokens({ codeRouterToken: CODE, legacyQoderToken: LEGACY });
    expect(resolveRequestIdentity(bearer(LEGACY), both, undefined)?.clientId).toBe(CLIENT_QODER);
    expect(resolveRequestIdentity(bearer(LEGACY), both, "hermes")?.clientId).toBe("hermes");
  });

  it("unknown or absent credentials resolve to null", () => {
    const both = tokens({ codeRouterToken: CODE, legacyQoderToken: LEGACY });
    expect(resolveRequestIdentity(undefined, both, undefined)).toBeNull();
    expect(resolveRequestIdentity("Basic abc", both, undefined)).toBeNull();
    expect(resolveRequestIdentity(bearer("not-a-configured-token"), both, undefined)).toBeNull();
  });
});

describe("fail-closed server token validation", () => {
  it("AMBIGUOUS_AUTH_FAILS_CLOSED: CMMChat colliding with the canonical Code bearer throws", () => {
    expect(() =>
      assertDistinctServerTokens({ cmmchatToken: CMMCHAT, codeRouterToken: CMMCHAT }),
    ).toThrow(RouterError);
    console.log("AMBIGUOUS_AUTH_FAILS_CLOSED=PASS");
  });

  it("CMMChat colliding with the legacy Qoder bearer throws", () => {
    expect(() =>
      assertDistinctServerTokens({ cmmchatToken: CMMCHAT, legacyQoderToken: CMMCHAT }),
    ).toThrow(RouterError);
  });

  it("the collision error never leaks a secret value", () => {
    try {
      assertDistinctServerTokens({ cmmchatToken: CMMCHAT, codeRouterToken: CMMCHAT });
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).message).not.toContain(CMMCHAT);
      expect(JSON.stringify((error as RouterError).meta)).not.toContain(CMMCHAT);
    }
  });

  it("Code and legacy bearers sharing a value is accepted as two aliases of one profile", () => {
    // Deterministic explicit policy: both map to PROFILE_CODE, so the value
    // resolves to exactly one profile and is not ambiguous.
    expect(() =>
      assertDistinctServerTokens({
        cmmchatToken: CMMCHAT,
        codeRouterToken: "shared-code-value",
        legacyQoderToken: "shared-code-value",
      }),
    ).not.toThrow();
  });

  it("a fully distinct or CMMChat-only configuration is accepted", () => {
    expect(() =>
      assertDistinctServerTokens({ cmmchatToken: CMMCHAT }),
    ).not.toThrow();
    expect(() =>
      assertDistinctServerTokens({
        cmmchatToken: CMMCHAT,
        codeRouterToken: CODE,
        legacyQoderToken: LEGACY,
      }),
    ).not.toThrow();
  });

  it("an empty CMMChat token is rejected", () => {
    expect(() => assertDistinctServerTokens({ cmmchatToken: "" })).toThrow(RouterError);
  });
});
