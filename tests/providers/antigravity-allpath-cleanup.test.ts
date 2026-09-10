import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AntigravityAdapter,
  feedStreamLine,
  type ParsedStreamEvent,
} from "../../src/providers/antigravity/adapter.js";
import type { RouterRequest } from "../../src/core/model.js";

/**
 * The adapter creates its run directories under `os.tmpdir()`, so this suite
 * must observe a PRIVATE temp root: scanning the shared system temp dir races
 * with the other Antigravity suites that run in parallel workers and create
 * `cmm-antigravity-run-*` directories of their own. `os.tmpdir()` re-reads
 * TMPDIR on every call, so pointing it here makes the observation hermetic.
 */
let privateTmpRoot: string;
let savedTmpdir: string | undefined;

beforeAll(() => {
  savedTmpdir = process.env.TMPDIR;
  privateTmpRoot = mkdtempSync(join(tmpdir(), "cmm-allpath-isolated-"));
  process.env.TMPDIR = privateTmpRoot;
});

afterAll(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  rmSync(privateTmpRoot, { recursive: true, force: true });
});

function runDirs(): string[] {
  return readdirSync(tmpdir()).filter((e) => e.startsWith("cmm-antigravity-run-"));
}

function makeRequest(messages: RouterRequest["messages"]): RouterRequest {
  return {
    requestId: `early-${Math.random().toString(36).slice(2, 8)}`,
    model: {
      id: "google/some-model",
      provider: "google",
      upstreamModel: "some-model",
      displayName: "Some",
      capability: "CHAT_ONLY",
    },
    messages,
    tools: [],
    stream: true,
  };
}

async function drain(
  adapter: AntigravityAdapter,
  request: RouterRequest,
): Promise<Array<{ type: string }>> {
  const events: Array<{ type: string }> = [];
  for await (const event of adapter.run(request, new AbortController().signal)) {
    events.push(event as { type: string });
  }
  return events;
}

describe("Antigravity all-path temp cleanup", () => {
  it("empty prompt creates no temp dir", async () => {
    const adapter = new AntigravityAdapter();
    const before = new Set(runDirs());
    const events = await drain(adapter, makeRequest([]));
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(runDirs().filter((d) => !before.has(d))).toEqual([]);
  });

  it("PAYG-poisoned env creates no temp dir", async () => {
    // OPENAI_API_KEY trips assertNoPaygFallback (GEMINI_* is stripped from
    // the child env instead, which is a different passing path).
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "dummy-poison";
    try {
      const adapter = new AntigravityAdapter();
      const before = new Set(runDirs());
      const events = await drain(
        adapter,
        makeRequest([{ role: "user", content: "hi" }]),
      );
      expect(events.map((e) => e.type)).toEqual(["error"]);
      expect(runDirs().filter((d) => !before.has(d))).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  it("spawn failure cleans its temp dir", async () => {
    const runner = {
      async streamInference() {
        throw new Error("spawn agy ENOENT");
      },
      async runInference() {
        throw new Error("spawn agy ENOENT");
      },
    };
    const adapter = new AntigravityAdapter(
      runner as unknown as ConstructorParameters<typeof AntigravityAdapter>[0],
    );
    const before = new Set(runDirs());
    const events = await drain(adapter, makeRequest([{ role: "user", content: "hi" }]));
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(runDirs().filter((d) => !before.has(d))).toEqual([]);
  });

  it("protocol error cleans its temp dir", async () => {
    const runner = {
      async streamInference(
        _args: string[],
        _options: { cwd: string; signal: AbortSignal },
        onEvent: (event: ParsedStreamEvent) => void,
      ) {
        feedStreamLine("not json at all", onEvent);
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      async runInference() {
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
    };
    const adapter = new AntigravityAdapter(
      runner as unknown as ConstructorParameters<typeof AntigravityAdapter>[0],
    );
    const before = new Set(runDirs());
    const events = await drain(adapter, makeRequest([{ role: "user", content: "hi" }]));
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(runDirs().filter((d) => !before.has(d))).toEqual([]);
    console.log("ANTIGRAVITY_ALL_PATH_TEMP_CLEANUP=PASS");
  });
});
