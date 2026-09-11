#!/usr/bin/env node
/**
 * Local fixture provider that emits ONE NDJSON-ish line built entirely from
 * multibyte UTF-8 characters (CJK, 3 bytes per code point in UTF-8 while each
 * is a single UTF-16 code unit in JavaScript).
 *
 * Its UTF-8 byte length is deliberately larger than the runner's injected
 * `maxNdjsonLineBytes` while its JavaScript `.length` stays below that bound.
 * A correct runner therefore fails the run closed; a runner that measures
 * characters instead of bytes wrongly accepts the line.
 *
 * Configuration comes from the environment:
 *   CMM_TEST_MULTIBYTE_CHARS    number of multibyte code points (default 300)
 *   CMM_TEST_MULTIBYTE_NEWLINE  "1" to terminate the line with "\n"
 *
 * With no newline the line stays in the partial-line buffer; with a newline it
 * tests the complete-line (`split("\n")`) path. No model inference and no
 * filesystem/shell side effects.
 */
const requested = Number.parseInt(process.env.CMM_TEST_MULTIBYTE_CHARS ?? "300", 10);
const count = Number.isFinite(requested) && requested > 0 ? requested : 300;
const filler = "中".repeat(count);
const line = JSON.stringify({
  event: "step_update",
  step_update: { text_delta: filler },
});
process.stdout.write(
  process.env.CMM_TEST_MULTIBYTE_NEWLINE === "1" ? `${line}\n` : line,
);

setInterval(() => undefined, 1000);
