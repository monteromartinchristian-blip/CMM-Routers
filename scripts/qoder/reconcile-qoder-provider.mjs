#!/usr/bin/env node
/**
 * Reconcile the Qoder custom provider `qoder-custom-cmm-router` with the real
 * per-model capabilities of the CMM Router subscription routes.
 *
 * Guarantees:
 *  - only that ONE provider entry is rewritten; every other provider and every
 *    other top-level key is preserved exactly;
 *  - each existing model id and displayName is carried over byte-for-byte, so
 *    the catalog identity cannot drift while capabilities are corrected;
 *  - the existing bearer is carried over untouched and is never printed;
 *  - the catalog must match the expected 25-model family layout, else it fails
 *    closed without writing;
 *  - a secret-bearing backup goes to a LOCAL-ONLY directory (never iCloud).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SETTINGS_PATH =
  process.env.QODER_SETTINGS_PATH ?? join(homedir(), ".qoder", "settings.json");
const BACKUP_DIR =
  process.env.QODER_BACKUP_DIR ??
  join(homedir(), "Library", "Application Support", "CMM Routers", "Qoder Backups");
const PROVIDER_ID = "qoder-custom-cmm-router";

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const AGY_EFFORTS = ["low", "medium", "high"];
const CHATGPT_5_5 = ["low", "medium", "high", "xhigh"];
const CHATGPT_MODERN = ["low", "medium", "high", "xhigh", "max"];

const CODEX = { context: 1_050_000, output: 128_000, vision: true };
const CLAUDE_1M = { context: 1_000_000, output: 128_000, vision: true };
const CLAUDE_HAIKU = { context: 200_000, output: 64_000, vision: true };
const GEMINI = { context: 1_048_576, output: 65_536, vision: false };
const GPT_OSS = { context: 131_072, output: 131_072, vision: false };
// The headless agy route exposes no image input, so its models stay text-only.
const AGY_CLAUDE = { context: 1_000_000, output: 128_000, vision: false };

const isClaude = (id) => id.startsWith("claude/");
const isGoogle = (id) => id.startsWith("google/");
const isAgyClaude = (id) => isGoogle(id) && id.includes("claude");
const isGemini = (id) => isGoogle(id) && id.includes("gemini");
const isGptOss = (id) => isGoogle(id) && id.includes("gpt-oss");

/**
 * Expected catalog layout, in order. Each slot matches its model by FAMILY
 * rather than by an exact literal, because the live ids embed the upstream
 * slug (e.g. `google/claude-opus-4-6-thinking`) and are preserved verbatim.
 */
const LAYOUT = [
  { match: (id) => id === "chatgpt/gpt-5.5", cap: CODEX, efforts: CHATGPT_5_5 },
  { match: (id) => id.startsWith("chatgpt/"), cap: CODEX, efforts: CHATGPT_MODERN },
  { match: (id) => id.startsWith("chatgpt/"), cap: CODEX, efforts: CHATGPT_MODERN },
  { match: (id) => id.startsWith("chatgpt/"), cap: CODEX, efforts: CHATGPT_MODERN },
  { match: (id) => id.startsWith("chatgpt/"), cap: CODEX, efforts: CHATGPT_MODERN },
  { match: (id) => id.startsWith("chatgpt/"), cap: CODEX, efforts: CHATGPT_MODERN },
  { match: (id) => isClaude(id) && id.includes("fable"), cap: CLAUDE_1M, efforts: CLAUDE_EFFORTS },
  { match: (id) => isClaude(id) && id.endsWith("/default"), cap: CLAUDE_1M, efforts: CLAUDE_EFFORTS },
  { match: (id) => isClaude(id) && id.endsWith("/haiku"), cap: CLAUDE_HAIKU, efforts: null },
  { match: (id) => isClaude(id) && id.endsWith("/opus"), cap: CLAUDE_1M, efforts: CLAUDE_EFFORTS },
  { match: (id) => isClaude(id) && id.endsWith("/sonnet"), cap: CLAUDE_1M, efforts: CLAUDE_EFFORTS },
  // agy-routed Claude: adjustable effort, no separate level in the slug.
  { match: isAgyClaude, cap: AGY_CLAUDE, efforts: AGY_EFFORTS },
  { match: isAgyClaude, cap: AGY_CLAUDE, efforts: AGY_EFFORTS },
  // Gemini slugs already encode -low/-medium/-high: no extra effort selector.
  { match: isGemini, cap: GEMINI, efforts: null },
  { match: isGemini, cap: GEMINI, efforts: null },
  { match: isGemini, cap: GEMINI, efforts: null },
  { match: isGemini, cap: GEMINI, efforts: null },
  { match: isGemini, cap: GEMINI, efforts: null },
  { match: isGemini, cap: GEMINI, efforts: null },
  { match: isGemini, cap: GEMINI, efforts: null },
  { match: isGemini, cap: GEMINI, efforts: null },
  { match: isGemini, cap: GEMINI, efforts: null },
  { match: isGemini, cap: GEMINI, efforts: null },
  { match: isGemini, cap: GEMINI, efforts: null },
  { match: isGptOss, cap: GPT_OSS, efforts: null },
];

