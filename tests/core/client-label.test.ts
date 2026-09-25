import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLIENT_LABEL_MAX_LENGTH,
  normalizeClientLabel,
} from "../../src/core/client-identity.js";

const REPO = join(import.meta.dirname, "../..");

/**
 * Subphase A — the core carries no taxonomy of known harnesses.
 *
 * The only application-level value in the core is an optional, bounded, opaque
 * diagnostic label. It is never an authorization input, never a routing input,
 * and a future harness requires no core change to be representable.
 */
describe("opaque client label (core)", () => {
  it("ABSENT_CLIENT_LABEL: absence is valid and yields no label", () => {
    expect(normalizeClientLabel(undefined)).toBeUndefined();
    expect(normalizeClientLabel("")).toBeUndefined();
    expect(normalizeClientLabel("   ")).toBeUndefined();
    console.log("ABSENT_CLIENT_LABEL=PASS");
  });

  it("ARBITRARY_CLIENT_LABEL: any harness name is preserved without a core list", () => {
    for (const label of [
      "deepseek-harness",
      "claude-code",
      "cline",
      "roo",
      "some-future-client",
      "a",
    ]) {
      expect(normalizeClientLabel(label)).toBe(label);
    }
    console.log("ARBITRARY_CLIENT_LABEL=PASS");
  });

  it("CLIENT_LABEL_SANITIZED: hostile input cannot carry markup or separators", () => {
    expect(normalizeClientLabel("evil\u0000<script>")).toBe("evil-script");
    expect(normalizeClientLabel("../../etc/passwd")).toBe("..-..-etc-passwd");
    expect(normalizeClientLabel("A B\tC")).toBe("a-b-c");
    const sanitized = normalizeClientLabel("qoder; rm -rf / && curl x")!;
    expect(sanitized).toMatch(/^[a-z0-9._-]+$/);
    console.log("CLIENT_LABEL_SANITIZED=PASS");
  });

  it("CLIENT_LABEL_BOUNDED: the label length is bounded", () => {
    const label = normalizeClientLabel("x".repeat(10_000))!;
    expect(label.length).toBe(CLIENT_LABEL_MAX_LENGTH);
    for (const raw of ["y".repeat(64), "z".repeat(65), "q".repeat(500)]) {
      expect(normalizeClientLabel(raw)!.length).toBeLessThanOrEqual(CLIENT_LABEL_MAX_LENGTH);
    }
    console.log("CLIENT_LABEL_BOUNDED=PASS");
  });

  it("a value that sanitizes away entirely is absence, not a synthetic category", () => {
    expect(normalizeClientLabel("\u0000\u0007")).toBeUndefined();
    expect(normalizeClientLabel("---")).toBeUndefined();
  });

  it("the core identity module declares no known-harness taxonomy", () => {
    const source = readFileSync(join(REPO, "src/core/client-identity.ts"), "utf-8").toLowerCase();
    for (const harness of ["qoder", "hermes", "codex", "claude", "cline", "roo", "deepseek"]) {
      expect(source, `src/core/client-identity.ts must not name ${harness}`).not.toContain(harness);
    }
    // No closed enum / allow-list of clients either.
    expect(source).not.toContain("known_clients");
    expect(source).not.toContain("knownclients");
  });

  it("no core module defines a branded client taxonomy", () => {
    const dir = join(REPO, "src/core");
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(dir, file), "utf-8").toLowerCase();
      for (const harness of ["qoder", "hermes", "codex-client", "cline", "roo", "deepseek"]) {
        expect(source, `src/core/${file} must not name the harness ${harness}`).not.toContain(
          harness,
        );
      }
    }
    console.log("CORE_HAS_NO_HARNESS_TAXONOMY=PASS");
  });
});
