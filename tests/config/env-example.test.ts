import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "../..");

describe("environment example matches runtime", () => {
  it("advertises no host/port variables the runtime ignores", () => {
    const example = readFileSync(join(REPO, ".env.example"), "utf-8");
    expect(example).not.toContain("CMM_ROUTER_HOST");
    expect(example).not.toContain("CMM_ROUTER_PORT");
    expect(example).toContain("CMM_ROUTER_TOKEN");
    console.log("ENV_EXAMPLE_MATCHES_RUNTIME=PASS");
  });

  it("schema hard-locks loopback binding", () => {
    const schema = readFileSync(join(REPO, "src/config/schema.ts"), "utf-8");
    expect(schema).toContain('z.literal("127.0.0.1")');
    expect(schema).not.toContain("0.0.0.0");
    console.log("LOOPBACK_ONLY=PASS");
  });
});
