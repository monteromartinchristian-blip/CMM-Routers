import { describe, expect, it } from "vitest";
import {
  resolveToolAccess,
  type ToolAccessRequest,
} from "../../src/core/tool-access-policy.js";
import type { RouterFunctionTool, RouterMessage } from "../../src/core/model.js";
import {
  CMM_TEST_ECHO_ACTION,
  CMM_TEST_WRITE_ACTION,
  testScopedActionRegistry,
} from "../fixtures/scoped-actions.js";

const CAPABLE = "CHAT_AND_TOOLS" as const;

function tool(name: string, description = `client description for ${name}`): RouterFunctionTool {
  return {
    kind: "function",
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: { evil: { type: "string" } } },
    },
  };
}

function request(overrides: Partial<ToolAccessRequest> = {}): ToolAccessRequest {
  return {
    profile: "CHAT",
    provider: "chatgpt",
    providerCapability: CAPABLE,
    tools: [],
    messages: [{ role: "user", content: "hi" }],
    scopedActions: testScopedActionRegistry(),
    ...overrides,
  };
}

function continuation(name: string, id = "call-1"): RouterMessage[] {
  return [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: null,
      toolCalls: [{ id, type: "function", function: { name, arguments: "{}" } }],
    },
    { role: "tool", content: "result", toolCallId: id },
  ];
}

