import { describe, expect, it } from "vitest";
import { sharedConfigSchema, localConfigSchema } from "../../src/config/schema.js";

describe("config schema", () => {
  it("rejects non-loopback hosts in standalone mode", () => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "0.0.0.0",
    });
    expect(result.success).toBe(false);
  });

  it("accepts loopback host", () => {
    const result = sharedConfigSchema.safeParse({
      mode: "standalone",
      host: "127.0.0.1",
    });
    expect(result.success).toBe(true);
  });

  it("uses default port 8790 when not specified", () => {
    const result = sharedConfigSchema.parse({
      mode: "standalone",
      host: "127.0.0.1",
    });
    expect(result.port).toBe(8790);
  });

  it("rejects local config with secret-like keys", () => {
    const result = localConfigSchema.safeParse({
      apiKey: "secret-value",
    });
    expect(result.success).toBe(false);
  });

  it("rejects local config with oauth tokens", () => {
    const result = localConfigSchema.safeParse({
      oauthToken: "token-value",
    });
    expect(result.success).toBe(false);
  });

  it("accepts local config with only safe keys", () => {
    const result = localConfigSchema.safeParse({
      machineId: "macbook-pro",
      profiles: { claude: "router-profile" },
    });
    expect(result.success).toBe(true);
  });
});
