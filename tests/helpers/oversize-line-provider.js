#!/usr/bin/env node
/**
 * Local fixture provider that emits ONE very large NDJSON line with no
 * terminating newline, then stays alive.
 *
 * Used to prove the Router bounds the partial NDJSON line buffer and fails the
 * run closed instead of accumulating provider-controlled memory without limit.
 * No model inference. No filesystem/shell side effects.
 */
const size = Number.parseInt(process.env.CMM_TEST_LINE_BYTES ?? "65536", 10);
const filler = "x".repeat(Number.isFinite(size) && size > 0 ? size : 65536);
process.stdout.write(
  JSON.stringify({ event: "step_update", step_update: { text_delta: filler } }),
);

setInterval(() => undefined, 1000);
