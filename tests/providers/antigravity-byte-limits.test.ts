import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SpawnInferenceRunner,
  type ParsedStreamEvent,
} from "../../src/providers/antigravity/adapter.js";
import {
  CappedTextBuffer,
  MAX_AGY_STDERR_DIAGNOSTIC_BYTES,
  MAX_AGY_STDOUT_DIAGNOSTIC_BYTES,
} from "../../src/providers/antigravity/process-client.js";

const MULTIBYTE_OVERSIZE = join(
  import.meta.dirname,
  "../helpers/multibyte-oversize-provider.js",
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

describe("CappedTextBuffer enforces a real UTF-8 byte bound", () => {
  it("bounds stdout diagnostics by bytes for multibyte-only input without splitting", () => {
    const cap = 4096;
    const buf = new CappedTextBuffer(cap);
    buf.push("中".repeat(3000)); // 3 bytes per code point
    buf.push("é".repeat(3000)); // 2 bytes per code point
    const value = buf.value();
    expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(cap);
    expect(buf.didOverflow()).toBe(true);
    expect(value.length).toBeGreaterThan(0);
    // A head region survived (the earliest retained code points).
    expect(value.startsWith("中")).toBe(true);
    expect(value.includes("\uFFFD")).toBe(false);
    console.log("AGY_STDOUT_UTF8_BYTE_BOUND=PASS");
  });

  it("bounds stderr diagnostics by bytes and keeps the most recent tail", () => {
    const cap = 1024;
    const buf = new CappedTextBuffer(cap);
    buf.push("😀".repeat(400)); // 4 bytes per code point
    buf.push("é"); // last pushed code point, 2 bytes
    const value = buf.value();
    expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(cap);
    expect(buf.didOverflow()).toBe(true);
    expect(value.length).toBeGreaterThan(0);
    // The tail region retains the most recent code point.
    expect(value.endsWith("é")).toBe(true);
    expect(value.includes("\uFFFD")).toBe(false);
    console.log("AGY_STDERR_UTF8_BYTE_BOUND=PASS");
  });

  it("drops a code point larger than the remaining room instead of corrupting it", () => {
    // cap 2 => headCap 1, tailCap 1: a 4-byte emoji cannot fit anywhere.
    const buf = new CappedTextBuffer(2);
    buf.push("😀😀");
    const value = buf.value();
    expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(2);
    expect(buf.didOverflow()).toBe(true);
    expect(value.includes("\uFFFD")).toBe(false);
    // Only whole code points (or nothing) may be retained.
    expect(value === "" || value === "😀").toBe(true);

    // cap 3 => headCap 1, tailCap 2: the 2-byte "é" fits the tail whole.
    const small = new CappedTextBuffer(3);
    small.push("é");
    expect(Buffer.byteLength(small.value(), "utf8")).toBeLessThanOrEqual(3);
    expect(small.value()).toBe("é");
    expect(small.value().includes("\uFFFD")).toBe(false);
  });

  it("holds the documented stdout/stderr constants to a byte bound", () => {
    for (const cap of [
      MAX_AGY_STDOUT_DIAGNOSTIC_BYTES,
      MAX_AGY_STDERR_DIAGNOSTIC_BYTES,
    ]) {
      const buf = new CappedTextBuffer(cap);
      // `cap` code points => 3 * cap bytes, far over the byte bound while the
      // raw character count stays below it.
      buf.push("中".repeat(cap));
      const value = buf.value();
      expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(cap);
      expect(buf.didOverflow()).toBe(true);
      expect(value.length).toBeGreaterThan(0);
      expect(value.includes("\uFFFD")).toBe(false);
    }
  });
});

describe("SpawnInferenceRunner enforces the NDJSON line bound in bytes", () => {
  const MAX_LINE_BYTES = 512;
  const MULTIBYTE_CHARS = 300;
  const LINE = JSON.stringify({
    event: "step_update",
    step_update: { text_delta: "中".repeat(MULTIBYTE_CHARS) },
  });

  const savedChars = process.env.CMM_TEST_MULTIBYTE_CHARS;
  const savedNewline = process.env.CMM_TEST_MULTIBYTE_NEWLINE;

  beforeAll(() => {
    process.env.CMM_TEST_MULTIBYTE_CHARS = String(MULTIBYTE_CHARS);
  });

  afterAll(() => {
    if (savedChars === undefined) delete process.env.CMM_TEST_MULTIBYTE_CHARS;
    else process.env.CMM_TEST_MULTIBYTE_CHARS = savedChars;
    if (savedNewline === undefined) delete process.env.CMM_TEST_MULTIBYTE_NEWLINE;
    else process.env.CMM_TEST_MULTIBYTE_NEWLINE = savedNewline;
  });

  it("fails closed on an unterminated multibyte line over the byte bound", async () => {
    // Adversarial precondition: under the character bound, over the byte bound.
    expect(LINE.length).toBeLessThan(MAX_LINE_BYTES);
    expect(Buffer.byteLength(LINE, "utf8")).toBeGreaterThan(MAX_LINE_BYTES);
    delete process.env.CMM_TEST_MULTIBYTE_NEWLINE;

    const runner = new SpawnInferenceRunner(process.execPath, {
      maxNdjsonLineBytes: MAX_LINE_BYTES,
      maxStdoutDiagnosticBytes: 256,
      maxStderrDiagnosticBytes: 256,
      terminationGraceMs: 200,
    });
    const events: ParsedStreamEvent[] = [];
    let pid: number | undefined;
    const result = await runner.streamInference(
      [MULTIBYTE_OVERSIZE],
      {
        cwd: tmpdir(),
        timeoutMs: 3000,
        signal: new AbortController().signal,
        onSpawn: (p) => (pid = p),
      },
      (event) => events.push(event),
    );

    const protocolErrors = events.filter((e) => e.kind === "protocolError");
    expect(protocolErrors).toHaveLength(1);
    expect(events.some((e) => e.kind === "completed")).toBe(false);
    // The retained raw diagnostics stay byte-bounded despite multibyte flooding.
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(256);
    await waitFor(() => pid !== undefined && !alive(pid));
    expect(alive(pid as number)).toBe(false);

    console.log("AGY_NDJSON_UTF8_BYTE_BOUND=PASS");
    console.log("AGY_DIAGNOSTIC_MEMORY_REMAINS_BOUNDED=PASS");
  }, 30000);

  it("fails closed on a newline-terminated multibyte line over the byte bound", async () => {
    process.env.CMM_TEST_MULTIBYTE_NEWLINE = "1";

    const runner = new SpawnInferenceRunner(process.execPath, {
      maxNdjsonLineBytes: MAX_LINE_BYTES,
      maxStdoutDiagnosticBytes: 256,
      maxStderrDiagnosticBytes: 256,
      terminationGraceMs: 200,
    });
    const events: ParsedStreamEvent[] = [];
    let pid: number | undefined;
    await runner.streamInference(
      [MULTIBYTE_OVERSIZE],
      {
        cwd: tmpdir(),
        timeoutMs: 3000,
        signal: new AbortController().signal,
        onSpawn: (p) => (pid = p),
      },
      (event) => events.push(event),
    );

    const protocolErrors = events.filter((e) => e.kind === "protocolError");
    expect(protocolErrors).toHaveLength(1);
    expect(events.some((e) => e.kind === "completed")).toBe(false);
    await waitFor(() => pid !== undefined && !alive(pid));
    expect(alive(pid as number)).toBe(false);

    console.log("AGY_NDJSON_TERMINATED_UTF8_BYTE_BOUND=PASS");
  }, 30000);
});
