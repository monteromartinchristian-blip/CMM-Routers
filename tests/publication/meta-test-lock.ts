import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lockDir = join(tmpdir(), "cmm-routers-publication-meta-test.lock");
const staleAfterMs = 10 * 60_000;
const pollEveryMs = 100;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function acquirePublicationMetaTestLock(
  timeoutMs = 5 * 60_000,
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
      if (Date.now() - info.mtimeMs > staleAfterMs) {
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
