import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SANITIZATION_POLICY_VERSION = "2026-09-11.1";

const HIGH_CONFIDENCE_SECRET_RULES = [
  {
    rule: "private-key",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    rule: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    rule: "openai-style-token",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    rule: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  },
  {
    rule: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    rule: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    rule: "jwt-like-token",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
];

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function addEvent(events, rule, count = 1) {
  events.set(rule, (events.get(rule) ?? 0) + count);
}

function findHighConfidenceSecrets(input) {
  const matches = [];

  for (const { rule, pattern } of HIGH_CONFIDENCE_SECRET_RULES) {
    pattern.lastIndex = 0;

    for (const match of input.matchAll(pattern)) {
      matches.push({
        rule,
        value: match[0],
        index: match.index ?? 0,
      });
    }
  }

  return matches.sort((a, b) => a.index - b.index || a.rule.localeCompare(b.rule));
}

function lineNumberAt(input, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (input.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, 8192);
  return !sample.includes(0);
}

export function sanitizeText(input) {
  const events = new Map();

  let text = input.replace(/\/Users\/[^/\s]+(?=\/)/g, () => {
    addEvent(events, "macos-home-path");
    return "/Users/example";
  });

  const normalizedLines = text.split(/\r?\n/).map((line) => {
    const normalized = line.replace(/[ \t\u00a0]+$/u, "");
    if (normalized !== line) {
      addEvent(events, "trailing-whitespace");
    }
    return normalized;
  });

  text = normalizedLines.join("\n").replace(/\n*$/u, "\n");

  return {
    text,
    events: [...events.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([rule, count]) => ({ rule, count })),
  };
}

export function scanText(path, input) {
  const findings = findHighConfidenceSecrets(input).map(
    ({ rule, value, index }) => ({
      severity: "BLOCK",
      rule,
      path,
      line: lineNumberAt(input, index),
      valueSha256: sha256(value),
    }),
  );

  const homePattern = /\/Users\/(?!example(?:\/|$))[^/\s]+(?=\/)/g;
  for (const match of input.matchAll(homePattern)) {
    findings.push({
      severity: "BLOCK",
      rule: "unsanitized-macos-home-path",
      path,
      line: lineNumberAt(input, match.index ?? 0),
      valueSha256: sha256(match[0]),
    });
  }

  return findings.sort(
    (left, right) =>
      left.line - right.line ||
      left.rule.localeCompare(right.rule) ||
      left.path.localeCompare(right.path),
  );
}

export function classifySecretLikeLiteral(path, value, context) {
  if (findHighConfidenceSecrets(value).length > 0) {
    return "BLOCK";
  }

  const inTests = /^tests\//.test(path);
  const humanReadable = /^[A-Za-z][A-Za-z0-9_-]{5,}$/.test(value);
  const authContext =
    /\b(?:auth|authorization|bearer|token|secret|password|api[_ -]?key|credential)\b/i.test(
      context,
    );

  if (inTests && humanReadable && authContext) {
    return "SAFE_TEST_FIXTURE";
  }

  if (inTests && humanReadable) {
    return "REVIEW_TEST_FIXTURE";
  }

  return "BLOCK";
}

function pathWithin(root, path) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(path);
  const rel = relative(absoluteRoot, absolute);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function scanTree(root) {
  const absoluteRoot = resolve(root);
  const findings = [];

  async function walk(directory) {
    if (!pathWithin(absoluteRoot, directory)) {
      throw new Error("scan path escaped root");
    }

    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));

    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const rel = relative(absoluteRoot, absolute).split(sep).join("/");
      const stat = await lstat(absolute);

      if (stat.isDirectory()) {
        await walk(absolute);
        continue;
      }

      if (stat.isSymbolicLink()) {
        continue;
      }

      if (!stat.isFile()) {
        findings.push({
          severity: "BLOCK",
          rule: "unsupported-filesystem-entry",
          path: rel,
          line: 1,
          valueSha256: sha256(rel),
        });
        continue;
      }

      const buffer = await readFile(absolute);
      if (!isProbablyText(buffer)) {
        continue;
      }

      findings.push(...scanText(rel, buffer.toString("utf8")));
    }
  }

  await walk(absoluteRoot);
  return findings;
}

async function main() {
  const [command, root] = process.argv.slice(2);

  if (!command) {
    return;
  }

  if (command !== "scan-tree" || !root) {
    throw new Error("usage: policy.mjs scan-tree <root>");
  }

  const findings = await scanTree(root);
  const blockers = findings.filter((finding) => finding.severity === "BLOCK");

  for (const finding of findings) {
    console.log(
      [
        "PUBLIC_SCAN_FINDING",
        `severity=${finding.severity}`,
        `rule=${finding.rule}`,
        `path=${finding.path}`,
        `line=${finding.line}`,
        `value_sha256=${finding.valueSha256 ?? "none"}`,
      ].join(" "),
    );
  }

  console.log(`PUBLIC_CANDIDATE_PRIVACY_FINDINGS=${findings.length}`);
  console.log(`PUBLIC_CANDIDATE_PRIVACY_BLOCKERS=${blockers.length}`);

  if (blockers.length > 0) {
    console.log("PUBLIC_CANDIDATE_PRIVACY_SCAN=FAIL");
    process.exitCode = 2;
    return;
  }

  console.log("PUBLIC_CANDIDATE_PRIVACY_SCAN=PASS");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `PUBLIC_POLICY_ERROR=${error instanceof Error ? error.message : "unknown"}`,
    );
    process.exitCode = 1;
  });
}
