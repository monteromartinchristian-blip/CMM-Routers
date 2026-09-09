import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Absolute path to isolated Claude configuration directory.
 * This ensures the router's Claude profile is completely separate from
 * the user's normal ~/.claude and any OmniRoute configuration.
 * An explicit CMM_CLAUDE_PROFILE_DIR override (set only from the router's
 * own config profileDir) may relocate it; the default never moves.
 */
export const CLAUDE_CONFIG_DIR =
  process.env.CMM_CLAUDE_PROFILE_DIR ??
  join(
    process.env.HOME || "~",
    "Library",
    "Application Support",
    "CMM",
    "SubscriptionRouter",
    "Claude",
  );

/**
 * Neutral working directory for Claude operations.
 * Prevents inheritance of project-level .claude settings.
 */
export const NEUTRAL_CWD = join(tmpdir(), "cmm-claude-neutral");

/**
 * Build an isolated environment for the Claude Agent SDK.
 *
 * This function creates a sanitized environment that:
 * 1. Sets a dedicated config directory (CLAUDE_CONFIG_DIR)
 * 2. Removes ALL Anthropic API/PAYG-related variables
 * 3. Uses a neutral working directory
 * 4. Preserves only safe, necessary environment variables
 *
 * IMPORTANT: The Agent SDK's options.env semantics may REPLACE rather than
 * merge the subprocess environment in current versions. We construct a
 * complete allowlisted environment rather than trying to delete specific keys.
 */
export function buildIsolatedEnvironment(): Record<string, string> {
  // Ensure config directory exists
  try {
    mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  } catch {
    // Directory creation may fail in some environments; continue anyway
  }

  // Ensure neutral CWD exists
  try {
    mkdirSync(NEUTRAL_CWD, { recursive: true });
  } catch {
    // Continue if directory creation fails
  }

  // Allowlisted environment variables that are safe to preserve
  const ALLOWED_VARS = [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "NODE_ENV",
  ];

  const env: Record<string, string> = {};

  // Copy only allowed variables from parent environment
  for (const key of ALLOWED_VARS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Set Claude-specific isolation variables
  env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;
  env.PWD = NEUTRAL_CWD;

  // Explicitly ensure NO Anthropic API/PAYG variables are present
  // (They won't be because we're building from scratch, but this documents intent)
  // Forbidden: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, etc.

  return env;
}
