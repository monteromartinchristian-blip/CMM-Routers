import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isProbablyText, sanitizeText } from "./policy.mjs";

function byteSort(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function normalizeRelative(path) {
  return path.split(sep).join("/");
}

function resolveWithin(root, relativePath) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, relativePath);
  const rel = relative(absoluteRoot, absolute);

  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")) {
    return absolute;
  }

  throw new Error(`path escapes tree root: ${relativePath}`);
}

async function walk(root, current = "") {
  const directory = resolveWithin(root, current || ".");
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => byteSort(a.name, b.name));

  const files = [];

  for (const entry of entries) {
    const relativePath = normalizeRelative(join(current, entry.name));
    const absolute = resolveWithin(root, relativePath);
    const stat = await lstat(absolute);

    if (stat.isDirectory()) {
      files.push(...(await walk(root, relativePath)));
      continue;
    }

    if (stat.isFile() || stat.isSymbolicLink()) {
      files.push(relativePath);
      continue;
    }

    throw new Error(`unsupported filesystem entry: ${relativePath}`);
  }

  return files;
}

export async function hashFile(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

export async function listTreeFiles(root) {
  const files = await walk(root);
  return files.sort(byteSort);
}

function addEvents(target, events) {
  for (const event of events) {
    target[event.rule] = (target[event.rule] ?? 0) + event.count;
  }
}

export async function sanitizeCandidateTree(rawRoot, candidateRoot) {
  await rm(candidateRoot, { recursive: true, force: true });
  await mkdir(candidateRoot, { recursive: true });

  const files = await listTreeFiles(rawRoot);
  let transformedFiles = 0;
  const events = {};

  for (const relativePath of files) {
    const rawPath = resolveWithin(rawRoot, relativePath);
    const candidatePath = resolveWithin(candidateRoot, relativePath);
    const stat = await lstat(rawPath);

    await mkdir(dirname(candidatePath), { recursive: true });

    if (stat.isSymbolicLink()) {
      await symlink(await readlink(rawPath), candidatePath);
      continue;
    }

    if (!stat.isFile()) {
      throw new Error(`unsupported filesystem entry: ${relativePath}`);
    }

    const raw = await readFile(rawPath);

    if (!isProbablyText(raw)) {
      await writeFile(candidatePath, raw);
      await chmod(candidatePath, stat.mode & 0o777);
      continue;
    }

    const rawText = raw.toString("utf8");
    const sanitized = sanitizeText(rawText);
    const output = Buffer.from(sanitized.text, "utf8");

    if (!raw.equals(output)) {
      transformedFiles += 1;
    }

    addEvents(events, sanitized.events);
    await writeFile(candidatePath, output);
    await chmod(candidatePath, stat.mode & 0o777);
  }

  return {
    files: files.length,
    transformedFiles,
    events,
  };
}

export async function proveAllowedDifferences(rawRoot, candidateRoot) {
  const rawFiles = await listTreeFiles(rawRoot);
  const candidateFiles = await listTreeFiles(candidateRoot);
  const rawSet = new Set(rawFiles);
  const candidateSet = new Set(candidateFiles);

  const unexplainedDifferences = [];

  for (const path of rawFiles) {
    if (!candidateSet.has(path)) {
      unexplainedDifferences.push(`missing:${path}`);
    }
  }

  for (const path of candidateFiles) {
    if (!rawSet.has(path)) {
      unexplainedDifferences.push(`extra:${path}`);
    }
  }

  let binaryDifferences = 0;
  let canonicalTextDifferences = 0;

  for (const relativePath of rawFiles) {
    if (!candidateSet.has(relativePath)) {
      continue;
    }

    const rawPath = resolveWithin(rawRoot, relativePath);
    const candidatePath = resolveWithin(candidateRoot, relativePath);
    const rawStat = await lstat(rawPath);
    const candidateStat = await lstat(candidatePath);

    if (rawStat.isSymbolicLink() || candidateStat.isSymbolicLink()) {
      if (!(rawStat.isSymbolicLink() && candidateStat.isSymbolicLink())) {
        unexplainedDifferences.push(`type:${relativePath}`);
        continue;
      }

      if ((await readlink(rawPath)) !== (await readlink(candidatePath))) {
        unexplainedDifferences.push(`symlink:${relativePath}`);
      }
      continue;
    }

    if (!(rawStat.isFile() && candidateStat.isFile())) {
      unexplainedDifferences.push(`type:${relativePath}`);
      continue;
    }

    const raw = await readFile(rawPath);
    const candidate = await readFile(candidatePath);

    if (!isProbablyText(raw)) {
      if (!raw.equals(candidate)) {
        binaryDifferences += 1;
        unexplainedDifferences.push(`binary:${relativePath}`);
      }
      continue;
    }

    const expected = Buffer.from(sanitizeText(raw.toString("utf8")).text, "utf8");
    if (!expected.equals(candidate)) {
      canonicalTextDifferences += 1;
      unexplainedDifferences.push(`text:${relativePath}`);
    }

    if ((rawStat.mode & 0o111) !== (candidateStat.mode & 0o111)) {
      unexplainedDifferences.push(`mode:${relativePath}`);
    }
  }

  unexplainedDifferences.sort(byteSort);

  return {
    sameFileSet:
      rawFiles.length === candidateFiles.length &&
      rawFiles.every((path, index) => path === candidateFiles[index]),
    binaryDifferences,
    canonicalTextDifferences,
    unexplainedDifferences,
  };
}

async function main() {
  const [command, rawRoot, candidateRoot] = process.argv.slice(2);

  if (!command) {
    return;
  }

  if (!rawRoot || !candidateRoot) {
    throw new Error("usage: tree.mjs <sanitize|prove> <raw-root> <candidate-root>");
  }

  if (command === "sanitize") {
    const result = await sanitizeCandidateTree(rawRoot, candidateRoot);
    console.log(`TREE_SANITIZE_FILES=${result.files}`);
    console.log(`TREE_SANITIZE_TRANSFORMED_FILES=${result.transformedFiles}`);
    console.log(`TREE_SANITIZE_EVENTS=${JSON.stringify(result.events)}`);
    console.log("TREE_SANITIZE_STATUS=PASS");
    return;
  }

  if (command === "prove") {
    const proof = await proveAllowedDifferences(rawRoot, candidateRoot);
    console.log(`TREE_PROOF_SAME_FILE_SET=${proof.sameFileSet ? "PASS" : "FAIL"}`);
    console.log(`TREE_PROOF_BINARY_DIFFERENCES=${proof.binaryDifferences}`);
    console.log(
      `TREE_PROOF_CANONICAL_TEXT_DIFFERENCES=${proof.canonicalTextDifferences}`,
    );
    console.log(
      `TREE_PROOF_UNEXPLAINED_DIFFERENCES=${proof.unexplainedDifferences.length}`,
    );

    if (
      !proof.sameFileSet ||
      proof.binaryDifferences !== 0 ||
      proof.canonicalTextDifferences !== 0 ||
      proof.unexplainedDifferences.length !== 0
    ) {
      process.exitCode = 2;
      return;
    }

    console.log("PUBLIC_CANDIDATE_ALLOWED_TRANSFORM_ONLY=PASS");
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`TREE_POLICY_ERROR=${error instanceof Error ? error.message : "unknown"}`);
    process.exitCode = 1;
  });
}
