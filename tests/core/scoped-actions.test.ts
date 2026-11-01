import { describe, expect, it } from "vitest";
import {
  defineScopedAction,
  ScopedActionRegistry,
} from "../../src/core/scoped-actions.js";
import {
  CMM_TEST_ECHO_ACTION,
  CMM_TEST_WRITE_ACTION,
  testScopedActionRegistry,
} from "../fixtures/scoped-actions.js";

describe("ScopedActionRegistry", () => {
  it("registers validated actions and returns canonical tools", () => {
    const registry = testScopedActionRegistry();
    expect(registry.size).toBe(2);
    expect(registry.has("cmm.test.echo")).toBe(true);
    expect(registry.get("cmm.test.echo")).toEqual(CMM_TEST_ECHO_ACTION);
    expect(registry.toRouterTool("cmm.test.echo")).toEqual({
      kind: "function",
      type: "function",
      function: {
        name: "cmm.test.echo",
        description: CMM_TEST_ECHO_ACTION.description,
        parameters: { ...CMM_TEST_ECHO_ACTION.parameters },
      },
    });
    expect(registry.toRouterTool("missing")).toBeUndefined();
  });

  it("rejects invalid ids, empty display names, non-object schemas and bad side effects", () => {
    expect(() =>
      defineScopedAction({
        id: "Not Valid!",
        displayName: "x",
        description: "x",
        parameters: { type: "object" },
        sideEffect: "none",
      }),
    ).toThrow(/Invalid scoped action id/);
    expect(() =>
      defineScopedAction({
        id: "cmm.test.empty",
        displayName: "",
        description: "x",
        parameters: { type: "object" },
        sideEffect: "none",
      }),
    ).toThrow(/displayName/);
    expect(() =>
      defineScopedAction({
        id: "cmm.test.bad-schema",
        displayName: "Bad",
        description: "x",
        parameters: [] as unknown as Record<string, unknown>,
        sideEffect: "none",
      }),
    ).toThrow(/parameters/);
    expect(() =>
      defineScopedAction({
        id: "cmm.test.bad-effect",
        displayName: "Bad",
        description: "x",
        parameters: { type: "object" },
        sideEffect: "delete" as never,
      }),
    ).toThrow(/sideEffect/);
  });

  it("rejects duplicate registration", () => {
    const registry = new ScopedActionRegistry([CMM_TEST_ECHO_ACTION]);
    expect(() => registry.register(CMM_TEST_ECHO_ACTION)).toThrow(/Duplicate scoped action/);
  });

  it("keeps registration separate from authorization", () => {
    const registry = new ScopedActionRegistry([CMM_TEST_ECHO_ACTION, CMM_TEST_WRITE_ACTION]);
    // Both are registered; neither is granted by the registry itself. The
    // policy tests prove the grant intersection separately.
    expect(registry.list().map((action) => action.id)).toEqual([
      "cmm.test.echo",
      "cmm.test.write",
    ]);
  });
});
