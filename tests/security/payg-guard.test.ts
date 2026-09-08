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
