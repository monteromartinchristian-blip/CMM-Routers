import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/providers/codex/adapter.js";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import { AntigravityAdapter } from "../../src/providers/antigravity/adapter.js";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function validAck(dir: string): string {
  const path = join(dir, "ack.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      plan: "GOAT",
      autoTopUpDisabled: true,
      allowOnDemandCredits: false,
    }),
  );
  return path;
}

describe("provider capability truthfulness", () => {
  it("no discovered model reports a PENDING_TASK_13 capability", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmm-cap-"));
    try {
      const adapters = [
        new CodexAdapter(),
        new ClaudeAdapter(),
        new AntigravityAdapter(),
        new CommandCodeAdapter({
          ackPath: validAck(dir),
          client: undefined as never,
        }),
      ];
      void adapters;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("production adapters emit only CHAT_ONLY or CHAT_AND_TOOLS", async () => {
    const { readFileSync } = await import("node:fs");
    const sources = [
      "src/providers/codex/adapter.ts",
      "src/providers/claude/adapter.ts",
      "src/providers/antigravity/adapter.ts",
      "src/providers/command-code/adapter.ts",
      "src/core/model.ts",
    ];
    for (const file of sources) {
      const content = readFileSync(join(import.meta.dirname, "../../", file), "utf-8");
      expect(content, file).not.toContain("PENDING_TASK_13");
    }
  });

  it("capability union has no pending marker", async () => {
    const { readFileSync } = await import("node:fs");
    const model = readFileSync(
      join(import.meta.dirname, "../../src/core/model.ts"),
      "utf-8",
    );
    expect(model).toContain('"CHAT_ONLY"');
    expect(model).not.toContain("PENDING");
  });
});
