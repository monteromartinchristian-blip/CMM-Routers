import { spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Bounded provider-process termination.
 *
 * Request graceful termination -> SIGINT -> bounded grace period -> if the
 * process is still alive SIGKILL -> bounded terminal verdict. One primitive is
 * used for every termination edge (timeout, AbortSignal, TTL cleanup,
 * post-result cancellation, fatal protocol failure, bridge failure, teardown)
 * so no path can leave a live provider process behind and no duplicate signal
 * race or lingering timer is possible.
 */
export const CHILD_TERMINATION_GRACE_MS = 2000;
export const CHILD_TERMINATION_VERDICT_MS = 2000;

export function terminateChild(
  child: ChildProcess,
  graceMs: number = CHILD_TERMINATION_GRACE_MS,
  verdictMs: number = CHILD_TERMINATION_VERDICT_MS,
): Promise<"exited" | "killed"> {
  return new Promise<"exited" | "killed">((resolve) => {
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let verdictTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (verdict: "exited" | "killed"): void => {
      if (done) return;
      done = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (verdictTimer !== undefined) clearTimeout(verdictTimer);
      child.removeListener("exit", onExit);
      child.removeListener("close", onExit);
      resolve(verdict);
    };
    // Settle on "close" (stdio fully drained), never on the earlier "exit":
    // the final provider output must still be observable to diagnostics.
    const onExit = (): void => settle("exited");
    child.once("close", onExit);
    try {
      child.kill("SIGINT");
    } catch {
      // Already dead: the exit/close listener settles immediately.
    }
    graceTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        settle("killed");
        return;
      }
      // Bounded terminal verdict: never wait on a provider that ignores even
      // SIGKILL (e.g. an uninterruptible child); cleanup must still settle.
      verdictTimer = setTimeout(() => settle("killed"), verdictMs);
    }, graceMs);
  });
}

/**
 * Longest prefix of `text` whose UTF-8 encoding is at most `maxBytes` bytes.
 * Iterates by code point, so a multibyte sequence is never split; a code point
 * that would exceed the remaining room is dropped entirely (no partial code
 * point, no U+FFFD substitution is ever introduced).
 */
export function truncateUtf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let kept = "";
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    kept += ch;
  }
  return kept;
}

/**
 * Longest suffix of `text` whose UTF-8 encoding is at most `maxBytes` bytes,
 * aligned to code-point boundaries. A code point that would exceed the
 * remaining room is dropped entirely, so the result is always valid UTF-8 and
 * never contains a U+FFFD substitution.
 */
export function truncateUtf8Tail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const chars = Array.from(text);
  let used = 0;
  const kept: string[] = [];
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i] as string;
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    kept.push(ch);
  }
  kept.reverse();
  return kept.join("");
}

/**
 * Capped diagnostic accumulator for provider-controlled output. Retains a
 * bounded head window plus a bounded tail window so error mapping still has
 * both the beginning and the most recent output, while total retained UTF-8
 * bytes never exceed `cap` regardless of provider lifetime.
 *
 * The cap is a real UTF-8 BYTE budget, not a UTF-16 character count: for any
 * sequence of pushes, `Buffer.byteLength(value(), "utf8") <= cap`. Truncation
 * iterates by code point, so a multibyte character is never split across the
 * window boundary and its bytes are never replaced by U+FFFD; a code point
 * that cannot fit in the remaining room is dropped entirely.
 */
export class CappedTextBuffer {
  private head = "";
  private tail = "";
  private overflowed = false;

  constructor(private readonly cap: number) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;
    const headCap = Math.floor(this.cap / 2);
    const tailCap = this.cap - headCap;
    let rest = chunk;
    const headBytes = Buffer.byteLength(this.head, "utf8");
    if (headBytes < headCap) {
      const added = truncateUtf8Head(rest, headCap - headBytes);
      this.head += added;
      rest = rest.slice(added.length);
    }
    if (rest.length > 0) {
      const combined = this.tail + rest;
      if (Buffer.byteLength(combined, "utf8") > tailCap) this.overflowed = true;
      this.tail = truncateUtf8Tail(combined, tailCap);
    }
  }

  didOverflow(): boolean {
    return this.overflowed;
  }

  value(): string {
    return this.head + this.tail;
  }
}

/** Bounded retention for agy stdout used only for diagnostic error mapping. */
export const MAX_AGY_STDOUT_DIAGNOSTIC_BYTES = 64 * 1024;
/** Bounded retention for agy stderr used only for diagnostic error mapping. */
export const MAX_AGY_STDERR_DIAGNOSTIC_BYTES = 64 * 1024;
/**
 * Maximum bytes of a single unterminated agy stream-json NDJSON line. A line
 * beyond this bound is a protocol violation, not valid output: the run fails
 * closed instead of accumulating provider-controlled memory. Matches the
 * Router-side control-frame bound and the 1 MiB tool-result bound.
 */
export const MAX_AGY_NDJSON_LINE_BYTES = 1024 * 1024;

export const AGY_PATH = join(homedir(), ".local", "bin", "agy");

export const GLOBAL_SETTINGS_PATH = join(
  homedir(),
  ".gemini",
  "antigravity-cli",
  "settings.json",
);

export function readGlobalSettingsState(): {
  exists: boolean;
  sha256: string | null;
  modelProvider: unknown;
  useG1Credits: unknown;
  enableTerminalSandbox: unknown;
  agentMode: unknown;
} {
  if (!existsSync(GLOBAL_SETTINGS_PATH)) {
    return {
      exists: false,
      sha256: null,
      modelProvider: "ABSENT",
      useG1Credits: "ABSENT",
      enableTerminalSandbox: "ABSENT",
      agentMode: "ABSENT",
    };
  }
  const raw = readFileSync(GLOBAL_SETTINGS_PATH);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw.toString("utf-8")) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const pick = (key: string): unknown =>
    parsed[key] === undefined ? "ABSENT" : parsed[key];
  return {
    exists: true,
    sha256,
    modelProvider: pick("modelProvider"),
    useG1Credits: pick("useG1Credits"),
    enableTerminalSandbox: pick("enableTerminalSandbox"),
    agentMode: pick("agentMode"),
  };
}

export function assertAccountOnlySettings(
  state: { modelProvider: unknown; useG1Credits: unknown },
): void {
  if (state.modelProvider === "gemini") {
    throw new Error(
      "Antigravity unsafe configuration: modelProvider=gemini routes to Gemini API PAYG",
    );
  }
  if (state.useG1Credits === true) {
    throw new Error(
      "Antigravity unsafe configuration: useG1Credits=true enables AI Credits fallback",
    );
  }
}

export const FORBIDDEN_PAYG_VARS = [
  "GEMINI_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_API_KEY",
] as const;

export function buildAgyChildEnv(
  extraEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      (FORBIDDEN_PAYG_VARS as readonly string[]).includes(key)
    ) {
      continue;
    }
    env[key] = value;
  }
  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      env[key] = value;
    }
  }
  return env;
}

export interface AgyRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error | undefined;
}

export interface AgyRunner {
  run(args: string[], options: { cwd: string; timeoutMs: number }): AgyRunResult;
}

export class RealAgyRunner implements AgyRunner {
  constructor(private readonly agyPath: string = AGY_PATH) {}

  run(
    args: string[],
    options: { cwd: string; timeoutMs: number },
  ): AgyRunResult {
    const result = spawnSync(this.agyPath, args, {
      cwd: options.cwd,
      env: buildAgyChildEnv(),
      encoding: "utf-8",
      timeout: options.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      error: result.error,
    };
  }
}
