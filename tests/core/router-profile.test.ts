import { describe, expect, it } from "vitest";
import {
  PROFILE_CHAT,
  PROFILE_AGENT,
  effectiveProfileToolCapability,
} from "../../src/core/router-profile.js";

describe("router profile capability policy", () => {
  it("CMMCHAT_CHAT_ONLY: the CMMChat profile is CHAT_ONLY on every provider capability", () => {
    expect(effectiveProfileToolCapability(PROFILE_CHAT, "CHAT_AND_TOOLS")).toBe("CHAT_ONLY");
    expect(effectiveProfileToolCapability(PROFILE_CHAT, "CHAT_ONLY")).toBe("CHAT_ONLY");
    expect(effectiveProfileToolCapability(PROFILE_CHAT, undefined)).toBe("CHAT_ONLY");
    console.log("CMMCHAT_CHAT_ONLY=PASS");
  });

  it("CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS: the Code profile needs a capable provider", () => {
    expect(effectiveProfileToolCapability(PROFILE_AGENT, "CHAT_AND_TOOLS")).toBe("CHAT_AND_TOOLS");
    console.log("CMM_CODE_ROUTER_PROFILE=CHAT_AND_TOOLS");
  });

  it("no unknown-capability promotion: Code profile is CHAT_ONLY without proven capability", () => {
    expect(effectiveProfileToolCapability(PROFILE_AGENT, "CHAT_ONLY")).toBe("CHAT_ONLY");
    expect(effectiveProfileToolCapability(PROFILE_AGENT, undefined)).toBe("CHAT_ONLY");
    expect(effectiveProfileToolCapability(PROFILE_AGENT, "PENDING_TASK_13")).toBe("CHAT_ONLY");
  });

  it("the two profiles are distinct and stable", () => {
    expect(PROFILE_CHAT).toBe("CHAT");
    expect(PROFILE_AGENT).toBe("AGENT");
    expect(PROFILE_CHAT).not.toBe(PROFILE_AGENT);
  });

  it("client identity is never an argument to the capability decision", () => {
    // The signature is (profile, providerCapability). A client identity cannot
    // be passed, so it cannot elevate: this is a structural guarantee.
    expect(effectiveProfileToolCapability.length).toBe(2);
  });
});
