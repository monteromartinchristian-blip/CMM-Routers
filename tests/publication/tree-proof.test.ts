import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

async function loadTree() {
  return import("../../scripts/publication/lib/tree.mjs");
}

const roots: string[] = [];

async function makePair() {
  const root = await mkdtemp(join(tmpdir(), "cmm-public-tree-"));
  roots.push(root);
  const raw = join(root, "raw");
  const candidate = join(root, "candidate");
  await mkdir(raw, { recursive: true });
  return { raw, candidate };
}

async function writeRaw(root: string, relative: string, data: string | Buffer) {
  const target = join(root, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  return target;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("public candidate tree provenance", () => {
  it("accepts only policy-derived text differences", async () => {
    const { sanitizeCandidateTree, proveAllowedDifferences } = await loadTree();
    const { raw, candidate } = await makePair();

    await writeRaw(raw, "docs/a.md", "Path /Users/example/CMM-Routers  \n");

    const result = await sanitizeCandidateTree(raw, candidate);
    const proof = await proveAllowedDifferences(raw, candidate);

    expect(result.files).toBe(1);
    expect(result.transformedFiles).toBe(1);
    expect(result.events["macos-home-path"]).toBe(1);
    expect(result.events["trailing-whitespace"]).toBe(1);
    expect(await readFile(join(candidate, "docs/a.md"), "utf8")).toBe(
      "Path /Users/example/CMM-Routers\n",
    );

    expect(proof).toMatchObject({
      sameFileSet: true,
      binaryDifferences: 0,
      canonicalTextDifferences: 0,
      unexplainedDifferences: [],
    });
  });

  it("rejects a candidate-only file", async () => {
    const { sanitizeCandidateTree, proveAllowedDifferences } = await loadTree();
    const { raw, candidate } = await makePair();

    await writeRaw(raw, "a.txt", "source\n");
    await sanitizeCandidateTree(raw, candidate);
    await writeRaw(candidate, "extra.txt", "not from source\n");

    const proof = await proveAllowedDifferences(raw, candidate);

    expect(proof.sameFileSet).toBe(false);
    expect(proof.unexplainedDifferences).toContain("extra:extra.txt");
  });

  it("rejects a missing candidate file", async () => {
    const { sanitizeCandidateTree, proveAllowedDifferences } = await loadTree();
    const { raw, candidate } = await makePair();

    await writeRaw(raw, "a.txt", "source\n");
    await writeRaw(raw, "b.txt", "source\n");
    await sanitizeCandidateTree(raw, candidate);
    await rm(join(candidate, "b.txt"));

    const proof = await proveAllowedDifferences(raw, candidate);

    expect(proof.sameFileSet).toBe(false);
    expect(proof.unexplainedDifferences).toContain("missing:b.txt");
  });

  it("rejects unexplained binary mutation", async () => {
    const { sanitizeCandidateTree, proveAllowedDifferences } = await loadTree();
    const { raw, candidate } = await makePair();

    await writeRaw(raw, "fixture.bin", Buffer.from([1, 2, 3, 0]));
    await sanitizeCandidateTree(raw, candidate);
    await writeFile(join(candidate, "fixture.bin"), Buffer.from([1, 9, 3, 0]));

    const proof = await proveAllowedDifferences(raw, candidate);

    expect(proof.binaryDifferences).toBe(1);
    expect(proof.unexplainedDifferences).toContain("binary:fixture.bin");
  });

  it("rejects unexplained textual mutation after sanitization", async () => {
    const { sanitizeCandidateTree, proveAllowedDifferences } = await loadTree();
    const { raw, candidate } = await makePair();

    await writeRaw(raw, "docs/a.md", "Path /Users/example/CMM-Routers\n");
    await sanitizeCandidateTree(raw, candidate);
    await writeFile(join(candidate, "docs/a.md"), "manual public edit\n");

    const proof = await proveAllowedDifferences(raw, candidate);

    expect(proof.canonicalTextDifferences).toBe(1);
    expect(proof.unexplainedDifferences).toContain("text:docs/a.md");
  });

  it("preserves binary bytes and executable mode", async () => {
    const { sanitizeCandidateTree } = await loadTree();
    const { raw, candidate } = await makePair();

    const rawBin = await writeRaw(raw, "bin/tool", Buffer.from([1, 2, 0, 255]));
    await chmod(rawBin, 0o755);

    await sanitizeCandidateTree(raw, candidate);

    const candidateBin = join(candidate, "bin/tool");
    expect(await readFile(candidateBin)).toEqual(Buffer.from([1, 2, 0, 255]));
    expect((await lstat(candidateBin)).mode & 0o111).not.toBe(0);
  });

  it("copies symlinks as symlinks without following their targets", async () => {
    const { sanitizeCandidateTree, proveAllowedDifferences } = await loadTree();
    const { raw, candidate } = await makePair();

    await writeRaw(raw, "inside.txt", "inside\n");
    await symlink("../outside-do-not-follow", join(raw, "outside-link"));

    await sanitizeCandidateTree(raw, candidate);

    const linkPath = join(candidate, "outside-link");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(linkPath)).toBe("../outside-do-not-follow");

    const proof = await proveAllowedDifferences(raw, candidate);
    expect(proof.unexplainedDifferences).toEqual([]);
  });

  it("rejects symlink-target mutation", async () => {
    const { sanitizeCandidateTree, proveAllowedDifferences } = await loadTree();
    const { raw, candidate } = await makePair();

    await writeRaw(raw, "inside.txt", "inside\n");
    await symlink("inside.txt", join(raw, "current"));
    await sanitizeCandidateTree(raw, candidate);

    await rm(join(candidate, "current"));
    await symlink("different.txt", join(candidate, "current"));

    const proof = await proveAllowedDifferences(raw, candidate);

    expect(proof.unexplainedDifferences).toContain("symlink:current");
  });

  it("returns stable byte-sorted relative paths", async () => {
    const { listTreeFiles } = await loadTree();
    const { raw } = await makePair();

    await writeRaw(raw, "z.txt", "z\n");
    await writeRaw(raw, "a/b.txt", "b\n");
    await writeRaw(raw, "a/a.txt", "a\n");

    expect(await listTreeFiles(raw)).toEqual(["a/a.txt", "a/b.txt", "z.txt"]);
  });
});