function fail(message) {
  console.error(`RECONCILE_FAILED: ${message}`);
  process.exit(1);
}

const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));

const provider = settings?.providers?.[PROVIDER_ID];
if (!provider || typeof provider !== "object") fail(`provider ${PROVIDER_ID} not found`);
if (typeof provider.apiKey !== "string" || provider.apiKey.length === 0) {
  fail("existing bearer is missing; refusing to write");
}

const current = provider.models;
if (!Array.isArray(current)) fail("provider.models is not an array");
if (current.length !== LAYOUT.length) {
  fail(`expected ${LAYOUT.length} models, found ${current.length}`);
}

// Fail closed on catalog shape drift: an unexpected id at a position means the
// family assumptions below no longer hold.
LAYOUT.forEach((slot, index) => {
  const id = current[index]?.model;
  if (typeof id !== "string" || !slot.match(id)) {
    fail(`model #${index} does not match the expected family layout`);
  }
});

const bearerBefore = provider.apiKey;

// Ids and display names are preserved verbatim; only capability truth changes.
const models = current.map((entry, index) => {
  const slot = LAYOUT[index];
  return {
    ...entry,
    contextWindow: slot.cap.context,
    maxOutputTokens: slot.cap.output,
    capabilities: {
      vision: slot.cap.vision,
      ...(slot.efforts !== null
        ? {
            thinking: {
              modes: ["enabled"],
              supportsEffort: true,
              supportedEffortLevels: slot.efforts,
            },
          }
        : {}),
    },
  };
});

// Back up the secret-bearing file to a LOCAL-ONLY location (never iCloud).
mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(BACKUP_DIR, `settings.json.${stamp}.bak`);
copyFileSync(SETTINGS_PATH, backupPath);
chmodSync(backupPath, 0o600);

const next = {
  ...settings,
  providers: { ...settings.providers, [PROVIDER_ID]: { ...provider, models } },
};

// Atomic replace: a partial write can never leave Qoder with a broken config.
const tmpPath = `${SETTINGS_PATH}.cmm-tmp`;
writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
renameSync(tmpPath, SETTINGS_PATH);

// ---- Non-secret validation -------------------------------------------------
const written = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
const wp = written.providers[PROVIDER_ID];

if (wp.apiKey !== bearerBefore) fail("bearer changed");
for (const field of ["baseUrl", "type", "protocol", "authType"]) {
  if (wp[field] !== provider[field]) fail(`${field} changed`);
}

const otherIds = Object.keys(written.providers).filter((k) => k !== PROVIDER_ID);
const otherBefore = Object.keys(settings.providers).filter((k) => k !== PROVIDER_ID);
if (JSON.stringify(otherIds.sort()) !== JSON.stringify(otherBefore.sort())) {
  fail("unrelated provider set changed");
}
for (const id of otherIds) {
  if (JSON.stringify(written.providers[id]) !== JSON.stringify(settings.providers[id])) {
    fail(`unrelated provider ${id} was modified`);
  }
}
if (JSON.stringify(written.enabledPlugins) !== JSON.stringify(settings.enabledPlugins)) {
  fail("enabledPlugins changed");
}

const wm = wp.models;
if (JSON.stringify(wm.map((m) => m.model)) !== JSON.stringify(current.map((m) => m.model))) {
  fail("model id list changed");
}

console.log("QODER_RECONCILE=OK");
console.log(`BACKUP_WRITTEN=${backupPath}`);
console.log(`QODER_MODEL_COUNT=${wm.length}`);
console.log(`GLOBAL_200000_COUNT=${wm.filter((m) => m.contextWindow === 200_000).length}`);
console.log(`GLOBAL_8192_COUNT=${wm.filter((m) => m.maxOutputTokens === 8_192).length}`);
console.log(`VISION_TRUE_COUNT=${wm.filter((m) => m.capabilities?.vision === true).length}`);
console.log(`EFFORT_SELECTOR_COUNT=${wm.filter((m) => m.capabilities?.thinking !== undefined).length}`);
console.log(`COMMAND_CODE_MODEL_COUNT=${wm.filter((m) => String(m.model).startsWith("command-code/")).length}`);
console.log(`BEARER_PRESERVED=${wp.apiKey === bearerBefore ? "YES" : "NO"}`);
console.log("BEARER_PRINTED=NO");
