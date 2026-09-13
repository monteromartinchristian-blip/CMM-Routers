import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const assets = [
  ["src/usage/storage/schema/001_initial.sql", "dist/usage/storage/schema/001_initial.sql"],
];

for (const [source, destination] of assets) {
  const target = resolve(destination);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(source), target);
}
