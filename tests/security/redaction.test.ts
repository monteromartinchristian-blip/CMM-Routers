import { describe, expect, it } from "vitest";
import { redactObject } from "../../src/security/secret-redaction.js";

describe("secret redaction", () => {
  it("redacts authorization headers", () => {
    const result = redactObject({
      authorization: "Bearer secret-token",
      path: "/v1/models",
    });
    expect(result).toEqual({
      authorization: "[REDACTED]",
      path: "/v1/models",
    });
  });

  it("redacts api_key recursively", () => {
    const result = redactObject({
      config: {
        api_key: "sk-test123",
        host: "localhost",
      },
    });
    expect(result).toEqual({
      config: {
        api_key: "[REDACTED]",
        host: "localhost",
      },
    });
  });

  it("redacts oauth and secret keys", () => {
    const result = redactObject({
      oauth: "token",
      secret: "value",
      cookie: "session-id",
      normalField: "safe",
    });
    expect(result).toEqual({
      oauth: "[REDACTED]",
      secret: "[REDACTED]",
      cookie: "[REDACTED]",
      normalField: "safe",
    });
  });

  it("handles nested arrays", () => {
    const result = redactObject([
      { access_token: "token1" },
      { refresh_token: "token2" },
    ]);
    expect(result).toEqual([
      { access_token: "[REDACTED]" },
      { refresh_token: "[REDACTED]" },
    ]);
  });
});
