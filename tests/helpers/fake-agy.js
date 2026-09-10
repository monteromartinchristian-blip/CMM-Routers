#!/usr/bin/env node
/**
 * Fake `agy` provider process for deterministic concurrency tests.
 *
 * It behaves like agy in the two ways this pass depends on:
 *   1. it spawns the registered CMM MCP launcher as its OWN child, so the
 *      launcher's ancestor chain contains this process's pid;
 *   2. it acts as the MCP client, sending tools/call and emitting its final
 *      assistant text only AFTER the tool response arrives.
 *
 * Configuration comes from the environment:
 *   CMM_TEST_TSX        absolute path to the tsx runner
 *   CMM_TEST_LAUNCHER   absolute path to the MCP launcher entry
 *   CMM_TEST_TOOL       declared tool name to call
 *   CMM_TEST_ARG        argument text for the tool call
 *   CMM_TEST_WAIT_MS    bounded wait for the tool response (default 15000)
 *   CMM_TEST_HOLD_MS    delay AFTER the tool result and BEFORE the final frame,
 *                       so a test can hold the provider in RESUMING state
 *
 * Stdout is NDJSON agy stream-json frames on the real parser contract.
 */
import { spawn } from "node:child_process";

const TSX = process.env.CMM_TEST_TSX;
const LAUNCHER = process.env.CMM_TEST_LAUNCHER;
const TOOL = process.env.CMM_TEST_TOOL ?? "cmm_echo";
const ARG = process.env.CMM_TEST_ARG ?? "canary";
const WAIT_MS = Number.parseInt(process.env.CMM_TEST_WAIT_MS ?? "15000", 10);
const HOLD_MS = Number.parseInt(process.env.CMM_TEST_HOLD_MS ?? "0", 10);

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const launcher = spawn(TSX, [LAUNCHER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

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
    const key = String(message.id);
    const waiter = pending.get(key);
    if (!waiter) continue;
    pending.delete(key);
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

function notify(method) {
  launcher.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
}

const onAbort = () => {
  try {
    launcher.kill("SIGKILL");
  } catch {
    // ignore
  }
  process.exit(130);
};
process.on("SIGINT", onAbort);
process.on("SIGTERM", onAbort);

try {
  emit({ event: "step_update", step_update: { text_delta: "thinking " } });
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fake-agy", version: "1.0.0" },
  });
  notify("notifications/initialized");
  const listed = await request("tools/list");
  const names = Array.isArray(listed.tools) ? listed.tools.map((t) => t.name) : [];
  if (!names.includes(TOOL)) {
    throw new Error(`declared tools ${JSON.stringify(names)} do not include ${TOOL}`);
  }
  const call = await request("tools/call", { name: TOOL, arguments: { text: ARG } });
  const text = Array.isArray(call.content) && call.content[0] ? String(call.content[0].text) : "";
  // Optional hold: keeps this provider process in RESUMING state so a test can
  // exercise post-result cancellation.
  if (HOLD_MS > 0) await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
  // Final text is derived ONLY from the tool-result wire value.
  emit({ event: "step_update", step_update: { text_delta: `final:${text}` } });
  emit({ event: "result", result: { status: "ok" } });
  try {
    launcher.kill("SIGKILL");
  } catch {
    // ignore
  }
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  try {
    launcher.kill("SIGKILL");
  } catch {
    // ignore
  }
  process.exit(1);
}
