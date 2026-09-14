import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const assets = [
  ["src/usage/storage/schema/001_initial.sql", "dist/usage/storage/schema/001_initial.sql"],
  [
    "src/usage/storage/schema/002_scrub_legacy_openrouter_key_buckets.sql",
    "dist/usage/storage/schema/002_scrub_legacy_openrouter_key_buckets.sql",
  ],
];

for (const [source, destination] of assets) {
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(source), target);
}
