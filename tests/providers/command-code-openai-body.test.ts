import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandCodeAdapter } from "../../src/providers/command-code/adapter.js";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
import type { RouterRequest } from "../../src/core/model.js";
import type { RouterEvent } from "../../src/core/events.js";
import { CMM_ECHO_TOOL } from "../fixtures/tool-contract.js";

function sse(frames: string[]): string {
  return frames.map((f) => `data: ${f}`).join("\n\n") + "\n\n";
}

describe("Command Code OpenAI wire: exact HTTP body", () => {
  let dir: string;
  let ackPath: string;
  let bodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-body-"));
    ackPath = join(dir, "ack.json");
    writeFileSync(
      ackPath,
      JSON.stringify({ version: 1, plan: "GOAT", autoTopUpDisabled: true, allowOnDemandCredits: false }),
    );
    bodies = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function adapterEmitting(): CommandCodeAdapter {
    const client = new CommandCodeClient({
      secret: "goat-secret",
      fetchFn: (async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return {
          status: 200,
          text: async () =>
            sse([
              JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
              JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
            ]),
        };
      }) as never,
    });
    return new CommandCodeAdapter({ ackPath, client });
  }

  async function drain(adapter: CommandCodeAdapter, request: RouterRequest): Promise<void> {
    const events: RouterEvent[] = [];
    for await (const event of adapter.run(request, new AbortController().signal)) events.push(event);
  }

  it("serializes tool_choice and parallel_tool_calls into the request body", async () => {
    const adapter = adapterEmitting();
    await drain(adapter, {
      requestId: "cc-1",
      model: {
        id: "command-code/test-model",
        provider: "command-code",
        upstreamModel: "test-model",
        displayName: "test-model",
        capability: "CHAT_AND_TOOLS",
      },
      messages: [{ role: "user", content: "echo" }],
      tools: [CMM_ECHO_TOOL],
      stream: true,
      // RouterRequest carries the API-independent normalized policy; the
      // Command Code OpenAI wire re-serializes it to the Chat wire shape.
      toolChoice: { kind: "required" },
      parallelToolCalls: false,
    });

    expect(bodies.length).toBe(1);
    const body = bodies[0]!;
    // The concrete HTTP JSON body must carry the controls, not just the
    // adapter's options object.
    expect(body.tool_choice).toBe("required");
    expect(body.parallel_tool_calls).toBe(false);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(true);
    console.log("COMMAND_CODE_OPENAI_TOOL_CHOICE_HTTP_BODY=PASS");
    console.log("COMMAND_CODE_OPENAI_PARALLEL_TOOL_CALLS_HTTP_BODY=PASS");
  });

  it("omits the controls entirely when the request does not set them", async () => {
    const adapter = adapterEmitting();
    await drain(adapter, {
      requestId: "cc-2",
      model: {
        id: "command-code/test-model",
        provider: "command-code",
        upstreamModel: "test-model",
        displayName: "test-model",
        capability: "CHAT_AND_TOOLS",
      },
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      stream: true,
    });
    const body = bodies[0]!;
    expect("tool_choice" in body).toBe(false);
    expect("parallel_tool_calls" in body).toBe(false);
    console.log("SILENT_TOOL_CHOICE_DROP=NONE");
    console.log("SILENT_PARALLEL_TOOL_POLICY_DROP=NONE");
  });

  it("forwards a named forced function choice verbatim", async () => {
    const adapter = adapterEmitting();
    // The normalized internal policy must reach the OpenAI wire as the exact
    // Chat Completions named-function shape.
    const wireShape = { type: "function", function: { name: "cmm_echo" } };
    await drain(adapter, {
      requestId: "cc-3",
      model: {
        id: "command-code/test-model",
        provider: "command-code",
        upstreamModel: "test-model",
        displayName: "test-model",
        capability: "CHAT_AND_TOOLS",
      },
      messages: [{ role: "user", content: "echo" }],
      tools: [CMM_ECHO_TOOL],
      stream: true,
      toolChoice: { kind: "named", name: "cmm_echo" },
    });
    expect(bodies[0]!.tool_choice).toEqual(wireShape);
  });
});
