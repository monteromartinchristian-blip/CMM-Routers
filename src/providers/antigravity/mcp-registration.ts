import { execFileSync } from "node:child_process";
import { RouterError } from "../../core/errors.js";

/**
 * Restart-safe reconciliation of the CMM-owned Antigravity MCP registration.
 *
 * `agy mcp add` writes a PERSISTENT, secret-free stdio server entry into the
 * user's agy configuration, so "already registered" is durable state that
 * outlives any Router process. Remembering it in memory is therefore not
 * idempotence: after a Router restart the persisted state is unknown and may
 * have been deleted, edited or duplicated by something else. This module reads
 * the real state back from the CLI and converges it onto exactly one canonical
 * entry for `cmm-qoder-tools`.
 *
 * Observed CLI surface (agy 1.2.0):
 *   `agy mcp add [--env K=V]... <name> <command> [args...]`  — "Add or update"
 *   `agy mcp remove <name>`                                  — exact name only
 *   `agy mcp list`                                           — NAME/TYPE/STATUS/COMMAND-URL table
 * `mcp add` fully REPLACES an existing entry (command, args and env), and
 * re-adds it in the enabled state, which is what makes repair idempotent.
 *
 * `agy mcp list` NEVER prints env, so a visible-canonical row can still hide a
 * stale persisted secret. Canonical state is therefore established by
 * CONSTRUCTION: the first ensure in every Router process re-issues
 * `agy mcp add` WITHOUT `--env`, which clears any hidden env as a side effect.
 */

/** Dedicated, CMM Router-owned MCP server name. Never a user-chosen name. */
export const CMM_QODER_TOOLS_MCP_SERVER_NAME = "cmm-qoder-tools";

/**
 * Finite bound on every CMM-owned `agy mcp` CLI call. The Router must never be
 * blocked indefinitely by a stuck registration subprocess.
 */
export const AGY_MCP_CLI_TIMEOUT_MS = 10_000;
/** Finite output bound for every CMM-owned `agy mcp` CLI call. */
export const AGY_MCP_CLI_MAX_BUFFER_BYTES = 1024 * 1024;
/** Diagnostic text kept from a failed CLI call, after redaction. */
export const AGY_MCP_CLI_DIAGNOSTIC_CHARS = 200;

export interface AgyMcpRegistration {
  name: string;
  type: string;
  /** Raw STATUS cell as reported by the CLI. */
  status: string;
  enabled: boolean;
  command: string;
  args: string[];
  /**
   * Only populated when the CLI output exposes an environment segment. The
   * observed `agy mcp list` never prints one, so in practice this stays
   * undefined; callers must not treat it as "no env configured" proof.
   */
  env?: Record<string, string>;
}

/** Why a CLI invocation failed, when the failure was not a plain nonzero exit. */
export type AgyCliFailure = "timeout" | "max_buffer" | "signal" | "not_found";

export interface AgyRunOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Present when the call was terminated/failed rather than exiting normally. */
  failure?: AgyCliFailure;
}

export type AgyRunner = (argv: string[]) => AgyRunOutcome;

export type McpRegistrationAction =
  | "noop"
  | "canonicalized"
  | "added"
  | "repaired"
  | "reconciled"
  | "failed";

export interface McpRegistrationResult {
  serverName: string;
  action: McpRegistrationAction;
  /** Extra registrations of the managed name that were collapsed into one. */
  duplicates: number;
  /** Registrations of the MANAGED name before the operation. */
  before: AgyMcpRegistration[];
  /** Registrations of the MANAGED name after the operation. */
  after: AgyMcpRegistration[];
  /** Exact argv issued to the CLI, in order. */
  commands: string[][];
  error?: string;
}

export interface AntigravityMcpRegistrationOptions {
  /** Absolute path to the agy binary. */
  agyPath: string;
  /** Launcher executable the MCP server must run. */
  command: string;
  args: string[];
  /** Must stay empty in production: the registration is secret-free. */
  env?: Record<string, string>;
  serverName?: string;
  /** Injectable CLI runner; tests must never touch the real agy config. */
  run?: AgyRunner;
}

