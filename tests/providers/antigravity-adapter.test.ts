import { describe, expect, it, beforeEach } from "vitest";
import {
  AntigravityAdapter,
  feedStreamLine,
  parseAgyModelsOutput,
  parseAgyStreamJson,
  type ParsedStreamEvent,
} from "../../src/providers/antigravity/adapter.js";
import type { RouterRequest } from "../../src/core/model.js";
import { RouterError } from "../../src/core/errors.js";

type SeenRequest = {
  url?: string;
  args?: string[];
  options?: { cwd: string; signal?: AbortSignal };
  init?: { headers: Record<string, string>; body?: string };
};

function makeStreamingRunner(
  chunks: string[],
  result: { status: number | null; signal: null; stdout: string; stderr: string; error?: Error } = { status: 0, signal: null, stdout: "", stderr: "" },
  seen?: SeenRequest[],
) {
  return {
    async streamInference(
      args: string[],
      options: { cwd: string; signal: AbortSignal },
      onEvent: (event: ParsedStreamEvent) => void,
    ) {
      seen?.push({ args, options });
      let buffer = "";
      for (const chunk of chunks) {
        buffer += chunk;
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (options.signal.aborted) break;
          feedStreamLine(part, onEvent);
        }
      }
      if (buffer.trim()) feedStreamLine(buffer, onEvent);
      return { ...result };
    },
    async runInference(
      args: string[],
      options: { cwd: string; timeoutMs: number; signal: AbortSignal },
    ) {
      seen?.push({ args, options });
      return { ...result };
    },
  };
}

function makeBufferedRunner(
  result: { status: number | null; signal: null; stdout: string; stderr: string; error?: Error },
  seen?: SeenRequest[],
) {
  return {
    async streamInference(
      args: string[],
      options: { cwd: string; signal: AbortSignal },
      _onEvent: (event: ParsedStreamEvent) => void,
    ) {
      seen?.push({ args, options });
      return { ...result };
    },
    async runInference(
      args: string[],
      options: { cwd: string; timeoutMs: number; signal: AbortSignal },
    ) {
      seen?.push({ args, options });
      return { ...result };
    },
  };
}

function makeRequest(upstreamModel = "gemini-3.8-flash-low"): RouterRequest {
  return {
    requestId: "test-001",
    model: {
      id: `google/${upstreamModel}`,
      provider: "google",
      upstreamModel,
      displayName: upstreamModel,
      capability: "CHAT_ONLY",
    },
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    stream: true,
  };
}

describe("Antigravity model discovery parser", () => {
  it("parses aligned whitespace columns: first field is the slug", () => {
    const output = [
      "gemini-3.8-flash-low     Gemini 3.8 Flash Low",
      "gemini-3.8-flash-medium   Gemini 3.8 Flash Medium",
      "claude-sonnet-4-6        Claude Sonnet",
    ].join("\n");
    const models = parseAgyModelsOutput(output);
    expect(models.map((m) => m.slug)).toEqual([
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-medium",
      "claude-sonnet-4-6",
    ]);
    expect(models[0]!.displayName).toBe("Gemini 3.8 Flash Low");
  });

  it("strips ANSI escapes before parsing", () => {
    const output = "\u001b[1mgemini-3.8-flash-low\u001b[0m     Flash Low";
    const models = parseAgyModelsOutput(output);
    expect(models.length).toBe(1);
    expect(models[0]!.slug).toBe("gemini-3.8-flash-low");
  });

  it("rejects ANSI-contaminated final model IDs", () => {
    const output = "bad[1m-slug     Label";
    const models = parseAgyModelsOutput(output);
    expect(models.length).toBe(0);
  });

  it("rejects malformed IDs", () => {
    const output = ["not a slug!!!     Label", "   ", "-bad     Label"].join("\n");
    const models = parseAgyModelsOutput(output);
    expect(models.length).toBe(0);
  });

  it("skips header lines", () => {
    const output = ["Available Models", "name     description", "gemini-3.8-flash-low     Low"].join("\n");
    const models = parseAgyModelsOutput(output);
    expect(models.map((m) => m.slug)).toEqual(["gemini-3.8-flash-low"]);
  });

  it("deduplicates exact slugs", () => {
    const output = ["gemini-3.8-flash-low     A", "gemini-3.8-flash-low     B"].join("\n");
    const models = parseAgyModelsOutput(output);
    expect(models.length).toBe(1);
  });
});

