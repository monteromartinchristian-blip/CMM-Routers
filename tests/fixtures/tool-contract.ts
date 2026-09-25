import type { RouterFunctionTool } from "../../src/core/model.js";

export const CMM_ECHO_TOOL: RouterFunctionTool = {
  kind: "function",
  type: "function",
  function: {
    name: "cmm_echo",
    description: "Return the supplied text unchanged.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

export const TOOL_FORCING_PROMPT =
  "You MUST call the cmm_echo tool with {\"text\":\"canary\"} as your only action. Do not answer in plain text.";