const HEADER_TOKENS = ["NAME", "TYPE", "STATUS", "COMMAND/URL"];
const EMPTY_STORE = /^\s*no mcp servers configured\.?\s*$/i;

/** The only transport the CMM-owned registration may use. */
const CANONICAL_TRANSPORT_TYPE = "stdio";

/**
 * Process-local marker of successful canonicalization, keyed by the exact
 * registration identity. Every new Router process starts empty, so its first
 * ensure always rewrites the entry (clearing any hidden persisted env); later
 * ensures in the same process may no-op once the visible state is canonical.
 */
const canonicalizedThisProcess = new Set<string>();

/**
 * Test-only: forget the per-process canonicalization markers so a new Router
 * process can be simulated inside one test runner.
 */
export function resetAntigravityMcpRegistrationProcessState(): void {
  canonicalizedThisProcess.clear();
}

function canonicalizationKey(
  agyPath: string,
  serverName: string,
  command: string,
  args: string[],
): string {
  return [agyPath, serverName, command, ...args].join("\u0000");
}

/**
 * Parse `agy mcp list` output into registrations. Uses the header row to locate
 * columns (so values may contain single spaces and odd padding), and falls back
 * to gap splitting when no usable header is present. Deterministic: the same
 * output always yields the same registrations, in output order.
 */
export function parseAgyMcpList(output: string): AgyMcpRegistration[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  if (lines.length === 1 && EMPTY_STORE.test(lines[0] as string)) return [];

  let starts: number[] | undefined;
  let dataLines = lines;
  const headerIndex = lines.findIndex((line) => /^\s*NAME\s+TYPE\s+STATUS/i.test(line));
  if (headerIndex >= 0) {
    starts = headerColumnStarts(lines[headerIndex] as string);
    dataLines = lines.slice(headerIndex + 1);
  }

  const registrations: AgyMcpRegistration[] = [];
  for (const line of dataLines) {
    const parsed = starts !== undefined ? parseByColumns(line, starts) : parseByGaps(line);
    if (parsed !== null) registrations.push(parsed);
  }
  return registrations;
}

/** Character offsets of the four header cells, or undefined if unfamiliar. */
function headerColumnStarts(header: string): number[] | undefined {
  const starts: number[] = [];
  const pattern = /\S+/g;
  for (const match of header.matchAll(pattern)) {
    if (match.index === undefined) continue;
    starts.push(match.index);
  }
  if (starts.length !== HEADER_TOKENS.length) return undefined;
  const tokens = starts.map((start, index) => {
    const end = index + 1 < starts.length ? (starts[index + 1] as number) : header.length;
    return header.slice(start, end).trim();
  });
  const familiar = tokens.every(
    (token, index) => token.toUpperCase() === HEADER_TOKENS[index],
  );
  return familiar ? starts : undefined;
}

function parseByColumns(line: string, starts: number[]): AgyMcpRegistration | null {
  const bounds = starts.map((start, index) =>
    index + 1 < starts.length ? (starts[index + 1] as number) : line.length,
  );
  const cells = starts.map((start, index) => line.slice(start, bounds[index]).trim());
  const [name, type, status, commandLine] = cells;
  if (
    name === undefined ||
    type === undefined ||
    status === undefined ||
    commandLine === undefined ||
    name.length === 0 ||
    type.length === 0 ||
    status.length === 0 ||
    commandLine.length === 0
  ) {
    return parseByGaps(line);
  }
  return buildRegistration(name, type, status, commandLine);
}

function parseByGaps(line: string): AgyMcpRegistration | null {
  const cells = line.trim().split(/\s{2,}/);
  if (cells.length < 4) return null;
  const [name, type, status, commandLine] = cells;
  if (
    name === undefined ||
    type === undefined ||
    status === undefined ||
    commandLine === undefined
  ) {
    return null;
  }
  return buildRegistration(name, type, status, commandLine);
}

