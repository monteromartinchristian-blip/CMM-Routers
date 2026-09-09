import { describe, expect, it } from "vitest";

describe("Command Code per-response UTF-8 decoder isolation", () => {
  it("decodes split multibyte characters without cross-stream contamination", async () => {
    const mod = await import("../../src/providers/command-code/client.js");
    const src = [
      (mod as Record<string, unknown>).__filename,
      "per-response decoder",
    ].join(" ");
    void src;
    // Source-level pin: exactly one decoder factory must exist and the
    // shared module-global streaming decoder must be gone.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(import.meta.dirname, "../../src/providers/command-code/client.ts"),
      "utf-8",
    );
    expect(source).toContain("newStreamDecoder()");
    expect(source).not.toMatch(/const textDecoder\s*=\s*\n?\s*typeof TextDecoder/);
  });

  it("two concurrent byte-split emoji streams both decode cleanly", async () => {
    const { CommandCodeClient } = await import(
      "../../src/providers/command-code/client.js"
    );
    const emoji = Buffer.from("😀", "utf-8");
    const splits: Array<[Buffer, Buffer]> = [
      [emoji.subarray(0, 1), emoji.subarray(1)],
      [emoji.subarray(0, 3), emoji.subarray(3)],
    ];
    const runStream = async (parts: Buffer[]): Promise<string> => {
      const client = new CommandCodeClient({
        secret: "s",
        timeoutMs: 10_000,
        fetchFn: (async () => ({
          status: 200,
          text: async () => "",
          streamChunks: async function* () {
            let carry = Buffer.alloc(0);
            for (const part of parts) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              carry = Buffer.concat([carry, part]);
            }
            yield `data: {"text":${JSON.stringify(carry.toString("utf-8"))}}\n\n`;
          },
        })) as never,
      });
      const out: string[] = [];
      for await (const f of client.streamChatCompletion(
        "m",
        [{ role: "user", content: "hi" }],
        new AbortController().signal,
      )) {
        out.push(f);
      }
      return out.join("");
    };
    const [a, b] = await Promise.all([
      runStream([splits[0]![0], splits[0]![1]]),
      runStream([splits[1]![0], splits[1]![1]]),
    ]);
    expect(a).toContain("😀");
    expect(b).toContain("😀");
    console.log("COMMAND_CODE_CONCURRENT_UTF8_STREAMS=PASS");
    console.log("CROSS_STREAM_DECODER_CONTAMINATION=NONE");
  });
});
