#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const MANAGED_RULE = "mcp(cmm-qoder-tools/*)";
const DEFAULT_PATH = join(homedir(), ".gemini", "antigravity-cli", "settings.json");

function marker(name, value) {
  process.stdout.write(`${name}=${value}\n`);
}

function die(code, message) {
  marker("ANTIGRAVITY_PERMISSION_PROVISION", "FAIL_CLOSED");
  marker("ANTIGRAVITY_PERMISSION_ERROR", message);
  process.exit(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    die(3, `${name}-must-be-string-array`);
  }
  return value;
}

function conflicts(rule) {
  if (rule === "mcp(*)" || rule === MANAGED_RULE) return true;
  return /^mcp\(cmm-qoder-tools\/[^)]*\)$/.test(rule);
}

function parseSettings(path) {
  if (!existsSync(path)) die(2, "settings-file-missing");

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    die(3, "settings-json-invalid");
  }

  if (!isObject(parsed)) die(3, "settings-root-must-be-object");

  const permissions = parsed.permissions;
  if (permissions !== undefined && !isObject(permissions)) {
    die(3, "permissions-must-be-object");
  }

  if (isObject(permissions)) {
    stringArray(permissions.allow, "permissions.allow");
    stringArray(permissions.ask, "permissions.ask");
    stringArray(permissions.deny, "permissions.deny");
  }

  return parsed;
}

function conflictRules(settings) {
  if (!isObject(settings.permissions)) return [];
  const ask = stringArray(settings.permissions.ask, "permissions.ask") ?? [];
  const deny = stringArray(settings.permissions.deny, "permissions.deny") ?? [];
  return [...ask, ...deny].filter(conflicts);
}

function hasManagedAllow(settings) {
  if (!isObject(settings.permissions)) return false;
  const allow = stringArray(settings.permissions.allow, "permissions.allow") ?? [];
  return allow.includes(MANAGED_RULE);
}

function safeWriteAtomic(path, settings, originalMode) {
  const directory = dirname(path);
  const temp = join(
    directory,
    `.cmm-antigravity-settings-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );

  const body = JSON.stringify(settings, null, 2) + "\n";
  let fd;
  try {
    fd = openSync(temp, "wx", originalMode);
    writeFileSync(fd, body, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temp, originalMode);
    renameSync(temp, path);
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(temp); } catch {}
    die(4, "atomic-settings-write-failed");
  }
}

const args = process.argv.slice(2);
if (
  args.some((arg) => arg !== "--check") ||
  args.filter((arg) => arg === "--check").length > 1
) {
  die(2, "unsupported-arguments");
}

const checkOnly = args.includes("--check");
const path = process.env.CMM_ANTIGRAVITY_SETTINGS_PATH || DEFAULT_PATH;
const settings = parseSettings(path);
const blockers = conflictRules(settings);

marker(
  "ANTIGRAVITY_PERMISSION_PATH_SOURCE",
  process.env.CMM_ANTIGRAVITY_SETTINGS_PATH ? "ENV_OVERRIDE" : "DEFAULT",
);
marker("ANTIGRAVITY_MANAGED_RULE", MANAGED_RULE);
marker("ANTIGRAVITY_GLOBAL_MCP_ALLOW_ADDED", "NO");
marker("ANTIGRAVITY_COMMAND_WILDCARD_ADDED", "NO");
marker("ANTIGRAVITY_WRITE_WILDCARD_ADDED", "NO");
marker("ANTIGRAVITY_ASK_OR_DENY_MODIFIED", "NO");

if (blockers.length > 0) {
  marker("ANTIGRAVITY_PERMISSION_CONFLICT_COUNT", String(blockers.length));
  die(5, "higher-precedence-mcp-conflict");
}

if (checkOnly) {
  if (!hasManagedAllow(settings)) die(6, "managed-rule-absent");
  marker("ANTIGRAVITY_SCOPED_MCP_PERMISSION_CHECK", "PASS");
  marker("ANTIGRAVITY_PERMISSION_PROVISION", "UNCHANGED");
  process.exit(0);
}

if (hasManagedAllow(settings)) {
  marker("ANTIGRAVITY_SCOPED_MCP_PERMISSION", "PRESENT");
  marker("ANTIGRAVITY_PERMISSION_PROVISION", "UNCHANGED");
  process.exit(0);
}

const mode = statSync(path).mode & 0o777;
const permissions = isObject(settings.permissions) ? { ...settings.permissions } : {};
const allow = stringArray(permissions.allow, "permissions.allow") ?? [];

settings.permissions = {
  ...permissions,
  allow: [...allow, MANAGED_RULE],
};

safeWriteAtomic(path, settings, mode);

marker("ANTIGRAVITY_SCOPED_MCP_PERMISSION", "ADDED");
marker("ANTIGRAVITY_PERMISSION_PROVISION", "PASS");