function buildRegistration(
  name: string,
  type: string,
  status: string,
  commandLine: string,
): AgyMcpRegistration {
  const [command, ...args] = commandLine.trim().split(/\s+/);
  return {
    name,
    type,
    status,
    enabled: status.toLowerCase() === "enabled",
    command: command ?? "",
    args,
  };
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Common secret shapes that must never reach a log or an error message. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+\S+/gi,
  /([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi,
];

/** Bound and redact provider/CLI diagnostic text before it is surfaced. */
function boundedDiagnostic(raw: string): string {
  const firstLine =
    raw
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const truncated =
    firstLine.length > AGY_MCP_CLI_DIAGNOSTIC_CHARS
      ? `${firstLine.slice(0, AGY_MCP_CLI_DIAGNOSTIC_CHARS)}…`
      : firstLine;
  let redacted = truncated;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match: string, key?: string) =>
      key !== undefined && key.length > 0 ? `${key}=[REDACTED]` : "[REDACTED]",
    );
  }
  return redacted;
}

export interface ExecFileAgyRunnerBounds {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

/**
 * The default runner: exact CLI invocation, never a shell, always bounded by a
 * finite timeout and maxBuffer. Timeout, output overflow, an unexpected signal
 * and a missing binary are reported as explicit failures so callers fail closed.
 */
export function execFileAgyRunner(
  agyPath: string,
  bounds: ExecFileAgyRunnerBounds = {},
): AgyRunner {
  const timeoutMs = bounds.timeoutMs ?? AGY_MCP_CLI_TIMEOUT_MS;
  const maxBufferBytes = bounds.maxBufferBytes ?? AGY_MCP_CLI_MAX_BUFFER_BYTES;
  return (argv) => {
    try {
      const stdout = execFileSync(agyPath, argv, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        maxBuffer: maxBufferBytes,
        killSignal: "SIGTERM",
      });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      const failure = error as {
        status?: number | null;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        code?: string;
        signal?: NodeJS.Signals | null;
      };
      const stdout = Buffer.isBuffer(failure.stdout)
        ? failure.stdout.toString("utf-8")
        : (failure.stdout ?? "");
      const stderr = Buffer.isBuffer(failure.stderr)
        ? failure.stderr.toString("utf-8")
        : (failure.stderr ?? "");
      const status = typeof failure.status === "number" ? failure.status : null;
      const kind = classifyFailure(failure.code, failure.signal);
      return kind === undefined
        ? { status, stdout, stderr }
        : { status, stdout, stderr, failure: kind };
    }
  };
}

function classifyFailure(
  code: string | undefined,
  signal: NodeJS.Signals | null | undefined,
): AgyCliFailure | undefined {
  if (code === "ETIMEDOUT") return "timeout";
  // spawnSync reports a maxBuffer overflow as ENOBUFS; exec* report
  // ERR_CHILD_PROCESS_STDIO_MAXBUFFER. Both mean "output bound exceeded".
  if (code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return "max_buffer";
  }
  if (code === "ENOENT") return "not_found";
  if (signal !== undefined && signal !== null) return "signal";
  return undefined;
}

function failureDetail(outcome: AgyRunOutcome): string {
  if (outcome.failure !== undefined) {
    const reason =
      outcome.failure === "timeout"
        ? "timed out"
        : outcome.failure === "max_buffer"
          ? "exceeded the maximum output size"
          : outcome.failure === "signal"
            ? "was terminated by an unexpected signal"
            : "could not be found";
    return `agy mcp CLI ${reason}`;
  }
  const detail = boundedDiagnostic(`${outcome.stderr}\n${outcome.stdout}`);
  return detail.length > 0
    ? detail
    : `exit status ${String(outcome.status)}`;
}