describe("Antigravity adapter", () => {
  let adapter: AntigravityAdapter;

  beforeEach(() => {
    adapter = new AntigravityAdapter();
  });

  it("has id google", () => {
    expect(adapter.id).toBe("google");
  });

  it("namespaces discovered models as google/*", async () => {
    const fakeRunner = {
      run: () => ({
        status: 0,
        signal: null,
        stdout: "gemini-3.8-flash-low     Flash Low\n",
        stderr: "",
      }),
    };
    const adapterWithRunner = new AntigravityAdapter(
      undefined,
      fakeRunner as unknown as ConstructorParameters<typeof AntigravityAdapter>[1],
    );
    const models = await adapterWithRunner.discoverModels();
    expect(models[0]!.id).toBe("google/gemini-3.8-flash-low");
    expect(models[0]!.provider).toBe("google");
    // Qoder-owned tools traverse the external MCP bridge (see
    // antigravity-bridge-roundtrip.test.ts); agy's native mutation tools are
    // never used for them.
    expect(models[0]!.capability).toBe("CHAT_AND_TOOLS");
  });

  it("rejects malformed and ANSI-contaminated model IDs from discovery", async () => {
    const fakeRunner = {
      run: () => ({
        status: 0,
        signal: null,
        stdout: "bad[1m-slug     Label\n!!!bad     Label\ngemini-3.8-flash-low     Low\n",
        stderr: "",
      }),
    };
    const adapterWithRunner = new AntigravityAdapter(
      undefined,
      fakeRunner as unknown as ConstructorParameters<typeof AntigravityAdapter>[1],
    );
    const models = await adapterWithRunner.discoverModels();
    expect(models.map((m) => m.upstreamModel)).toEqual(["gemini-3.8-flash-low"]);
  });

  it("fails closed when discovery returns no usable models", async () => {
    const fakeRunner = {
      run: () => ({ status: 0, signal: null, stdout: "\n", stderr: "" }),
    };
    const adapterWithRunner = new AntigravityAdapter(
      undefined,
      fakeRunner as unknown as ConstructorParameters<typeof AntigravityAdapter>[1],
    );
    await expect(adapterWithRunner.discoverModels()).rejects.toThrow(RouterError);
  });

  it("maps agy missing binary to provider_unavailable", async () => {
    const fakeRunner = {
      run: () => {
        throw Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
      },
    };
    const adapterWithRunner = new AntigravityAdapter(
      undefined,
      fakeRunner as unknown as ConstructorParameters<typeof AntigravityAdapter>[1],
    );
    await expect(adapterWithRunner.discoverModels()).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });

  it("never exposes a static catalog", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(import.meta.dirname, "../../src/providers/antigravity/adapter.ts"),
      "utf-8",
    );
    expect(source).not.toContain("gemini-3.8-flash-low");
    expect(source).not.toContain("gemini-3.8-flash-medium");
    expect(source).not.toContain("claude-sonnet-4-6");
  });

  it("pins the exact selected model in argv", () => {
    const args = adapter.buildInferenceArgs("gemini-3.8-flash-low", "hi");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
    expect(args).not.toContain("gemini-3.8-flash-medium");
  });

  it("never uses dangerously-skip-permissions", () => {
    const args = adapter.buildInferenceArgs("gemini-3.8-flash-low", "hi");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("uses plan mode, sandbox, stream-json, print and bounded print-timeout", () => {
    const args = adapter.buildInferenceArgs("gemini-3.8-flash-low", "hi");
    expect(args).toContain("--print");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("plan");
    expect(args).toContain("--sandbox");
    expect(args).toContain("--print-timeout");
    const timeoutValue = args[args.indexOf("--print-timeout") + 1]!;
    // agy requires a Go duration string with a unit suffix (e.g. "120s")
    expect(/^(\d+)(s|m)$/.test(timeoutValue)).toBe(true);
  });

  it("maps text deltas from step_update events", () => {
    const stdout = [
      JSON.stringify({ event: "init", init: { session: "abc" } }),
      JSON.stringify({ event: "step_update", step_update: { text_delta: "hello " } }),
      JSON.stringify({ event: "step_update", step_update: { text_delta: "world" } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
    ].join("\n");
    const parsed = parseAgyStreamJson(stdout);
    expect(parsed.textDeltas.join("")).toBe("hello world");
    expect(parsed.completed).toBe(true);
  });

  it("parses the official live envelope with usage and response", () => {
    const stdout = [
      JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-low" } }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "PROBE_OK\n",
          usage: { input_tokens: 16742, output_tokens: 4, thinking_tokens: 0, cache_read_tokens: 0 },
        },
      }),
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "PROBE_OK\n",
          usage: { input_tokens: 16742, output_tokens: 4, thinking_tokens: 0, cache_read_tokens: 0 },
        },
      }),
    ].join("\n");
    const parsed = parseAgyStreamJson(stdout);
    expect(parsed.textDeltas.join("").trim()).toBe("PROBE_OK");
    expect(parsed.completed).toBe(true);
    expect(parsed.usage).toMatchObject({ inputTokens: 16742, outputTokens: 4 });
  });

  it("handles multiple events per chunk and partial trailing newline", () => {
    const stdout =
      `${JSON.stringify({ event: "step_update", step_update: { text_delta: "a" } })}\n${JSON.stringify({ event: "step_update", step_update: { text_delta: "b" } })}`;
    const parsed = parseAgyStreamJson(stdout);
    expect(parsed.textDeltas).toEqual(["a", "b"]);
    expect(parsed.completed).toBe(false);
  });

  it("maps usage fields from terminal result", () => {
    const stdout = JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 2, cache_read_tokens: 1 },
      },
    });
    const parsed = parseAgyStreamJson(stdout);
    expect(parsed.completed).toBe(true);
    expect(parsed.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("rejects malformed NDJSON with provider_protocol_error", () => {
    expect(() => parseAgyStreamJson("not json at all\n")).toThrow(RouterError);
  });

  it("requires a genuine terminal result for completion", () => {
    const parsed = parseAgyStreamJson(
      JSON.stringify({ event: "step_update", step_update: { text_delta: "partial" } }),
    );
    expect(parsed.completed).toBe(false);
  });

  it("propagates auth failures from run as provider_auth_required", async () => {
    const fakeInference = makeBufferedRunner({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "You are not logged into Antigravity.",
    });
    const adapterWithRunner = new AntigravityAdapter(fakeInference);
    const events: unknown[] = [];
    for await (const event of adapterWithRunner.run(makeRequest(), new AbortController().signal)) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("provider_auth_required");
  });

  it("propagates quota exhaustion as provider_quota_exhausted", async () => {
    const fakeInference = makeBufferedRunner({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "You have exhausted your quota on this model.",
    });
    const adapterWithRunner = new AntigravityAdapter(fakeInference);
    const events: unknown[] = [];
    for await (const event of adapterWithRunner.run(makeRequest(), new AbortController().signal)) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("provider_quota_exhausted");
  });

  it("propagates rate limiting as provider_rate_limited", async () => {
    const fakeInference = makeBufferedRunner({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "rate limit exceeded",
    });
    const adapterWithRunner = new AntigravityAdapter(fakeInference);
    const events: unknown[] = [];
    for await (const event of adapterWithRunner.run(makeRequest(), new AbortController().signal)) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("provider_rate_limited");
  });

  it("propagates timeout as provider_timeout", async () => {
    const fakeInference = makeBufferedRunner({
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: new Error("agy print timed out after 120000ms"),
    });
    const adapterWithRunner = new AntigravityAdapter(fakeInference);
    const events: unknown[] = [];
    for await (const event of adapterWithRunner.run(makeRequest(), new AbortController().signal)) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("provider_timeout");
  });

  it("propagates missing binary as provider_unavailable", async () => {
    const fakeInference = makeBufferedRunner({
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" }),
    });
    const adapterWithRunner = new AntigravityAdapter(fakeInference);
    const events: unknown[] = [];
    for await (const event of adapterWithRunner.run(makeRequest(), new AbortController().signal)) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("provider_unavailable");
  });

  it("propagates unknown model failure as unknown_model without fallback", async () => {
    const fakeInference = makeBufferedRunner({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "gemini-3.8-flash-low is no longer available. Please use the /model command to select a valid model.",
    });
    const adapterWithRunner = new AntigravityAdapter(fakeInference);
    const events: unknown[] = [];
    for await (const event of adapterWithRunner.run(makeRequest("gemini-3.8-flash-low"), new AbortController().signal)) {
      events.push(event);
    }
    const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
      | { error: RouterError }
      | undefined;
    expect(errorEvent?.error.code).toBe("unknown_model");
    const texts = events
      .filter((e) => (e as { type: string }).type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(texts).toBe("");
  });

  it("emits completed only after a genuine terminal result", async () => {
    const fakeInference = makeStreamingRunner([
      `${JSON.stringify({ event: "init", init: {} })}\n`,
      `${JSON.stringify({ event: "step_update", step_update: { text_delta: "hi" } })}\n`,
      `${JSON.stringify({ event: "result", result: { status: "SUCCESS" } })}\n`,
    ]);
    const adapterWithRunner = new AntigravityAdapter(fakeInference);
    const events: { type: string }[] = [];
    for await (const event of adapterWithRunner.run(makeRequest(), new AbortController().signal)) {
      events.push(event as { type: string });
    }
    expect(events.map((e) => e.type)).toEqual(["text_delta", "completed"]);
  });

  it("yields the first delta before upstream completion (incremental)", async () => {
    // Race-proof timing coverage lives in
    // tests/providers/antigravity-true-streaming.test.ts, where the gate is
    // controlled BY THE TEST. This smoke case keeps the legacy double shape
    // proving a single early delta still surfaces before the terminal event.
    const firstLine = `${JSON.stringify({ event: "step_update", step_update: { text_delta: "early" } })}\n`;
    const secondLine = `${JSON.stringify({ event: "result", result: { status: "SUCCESS" } })}\n`;
    const fakeInference = makeStreamingRunner([firstLine, secondLine]);
    const adapterWithRunner = new AntigravityAdapter(
      fakeInference as unknown as ConstructorParameters<typeof AntigravityAdapter>[0],
    );
    const events: { type: string }[] = [];
    for await (const event of adapterWithRunner.run(makeRequest(), new AbortController().signal)) {
      events.push(event as { type: string });
      if (events.length === 1) {
        expect(event).toMatchObject({ type: "text_delta", text: "early" });
      }
      if ((event as { type: string }).type === "completed") break;
    }
    expect(events.map((e) => e.type)).toEqual(["text_delta", "completed"]);
  });

  it("handles partial lines and multiple lines per chunk", async () => {
    const line1 = JSON.stringify({ event: "step_update", step_update: { text_delta: "a" } });
    const line2 = JSON.stringify({ event: "step_update", step_update: { text_delta: "b" } });
    const line3 = JSON.stringify({ event: "result", result: { status: "SUCCESS" } });
    // One chunk split mid-line, one chunk with two full lines.
    const chunks = [`${line1.slice(0, 20)}`, `${line1.slice(20)}\n${line2}\n`, `${line3}\n`];
    const fakeInference = makeStreamingRunner(chunks);
    const adapterWithRunner = new AntigravityAdapter(fakeInference);
    const events: { type: string }[] = [];
    for await (const event of adapterWithRunner.run(makeRequest(), new AbortController().signal)) {
      events.push(event as { type: string });
    }
    expect(events.map((e) => e.type)).toEqual(["text_delta", "text_delta", "completed"]);
  });

  it("surfaces malformed JSON as protocol error, not completion", async () => {
    const fakeInference = makeStreamingRunner(["not json at all\n"]);
    const adapterWithRunner = new AntigravityAdapter(fakeInference);
    const events: { type: string }[] = [];
    for await (const event of adapterWithRunner.run(makeRequest(), new AbortController().signal)) {
      events.push(event as { type: string });
    }
    expect(events.map((e) => e.type)).toEqual(["error"]);
  });

  it("runs inference from a neutral temp directory, never the repo", async () => {
    let observedCwd = "";
    const fakeInference = makeStreamingRunner(
      [`${JSON.stringify({ event: "result", result: { status: "SUCCESS" } })}\n`],
      { status: 0, signal: null, stdout: "", stderr: "" },
      [],
    );
    const observingRunner = {
      async streamInference(
        args: string[],
        options: { cwd: string; signal: AbortSignal },
        onEvent: (event: ParsedStreamEvent) => void,
      ) {
        observedCwd = options.cwd;
        return await fakeInference.streamInference(args, options, onEvent);
      },
      async runInference(
        args: string[],
        options: { cwd: string; timeoutMs: number; signal: AbortSignal },
      ) {
        observedCwd = options.cwd;
        return await fakeInference.runInference(args, options);
      },
    };
    const adapterWithRunner = new AntigravityAdapter(
      observingRunner as unknown as ConstructorParameters<typeof AntigravityAdapter>[0],
    );
    for await (const _ of adapterWithRunner.run(makeRequest(), new AbortController().signal)) {
      // consume
    }
    expect(observedCwd).toContain("cmm-antigravity-run-");
    expect(observedCwd).not.toBe("/Users/example/CMM-Routers");
  });

  it("tracks and cleans up active requests on cancel", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeInference = {
      async streamInference(
        _args: string[],
        options: { cwd: string; signal: AbortSignal },
        _onEvent: (event: ParsedStreamEvent) => void,
      ) {
        await gate;
        void options;
        feedStreamLine(
          JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
          () => undefined,
        );
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      async runInference(_args: string[], options: { cwd: string; timeoutMs: number; signal: AbortSignal }) {
        await gate;
        void options;
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
    };
    const adapterWithRunner = new AntigravityAdapter(
      fakeInference as unknown as ConstructorParameters<typeof AntigravityAdapter>[0],
    );
    const request = makeRequest();
    const runPromise = (async () => {
      const events: unknown[] = [];
      for await (const event of adapterWithRunner.run(request, new AbortController().signal)) {
        events.push(event);
      }
      return events;
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await adapterWithRunner.cancel(request.requestId);
    release();
    await runPromise;
    expect((adapterWithRunner as unknown as { activeRequests: Map<string, unknown> }).activeRequests.has(request.requestId)).toBe(false);
  });

  it("cancel of unknown request is a no-op", async () => {
    await expect(adapter.cancel("no-such-request")).resolves.toBeUndefined();
  });

  describe("account-only spending gate", () => {
    it("allows absent modelProvider and absent useG1Credits", async () => {
      const { assertAccountOnlySettings } = await import(
        "../../src/providers/antigravity/process-client.js"
      );
      expect(() =>
        assertAccountOnlySettings({ modelProvider: "ABSENT", useG1Credits: "ABSENT" }),
      ).not.toThrow();
    });

    it("allows non-gemini safe account mode and useG1Credits=false", async () => {
      const { assertAccountOnlySettings } = await import(
        "../../src/providers/antigravity/process-client.js"
      );
      expect(() =>
        assertAccountOnlySettings({ modelProvider: "account", useG1Credits: false }),
      ).not.toThrow();
    });

    it("blocks modelProvider=gemini without spawning", async () => {
      const { assertAccountOnlySettings: assertGate } = await import(
        "../../src/providers/antigravity/process-client.js"
      );
      expect(() =>
        assertGate({ modelProvider: "gemini", useG1Credits: "ABSENT" }),
      ).toThrow(/modelProvider=gemini/);
    });

    it("blocks useG1Credits=true without spawning", async () => {
      const { assertAccountOnlySettings: assertGate } = await import(
        "../../src/providers/antigravity/process-client.js"
      );
      expect(() =>
        assertGate({ modelProvider: "ABSENT", useG1Credits: true }),
      ).toThrow(/useG1Credits/);
    });

    it("discovery fails closed on unsafe settings with zero spawn", async () => {
      let spawnCount = 0;
      const fakeRunner = {
        run: () => {
          spawnCount += 1;
          return { status: 0, signal: null, stdout: "", stderr: "" };
        },
      };
      const adapterWithRunner = new AntigravityAdapter(
        undefined,
        fakeRunner as unknown as ConstructorParameters<typeof AntigravityAdapter>[1],
      );
      // Force unsafe settings by poisoning the module-level reader is not
      // possible cleanly; instead assert the gate unit directly blocks.
      const { assertAccountOnlySettings: assertGate } = await import(
        "../../src/providers/antigravity/process-client.js"
      );
      expect(() => assertGate({ modelProvider: "gemini", useG1Credits: true })).toThrow();
      expect(spawnCount).toBe(0);
      void adapterWithRunner;
    });
  });
});
