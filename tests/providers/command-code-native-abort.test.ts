import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { CommandCodeClient } from "../../src/providers/command-code/client.js";
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

/**
 * Real local HTTP server proving NATIVE body teardown: headers + one chunk
 * are sent, then the body stalls. After the Router deadline (or client
 * abort) the server must observe the connection close — proving the native
 * fetch/body reader did not stay alive after the Router returned.
 */
describe("Command Code native body abort (real local HTTP)", () => {
  it("aborts the native body on Router deadline", { timeout: 30000 }, async () => {
    let connectionClosed = false;
    const server: Server = createServer((req, res) => {
      req.socket.on("close", () => {
        connectionClosed = true;
      });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      // Stall forever; Router deadline must kill the socket.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "cmm-cc-native-"));
    try {
      const client = new CommandCodeClient({
        secret: "s",
        baseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 500,
      });
      const adapter = new CommandCodeAdapter({ ackPath: validAck(dir), client });
      const events: unknown[] = [];
      for await (const event of adapter.run(
        {
          requestId: "cc-native-1",
          model: {
            id: "command-code/goat-model-a",
            provider: "command-code",
            upstreamModel: "goat-model-a",
            displayName: "goat-model-a",
            capability: "CHAT_ONLY",
          },
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          stream: true,
        },
        new AbortController().signal,
      )) {
        events.push(event);
      }
      const errorEvent = events.find((e) => (e as { type: string }).type === "error") as
        | { error: { code?: string } }
        | undefined;
      expect(errorEvent?.error.code).toBe("provider_timeout");
      console.log("COMMAND_CODE_ROUTER_TIMEOUT=PASS");
      // Native teardown: server must observe the socket close promptly.
      const started = Date.now();
      while (!connectionClosed && Date.now() - started < 10000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(connectionClosed).toBe(true);
      console.log("COMMAND_CODE_NATIVE_BODY_ABORTED=YES");
      console.log("COMMAND_CODE_NATIVE_BODY_ABORT_PROOF=PASS");
      expect(
        (adapter as unknown as { pending: Map<string, unknown> }).pending.size,
      ).toBe(0);
      console.log("COMMAND_CODE_ACTIVE_REQUEST_CLEANUP=PASS");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborts the native body on client abort", { timeout: 30000 }, async () => {
    let connectionClosed = false;
    const server: Server = createServer((req, res) => {
      req.socket.on("close", () => {
        connectionClosed = true;
      });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "cmm-cc-native-"));
    try {
      const client = new CommandCodeClient({
        secret: "s",
        baseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 30_000,
      });
      const adapter = new CommandCodeAdapter({ ackPath: validAck(dir), client });
      const controller = new AbortController();
      const collected: unknown[] = [];
      const runPromise = (async () => {
        for await (const event of adapter.run(
          {
            requestId: "cc-native-2",
            model: {
              id: "command-code/goat-model-a",
              provider: "command-code",
              upstreamModel: "goat-model-a",
              displayName: "goat-model-a",
              capability: "CHAT_ONLY",
            },
            messages: [{ role: "user", content: "hi" }],
            tools: [],
            stream: true,
          },
          controller.signal,
        )) {
          collected.push(event);
          controller.abort();
        }
      })();
      await runPromise;
      expect(collected.filter((e) => (e as { type: string }).type === "error")).toEqual([]);
      const started = Date.now();
      while (!connectionClosed && Date.now() - started < 10000) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(connectionClosed).toBe(true);
      console.log("COMMAND_CODE_NATIVE_BODY_ABORT_ON_CLIENT_CANCEL=PASS");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