/**
 * Converge the persisted `cmm-qoder-tools` registration to exactly one canonical
 * entry and describe what was done. Throws `provider_unavailable` when the CLI
 * cannot be read or written, because a Router that cannot register the tools
 * bridge would silently lose every tool call.
 */
export function ensureAntigravityMcpRegistration(
  options: AntigravityMcpRegistrationOptions,
): McpRegistrationResult {
  const serverName = options.serverName ?? CMM_QODER_TOOLS_MCP_SERVER_NAME;
  const run = options.run ?? execFileAgyRunner(options.agyPath);
  const env = options.env ?? {};
  const commands: string[][] = [];
  const key = canonicalizationKey(options.agyPath, serverName, options.command, options.args);

  const listed = run(["mcp", "list"]);
  if (listed.status !== 0) {
    throw new RouterError(
      "provider_unavailable",
      `agy mcp list failed: ${failureDetail(listed)}`,
    );
  }
  const before = parseAgyMcpList(listed.stdout).filter((entry) => entry.name === serverName);
  const duplicates = Math.max(0, before.length - 1);
  const isCanonical = (entry: AgyMcpRegistration): boolean =>
    entry.type === CANONICAL_TRANSPORT_TYPE &&
    entry.command === options.command &&
    arraysEqual(entry.args, options.args) &&
    entry.enabled &&
    // The desired env must be empty: the registration is secret-free. Absence of
    // a PERSISTED env cannot be proven from `mcp list`; that is established by
    // rewriting the entry below, not by this predicate.
    Object.keys(env).length === 0;

  const onlyBefore = before.length === 1 ? (before[0] as AgyMcpRegistration) : undefined;
  const visibleCanonical = onlyBefore !== undefined && isCanonical(onlyBefore);
  if (visibleCanonical && canonicalizedThisProcess.has(key)) {
    return { serverName, action: "noop", duplicates: 0, before, after: before, commands };
  }

  const envFlags = Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  const addArgv = ["mcp", "add", ...envFlags, serverName, options.command, ...options.args];

  if (duplicates > 0) {
    // Collapse duplicates: a name-keyed store keeps one entry, and `add`
    // (Add or update) then publishes the canonical one.
    const removeArgv = ["mcp", "remove", serverName];
    commands.push(removeArgv);
    run(removeArgv);
  }
  commands.push(addArgv);
  const added = run(addArgv);
  if (added.status !== 0) {
    throw new RouterError(
      "provider_unavailable",
      `agy mcp add failed: ${failureDetail(added)}`,
    );
  }

  const verified = run(["mcp", "list"]);
  const after =
    verified.status === 0
      ? parseAgyMcpList(verified.stdout).filter((entry) => entry.name === serverName)
      : [];
  if (after.length !== 1 || !isCanonical(after[0] as AgyMcpRegistration)) {
    throw new RouterError(
      "provider_unavailable",
      "agy MCP registration did not converge to exactly one canonical cmm-qoder-tools entry",
    );
  }

  canonicalizedThisProcess.add(key);
  const action: McpRegistrationAction =
    duplicates > 0
      ? "reconciled"
      : before.length === 0
        ? "added"
        : visibleCanonical
          ? "canonicalized"
          : "repaired";
  return { serverName, action, duplicates, before, after, commands };
}

/**
 * Startup-safe variant: performs the identical convergence but reports failures
 * (including duplicates) instead of throwing, so an audit at Router startup can
 * never take the Router down.
 */
export function reconcileAntigravityMcpRegistration(
  options: AntigravityMcpRegistrationOptions,
): McpRegistrationResult {
  const serverName = options.serverName ?? CMM_QODER_TOOLS_MCP_SERVER_NAME;
  try {
    return ensureAntigravityMcpRegistration(options);
  } catch (error) {
    return {
      serverName,
      action: "failed",
      duplicates: 0,
      before: [],
      after: [],
      commands: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
