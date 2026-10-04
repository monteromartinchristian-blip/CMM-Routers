#!/usr/bin/env node
/**
 * Checkpoint A acceptance gate.
 *
 *   node scripts/verify-live-checkpoint.mjs <repoPath> [--out dir]
 *
 * Checkpoint A must reproduce the currently running Router dist, which was
 * built from an intermediate state of src/providers/claude/adapter.ts: six of
 * its eight dirty hunks were built, two landed afterwards. A therefore has to
 * split that one file mid-way, and a commit that merely *looks* right is the
 * expected failure mode. Nothing here trusts the working tree: content is read
 * from the git index via `git show :<path>`, so an unstaged edit cannot
 * masquerade as staged.
 *
 * Three independent things must hold:
 *   - every live marker is present in the staged content
 *   - every post-live marker is absent from the staged content
 *   - the two post-live hunks still exist as unstaged changes
 *
 * The third is what distinguishes a correct split from both hunks being
 * committed, and from both being dropped. Read-only: it never writes to the
 * index, the worktree, or HEAD.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLAUDE = "src/providers/claude/adapter.ts";
const SERVER = "src/http/server.ts";

/** Present in the 2026-10-03 01:17:53 dist. Must survive into A. */
const REQUIRED = {
  "src/http/catalog.ts": ["observationMode", "readObservations"],
  "src/http/diagnostics.ts": ["observationMode", "readObservations"],
  "src/providers/antigravity/adapter.ts": ["pendingDiscovery", "discoverModelsOnce"],
  "src/providers/antigravity/process-client.ts": ["execFile"],
  "src/registry/provider-registry.ts": ["readObservations", "pendingHealth"],
  [CLAUDE]: [
    "requirement is a fact about this Router",
    "let queryResult",
    "queryResult = query(",
    "queryResult?.close?.()",
    "const warmQuery = await startup(",
    "warmQuery?.close?.()",
  ],
};

/** Landed after the dist build. Must NOT be in A. */
const FORBIDDEN = {
  // The post-live display-name guard. The live form is the bare call with no
  // test, so the guard's own regex test is the distinguishing token.
  [CLAUDE + "\u0000guard"]: [".test(baseModel)"],
  // Committed at 31e48d7 and present in ff88129, but never emitted by the
  // running build, so A must revert it. This is not a dirty hunk at all.
  [CLAUDE + "\u0000alias"]: ["if (!isAlias) continue;"],
  // Readiness must not appear anywhere; server.ts is excluded wholesale below.
  [SERVER]: ["No fresh available provider observations", "observationMode"],
};

const EXPECTED_STAGED_CLAUDE_HUNKS = 8;
const EXPECTED_EXCLUDED_CLAUDE_HUNKS = 2;

function git(repo, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (allowFail) return "";
    throw new Error(`git ${args.join(" ")} failed: ${error.message}`);
  }
}

/** Index content for a path, or null when the path is not in the index. */
function indexContent(repo, path) {
  return git(repo, ["show", `:${path}`], { allowFail: true });
}

