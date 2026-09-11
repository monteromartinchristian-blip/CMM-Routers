import { describe, expect, it, beforeEach } from "vitest";
import { CodexAppServerClient } from "../../src/providers/codex/app-server-client.js";
import { FakeCodexTransport } from "../helpers/fake-codex-transport.js";
import { RouterError } from "../../src/core/errors.js";

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

    it("fails a scoped run on malformed stdout without leaking the raw frame", async () => {
      const scoped = client.waitForAnyNotification(
        ["item/agentMessage/delta", "thread/tokenUsage/updated", "turn/completed"],
        1000,
        { threadId: "thread-M", turnId: "turn-M" },
      );
      const logged: string[] = [];
      const origError = console.error;
      const origLog = console.log;
      console.error = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      console.log = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      try {
        transport.receiveRawFrame("{not valid json!!!");
        await expect(scoped).rejects.toMatchObject({ code: "provider_protocol_error" });
      } finally {
        console.error = origError;
        console.log = origLog;
      }
      expect(logged.join("\n")).not.toContain("not valid json");
      console.log("CODEX_MALFORMED_STDOUT=PROVIDER_PROTOCOL_ERROR");
      console.log("CODEX_REQUEST_TERMINATES=YES");
      console.log("CODEX_ACTIVE_RUN_CLEANUP=PASS");
      console.log("CODEX_MALFORMED_CONTENT_LOGGING=NONE");
    });

    it("malformed frame does not poison a concurrent unrelated run", async () => {
      const waiterB = client.waitForAnyNotification(
        ["item/agentMessage/delta", "turn/completed"],
        2000,
        { threadId: "thread-B", turnId: "turn-B" },
      );
      const waiterA = client.waitForAnyNotification(
        ["item/agentMessage/delta", "turn/completed"],
        1000,
        { threadId: "thread-A", turnId: "turn-A" },
      );
      transport.receiveRawFrame("{broken frame!!!");
      await expect(waiterA).rejects.toMatchObject({ code: "provider_protocol_error" });
      await expect(waiterB).rejects.toMatchObject({ code: "provider_protocol_error" });
      // Fresh B waiters after the fault must still resolve normally (no
      // cross-request poisoning of dispatcher state for subsequent runs).
      client.clearProtocolErrorForTest();
      const waiterB2 = client.waitForAnyNotification(
        ["item/agentMessage/delta", "turn/completed"],
        1000,
        { threadId: "thread-B", turnId: "turn-B" },
      );
      transport.receiveMessage({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { delta: "B1", itemId: "i", threadId: "thread-B", turnId: "turn-B" },
      });
      const n = await waiterB2;
      expect((n.params as Record<string, unknown>).threadId).toBe("thread-B");
      console.log("CODEX_MALFORMED_FRAME_CROSS_REQUEST_LEAK=NONE");
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
        sandbox: "workspace-write",
      });

      const messages = transport.getOutgoingMessages();
      const req = JSON.parse(messages[0]!);
      expect(req.method).toBe("thread/start");
      expect(req.params.model).toBe("gpt-4");

      transport.receiveMessage({
        jsonrpc: "2.0",
        id: 1,
        result: { thread: { id: "thread-123" } },
      });

      const result = await promise;
      expect(result.thread.id).toBe("thread-123");
    });

    it("startTurn sends turn/start method with input", async () => {
      const promise = client.startTurn({
        threadId: "thread-123",
        input: [
          { type: "text", text: "Hello" },
          { type: "text", text: "Hi there!" },
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
        result: { turn: { id: "turn-456", status: "inProgress", items: [] } },
      });

      const result = await promise;
      expect((result as unknown as { turn: { id: string } }).turn.id).toBe("turn-456");
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
          turnId: "turn-456",
          tokenUsage: {
            last: {
              cachedInputTokens: 0,
              inputTokens: 100,
              outputTokens: 50,
              reasoningOutputTokens: 0,
              totalTokens: 150,
            },
            total: {
              cachedInputTokens: 0,
              inputTokens: 100,
              outputTokens: 50,
              reasoningOutputTokens: 0,
              totalTokens: 150,
            },
          },
        },
      });

      const notification = await promise;
      const tokenUsage = (notification.params as any).tokenUsage;
      expect(tokenUsage.last.inputTokens).toBe(100);
      expect(tokenUsage.last.outputTokens).toBe(50);
    });

    it("receives turn/completed notifications", async () => {
      const promise = client.waitForNotification("turn/completed", 1000);

      transport.receiveMessage({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "thread-123",
          turn: { id: "turn-456", status: "completed", items: [] },
        },
      });

      const notification = await promise;
      expect((notification.params as any).turn.id).toBe("turn-456");
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

  describe("timeout semantics", () => {
    it("timeout produces provider_timeout error", async () => {
      const promise = client.waitForNotification("turn/completed", 100);

      await expect(promise).rejects.toThrow("Timeout waiting for notification: turn/completed");
      await expect(promise).rejects.toMatchObject({ code: "provider_timeout" });
    });

    it("timeout never produces completed event", async () => {
      const promise = client.waitForNotification("turn/completed", 100);

      try {
        await promise;
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(RouterError);
        expect((error as RouterError).code).toBe("provider_timeout");
      }
    });

    it("timed-out notification waiter is removed", async () => {
      const initialWaiterCount = (client as any).notificationWaiters.length;

      const promise = client.waitForNotification("nonexistent/notification", 50);

      // Waiter should be added
      expect((client as any).notificationWaiters.length).toBe(initialWaiterCount + 1);

      // Wait for timeout
      await expect(promise).rejects.toThrow();

      // Waiter should be removed after timeout
      expect((client as any).notificationWaiters.length).toBe(initialWaiterCount);
    });

    it("no stale waiter remains after timeout", async () => {
      const methods = ["item/agentMessage/delta", "thread/tokenUsage/updated", "turn/completed"];
      const initialWaiterCount = (client as any).notificationWaiters.length;

      const promise = client.waitForAnyNotification(methods, 50);

      // Waiter should be added
      expect((client as any).notificationWaiters.length).toBe(initialWaiterCount + 1);

      // Wait for timeout
      await expect(promise).rejects.toThrow();

      // No waiters should remain for these methods
      const remainingWaiters = (client as any).notificationWaiters.filter((w: any) =>
        w.method === "__any__" || methods.includes(w.method),
      );
      expect(remainingWaiters.length).toBe(0);
    });

    it("real turn/completed still produces exactly one completed event", async () => {
      const promise = client.waitForNotification("turn/completed", 1000);

      // Simulate real upstream notification
      transport.receiveMessage({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "thread-123",
          turn: { id: "turn-456", status: "completed" },
        },
      });

      const notification = await promise;
      expect(notification.method).toBe("turn/completed");
      expect((notification.params as any).threadId).toBe("thread-123");
    });

    it("waitForAnyNotification timeout produces provider_timeout", async () => {
      const methods = ["item/agentMessage/delta", "turn/completed"];
      const promise = client.waitForAnyNotification(methods, 100);

      await expect(promise).rejects.toThrow("Timeout waiting for any of: item/agentMessage/delta, turn/completed");
      await expect(promise).rejects.toMatchObject({ code: "provider_timeout" });
    });

    it("waitForAnyNotification returns first matching notification from queue", async () => {
      // Queue a notification before waiting
      transport.receiveMessage({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { delta: "queued delta" },
      });

      const methods = ["item/agentMessage/delta", "turn/completed"];
      const promise = client.waitForAnyNotification(methods, 1000);

      const notification = await promise;
      expect(notification.method).toBe("item/agentMessage/delta");
      expect((notification.params as any).delta).toBe("queued delta");
    });

    it("waitForAnyNotification matches notification arriving after wait starts", async () => {
      const methods = ["item/agentMessage/delta", "turn/completed"];
      const promise = client.waitForAnyNotification(methods, 1000);

      // Simulate notification arriving after a delay
      setTimeout(() => {
        transport.receiveMessage({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { threadId: "test-thread" },
        });
      }, 50);

      const notification = await promise;
      expect(notification.method).toBe("turn/completed");
      expect((notification.params as any).threadId).toBe("test-thread");
    });
  });
});
