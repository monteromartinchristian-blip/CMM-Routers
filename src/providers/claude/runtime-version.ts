import { readFileSync } from "node:fs";

/**
 * The Claude Code runtime this Router actually runs.
 *
 * The Agent SDK bundles its own CLI and executes that binary, not whatever
 * `claude` happens to be on PATH. The account's catalog states the oldest
 * runtime that can serve each model, so knowing this version is what lets the
 * catalog tell "the account knows this model" from "this Router can run it".
 *
 * Read from the SDK's own manifest, which is the artifact the runtime is
 * launched from. An unreadable manifest is an honest unknown ("0.0.0"), which
 * makes every version-gated model unavailable rather than falsely available.
 */
export function claudeRuntimeVersion(): string {
  try {
    const manifestPath = new URL(
      "../../../node_modules/@anthropic-ai/claude-agent-sdk/manifest.json",
      import.meta.url,
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version?: string;
    };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}