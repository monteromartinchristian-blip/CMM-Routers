import { copyFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const sourceSchemaDir = resolve("src/usage/storage/schema");
const destinationSchemaDir = resolve("dist/usage/storage/schema");

await mkdir(destinationSchemaDir, { recursive: true });

const migrations = (await readdir(sourceSchemaDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name)
  .sort();

for (const filename of migrations) {
  await copyFile(
    resolve(sourceSchemaDir, filename),
    resolve(destinationSchemaDir, filename),
  );
}
