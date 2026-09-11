import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { AntigravityAdapter } from "../../src/providers/antigravity/adapter.js";

function discoveryDirs(): string[] {
  return readdirSync(tmpdir()).filter((e) => e.startsWith("cmm-antigravity-discovery-"));
}

describe("Antigravity discovery temp cleanup", () => {
  it("removes its temp directory on successful discovery", async () => {
    const fakeRunner = {
      run: () => ({
        status: 0,
        signal: null,
        stdout: "gemini-3.8-flash-low     Flash Low\n",
        stderr: "",
      }),
    };
    const adapter = new AntigravityAdapter(
      undefined,
      fakeRunner as unknown as ConstructorParameters<typeof AntigravityAdapter>[1],
    );
    const before = new Set(discoveryDirs());
    const models = await adapter.discoverModels();
    expect(models.length).toBe(1);
    const leaked = discoveryDirs().filter((d) => !before.has(d));
    expect(leaked).toEqual([]);
    console.log("ANTIGRAVITY_DISCOVERY_TEMP_CLEANUP=PASS");
  });

  it("removes its temp directory when discovery throws", async () => {
    const fakeRunner = {
      run: () => {
        throw new Error("spawn agy ENOENT");
      },
    };
    const adapter = new AntigravityAdapter(
      undefined,
      fakeRunner as unknown as ConstructorParameters<typeof AntigravityAdapter>[1],
    );
    const before = new Set(discoveryDirs());
    await expect(adapter.discoverModels()).rejects.toThrow();
    const leaked = discoveryDirs().filter((d) => !before.has(d));
    expect(leaked).toEqual([]);
    void existsSync;
  });
});
