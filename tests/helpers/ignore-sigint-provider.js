#!/usr/bin/env node
/**
 * Local fixture provider that deliberately IGNORES SIGINT.
 *
 * Used to prove the Router's child-termination primitive escalates from SIGINT
 * to SIGKILL after a bounded grace period and still observes child exit. On
 * SIGINT it writes a marker to stdout (so a test can prove SIGINT was actually
 * delivered) and stays alive; the Router must then SIGKILL it.
 *
 * No model inference. No filesystem/shell side effects.
 */
process.on("SIGINT", () => {
  process.stdout.write(
    `${JSON.stringify({ event: "step_update", step_update: { text_delta: "SIGINT_SEEN" } })}\n`,
  );
});

process.stdout.write(
  `${JSON.stringify({ event: "step_update", step_update: { text_delta: "live" } })}\n`,
);

// Stay alive until SIGKILL.
setInterval(() => undefined, 1000);
