import { createHash } from "node:crypto";

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
  return findHighConfidenceSecrets(input).map(({ rule, value, index }) => ({
    severity: "BLOCK",
    rule,
    path,
    line: lineNumberAt(input, index),
    valueSha256: sha256(value),
  }));
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
