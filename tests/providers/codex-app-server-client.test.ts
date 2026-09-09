import { describe, expect, it, beforeEach } from "vitest";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import { FakeCodexTransport } from "../helpers/fake-codex-transport.js";

describe("CodexAppServerClient", () => {
  let transport: FakeCodexTransport;
  let client: CodexAppServerClient;

  beforeEach(() => {
    transport = new FakeCodexTransport();
    client = new CodexAppServerClient(transport);
  });

  describe("instantiation", () => {
    it("can be instantiated with a duplex stream", () => {
      expect(client).toBeDefined();
    });
  });

  describe("request correlation", () => {
    it("assigns incrementing IDs to requests", async () => {
      // Send multiple requests
      const promise1 = (client as any).sendRequest("test/method1", {});
      const promise2 = (client as any).sendRequest("test/method2", {});
      const promise3 = (client as any).sendRequest("test/method3", {});

      const messages = transport.getOutgoingMessages();
      expect(messages.length).toBe(3);

      const req1 = JSON.parse(messages[0]!);
      const req2 = JSON.parse(messages[1]!);
      const req3 = JSON.parse(messages[2]!);

      expect(req1.id).toBe(1);
      expect(req2.id).toBe(2);
      expect(req3.id).toBe(3);

      // Resolve them
      transport.receiveMessage({ jsonrpc: "2.0", id: 1, result: "ok1" });
      transport.receiveMessage({ jsonrpc: "2.0", id: 2, result: "ok2" });
      transport.receiveMessage({ jsonrpc: "2.0", id: 3, result: "ok3" });

      const results = await Promise.all([promise1, promise2, promise3]);
      expect(results).toEqual(["ok1", "ok2", "ok3"]);
    });

    it("correlates responses by request ID", async () => {
      const promise = (client as any).sendRequest("test/method", { foo: "bar" });

      // Respond out of order
      transport.receiveMessage({ jsonrpc: "2.0", id: 2, result: "second" });
      transport.receiveMessage({ jsonrpc: "2.0", id: 1, result: "first" });

      const result = await promise;
      expect(result).toBe("first");
    });

    it("rejects pending request on error response", async () => {
      const promise = (client as any).sendRequest("test/error", {});

      transport.receiveMessage({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "Invalid Request" },
      });

      await expect(promise).rejects.toThrow("Codex error: Invalid Request");
    });
  });

  describe("newline-delimited JSON parsing", () => {
    it("parses multiple messages in single chunk", async () => {
      const promise = (client as any).sendRequest("test/multi", {});

      // Send two messages in one chunk
      const chunk = Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "first" }) +
          "\n" +
          JSON.stringify({ jsonrpc: "2.0", id: 2, result: "second" }) +
          "\n",
      );
      transport.push(chunk);

      const result = await promise;
      expect(result).toBe("first");
    });

    it("handles partial lines across chunks", async () => {
      const promise = (client as any).sendRequest("test/partial", {});

      // Send incomplete line
      transport.push(Buffer.from('{"jsonrpc":"2.0","id":1,"res'));
      // Complete it
      transport.push(Buffer.from('ult":"done"}\n'));

      const result = await promise;
      expect(result).toBe("done");
    });

    it("ignores malformed JSON without crashing", async () => {
      transport.receiveMalformedJson();

      // Client should still work after malformed JSON
      const promise = (client as any).sendRequest("test/after-error", {});
      transport.receiveMessage({ jsonrpc: "2.0", id: 1, result: "ok" });

      const result = await promise;
      expect(result).toBe("ok");
    });
  });

  describe("initialize handshake", () => {
    it("sends initialize request with correct method and params", async () => {
      const initPromise = client.initialize({
        clientInfo: {
          name: "test-client",
          version: "1.0.0",
        },
      });

      const messages = transport.getOutgoingMessages();
      expect(messages.length).toBe(1);

      const req = JSON.parse(messages[0]!);
      expect(req.method).toBe("initialize");
      expect(req.params.clientInfo.name).toBe("test-client");
      expect(req.params.clientInfo.version).toBe("1.0.0");

      transport.receiveMessage({
        jsonrpc: "2.0",
        id: 1,
        result: { serverInfo: { name: "codex", version: "0.147.0" } },
      });

      const result = await initPromise;
      expect((result as any).serverInfo.name).toBe("codex");
    });

    it("sends initialized notification", async () => {
      await client.sendInitializedNotification();

      const messages = transport.getOutgoingMessages();
      expect(messages.length).toBe(1);

      const notification = JSON.parse(messages[0]!);
      expect(notification.method).toBe("initialized");
      expect(notification.jsonrpc).toBe("2.0");
      // Notifications don't have id
      expect(notification.id).toBeUndefined();
    });
  });

  describe("thread/turn lifecycle", () => {
    it("startThread sends thread/start method", async () => {
      const promise = client.startThread({
        model: "gpt-4",
        sandboxMode: "restricted",
        permissions: [],
      });

      const messages = transport.getOutgoingMessages();
      const req = JSON.parse(messages[0]!);
      expect(req.method).toBe("thread/start");
      expect(req.params.model).toBe("gpt-4");

      transport.receiveMessage({
        jsonrpc: "2.0",
        id: 1,
        result: { threadId: "thread-123" },
      });

      const result = await promise;
      expect(result.threadId).toBe("thread-123");
    });

    it("startTurn sends turn/start method with input", async () => {
      const promise = client.startTurn({
        threadId: "thread-123",
        input: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ],
      });

      const messages = transport.getOutgoingMessages();
      const req = JSON.parse(messages[0]!);
      expect(req.method).toBe("turn/start");
      expect(req.params.threadId).toBe("thread-123");
      expect(req.params.input.length).toBe(2);

      transport.receiveMessage({
        jsonrpc: "2.0",
        id: 1,
        result: { turnId: "turn-456" },
      });

      const result = await promise;
      expect(result.turnId).toBe("turn-456");
    });

    it("interruptTurn sends turn/interrupt method", async () => {
      const promise = client.interruptTurn({
        threadId: "thread-123",
        turnId: "turn-456",
      });

      const messages = transport.getOutgoingMessages();
      const req = JSON.parse(messages[0]!);
      expect(req.method).toBe("turn/interrupt");

      transport.receiveMessage({
        jsonrpc: "2.0",
        id: 1,
        result: null,
      });

      await promise; // Should resolve without error
    });
  });

  describe("event streaming", () => {
    it("receives agentMessage/delta notifications", async () => {
      const promise = client.waitForNotification("item/agentMessage/delta", 1000);

      transport.receiveMessage({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-123",
          turnId: "turn-456",
          delta: "Hello ",
        },
      });

      const notification = await promise;
      expect((notification.params as any).delta).toBe("Hello ");
    });

    it("receives tokenUsage/updated notifications", async () => {
      const promise = client.waitForNotification(
        "thread/tokenUsage/updated",
        1000,
      );

      transport.receiveMessage({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-123",
          inputTokens: 100,
          outputTokens: 50,
        },
      });

      const notification = await promise;
      expect((notification.params as any).inputTokens).toBe(100);
      expect((notification.params as any).outputTokens).toBe(50);
    });

    it("receives turn/completed notifications", async () => {
      const promise = client.waitForNotification("turn/completed", 1000);

      transport.receiveMessage({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "thread-123",
          turnId: "turn-456",
          finishReason: "stop",
        },
      });

      const notification = await promise;
      expect((notification.params as any).finishReason).toBe("stop");
    });

    it("times out waiting for notification if not received", async () => {
      const promise = client.waitForNotification("nonexistent/notification", 100);

      await expect(promise).rejects.toThrow("Timeout waiting for notification");
    });

    it("queues notifications if no waiter is registered", async () => {
      // Send notification before setting up waiter
      transport.receiveMessage({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { delta: "queued" },
      });

      // Now wait for it - should get queued notification immediately
      const promise = client.waitForNotification("item/agentMessage/delta", 1000);
      const notification = await promise;
      expect((notification.params as any).delta).toBe("queued");
    });
  });

  describe("approval auto-decline", () => {
    it("auto-declines commandExecution approval requests", async () => {
      transport.receiveMessage({
        jsonrpc: "2.0",
        id: 999,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-123",
          turnId: "turn-456",
          command: "ls",
          args: ["-la"],
        },
      });

      const messages = transport.getOutgoingMessages();
      expect(messages.length).toBe(1);

      const response = JSON.parse(messages[0]!);
      expect(response.id).toBe(999);
      expect(response.result.decision).toBe("decline");
    });

    it("auto-declines fileChange approval requests", async () => {
      transport.receiveMessage({
        jsonrpc: "2.0",
        id: 998,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-123",
          turnId: "turn-456",
          path: "/tmp/test.txt",
          change: "modified",
        },
      });

      const messages = transport.getOutgoingMessages();
      const response = JSON.parse(messages[0]!);
      expect(response.id).toBe(998);
      expect(response.result.decision).toBe("decline");
    });

    it("auto-declines permissions approval requests", async () => {
      transport.receiveMessage({
        jsonrpc: "2.0",
        id: 997,
        method: "item/permissions/requestApproval",
        params: {
          threadId: "thread-123",
          turnId: "turn-456",
          permission: "network_access",
        },
      });

      const messages = transport.getOutgoingMessages();
      const response = JSON.parse(messages[0]!);
      expect(response.id).toBe(997);
      expect(response.result.decision).toBe("decline");
    });

    it("auto-declines applyPatchApproval requests", async () => {
      transport.receiveMessage({
        jsonrpc: "2.0",
        id: 996,
        method: "applyPatchApproval",
        params: {},
      });

      const messages = transport.getOutgoingMessages();
      const response = JSON.parse(messages[0]!);
      expect(response.id).toBe(996);
      expect(response.result.decision).toBe("decline");
    });

    it("auto-declines execCommandApproval requests", async () => {
      transport.receiveMessage({
        jsonrpc: "2.0",
        id: 995,
        method: "execCommandApproval",
        params: {},
      });

      const messages = transport.getOutgoingMessages();
      const response = JSON.parse(messages[0]!);
      expect(response.id).toBe(995);
      expect(response.result.decision).toBe("decline");
    });
  });

  describe("process exit handling", () => {
    it("rejects all pending requests on stream error", async () => {
      const promise1 = (client as any).sendRequest("test/one", {});
      const promise2 = (client as any).sendRequest("test/two", {});

      const error = new Error("Stream closed");
      transport.simulateError(error);

      await expect(promise1).rejects.toThrow("Stream closed");
      await expect(promise2).rejects.toThrow("Stream closed");
    });
  });

  describe("cancellation cleanup", () => {
    it("stops accepting new messages after stop()", async () => {
      await client.stop();

      // Try to receive a message - should be ignored
      transport.receiveMessage({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { delta: "should be ignored" },
      });

      // No notification should be queued
      await expect(
        client.waitForNotification("item/agentMessage/delta", 100),
      ).rejects.toThrow("Timeout");
    });

    it("clears pending requests and waiters on stop", async () => {
      const promise = (client as any).sendRequest("test/pending", {});

      // Stop should clear pending requests without waiting for them
      await client.stop();

      // Verify internal state was cleared
      expect((client as any).pendingRequests.size).toBe(0);
      expect((client as any).notificationWaiters.length).toBe(0);
    });
  });

  describe("model discovery", () => {
    it("listModels sends model/list method", async () => {
      const promise = client.listModels();

      const messages = transport.getOutgoingMessages();
      const req = JSON.parse(messages[0]!);
      expect(req.method).toBe("model/list");

      transport.receiveMessage({
        jsonrpc: "2.0",
        id: 1,
        result: {
          data: [
            { id: "gpt-4", model: "gpt-4", displayName: "GPT-4" },
            { id: "gpt-3.5-turbo", model: "gpt-3.5-turbo", displayName: "GPT-3.5 Turbo" },
          ],
        },
      });

      const result = await promise;
      expect(result.data.length).toBe(2);
      expect(result.data[0]!.id).toBe("gpt-4");
    });
  });
});
