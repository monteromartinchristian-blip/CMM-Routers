import { describe, expect, it } from "vitest";
import { RouterError } from "../../src/core/errors.js";

describe("RouterError", () => {
  it("keeps stable error categories and safe metadata", () => {
    const error = new RouterError(
      "provider_quota_exhausted",
      "quota exhausted",
      { provider: "google", retryAfterMs: 5000 },
    );

    expect(error.code).toBe("provider_quota_exhausted");
    expect(error.meta.provider).toBe("google");
  });
});