describe("shared tool-access policy", () => {
  it("CHAT without tools is ordinary conversation", () => {
    const decision = resolveToolAccess(request({ profile: "CHAT" }));
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("unreachable");
    expect(decision.access.mode).toBe("none");
    expect(decision.access.tools).toEqual([]);
  });

  it("CHAT supplied tools without a grant fail closed", () => {
    const decision = resolveToolAccess(
      request({ profile: "CHAT", tools: [tool("cmm.test.echo")], grantedActions: [] }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.error.code).toBe("unsupported_capability");
  });

  it("CHAT granted scoped action succeeds and uses the Router definition", () => {
    const decision = resolveToolAccess(
      request({
        profile: "CHAT",
        tools: [tool("cmm.test.echo", "caller-supplied description")],
        grantedActions: ["cmm.test.echo"],
      }),
    );
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("unreachable");
    expect(decision.access.mode).toBe("scoped");
    expect(decision.access.allowedToolNames).toEqual(new Set(["cmm.test.echo"]));
    expect(decision.access.tools).toEqual([
      {
        kind: "function",
        type: "function",
        function: {
          name: CMM_TEST_ECHO_ACTION.id,
          description: CMM_TEST_ECHO_ACTION.description,
          parameters: CMM_TEST_ECHO_ACTION.parameters,
        },
      },
    ]);
  });

  it("CHAT unknown action fails closed even when the caller claims a grant", () => {
    const decision = resolveToolAccess(
      request({
        profile: "CHAT",
        tools: [tool("invented_tool")],
        grantedActions: ["invented_tool"],
      }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.error.message).toContain("not registered");
  });

  it("CHAT registered but ungranted action fails closed", () => {
    const decision = resolveToolAccess(
      request({
        profile: "CHAT",
        tools: [tool("cmm.test.write")],
        grantedActions: ["cmm.test.echo"],
      }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.error.message).toContain("not granted");
  });

  it("CHAT mixed allowed and forbidden actions fails closed without stripping", () => {
    const decision = resolveToolAccess(
      request({
        profile: "CHAT",
        tools: [tool("cmm.test.echo"), tool("cmm.test.write")],
        grantedActions: ["cmm.test.echo"],
      }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.error.code).toBe("unsupported_capability");
  });

  it("CHAT mixed granted action and arbitrary tool fails closed", () => {
    const decision = resolveToolAccess(
      request({
        profile: "CHAT",
        tools: [tool("cmm.test.echo"), tool("arbitrary_shell")],
        grantedActions: ["cmm.test.echo"],
      }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.error.message).toContain("arbitrary_shell");
  });

  it("AGENT transports arbitrary harness tools exactly", () => {
    const tools = [tool("run_command"), tool("write_file")];
    const decision = resolveToolAccess(
      request({ profile: "AGENT", tools, grantedActions: [] }),
    );
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("unreachable");
    expect(decision.access.mode).toBe("agent");
    expect(decision.access.tools).toEqual(tools);
  });

  it("both profiles respect provider/model capability", () => {
    for (const profile of ["CHAT", "AGENT"] as const) {
      const decision = resolveToolAccess(
        request({
          profile,
          providerCapability: "CHAT_ONLY",
          tools: [tool("cmm.test.echo")],
          grantedActions: ["cmm.test.echo"],
        }),
      );
      expect(decision.allowed).toBe(false);
      if (decision.allowed) throw new Error("unreachable");
      expect(decision.error.message).toContain("Model supports chat only");
    }
  });

  it("both profiles respect protocol representability", () => {
    for (const profile of ["CHAT", "AGENT"] as const) {
      const decision = resolveToolAccess(
        request({
          profile,
          provider: "claude",
          tools: [tool("cmm.test.echo")],
          grantedActions: ["cmm.test.echo"],
          toolChoice: { kind: "required" },
        }),
      );
      expect(decision.allowed).toBe(false);
      if (decision.allowed) throw new Error("unreachable");
      expect(decision.error.code).toBe("unsupported_capability");
    }
  });

  it("rejects a named tool_choice that is not declared", () => {
    for (const profile of ["CHAT", "AGENT"] as const) {
      const decision = resolveToolAccess(
        request({
          profile,
          tools: [tool("cmm.test.echo")],
          grantedActions: ["cmm.test.echo"],
          toolChoice: { kind: "named", name: "other" },
        }),
      );
      expect(decision.allowed).toBe(false);
    }
  });

  it("rejects duplicate scoped-action names on CHAT", () => {
    const decision = resolveToolAccess(
      request({
        profile: "CHAT",
        tools: [tool("cmm.test.echo"), tool("cmm.test.echo")],
        grantedActions: ["cmm.test.echo"],
      }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.error.code).toBe("invalid_request");
  });

  it("preserves AGENT duplicate declarations for compatibility", () => {
    const decision = resolveToolAccess(
      request({ profile: "AGENT", tools: [tool("same"), tool("same")] }),
    );
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("unreachable");
    expect(decision.access.tools).toHaveLength(2);
  });

  it("CHAT allows a correlated scoped action continuation", () => {
    const decision = resolveToolAccess(
      request({
        profile: "CHAT",
        tools: [tool("cmm.test.echo")],
        grantedActions: ["cmm.test.echo"],
        messages: continuation("cmm.test.echo"),
      }),
    );
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("unreachable");
    expect(decision.access.mode).toBe("scoped");
  });

  it("CHAT rejects assistant history naming an ungranted action", () => {
    const decision = resolveToolAccess(
      request({
        profile: "CHAT",
        tools: [tool("cmm.test.echo")],
        grantedActions: ["cmm.test.echo"],
        messages: continuation("cmm.test.write"),
      }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.error.code).toBe("unsupported_capability");
  });

  it("CHAT rejects a tool result that does not match an assistant call", () => {
    const rejected = resolveToolAccess(
      request({
        profile: "CHAT",
        tools: [tool("cmm.test.echo")],
        grantedActions: ["cmm.test.echo"],
        messages: continuation("cmm.test.echo", "call-real").map((message) =>
          message.role === "tool" ? { ...message, toolCallId: "call-guessed" } : message,
        ),
      }),
    );
    expect(rejected.allowed).toBe(false);
    if (rejected.allowed) throw new Error("unreachable");
    expect(rejected.error.code).toBe("invalid_request");
  });

  it("CHAT rejects tool-result continuation without assistant history", () => {
    const decision = resolveToolAccess(
      request({
        profile: "CHAT",
        tools: [tool("cmm.test.echo")],
        grantedActions: ["cmm.test.echo"],
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", content: "result", toolCallId: "call-1" },
        ],
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  it("CHAT rejects tool semantics when no tools array carries the scope", () => {
    const decision = resolveToolAccess(
      request({
        profile: "CHAT",
        tools: [],
        toolChoice: { kind: "auto" },
        grantedActions: ["cmm.test.echo"],
      }),
    );
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.error.code).toBe("unsupported_capability");
  });

  it("fixtures are inert and write-shaped only for policy tests", () => {
    expect(CMM_TEST_ECHO_ACTION.sideEffect).toBe("none");
    expect(CMM_TEST_WRITE_ACTION.sideEffect).toBe("write");
  });
});
