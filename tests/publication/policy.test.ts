import { describe, expect, it } from "vitest";

async function loadPolicy() {
  return import("../../scripts/publication/lib/policy.mjs");
}

describe("public publication policy", () => {
  it("normalizes generic macOS home paths without embedding the real username in policy", async () => {
    const { sanitizeText } = await loadPolicy();
    const result = sanitizeText("Path: /Users/example/projects/CMM-Routers\n");

    expect(result.text).toBe("Path: /Users/example/projects/CMM-Routers\n");
    expect(result.events).toContainEqual({ rule: "macos-home-path", count: 1 });
  });

  it("normalizes trailing ASCII and NBSP whitespace plus the final newline", async () => {
    const { sanitizeText } = await loadPolicy();
    const result = sanitizeText("a  \n" + "b\u00a0\n" + "c");

    expect(result.text).toBe("a\nb\nc\n");
  });

  it("does not classify NUL-containing buffers as text", async () => {
    const { isProbablyText } = await loadPolicy();

    expect(isProbablyText(Buffer.from([0, 1, 2, 0, 255]))).toBe(false);
    expect(isProbablyText(Buffer.from("plain UTF-8 text\n"))).toBe(true);
  });

  it("blocks known provider credential shapes instead of auto-redacting them", async () => {
    const { scanText } = await loadPolicy();
    const candidate = "token=" + "sk-" + "a".repeat(40);
    const findings = scanText("docs/example.md", candidate);

    expect(findings.some((finding) => finding.severity === "BLOCK")).toBe(true);
    expect(findings.every((finding) => !("value" in finding))).toBe(true);
    expect(
      findings
        .filter((finding) => finding.severity === "BLOCK")
        .every((finding) => /^[a-f0-9]{64}$/.test(finding.valueSha256 ?? "")),
    ).toBe(true);
  });

  it("detects multiple high-confidence credential families without exposing values", async () => {
    const { scanText } = await loadPolicy();
    const samples = [
      "ghp_" + "A".repeat(36),
      "AIza" + "A".repeat(35),
      "AKIA" + "A".repeat(16),
      "xoxb-" + "1".repeat(12) + "-" + "A".repeat(24),
      "eyJ" + "A".repeat(24) + "." + "e30" + "." + "B".repeat(24),
      "-----BEGIN OPENSSH " + "PRIVATE KEY-----",
    ];

    for (const sample of samples) {
      const findings = scanText("docs/example.md", sample);
      expect(findings.some((finding) => finding.severity === "BLOCK")).toBe(true);
      expect(JSON.stringify(findings)).not.toContain(sample);
    }
  });

  it("permits deterministic human-readable auth fixtures only under tests", async () => {
    const { classifySecretLikeLiteral } = await loadPolicy();

    expect(
      classifySecretLikeLiteral(
        "tests/http/example.test.ts",
        "tool-loop-qoder-secret",
        "const BEARER =",
      ),
    ).toBe("SAFE_TEST_FIXTURE");

    expect(
      classifySecretLikeLiteral(
        "src/example.ts",
        "tool-loop-qoder-secret",
        "const BEARER =",
      ),
    ).toBe("BLOCK");
  });

  it("keeps ambiguous test literals in review instead of silently accepting them", async () => {
    const { classifySecretLikeLiteral } = await loadPolicy();

    expect(
      classifySecretLikeLiteral(
        "tests/fixtures/example.txt",
        "fixture-material-12345",
        "unrelated fixture",
      ),
    ).toBe("REVIEW_TEST_FIXTURE");
  });

  it("never marks a known vendor secret shape as a safe test fixture", async () => {
    const { classifySecretLikeLiteral } = await loadPolicy();
    const candidate = "sk-" + "z".repeat(40);

    expect(
      classifySecretLikeLiteral(
        "tests/http/example.test.ts",
        candidate,
        "test bearer token",
      ),
    ).toBe("BLOCK");
  });

  it("publishes a non-empty versioned sanitization policy", async () => {
    const { SANITIZATION_POLICY_VERSION } = await loadPolicy();

    expect(SANITIZATION_POLICY_VERSION).toMatch(
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$/,
    );
  });
});
