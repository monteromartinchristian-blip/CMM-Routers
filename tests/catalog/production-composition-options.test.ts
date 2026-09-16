import { describe, expect, it } from "vitest";
import type { ProductionCompositionOptions } from "../../src/index.js";

// These assignments are compile-time boundary tests. If any of the forbidden
// fields returns to the public production options surface, TypeScript reports
// the @ts-expect-error directive as unused and `npm run typecheck` fails.
const wholeAdapterOverrideMustStayPrivate: ProductionCompositionOptions = {
  // @ts-expect-error production composition must always instantiate the real adapters
  dedicatedAdapterOverrides: {},
};

const commandAckPathMustStayOutOfCompositionApi: ProductionCompositionOptions = {
  // @ts-expect-error spend acknowledgement location is operator policy, not a test hook
  commandCodeAckPath: "/tmp/forbidden-command-code-ack.json",
};

const cavotiAckPathMustStayOutOfCompositionApi: ProductionCompositionOptions = {
  // @ts-expect-error spend acknowledgement location is operator policy, not a test hook
  cavotiAckPath: "/tmp/forbidden-cavoti-ack.json",
};

describe("production composition option boundary", () => {
  it("keeps the compile-time boundary fixture live at runtime", () => {
    expect([
      wholeAdapterOverrideMustStayPrivate,
      commandAckPathMustStayOutOfCompositionApi,
      cavotiAckPathMustStayOutOfCompositionApi,
    ]).toHaveLength(3);
  });
});