function stagedPaths(repo) {
  return git(repo, ["diff", "--cached", "--name-only", "HEAD"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function hunkCount(repo, path, { cached }) {
  const out = git(
    repo,
    ["diff", cached ? "--cached" : "--no-ext-diff", "-U0", "--", path],
    { allowFail: true },
  );
  return out.split("\n").filter((line) => line.startsWith("@@")).length;
}

const [repoArg, ...rest] = process.argv.slice(2);
if (!repoArg) {
  console.error("usage: verify-live-checkpoint.mjs <repoPath> [--out dir]");
  process.exit(2);
}
const outIndex = rest.indexOf("--out");
const outDir = outIndex === -1 ? null : rest[outIndex + 1];

const staged = stagedPaths(repoArg);
const failures = [];

// --- 1. the five whole live files are staged, server.ts is not ---------------
const serverStaged = staged.includes(SERVER);
if (serverStaged) failures.push(`${SERVER} is staged; it must not be part of A`);

for (const path of Object.keys(REQUIRED)) {
  if (path === CLAUDE) continue;
  if (!staged.includes(path)) failures.push(`${path} is not staged; A is incomplete`);
}

// --- 2. required live markers survive into the staged content --------------
const missingRequired = [];
for (const [path, markers] of Object.entries(REQUIRED)) {
  const content = indexContent(repoArg, path);
  if (content === "") {
    missingRequired.push({ file: path, markers, reason: "not in index" });
    continue;
  }
  const absent = markers.filter((marker) => !content.includes(marker));
  if (absent.length > 0) missingRequired.push({ file: path, markers: absent });
}

// --- 3. no post-live marker reached the index -----------------------------
const presentForbidden = [];
for (const [key, markers] of Object.entries(FORBIDDEN)) {
  const isGuard = key.endsWith("\u0000guard");
  const path = isGuard ? key.slice(0, -"\u0000guard".length) : key;
  const content = indexContent(repoArg, path);
  if (content === "") continue;
  const found = markers.filter((marker) => content.includes(marker));
  if (found.length > 0) presentForbidden.push({ file: path, markers: found });
}

// --- 4. the mid-file split actually happened --------------------------------
const stagedHunks = hunkCount(repoArg, CLAUDE, { cached: true });
const unstagedHunks = hunkCount(repoArg, CLAUDE, { cached: false });
if (stagedHunks !== EXPECTED_STAGED_CLAUDE_HUNKS) {
  failures.push(
    `${CLAUDE}: ${stagedHunks} staged hunk(s), expected ${EXPECTED_STAGED_CLAUDE_HUNKS}`,
  );
}
if (unstagedHunks !== EXPECTED_EXCLUDED_CLAUDE_HUNKS) {
  failures.push(
    `${CLAUDE}: ${unstagedHunks} unstaged hunk(s), expected ${EXPECTED_EXCLUDED_CLAUDE_HUNKS} ` +
      `still holding the post-live work for checkpoint B`,
  );
}

// --- 5. evidence artifact ---------------------------------------------------
const patch = git(repoArg, ["diff", "--cached", "--binary", "HEAD"]);
const patchSha = createHash("sha256").update(patch).digest("hex");
let patchPath = null;
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  patchPath = join(outDir, "checkpoint-a.staged.patch");
  writeFileSync(patchPath, patch);
}

const valid = failures.length === 0 && missingRequired.length === 0 && presentForbidden.length === 0;

console.log(`STAGED_FILES=${staged.join(",") || "(none)"}`);
console.log(`STAGED_CLAUDE_INCLUDED_HUNKS=${stagedHunks}`);
console.log(`STAGED_CLAUDE_EXCLUDED_HUNKS=${unstagedHunks}`);
console.log(`STAGED_SERVER_TS=${serverStaged ? "PRESENT" : "ABSENT"}`);
console.log(`STAGED_POST_LIVE_MARKERS=${presentForbidden.length}`);
console.log(`STAGED_REQUIRED_MARKERS_MISSING=${missingRequired.length}`);
console.log(`STAGED_PATCH_SHA256=${patchSha}`);
console.log(`STAGED_PATCH_PATH=${patchPath ?? "(not written; pass --out <dir>)"}`);
console.log(`CHECKPOINT_A_STAGED_VALID=${valid ? "YES" : "NO"}`);

for (const failure of failures) console.error(`  ! ${failure}`);
for (const miss of missingRequired) {
  console.error(`  ! missing live marker in ${miss.file}: ${miss.markers.join(", ")}`);
}
for (const hit of presentForbidden) {
  console.error(`  ! post-live marker staged in ${hit.file}: ${hit.markers.join(", ")}`);
}

console.error(
  "NOTE: this gates the STAGED patch only. The dist comparison against the " +
    "running build is the final oracle.",
);

// A non-zero exit stops a pipeline before a bad commit is made.
process.exit(valid ? 0 : 1);