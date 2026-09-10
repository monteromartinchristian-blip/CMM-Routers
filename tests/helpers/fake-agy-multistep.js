#!/usr/bin/env node
/**
 * Fake `agy` provider process for the two-step tool-loop proof.
 *
 * It spawns the registered CMM MCP launcher as its OWN child and acts as the
 * MCP client. Causality is enforced by construction:
 *   - it requests TOOL_A and WAITS for result A through the real MCP wire;
 *   - only AFTER result A arrives does it request TOOL_B;
 *   - only AFTER result B arrives does it emit its FINAL text, derived from
 *     BOTH results.
 *
 * So the final answer cannot exist unless both tool results crossed the real
 * production transport. No model inference; no side effects.
 *
 * Env: CMM_TEST_TSX, CMM_TEST_LAUNCHER, CMM_TEST_TOOL_A, CMM_TEST_TOOL_B,
 *      CMM_TEST_WAIT_MS (default 15000).
 */
import { spawn } from "node:child_process";

const TSX = process.env.CMM_TEST_TSX;
const LAUNCHER = process.env.CMM_TEST_LAUNCHER;
const TOOL_A = process.env.CMM_TEST_TOOL_A ?? "cmm_echo";
const TOOL_B = process.env.CMM_TEST_TOOL_B ?? TOOL_A;
const WAIT_MS = Number.parseInt(process.env.CMM_TEST_WAIT_MS ?? "15000", 10);

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const launcher = spawn(TSX, [LAUNCHER], { stdio: ["pipe", "pipe", "pipe"], env: process.env });

let buffer = "";
const pending = new Map();
let nextId = 1;

launcher.stdout.setEncoding("utf-8");
launcher.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const waiter = pending.get(String(message.id));
    if (!waiter) continue;
    pending.delete(String(message.id));
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }
});
launcher.stderr.setEncoding("utf-8");
launcher.stderr.on("data", () => undefined);
launcher.on("exit", () => {
  for (const [, waiter] of pending) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error("launcher exited before responding"));
  }
  pending.clear();
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(String(id));
      reject(new Error(`MCP ${method} timed out`));
    }, WAIT_MS);
    pending.set(String(id), { resolve, reject, timer });
    launcher.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`,
    );
  });
}
const notify = (method) => launcher.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);

const killLauncher = () => {
  try {
    launcher.kill("SIGKILL");
  } catch {
    // ignore
  }
};
process.on("SIGINT", () => {
  killLauncher();
  process.exit(130);
});
process.on("SIGTERM", () => {
  killLauncher();
  process.exit(130);
});

const textOf = (call) =>
  Array.isArray(call?.content) && call.content[0] ? String(call.content[0].text) : "";

try {
  emit({ event: "step_update", step_update: { text_delta: "thinking " } });
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fake-agy-multistep", version: "1.0.0" },
  });
  notify("notifications/initialized");
  await request("tools/list");

  const callA = await request("tools/call", { name: TOOL_A, arguments: { step: "A" } });
  const resultA = textOf(callA);
  // Optional hold BETWEEN tool A's result and tool B, so a test can cancel
  // exactly between the two tool calls.
  const holdBeforeB = Number.parseInt(process.env.CMM_TEST_HOLD_BEFORE_B_MS ?? "0", 10);
  if (holdBeforeB > 0) await new Promise((resolve) => setTimeout(resolve, holdBeforeB));
  // Tool B is requested ONLY now, after result A crossed the MCP wire.
  const callB = await request("tools/call", { name: TOOL_B, arguments: { step: "B" } });
  const resultB = textOf(callB);

  emit({ event: "step_update", step_update: { text_delta: `final:${resultA}|${resultB}` } });
  emit({ event: "result", result: { status: "ok" } });
  killLauncher();
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  killLauncher();
  process.exit(1);
}
