/**
 * Variables that silently reroute subscription traffic to PAYG billing. They
 * are reserved: the PAYG guard refuses a config whose environment carries
 * them, and no provider manifest may claim one as its credential namespace.
 */
export const FORBIDDEN_PAYG_ENV_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

export function assertNoPaygFallback(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  const present = FORBIDDEN_PAYG_ENV_VARS.filter((key) => Boolean(env[key]));
  if (present.length > 0) {
    throw new Error(
      `PAYG fallback blocked; unset: ${present.join(", ")}`,
    );
  }
}
