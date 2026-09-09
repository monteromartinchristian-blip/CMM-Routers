import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";

describe("CodexAppServerClient", () => {
  it("can be instantiated", () => {
    // Simple instantiation test without complex stream mocking
    const { Duplex } = require("node:stream");
    const duplex = new Duplex({ read() {}, write() {} });
    const client = new CodexAppServerClient(duplex);
    expect(client).toBeDefined();
  });

  it("has correct provider id in adapter", async () => {
    const { CodexAdapter } = await import("../../src/providers/codex/adapter.js");
    const adapter = new CodexAdapter();
    expect(adapter.id).toBe("chatgpt");
  });
});
