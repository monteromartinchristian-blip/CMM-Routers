import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { acquirePublicationMetaTestLock } from "./meta-test-lock.js";
const projectRoot = resolve(import.meta.dirname, "../..");
const prepareScript = join(
  projectRoot,
  "scripts/publication/prepare-publication.sh",
);
const policyCli = join(projectRoot, "scripts/publication/lib/policy.mjs");

const roots: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return spawnSync(file, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
  });
}

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "cmm-prepare-publication-"));
  roots.push(root);
  return root;
}

async function cloneInternal(root: string) {
  const internal = join(root, "internal");
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", projectRoot, internal]);
  return internal;
}

async function makePublic(root: string) {
  const publicRepo = join(root, "public");
  const remote = join(root, "remote.git");

  execFileSync("git", ["init", "--quiet", publicRepo]);
  git(publicRepo, "branch", "-M", "main");
  git(publicRepo, "config", "user.name", "CMM Routers Test");
  git(
    publicRepo,
    "config",
    "user.email",
    "123456+cmm-routers-test@users.noreply.github.com",
  );

  await writeFile(join(publicRepo, "README.md"), "# Public root\n");
  git(publicRepo, "add", "README.md");
  git(publicRepo, "commit", "--quiet", "-m", "Initial public root");

  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  git(publicRepo, "remote", "add", "origin", remote);
  git(publicRepo, "push", "--quiet", "-u", "origin", "main");

  return {
    publicRepo,
    remote,
    predecessor: git(publicRepo, "rev-parse", "HEAD"),
  };
}

function invokePrepare(params: {
  internal: string;
  publicRepo: string;
  sourceSha: string;
  evidenceDir: string;
  message?: string;
}) {
  return run(
    "/bin/bash",
    [
      prepareScript,
      "--internal-repo",
      params.internal,
      "--public-staging",
      params.publicRepo,
      "--source-sha",
      params.sourceSha,
      "--message",
      params.message ?? "Public test release",
    ],
    {
      env: {
        CMM_ROUTERS_EVIDENCE_DIR: params.evidenceDir,
      },
    },
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const describePreparePublication =
  process.env.CMM_ROUTERS_PUBLICATION_CANDIDATE_VERIFY === "1" ||
  process.env.CMM_ROUTERS_PUBLICATION_FRESH_CLONE_VERIFY === "1"
    ? describe.skip
    : describe;

describePreparePublication("prepare-publication", () => {
  let releasePublicationMetaTestLock: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    releasePublicationMetaTestLock =
      await acquirePublicationMetaTestLock();
  }, 310_000);

  afterAll(async () => {
    await releasePublicationMetaTestLock?.();
  });

  it("policy CLI scans a tree and fails closed on an unsanitized home path", async () => {
    const root = await makeRoot();
    const tree = join(root, "tree");
    execFileSync("mkdir", ["-p", tree]);
    await writeFile(join(tree, "a.txt"), "Path: /Users/example/project\n");

    const result = run("node", [policyCli, "scan-tree", tree]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("PUBLIC_CANDIDATE_PRIVACY_SCAN=FAIL");
    expect(result.stdout).not.toContain("private-user");
  });

  it(
    "creates an unrelated public descendant, sanitizes content, and stops before push",
    async () => {
      const root = await makeRoot();
      const internal = await cloneInternal(root);
      const { publicRepo, remote, predecessor } = await makePublic(root);
      const evidenceDir = join(root, "evidence");
      const sourceSha = git(internal, "rev-parse", "HEAD");

      const result = invokePrepare({
        internal,
        publicRepo,
        sourceSha,
        evidenceDir,
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(
        "PUBLICATION_PREPARE_STATUS=READY_FOR_EXPLICIT_PUSH_APPROVAL",
      );
      expect(result.stdout).toContain("PUSH_PERFORMED=NO");
      expect(result.stdout).toContain("INTERNAL_GIT_ANCESTRY_IMPORTED=NO");

      const prepared = git(publicRepo, "rev-parse", "HEAD");
      expect(prepared).not.toBe(predecessor);
      expect(git(publicRepo, "rev-parse", "HEAD^")).toBe(predecessor);
      expect(git(publicRepo, "rev-list", "--count", "HEAD")).toBe("2");

      const remoteHead = execFileSync(
        "git",
        ["ls-remote", "--heads", remote, "refs/heads/main"],
        { encoding: "utf8" },
      )
        .trim()
        .split(/\s+/)[0];

      expect(remoteHead).toBe(predecessor);
      expect(git(publicRepo, "status", "--porcelain")).toBe("");
      expect(git(publicRepo, "log", "--format=%H")).not.toContain(sourceSha);

      const plan = await readFile(
        join(
          publicRepo,
          "docs/superpowers/plans/2026-09-11-cmm-routers-publication-pipeline.md",
        ),
        "utf8",
      );
      expect(plan).not.toMatch(/\/Users\/(?!example\/)[^/\s]+\//);
    },
    120_000,
  );

  it("fails closed when the internal worktree is dirty", async () => {
    const root = await makeRoot();
    const internal = await cloneInternal(root);
    const { publicRepo } = await makePublic(root);
    await writeFile(join(internal, "dirty.txt"), "dirty\n");

    const result = invokePrepare({
      internal,
      publicRepo,
      sourceSha: git(internal, "rev-parse", "HEAD"),
      evidenceDir: join(root, "evidence"),
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "internal-worktree-dirty",
    );
  });

  it("fails closed when public staging is dirty", async () => {
    const root = await makeRoot();
    const internal = await cloneInternal(root);
    const { publicRepo } = await makePublic(root);
    await writeFile(join(publicRepo, "dirty.txt"), "dirty\n");

    const result = invokePrepare({
      internal,
      publicRepo,
      sourceSha: git(internal, "rev-parse", "HEAD"),
      evidenceDir: join(root, "evidence"),
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "public-staging-dirty",
    );
  });

  it("fails closed when origin/main is not the public staging predecessor", async () => {
    const root = await makeRoot();
    const internal = await cloneInternal(root);
    const { publicRepo } = await makePublic(root);

    await writeFile(join(publicRepo, "local-only.txt"), "local\n");
    git(publicRepo, "add", "local-only.txt");
    git(publicRepo, "commit", "--quiet", "-m", "Local divergent commit");

    const result = invokePrepare({
      internal,
      publicRepo,
      sourceSha: git(internal, "rev-parse", "HEAD"),
      evidenceDir: join(root, "evidence"),
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "remote-predecessor-mismatch",
    );
  });

  it("blocks a high-confidence secret before public staging mutation", async () => {
    const root = await makeRoot();
    const internal = await cloneInternal(root);
    const { publicRepo, predecessor } = await makePublic(root);

    await writeFile(
      join(internal, "docs-secret-fixture.txt"),
      "credential=sk-" + "q".repeat(40) + "\n",
    );
    git(internal, "add", "docs-secret-fixture.txt");
    git(internal, "config", "user.name", "Internal Test");
    git(
      internal,
      "config",
      "user.email",
      "internal-test@users.noreply.github.com",
    );
    git(internal, "commit", "--quiet", "-m", "test secret blocker");
    const secretSha = git(internal, "rev-parse", "HEAD");

    const result = invokePrepare({
      internal,
      publicRepo,
      sourceSha: secretSha,
      evidenceDir: join(root, "evidence"),
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "PUBLIC_CANDIDATE_PRIVACY_SCAN=FAIL",
    );
    expect(git(publicRepo, "rev-parse", "HEAD")).toBe(predecessor);
  });
});
