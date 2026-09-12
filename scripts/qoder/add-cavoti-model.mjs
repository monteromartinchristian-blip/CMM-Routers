#!/usr/bin/env node
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const SETTINGS_PATH =
  process.env.QODER_SETTINGS_PATH ?? join(homedir(), ".qoder", "settings.json");
const BACKUP_DIR =
  process.env.QODER_BACKUP_DIR ??
  join(homedir(), "Library", "Application Support", "CMM Routers", "Qoder Backups");

const PROVIDER_ID = "qoder-custom-cmm-router";
const MODEL_ID = "cavoti/deepseek-v4.1-flash";

const CAVOTI_MODEL = {
  model: MODEL_ID,
  displayName: "DeepSeek V4.1 Flash (Cavoti via CMM Routers)",
  contextWindow: 1_000_000,
  maxOutputTokens: 8_192,
  capabilities: {
    vision: false,
  },
};

function fail(marker, message) {
  console.error(marker);
  if (message) console.error(message);
  process.exit(1);
}

let raw;
let settings;
try {
  raw = readFileSync(SETTINGS_PATH, "utf8");
  settings = JSON.parse(raw);
} catch {
  fail("QODER_CAVOTI_MODEL=SETTINGS_UNREADABLE");
}

if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
  fail("QODER_CAVOTI_MODEL=SETTINGS_INVALID");
}

const provider = settings?.providers?.[PROVIDER_ID];
if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
  fail("QODER_CAVOTI_MODEL=PROVIDER_NOT_FOUND");
}
if (provider.baseUrl !== "http://127.0.0.1:8790/v1") {
  fail("QODER_CAVOTI_MODEL=BASE_URL_MISMATCH");
}
if (
  provider.type !== "openai-compatible" ||
  provider.protocol !== "openai" ||
  provider.authType !== "bearer"
) {
  fail("QODER_CAVOTI_MODEL=PROTOCOL_MISMATCH");
}
if (typeof provider.apiKey !== "string" || provider.apiKey.length === 0) {
  fail("QODER_CAVOTI_MODEL=BEARER_MISSING");
}
if (!Array.isArray(provider.models)) {
  fail("QODER_CAVOTI_MODEL=MODELS_INVALID");
}

const matches = provider.models.filter((item) => item?.model === MODEL_ID);
if (matches.length > 1) {
  fail("QODER_CAVOTI_MODEL=DUPLICATE_EXISTING");
}
if (matches.length === 1) {
  if (!isDeepStrictEqual(matches[0], CAVOTI_MODEL)) {
    fail("QODER_CAVOTI_MODEL=CONFLICT");
  }
  console.log("QODER_CAVOTI_MODEL=ALREADY_PRESENT");
  console.log("QODER_CAVOTI_MODEL_COUNT=1");
  process.exit(0);
}

provider.models.push(CAVOTI_MODEL);

mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
chmodSync(BACKUP_DIR, 0o700);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(BACKUP_DIR, `settings.json.${stamp}.cavoti.bak`);
copyFileSync(SETTINGS_PATH, backupPath);
chmodSync(backupPath, 0o600);

const originalMode = statSync(SETTINGS_PATH).mode & 0o777;
const tempPath = join(
  dirname(SETTINGS_PATH),
  `.settings.json.cavoti-${process.pid}-${Date.now()}.tmp`,
);
writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
chmodSync(tempPath, originalMode || 0o600);
renameSync(tempPath, SETTINGS_PATH);

console.log("QODER_CAVOTI_MODEL=ADDED");
console.log(`QODER_CAVOTI_MODEL_ID=${MODEL_ID}`);
console.log("QODER_CAVOTI_SELECTED_MODEL_CHANGED=NO");
console.log("QODER_CAVOTI_BEARER_CHANGED=NO");
console.log("QODER_CAVOTI_OTHER_PROVIDERS_CHANGED=NO");
console.log("QODER_CAVOTI_BACKUP=LOCAL_ONLY_CREATED");
