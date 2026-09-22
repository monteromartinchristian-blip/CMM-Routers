import { describe, expect, it } from "vitest";
import {
  PROFILE_CMMCHAT,
  PROFILE_CODE,
  effectiveProfileToolCapability,
} from "../../src/core/router-profile.js";

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
