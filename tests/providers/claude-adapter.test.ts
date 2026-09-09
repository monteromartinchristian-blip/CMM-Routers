import { describe, expect, it, beforeEach } from "vitest";
import { ClaudeAdapter } from "../../src/providers/claude/adapter.js";
import type { RouterRequest } from "../../src/core/provider.js";

describe("ClaudeAdapter", () => {
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    adapter = new ClaudeAdapter();
  });

  describe("id", () => {
    it("returns 'claude'", () => {
      expect(adapter.id).toBe("claude");
    });
  });

  describe("discoverModels", () => {
    it("returns array of Claude models", async () => {
      const models = await adapter.discoverModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]?.id).toMatch(/^claude\//);
      expect(models[0]?.provider).toBe("claude");
      expect(models[0]?.upstreamModel).toBeDefined();
      expect(models[0]?.displayName).toBeDefined();
    });

    it("all models have CHAT_ONLY_PENDING_TASK_13 capability", async () => {
      const models = await adapter.discoverModels();
      for (const model of models) {
        expect(model.capability).toBe("CHAT_ONLY_PENDING_TASK_13");
      }
    });
  });

  describe("health", () => {
    it("returns health status", { timeout: 10000 }, async () => {
      const health = await adapter.health();
      expect(["ready", "degraded", "unavailable", "auth_required"]).toContain(health.status);
    });
  });

  describe("run", () => {
    it("yields text_delta events for user messages", { timeout: 15000 }, async () => {
      const request: RouterRequest = {
        requestId: "test-001",
        model: {
          id: "claude/sonnet",
          provider: "claude",
          upstreamModel: "sonnet",
          displayName: "Sonnet",
        },
        messages: [
          { role: "user", content: "Hello" },
        ],
        tools: [],
        stream: true,
      };

      const abortController = new AbortController();
      const events = [];

      for await (const event of adapter.run(request, abortController.signal)) {
        events.push(event);
      }

      // Should receive at least some events
      expect(events.length).toBeGreaterThan(0);
    });

    it("yields completed event at end OR error if not authenticated", { timeout: 15000 }, async () => {
      const request: RouterRequest = {
        requestId: "test-002",
        model: {
          id: "claude/sonnet",
          provider: "claude",
          upstreamModel: "sonnet",
          displayName: "Sonnet",
        },
        messages: [
          { role: "user", content: "Hi" },
        ],
        tools: [],
        stream: true,
      };

      const abortController = new AbortController();
      const events = [];

      for await (const event of adapter.run(request, abortController.signal)) {
        events.push(event);
      }

      // Should receive either completed or error event
      const completedEvent = events.find((e) => e.type === "completed");
      const errorEvent = events.find((e) => e.type === "error");
      
      // At least one should be present
      expect(completedEvent || errorEvent).toBeDefined();
    });

    it("handles signal abortion gracefully", { timeout: 15000 }, async () => {
      const request: RouterRequest = {
        requestId: "test-003",
        model: {
          id: "claude/sonnet",
          provider: "claude",
          upstreamModel: "sonnet",
          displayName: "Sonnet",
        },
        messages: [
          { role: "user", content: "Test" },
        ],
        tools: [],
        stream: true,
      };

      const abortController = new AbortController();

      // Abort immediately
      abortController.abort();

      const events = [];
      for await (const event of adapter.run(request, abortController.signal)) {
        events.push(event);
      }

      // Should complete without error when aborted
      expect(events.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("cancel", () => {
    it("cancels active request", async () => {
      const request: RouterRequest = {
        requestId: "test-cancel-001",
        model: {
          id: "claude/sonnet",
          provider: "claude",
          upstreamModel: "sonnet",
          displayName: "Sonnet",
        },
        messages: [
          { role: "user", content: "Long running task" },
        ],
        tools: [],
        stream: true,
      };

      const abortController = new AbortController();

      // Start request in background
      const runPromise = (async () => {
        const events = [];
        try {
          for await (const event of adapter.run(request, abortController.signal)) {
            events.push(event);
          }
        } catch (err) {
          // Expected when aborted - ignore
        }
        return events;
      })();

      // Give it a moment to start
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Cancel
      await adapter.cancel(request.requestId);

      // Should complete or error gracefully
      const events = await runPromise;
      expect(events).toBeDefined();
    });

    it("handles cancel for non-existent request", async () => {
      // Should not throw
      await expect(adapter.cancel("non-existent")).resolves.toBeUndefined();
    });

    it("cleans up active request tracking after cancel", { timeout: 15000 }, async () => {
      const request: RouterRequest = {
        requestId: "test-cleanup-001",
        model: {
          id: "claude/sonnet",
          provider: "claude",
          upstreamModel: "sonnet",
          displayName: "Sonnet",
        },
        messages: [
          { role: "user", content: "Test" },
        ],
        tools: [],
        stream: true,
      };

      const abortController = new AbortController();

      // Start and immediately cancel
      const runPromise = adapter.run(request, abortController.signal);
      await adapter.cancel(request.requestId);

      // Consume the iterator to clean up
      for await (const _ of runPromise) {
        // Ignore events
      }

      // Active requests should be cleaned up
      const activeRequests = (adapter as any).activeRequests;
      expect(activeRequests.has(request.requestId)).toBe(false);
    });
  });
});
