import { describe, expect, it } from "vitest";
import {
  PROFILE_CMMCHAT,
  PROFILE_CODE,
  effectiveProfileToolCapability,
} from "../../src/core/router-profile.js";
import {
  CLIENT_CMMCHAT,
  CLIENT_CODEX,
  CLIENT_GENERIC,
  CLIENT_HERMES,
  CLIENT_OTHER,
  CLIENT_QODER,
  normalizeClientId,
} from "../../src/core/client-identity.js";

describe("router profile capability policy", () => {
  it("CMMCHAT_CHAT_ONLY: the CMMChat profile is CHAT_ONLY on every provider capability", () => {
    expect(effectiveProfileToolCapability(PROFILE_CMMCHAT, "CHAT_AND_TOOLS")).toBe("CHAT_ONLY");
    expect(effectiveProfileToolCapability(PROFILE_CMMCHAT, "CHAT_ONLY")).toBe("CHAT_ONLY");
    expect(effectiveProfileToolCapability(PROFILE_CMMCHAT, undefined)).toBe("CHAT_ONLY");
    console.log("CMMCHAT_CHAT_ONLY=PASS");
  });

  it("CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS: the Code profile needs a capable provider", () => {
    expect(effectiveProfileToolCapability(PROFILE_CODE, "CHAT_AND_TOOLS")).toBe("CHAT_AND_TOOLS");
    console.log("CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS");
  });

  it("no unknown-capability promotion: Code profile is CHAT_ONLY without proven capability", () => {
    expect(effectiveProfileToolCapability(PROFILE_CODE, "CHAT_ONLY")).toBe("CHAT_ONLY");
    expect(effectiveProfileToolCapability(PROFILE_CODE, undefined)).toBe("CHAT_ONLY");
    expect(effectiveProfileToolCapability(PROFILE_CODE, "PENDING_TASK_13")).toBe("CHAT_ONLY");
  });

  it("the two profiles are distinct and stable", () => {
    expect(PROFILE_CMMCHAT).toBe("cmmchat");
    expect(PROFILE_CODE).toBe("code");
    expect(PROFILE_CMMCHAT).not.toBe(PROFILE_CODE);
  });

  it("client identity is never an argument to the capability decision", () => {
    // The signature is (profile, providerCapability). A client identity cannot
    // be passed, so it cannot elevate: this is a structural guarantee.
    expect(effectiveProfileToolCapability.length).toBe(2);
  });
});

describe("client identity normalization (diagnostics only)", () => {
  it("defaults to generic-openai when the client sends nothing", () => {
    expect(normalizeClientId(undefined)).toBe(CLIENT_GENERIC);
    expect(normalizeClientId("")).toBe(CLIENT_GENERIC);
    expect(normalizeClientId("   ")).toBe(CLIENT_GENERIC);
  });

  it("recognizes the bounded known client identifiers case-insensitively", () => {
    expect(normalizeClientId("Qoder")).toBe(CLIENT_QODER);
    expect(normalizeClientId(" hermes ")).toBe(CLIENT_HERMES);
    expect(normalizeClientId("codex-client")).toBe(CLIENT_CODEX);
    expect(normalizeClientId("CMMChat")).toBe(CLIENT_CMMCHAT);
    expect(normalizeClientId("generic-openai")).toBe(CLIENT_GENERIC);
  });

  it("maps every unrecognized value onto the bounded OTHER bucket", () => {
    expect(normalizeClientId("acme-harness")).toBe(CLIENT_OTHER);
    expect(normalizeClientId("codex")).toBe(CLIENT_OTHER);
    expect(normalizeClientId("qoder;rm -rf /")).toBe(CLIENT_OTHER);
    expect(normalizeClientId("../../etc/passwd")).toBe(CLIENT_OTHER);
    expect(normalizeClientId("a".repeat(500))).toBe(CLIENT_OTHER);
    expect(normalizeClientId("\u0000\u0007")).toBe(CLIENT_OTHER);
  });

  it("never returns raw attacker-controlled input", () => {
    const hostile = "qoder-evil\u0000<script>";
    const result = normalizeClientId(hostile);
    expect(hostile).not.toContain(result);
    expect(result).toBe(CLIENT_OTHER);
  });

  it("output is always bounded and drawn from the closed set", () => {
    const allowed = new Set([
      CLIENT_CMMCHAT,
      CLIENT_QODER,
      CLIENT_HERMES,
      CLIENT_CODEX,
      CLIENT_GENERIC,
      CLIENT_OTHER,
    ]);
    for (const raw of ["x".repeat(10_000), "  QODER  ", "hermes\n", "a/b/c", ""]) {
      const result = normalizeClientId(raw);
      expect(allowed.has(result)).toBe(true);
      expect(result.length).toBeLessThanOrEqual(64);
    }
  });
});
