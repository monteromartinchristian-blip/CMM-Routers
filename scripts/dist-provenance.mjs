#!/usr/bin/env node
/**
 * dist provenance tooling.
 *
 * Two jobs:
 *
 *   fingerprint <distDir> [--out f.json]
 *       Hash every emitted file and record which behaviour markers are present.
 *       TypeScript comments survive into the emitted JS, so marker text is a
 *       usable fingerprint: a marker present in the source tree but absent here
 *       means the dist was not built from that source state.
 *
 *   diff <baselineDist> <candidateDist> [--ignore-comments] [--out d.json] [--max-diff-lines N]
 *       Compare two dist directories. A reproduction build is expected to be
 *       byte-identical; any difference here is a provenance failure. A build that
 *       carries deliberate later work is expected to differ, so each changed file
 *       is reported with the markers that appeared or disappeared, which is what
 *       makes an intentional difference explainable rather than merely tolerated.
 *
 * Emitted JS is the artifact under test. This never writes to either dist.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";

const MARKERS = [
  // --- observation / readiness line (active stream) ---
  "readObservations",
  "observationMode",
  "No fresh available provider observations",
  "No providers available",
  "pendingDiscovery",
  "pendingHealth",
  "discoverModelsOnce",
  // --- antigravity process client ---
  "execFile",
  "spawnSync",
  // --- claude adapter resource handling ---
  "queryResult?.close?.()",
  "warmQuery?.close?.()",
  "account restriction is a fact",
  "runtime requirement is a fact",
  "Qoder-owned tools traverse",
  // --- block B catalog reconciliation ---
  "readAccountCatalogForRuntime",
  "readProfileAccountCatalog",
  "ACCOUNT_CATALOG_VERSION",
  "reasoning_effort_default",
  "minRuntimeVersion",
];

function parseArgs(argv) {
  const positional = [];
  const flags = { ignoreComments: false, maxDiffLines: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ignore-comments") flags.ignoreComments = true;
    else if (arg === "--max-diff-lines") flags.maxDiffLines = Number(argv[++i]);
    else if (arg === "--out") flags.out = argv[++i];
    else positional.push(arg);
  }
  return { positional, flags };
}

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else files.push(full);
    }
  }
  // Stable order so two runs produce byte-identical reports.
  return files.sort().map((full) => relative(root, full).split(sep).join("/"));
}

function fingerprint(dir, flags) {
  const files = {};
  for (const rel of walk(dir)) {
    const text = readFileSync(join(dir, rel), "utf8");
    files[rel] = {
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
      markers: MARKERS.filter((m) => text.includes(m)),
    };
  }
  return {
    dir,
    files,
    markersPresent: MARKERS.filter((m) =>
      Object.values(files).some((f) => f.markers.includes(m)),
    ),
  };
}

/**
 * Real unified diff, via diff(1). The previous hand-rolled renderer walked two
 * texts looking for re-anchoring points and, on a structural change, reported
 * whole regions as removed when the true delta was a handful of lines. Output
 * that contradicts the hash verdict is worse than no output, so this defers to
 * the system tool.
 */
function unifiedDiff(baselinePath, candidatePath, maxLines) {
  let out;
  try {
    out = execFileSync("diff", ["-u", baselinePath, candidatePath], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    // diff exits 1 when files differ, which is the normal case here.
    if (typeof error.stdout !== "string") {
      return ["  diff unavailable: " + error.message];
    }
    out = error.stdout;
  }
  const lines = out.split("\n");
  if (lines.length <= maxLines) return lines;
  return lines
    .slice(0, maxLines)
    .concat(["  ... (truncated, " + (lines.length - maxLines) + " more lines)"]);
}

function diff(baselineDir, candidateDir, flags) {
  const base = fingerprint(baselineDir, flags);
  const cand = fingerprint(candidateDir, flags);
  const names = [...new Set([...Object.keys(base.files), ...Object.keys(cand.files)])].sort();

  const changed = [];
  const added = [];
  const removed = [];
  const markerMoves = [];

  for (const rel of names) {
    const b = base.files[rel];
    const c = cand.files[rel];
    if (b && !c) {
      removed.push(rel);
      continue;
    }
    if (!b && c) {
      added.push(rel);
      continue;
    }
    if (b.sha256 === c.sha256) continue;

    const gained = c.markers.filter((m) => !b.markers.includes(m));
    const lost = b.markers.filter((m) => !c.markers.includes(m));
    if (gained.length > 0 || lost.length > 0) markerMoves.push({ file: rel, gained, lost });

    changed.push({
      file: rel,
      baselineSha: b.sha256,
      candidateSha: c.sha256,
      markersGained: gained,
      markersLost: lost,
      // SUPPORTING EVIDENCE ONLY. The verdict is the sha256 above.
      diff: flags.ignoreComments
        ? []
        : unifiedDiff(join(baselineDir, rel), join(candidateDir, rel), flags.maxDiffLines),
    });
  }

  const identical = changed.length === 0 && added.length === 0 && removed.length === 0;
  return {
    baseline: baselineDir,
    candidate: candidateDir,
    ignoreComments: flags.ignoreComments,
    // Provenance verdicts come from content hashes and counts. Marker presence
    // and rendered diffs are triage aids: a marker can be vacuous (unmatchable
    // text, e.g. a phrase spanning a line break) and a diff can be truncated.
    trust: {
      primary: ["sha256", "identical", "changedFiles", "addedFiles", "removedFiles"],
      supportingOnly: ["markersPresent", "markerMoves", "diff"],
    },
    identical,
    summary: {
      filesCompared: names.length,
      identical,
      changedFiles: changed.length,
      addedFiles: added.length,
      removedFiles: removed.length,
      markersGained: [...new Set(markerMoves.flatMap((m) => m.gained))],
      markersLost: [...new Set(markerMoves.flatMap((m) => m.lost))],
    },
    markerMoves,
    changed,
    added,
    removed,
  };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, a, b] = positional;

if (!command || !a) {
  console.error("usage: dist-provenance.mjs fingerprint <distDir> [--out f.json]");
  console.error("       dist-provenance.mjs diff <baselineDist> <candidateDist> [--ignore-comments] [--out d.json]");
  process.exit(2);
}

let report;
if (command === "fingerprint") {
  report = fingerprint(a, flags);
} else if (command === "diff") {
  if (!b) {
    console.error("diff requires two directories");
    process.exit(2);
  }
  report = diff(a, b, flags);
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}

const json = JSON.stringify(report, null, 2);
if (flags.out) writeFileSync(flags.out, `${json}\n`);
else console.log(json);

if (command === "diff") {
  process.stderr.write(
    `IDENTICAL=${report.identical ? "YES" : "NO"} ` +
      `CHANGED=${report.summary.changedFiles} ` +
      `ADDED=${report.summary.addedFiles} ` +
      `REMOVED=${report.summary.removedFiles}\n`,
  );
}