import { describe, expect, it } from "vitest";
import {
  buildCodexSpawnEnv,
  resolveCodexProviderHome,
} from "../../src/providers/codex/adapter.js";

describe("Codex upstream CODEX_HOME isolation", () => {
  it("prefers the explicit Router-owned home over runtime injection", () => {
    expect(
      resolveCodexProviderHome("/router/explicit", {
        CMM_ROUTER_CODEX_HOME: "/router/env",
      }),
    ).toBe("/router/explicit");
  });

  it("accepts CMM_ROUTER_CODEX_HOME as the production runtime injection", () => {
    expect(
      resolveCodexProviderHome(undefined, {
        CMM_ROUTER_CODEX_HOME: "/router/env",
      }),
    ).toBe("/router/env");
  });

  it("does not adopt an inherited CODEX_HOME as the upstream profile", () => {
    expect(
      resolveCodexProviderHome(undefined, {
        CODEX_HOME: "/user/.codex",
      }),
    ).toBeUndefined();
  });

  it("fails closed when no Router-owned Codex home was selected", () => {
    expect(() =>
      buildCodexSpawnEnv(undefined, {
        CODEX_HOME: "/user/.codex",
        HOME: "/user",
      }),
    ).toThrow(/isolated CODEX_HOME/);
  });

  it("overrides any inherited CODEX_HOME with the selected upstream home", () => {
    const env = buildCodexSpawnEnv("/router/codex-home", {
      CODEX_HOME: "/user/.codex",
      HOME: "/user",
      PATH: "/bin",
    });

    expect(env.CODEX_HOME).toBe("/router/codex-home");
    expect(env.HOME).toBe("/user");
    expect(env.PATH).toBe("/bin");
  });
});
