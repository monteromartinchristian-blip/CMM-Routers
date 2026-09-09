#!/usr/bin/env node
// Authoritative shared-config validation for scripts/preflight.sh.
//
// This script imports the SAME Zod schema that production loadConfig() uses
// (src/config/schema.ts, or its compiled dist/config/schema.js artifact).
// There is no second schema: preflight must never re-implement constraints.
//
// Output is status-safe: booleans, env NAMES and configured paths only.
// Secret VALUES are never read, printed or logged. Zod issue details are
// reduced to paths + codes so no config content leaks.
//
// Exit codes: 0 = valid, 1 = invalid, 3 = shared.json missing.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configDir = process.env.CMM_CONFIG_DIR ?? resolve(repoRoot, "config");
const sharedPath = resolve(configDir, "shared.json");
const localPath = resolve(configDir, "local.json");

function emit(line) {
  process.stdout.write(`${line}\n`);
}

async function loadSchemaModule() {
  // Source of truth: the same module production loadConfig() imports.
  // Node >= 22.6 can import TypeScript directly; older runtimes fall back
  // to the compiled artifact that production actually executes.
  const src = resolve(repoRoot, "src/config/schema.ts");
  if (existsSync(src)) {
    try {
      return await import(pathToFileURL(src).href);
    } catch (error) {
      const code = error instanceof Error ? error.code : undefined;
      if (code !== "ERR_UNKNOWN_FILE_EXTENSION" && code !== "ERR_UNSUPPORTED_NODE_VERSION") {
        throw error;
      }
    }
  }
  const dist = resolve(repoRoot, "dist/config/schema.js");
  if (existsSync(dist)) return import(pathToFileURL(dist).href);
  throw new Error("production config schema not found (run npm install/build)");
}

function issuesOf(result) {
  return result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}:${issue.code}`)
    .join(",");
}

async function main() {
  const { sharedConfigSchema, localConfigSchema } = await loadSchemaModule();

  if (!existsSync(sharedPath)) {
    emit("CONFIG=MISSING");
    return 3;
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(sharedPath, "utf-8"));
  } catch {
    emit("CONFIG=INVALID");
    emit("CONFIG_ERROR=shared.json:json_parse");
    return 1;
  }

  const shared = sharedConfigSchema.safeParse(raw);
  if (!shared.success) {
    emit("CONFIG=INVALID");
    emit(`CONFIG_ERROR=shared.json:${issuesOf(shared)}`);
    return 1;
  }

  if (existsSync(localPath)) {
    let localRaw;
    try {
      localRaw = JSON.parse(readFileSync(localPath, "utf-8"));
    } catch {
      emit("CONFIG=INVALID");
      emit("CONFIG_ERROR=local.json:json_parse");
      return 1;
    }
    const local = localConfigSchema.safeParse(localRaw);
    if (!local.success) {
      emit("CONFIG=INVALID");
      emit(`CONFIG_ERROR=local.json:${issuesOf(local)}`);
      return 1;
    }
  }

  const providers = shared.data.providers;
  emit("CONFIG=VALID");
  emit(`CHATGPT_ENABLED=${providers.chatgpt.enabled ? "1" : "0"}`);
  emit(`CLAUDE_ENABLED=${providers.claude.enabled ? "1" : "0"}`);
  emit(`GOOGLE_ENABLED=${providers.google.enabled ? "1" : "0"}`);
  emit(`COMMAND_CODE_ENABLED=${providers["command-code"].enabled ? "1" : "0"}`);
  emit(`BEARER_SECRET_ENV=${shared.data.bearerSecretEnv}`);
  emit(`CLAUDE_PROFILE_DIR=${providers.claude.profileDir ?? ""}`);
  emit(`AGY_PATH=${providers.google.agyPath ?? ""}`);
  emit(`COMMAND_CODE_SECRET_ENV=${providers["command-code"].secretEnv}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    // Schema/loader failure must fail closed, never report VALID.
    emit("CONFIG=UNAVAILABLE");
    emit(`CONFIG_ERROR=${error instanceof Error ? error.name : "unknown"}`);
    process.exit(2);
  });
