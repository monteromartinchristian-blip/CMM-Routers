#!/usr/bin/env node
// Fake `agy mcp` CLI fixture for bounds tests. Behaviour is selected by the
// FAKE_AGY_CLI_MODE environment variable so one file covers every adversarial
// case. Never touches the real agy configuration.
import { writeSync } from "node:fs";

const mode = process.env.FAKE_AGY_CLI_MODE ?? "normal";
const argv = process.argv.slice(2);

function writeAll(fd, chunk) {
  // Synchronous write of a large buffer; the parent's maxBuffer bound is what
  // is under test. writeSync guarantees the bytes leave the process before it
  // exits (process.stdout.write to a pipe is async and would be truncated by
  // an immediate process.exit).
  writeSync(fd, chunk);
}

switch (mode) {
  case "hang": {
    // Stay alive forever (the parent's timeout kill is what is under test).
    setInterval(() => {}, 1 << 30);
    break;
  }
  case "oversize-stdout": {
    writeAll(1, "A".repeat(256 * 1024));
    process.exit(0);
    break;
  }
  case "oversize-stderr": {
    writeAll(2, "B".repeat(256 * 1024));
    process.exit(0);
    break;
  }
  case "exit-nonzero": {
    writeAll(2, "Error: MCP store unavailable\n");
    process.exit(3);
    break;
  }
  case "argv-echo": {
    writeAll(1, JSON.stringify(argv));
    process.exit(0);
    break;
  }
  case "normal-list": {
    writeAll(1, "No MCP servers configured.\n");
    process.exit(0);
    break;
  }
  case "normal-add": {
    writeAll(1, 'Added MCP server "cmm-qoder-tools" (stdio)\n');
    process.exit(0);
    break;
  }
  default: {
    process.exit(0);
  }
}
