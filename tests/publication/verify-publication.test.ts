import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { acquirePublicationMetaTestLock } from "./meta-test-lock.js";
const projectRoot = resolve(import.meta.dirname, "../..");
const verifyScript = join(
  projectRoot,
  "scripts/publication/verify-publication.sh",
);
const treeCli = join(projectRoot, "scripts/publication/lib/tree.mjs");
const roots: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "cmm-verify-publication-"));
  roots.push(root);
  return root;
}

async function makeSanitizedPublic(root: string) {
  const raw = join(root, "raw");
  const publicRepo = join(root, "public");
  const remote = join(root, "remote.git");
  const evidence = join(root, "evidence");

  await mkdir(raw, { recursive: true });
  await mkdir(publicRepo, { recursive: true });

  execFileSync(
    "rsync",
    [
      "-a",
      "--delete",
      "--exclude",
      ".git",
      "--exclude",
      "node_modules/",
      "--exclude",
      "dist/",
      `${projectRoot}/`,
      `${raw}/`,
    ],
    { stdio: "ignore" },
  );

  execFileSync("node", [treeCli, "sanitize", raw, publicRepo], {
    stdio: "ignore",
  });

  execFileSync("git", ["init", "--quiet", publicRepo]);
  git(publicRepo, "branch", "-M", "main");
  git(publicRepo, "config", "user.name", "CMM Routers Test");
  git(
    publicRepo,
    "config",
    "user.email",
    "123456+cmm-routers-test@users.noreply.github.com",
  );
  git(publicRepo, "add", "-A");
  git(publicRepo, "commit", "--quiet", "-m", "Initial sanitized public root");

  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  git(publicRepo, "remote", "add", "origin", remote);
  git(publicRepo, "push", "--quiet", "-u", "origin", "main");

  return { publicRepo, remote, evidence };
}

function invokeVerify(remote: string, expectedHead: string, evidence: string) {
  return spawnSync(
    "/bin/bash",
    [
      verifyScript,
      "--remote",
      remote,
      "--expected-head",
      expectedHead,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CMM_ROUTERS_EVIDENCE_DIR: evidence,
      },
    },
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const describeVerifyPublication =
  process.env.CMM_ROUTERS_PUBLICATION_CANDIDATE_VERIFY === "1" ||
  process.env.CMM_ROUTERS_PUBLICATION_FRESH_CLONE_VERIFY === "1"
    ? describe.skip
    : describe;

describeVerifyPublication("verify-publication", () => {
  let releasePublicationMetaTestLock: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    releasePublicationMetaTestLock =
      await acquirePublicationMetaTestLock();
  }, 310_000);

  afterAll(async () => {
    await releasePublicationMetaTestLock?.();
  });

  it("verifies a fresh sanitized public clone end to end", async () => {
    const root = await makeRoot();
    const fixture = await makeSanitizedPublic(root);
    const head = git(fixture.publicRepo, "rev-parse", "HEAD");

    const result = invokeVerify(fixture.remote, head, fixture.evidence);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("PUBLIC_REMOTE_HEAD_MATCH=PASS");
    expect(result.stdout).toContain(
      "PUBLIC_FRESH_CLONE_VERIFICATION=CLOSED_PASS",
    );
    expect(result.stdout).toContain("PUBLIC_RELEASE_REPRODUCIBLE=YES");

    const report = join(
      fixture.evidence,
      `CMM-Routers-publication-verify-${head.slice(0, 7)}.txt`,
    );
    expect(await readFile(report, "utf8")).toContain(
      "PUBLIC_RELEASE_REPRODUCIBLE=YES",
    );
    expect(await readFile(`${report}.sha256`, "utf8")).toMatch(
      /^[0-9a-f]{64}\s+/,
    );
  }, 120_000);

  it("fails closed when remote main is not the expected head", async () => {
    const root = await makeRoot();
    const fixture = await makeSanitizedPublic(root);

    const result = invokeVerify(
      fixture.remote,
      "a".repeat(40),
      fixture.evidence,
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "remote-head-mismatch",
    );
  });

  it("fails closed on non-noreply public history", async () => {
    const root = await makeRoot();
    const fixture = await makeSanitizedPublic(root);

    git(fixture.publicRepo, "config", "user.email", "publisher@example.com");
    await writeFile(join(fixture.publicRepo, "metadata.txt"), "bad metadata\n");
    git(fixture.publicRepo, "add", "metadata.txt");
    git(fixture.publicRepo, "commit", "--quiet", "-m", "Bad metadata commit");
    git(fixture.publicRepo, "push", "--quiet", "origin", "main");

    const head = git(fixture.publicRepo, "rev-parse", "HEAD");
    const result = invokeVerify(fixture.remote, head, fixture.evidence);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "public-history-non-noreply-metadata",
    );
  });

  it("fails closed on a merge commit in public history", async () => {
    const root = await makeRoot();
    const fixture = await makeSanitizedPublic(root);

    git(fixture.publicRepo, "checkout", "-q", "-b", "side");
    await writeFile(join(fixture.publicRepo, "side.txt"), "side\n");
    git(fixture.publicRepo, "add", "side.txt");
    git(fixture.publicRepo, "commit", "--quiet", "-m", "Side");

    git(fixture.publicRepo, "checkout", "-q", "main");
    await writeFile(join(fixture.publicRepo, "main.txt"), "main\n");
    git(fixture.publicRepo, "add", "main.txt");
    git(fixture.publicRepo, "commit", "--quiet", "-m", "Main");

    git(
      fixture.publicRepo,
      "merge",
      "--quiet",
      "--no-ff",
      "side",
      "-m",
      "Merge side",
    );
    git(fixture.publicRepo, "push", "--quiet", "origin", "main");

    const head = git(fixture.publicRepo, "rev-parse", "HEAD");
    const result = invokeVerify(fixture.remote, head, fixture.evidence);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "public-history-not-linear",
    );
  });

  it("fails closed on an unsanitized macOS home path in tracked content", async () => {
    const root = await makeRoot();
    const fixture = await makeSanitizedPublic(root);

    await writeFile(
      join(fixture.publicRepo, "privacy.txt"),
      "/Users/example/secret\n",
    );
    git(fixture.publicRepo, "add", "privacy.txt");
    git(fixture.publicRepo, "commit", "--quiet", "-m", "Privacy violation");
    git(fixture.publicRepo, "push", "--quiet", "origin", "main");

    const head = git(fixture.publicRepo, "rev-parse", "HEAD");
    const result = invokeVerify(fixture.remote, head, fixture.evidence);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("PUBLIC_CANDIDATE_PRIVACY_SCAN=FAIL");
    expect(result.stdout).not.toContain("private-user");
  });
});
