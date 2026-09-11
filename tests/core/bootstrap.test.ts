import { describe, expect, it } from "vitest";

describe("bootstrap", () => {
  it("runs the TypeScript test toolchain", () => {
    expect(process.versions.node).toBeTruthy();
  });
});
