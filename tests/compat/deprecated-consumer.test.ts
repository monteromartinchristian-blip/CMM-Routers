import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONSUMER_CMMCHAT,
  CONSUMER_QODER,
  CODE_ROUTER_TOKEN_ENV,
  QODER_TOKEN_ENV,
  effectiveToolCapability,
} from "../../src/compat/deprecated-consumer.js";
import { PROFILE_CMMCHAT, PROFILE_CODE } from "../../src/core/router-profile.js";

const REPO = join(import.meta.dirname, "../..");

describe("legacy consumer-capability compatibility shim", () => {
  it("keeps the legacy consumer constants but re-points them at profiles", () => {
    expect(CONSUMER_CMMCHAT).toBe(PROFILE_CMMCHAT);
    expect(CONSUMER_QODER).toBe(PROFILE_CODE);
    console.log("LEGACY_CONSUMER_CONSTANTS_PRESERVED=PASS");
  });

  it("preserves the legacy capability semantics used by existing callers", () => {
    expect(effectiveToolCapability(CONSUMER_CMMCHAT, "CHAT_AND_TOOLS")).toBe("CHAT_ONLY");
    expect(effectiveToolCapability(CONSUMER_CMMCHAT, "CHAT_ONLY")).toBe("CHAT_ONLY");
    expect(effectiveToolCapability(CONSUMER_QODER, "CHAT_AND_TOOLS")).toBe("CHAT_AND_TOOLS");
    expect(effectiveToolCapability(CONSUMER_QODER, "CHAT_ONLY")).toBe("CHAT_ONLY");
    expect(effectiveToolCapability(CONSUMER_QODER, undefined)).toBe("CHAT_ONLY");
  });

  it("preserves the legacy env-var name and adds the canonical one", () => {
    expect(QODER_TOKEN_ENV).toBe("CMM_QODER_TOKEN");
    expect(CODE_ROUTER_TOKEN_ENV).toBe("CMM_CODE_ROUTER_TOKEN");
  });

  it("the profile authorization module is product-agnostic", () => {
    const source = readFileSync(join(REPO, "src/core/router-profile.ts"), "utf-8");
    expect(source.toLowerCase()).not.toContain("qoder");
    expect(source.toLowerCase()).not.toContain("hermes");
    expect(source.toLowerCase()).not.toContain("client");
  });

  it("the deprecated vocabulary lives outside the core", () => {
    const source = readFileSync(join(REPO, "src/compat/deprecated-consumer.ts"), "utf-8");
    expect(source).toContain("CONSUMER_QODER");
    // The core module that used to hold it no longer exists.
    expect(() => readFileSync(join(REPO, "src/core/consumer-capability.ts"), "utf-8")).toThrow();
    console.log("LEGACY_VOCABULARY_OUTSIDE_CORE=PASS");
  });
});
