import { describe, expect, it } from "vitest";
import { RouterError } from "../../src/core/errors.js";
import { PROFILE_CMMCHAT, PROFILE_CODE } from "../../src/core/router-profile.js";
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

/**
 * Authorization is the profile. The application label is opaque diagnostics and
 * never changes which profile a credential authenticates.
 */
describe("code router identity resolution", () => {
  it("the canonical Code Router bearer authenticates the CODE profile with no label", () => {
    const identity = resolveRequestIdentity(bearer(CODE), tokens({ codeRouterToken: CODE }), undefined);
    expect(identity).toEqual({ profile: PROFILE_CODE });
  });

  it("LEGACY_QODER_BEARER_STILL_AUTHENTICATES_CODE: the legacy bearer authenticates CODE", () => {
    const identity = resolveRequestIdentity(bearer(LEGACY), tokens({ legacyQoderToken: LEGACY }), undefined);
    expect(identity).toEqual({ profile: PROFILE_CODE, clientLabel: "qoder" });
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
    expect(resolveRequestIdentity(bearer(CODE), both, undefined)?.profile).toBe(PROFILE_CODE);
    expect(resolveRequestIdentity(bearer(LEGACY), both, undefined)?.profile).toBe(PROFILE_CODE);
  });

  it("neither Code bearer configured: no CODE authentication is available", () => {
    const only = tokens();
    expect(resolveRequestIdentity(bearer(CODE), only, undefined)).toBeNull();
    expect(resolveRequestIdentity(bearer(LEGACY), only, undefined)).toBeNull();
    expect(resolveRequestIdentity(bearer(CMMCHAT), only, undefined)).toEqual({
      profile: PROFILE_CMMCHAT,
      clientLabel: "cmmchat",
    });
  });

  it("CMMCHAT_BEARER_CANNOT_ELEVATE: no label can change the CMMChat profile", () => {
    const both = tokens({ codeRouterToken: CODE, legacyQoderToken: LEGACY });
    for (const header of ["qoder", "hermes", "codex-client", "anything", "deepseek-harness"]) {
      expect(resolveRequestIdentity(bearer(CMMCHAT), both, header)?.profile).toBe(PROFILE_CMMCHAT);
    }
    console.log("CMMCHAT_BEARER_CANNOT_ELEVATE=PASS");
  });

  it("an arbitrary label is preserved opaquely and never changes the profile", () => {
    const both = tokens({ codeRouterToken: CODE, legacyQoderToken: LEGACY });
    for (const header of ["hermes", "deepseek-harness", "claude-code", "cline", "roo"]) {
      const identity = resolveRequestIdentity(bearer(CODE), both, header);
      expect(identity?.profile).toBe(PROFILE_CODE);
      expect(identity?.clientLabel).toBe(header);
    }
    console.log("ARBITRARY_LABEL_DOES_NOT_CHANGE_PROFILE=PASS");
  });

  it("a hostile label is sanitized and bounded", () => {
    const both = tokens({ codeRouterToken: CODE, legacyQoderToken: LEGACY });
    const identity = resolveRequestIdentity(bearer(CODE), both, "evil\u0000<script>");
    expect(identity?.clientLabel).toBe("evil-script");
    const long = resolveRequestIdentity(bearer(CODE), both, "x".repeat(5000));
    expect(long?.clientLabel!.length).toBeLessThanOrEqual(64);
  });

  it("unknown or absent credentials resolve to null", () => {
    const both = tokens({ codeRouterToken: CODE, legacyQoderToken: LEGACY });
    expect(resolveRequestIdentity(undefined, both, undefined)).toBeNull();
    expect(resolveRequestIdentity("Basic abc", both, undefined)).toBeNull();
    expect(resolveRequestIdentity(bearer("not-configured"), both, undefined)).toBeNull();
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
    expect(() =>
      assertDistinctServerTokens({
        cmmchatToken: CMMCHAT,
        codeRouterToken: "shared-code-value",
        legacyQoderToken: "shared-code-value",
      }),
    ).not.toThrow();
  });

  it("a fully distinct or CMMChat-only configuration is accepted", () => {
    expect(() => assertDistinctServerTokens({ cmmchatToken: CMMCHAT })).not.toThrow();
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
