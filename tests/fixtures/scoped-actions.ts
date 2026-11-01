import {
  defineScopedAction,
  ScopedActionRegistry,
} from "../../src/core/scoped-actions.js";

/**
 * Inert, deterministic actions used by the Router's test harness.
 *
 * They are test fixtures only: no production connector is registered, and
 * neither action performs network, filesystem, shell or quota work. The client
 * executes them; the Router only transports the call and its result.
 */
export const CMM_TEST_ECHO_ACTION = defineScopedAction({
  id: "cmm.test.echo",
  displayName: "Test echo",
  description: "Return the supplied text unchanged.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  sideEffect: "none",
});

export const CMM_TEST_WRITE_ACTION = defineScopedAction({
  id: "cmm.test.write",
  displayName: "Test write",
  description: "Inert write-shaped action used to prove mixed grants fail closed.",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  sideEffect: "write",
});

export function testScopedActionRegistry(): ScopedActionRegistry {
  return new ScopedActionRegistry([CMM_TEST_ECHO_ACTION, CMM_TEST_WRITE_ACTION]);
}
