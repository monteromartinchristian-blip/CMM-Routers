import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "../../src");

function readSource(relative: string): string {
  return readFileSync(join(SRC, relative), "utf-8");
}

describe("runtime log hygiene", () => {
  it("never logs completion deltas or message content", () => {
    const offenders: string[] = [];
    const files = [
      "providers/codex/adapter.ts",
      "providers/codex/app-server-client.ts",
      "providers/claude/adapter.ts",
      "providers/antigravity/adapter.ts",
      "providers/command-code/adapter.ts",
      "providers/command-code/client.ts",
      "http/openai-chat.ts",
      "http/openai-responses.ts",
      "http/diagnostics.ts",
    ];
    const contentPatterns = [
      /Yielding delta/,
      /substring\(0, 50\)/,
      /console.*delta|delta.*console\.log/,
    ];
    for (const file of files) {
      const source = readSource(file);
      for (const pattern of contentPatterns) {
        if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("codex adapter carries no console logging at all", () => {
    for (const file of ["providers/codex/adapter.ts", "providers/codex/app-server-client.ts"]) {
      const source = readSource(file);
      expect(source, file).not.toMatch(/console\.(log|error|debug|warn)/);
    }
  });

  it("normalizes Codex turn statuses to the neutral finish vocabulary", async () => {
    const { normalizeCodexFinishReason } = await import(
      "../../src/providers/codex/adapter.js"
    );
    expect(normalizeCodexFinishReason("completed")).toBe("stop");
    expect(normalizeCodexFinishReason("stop")).toBe("stop");
    expect(normalizeCodexFinishReason("tool_calls")).toBe("tool_calls");
    expect(normalizeCodexFinishReason("tool_calls_requested")).toBe("tool_calls");
    expect(normalizeCodexFinishReason("length")).toBe("length");
    expect(normalizeCodexFinishReason("max_tokens")).toBe("length");
    expect(normalizeCodexFinishReason("max_output_tokens")).toBe("length");
    expect(normalizeCodexFinishReason("truncated")).toBe("length");
    expect(normalizeCodexFinishReason("weird-future-status")).toBe("stop");
    expect(normalizeCodexFinishReason(undefined)).toBe("stop");
  });
});
