import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lockDir = join(tmpdir(), "cmm-routers-publication-meta-test.lock");

/**
 * A holder may run one full nested verification (see
 * `SERIAL_NESTED_VERIFICATION_BUDGET_MS`), so the stale threshold has to
 * outlast any live holder: breaking a live lock would let two nested
 * publication suites run at once, which is the contention the lock exists to
 * prevent. 20 min clears the outer nested budget of 10 min with room for the
 * rest of the holding file.
 */
export const PUBLICATION_META_TEST_LOCK_STALE_AFTER_MS = 20 * 60_000;

/**
 * How long a waiter may wait for the lock. Must exceed the longest legitimate
 * hold so a slow-but-live holder is waited out instead of failing the run.
 * Nested verification is serial and measured at 202-315s (plus surrounding
 * steps), so 15 min covers one full holder with margin; the previous 5 min was
 * sized for the ~60s parallel nested run and no longer fits.
 */
export const PUBLICATION_META_TEST_LOCK_WAIT_MS = 15 * 60_000;

const pollEveryMs = 100;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function acquirePublicationMetaTestLock(
  timeoutMs = PUBLICATION_META_TEST_LOCK_WAIT_MS,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, "owner"), `${process.pid}\n`, { encoding: "utf8" });

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }

    try {
      const info = await stat(lockDir);
      if (Date.now() - info.mtimeMs > PUBLICATION_META_TEST_LOCK_STALE_AFTER_MS) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }

    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for publication meta-test serialization lock");
    }

    await sleep(pollEveryMs);
  }
}
