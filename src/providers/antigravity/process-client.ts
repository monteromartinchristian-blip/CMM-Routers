import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AGY_PATH = join(homedir(), ".local", "bin", "agy");
export const AGY_VERSION = "1.1.16";

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

export function buildAgyChildEnv(): Record<string, string> {
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
