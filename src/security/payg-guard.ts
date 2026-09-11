const forbidden = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

export function assertNoPaygFallback(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  const present = forbidden.filter((key) => Boolean(env[key]));
  if (present.length > 0) {
    throw new Error(
      `PAYG fallback blocked; unset: ${present.join(", ")}`,
    );
  }
}
