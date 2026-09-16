/**
 * Budget for the outer publication meta-tests.
 *
 * `prepare-publication.test.ts` and `verify-publication.test.ts` each run a
 * full nested verification: npm ci, build, the nested test suite, typecheck,
 * and the security audit. The nested suite runs through the deterministic
 * serial command (`npm run test:serial`): serial execution removes scheduler
 * amplification but the suite still spawns real subprocesses, so it stays
 * load-sensitive.
 *
 * Measured nested-suite runtimes: 202s (157 files) and 259s/314s for the
 * 158-file tree on two consecutive runs of identical content — a ~21% spread.
 * With ~13s of surrounding steps, the whole body measured 281s and 344s.
 *
 * 600_000 ms keeps ~1.7x over the worst measurement while still failing a
 * genuinely hung publication flow. It replaces 120_000 ms, which cannot fit
 * deterministic verification at all.
 */
export const SERIAL_NESTED_VERIFICATION_BUDGET_MS = 600_000;
