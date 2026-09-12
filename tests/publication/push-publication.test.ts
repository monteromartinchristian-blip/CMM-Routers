import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const pushScript = join(projectRoot, "scripts/publication/push-publication.sh");
const roots: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function remoteHead(remote: string) {
  const output = execFileSync(
    "git",
    ["ls-remote", "--heads", remote, "refs/heads/main"],
    { encoding: "utf8" },
  ).trim();

  return output ? output.split(/\s+/)[0] : "";
}

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "cmm-push-publication-"));
  roots.push(root);
  return root;
}

async function makePreparedPublic(
  root: string,
  options: { preparedEmail?: string } = {},
) {
  const publicRepo = join(root, "public");
  const remote = join(root, "remote.git");
  const evidence = join(root, "evidence");

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
  const predecessor = git(publicRepo, "rev-parse", "HEAD");

  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  git(publicRepo, "remote", "add", "origin", remote);
  git(publicRepo, "push", "--quiet", "-u", "origin", "main");

  if (options.preparedEmail) {
    git(publicRepo, "config", "user.email", options.preparedEmail);
  }

  await writeFile(join(publicRepo, "release.txt"), "prepared\n");
  git(publicRepo, "add", "release.txt");
  git(publicRepo, "commit", "--quiet", "-m", "Prepared public release");
  const head = git(publicRepo, "rev-parse", "HEAD");

  return { publicRepo, remote, evidence, predecessor, head };
}

function invokePush(params: {
  publicRepo: string;
  head: string;
  predecessor: string;
  evidence: string;
  env?: NodeJS.ProcessEnv;
}) {
  return spawnSync(
    "/bin/bash",
    [
      pushScript,
      "--public-staging",
      params.publicRepo,
      "--expected-head",
      params.head,
      "--expected-remote-predecessor",
      params.predecessor,
      "--transport",
      "origin",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CMM_ROUTERS_EVIDENCE_DIR: params.evidence,
        ...params.env,
      },
    },
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("push-publication", () => {
  it("pushes exactly the approved prepared commit to a local bare remote", async () => {
    const root = await makeRoot();
    const fixture = await makePreparedPublic(root);
    const originBefore = git(fixture.publicRepo, "remote", "get-url", "origin");

    const result = invokePush({
      publicRepo: fixture.publicRepo,
      head: fixture.head,
      predecessor: fixture.predecessor,
      evidence: fixture.evidence,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("PUBLIC_PUSH_STATUS=CLOSED_PASS");
    expect(result.stdout).toContain("PUBLIC_REMOTE_UPDATED=YES");
    expect(result.stdout).toContain("FORCE_PUSH=NO");
    expect(result.stdout).toContain("PUSH_RETRY=NO");
    expect(remoteHead(fixture.remote)).toBe(fixture.head);
    expect(git(fixture.publicRepo, "remote", "get-url", "origin")).toBe(
      originBefore,
    );
  });

  it("fails closed on the wrong expected local head without remote mutation", async () => {
    const root = await makeRoot();
    const fixture = await makePreparedPublic(root);

    const result = invokePush({
      publicRepo: fixture.publicRepo,
      head: "a".repeat(40),
      predecessor: fixture.predecessor,
      evidence: fixture.evidence,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "local-head-mismatch",
    );
    expect(remoteHead(fixture.remote)).toBe(fixture.predecessor);
  });

  it("fails closed on the wrong expected remote predecessor without mutation", async () => {
    const root = await makeRoot();
    const fixture = await makePreparedPublic(root);

    const result = invokePush({
      publicRepo: fixture.publicRepo,
      head: fixture.head,
      predecessor: "b".repeat(40),
      evidence: fixture.evidence,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "remote-predecessor-mismatch",
    );
    expect(remoteHead(fixture.remote)).toBe(fixture.predecessor);
  });

  it("fails closed on a dirty public staging worktree", async () => {
    const root = await makeRoot();
    const fixture = await makePreparedPublic(root);
    await writeFile(join(fixture.publicRepo, "dirty.txt"), "dirty\n");

    const result = invokePush({
      publicRepo: fixture.publicRepo,
      head: fixture.head,
      predecessor: fixture.predecessor,
      evidence: fixture.evidence,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "public-staging-dirty",
    );
    expect(remoteHead(fixture.remote)).toBe(fixture.predecessor);
  });

  it("fails closed on non-noreply public commit metadata", async () => {
    const root = await makeRoot();
    const fixture = await makePreparedPublic(root, {
      preparedEmail: "publisher@example.com",
    });

    const result = invokePush({
      publicRepo: fixture.publicRepo,
      head: fixture.head,
      predecessor: fixture.predecessor,
      evidence: fixture.evidence,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "public-history-non-noreply-metadata",
    );
    expect(remoteHead(fixture.remote)).toBe(fixture.predecessor);
  });

  it("treats a push command error as success only when remote already reached expected head", async () => {
    const root = await makeRoot();
    const fixture = await makePreparedPublic(root);
    const wrapper = join(root, "wrapper");
    const countFile = join(root, "push-count.txt");
    await mkdir(wrapper);

    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const gitWrapper = join(wrapper, "git");

    await writeFile(
      gitWrapper,
      `#!/bin/sh
if [ "$1" = "push" ]; then
  count=0
  [ ! -f "$GIT_WRAPPER_COUNT" ] || count="$(cat "$GIT_WRAPPER_COUNT")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$GIT_WRAPPER_COUNT"
  "$REAL_GIT" "$@"
  rc=$?
  [ "$rc" -eq 0 ] || exit "$rc"
  exit 42
fi
exec "$REAL_GIT" "$@"
`,
    );
    await chmod(gitWrapper, 0o755);

    const result = invokePush({
      publicRepo: fixture.publicRepo,
      head: fixture.head,
      predecessor: fixture.predecessor,
      evidence: fixture.evidence,
      env: {
        PATH: `${wrapper}:${process.env.PATH ?? ""}`,
        REAL_GIT: realGit,
        GIT_WRAPPER_COUNT: countFile,
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "PUBLIC_PUSH_COMMAND_ERROR_REMOTE_CONFIRMED=YES",
    );
    expect(remoteHead(fixture.remote)).toBe(fixture.head);
    expect((await readFile(countFile, "utf8")).trim()).toBe("1");
  });

  it("never retries an errored push when the remote did not change", async () => {
    const root = await makeRoot();
    const fixture = await makePreparedPublic(root);
    const wrapper = join(root, "wrapper");
    const countFile = join(root, "push-count.txt");
    await mkdir(wrapper);

    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const gitWrapper = join(wrapper, "git");

    await writeFile(
      gitWrapper,
      `#!/bin/sh
if [ "$1" = "push" ]; then
  count=0
  [ ! -f "$GIT_WRAPPER_COUNT" ] || count="$(cat "$GIT_WRAPPER_COUNT")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$GIT_WRAPPER_COUNT"
  exit 42
fi
exec "$REAL_GIT" "$@"
`,
    );
    await chmod(gitWrapper, 0o755);

    const result = invokePush({
      publicRepo: fixture.publicRepo,
      head: fixture.head,
      predecessor: fixture.predecessor,
      evidence: fixture.evidence,
      env: {
        PATH: `${wrapper}:${process.env.PATH ?? ""}`,
        REAL_GIT: realGit,
        GIT_WRAPPER_COUNT: countFile,
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "push-command-failed-remote-not-updated",
    );
    expect(remoteHead(fixture.remote)).toBe(fixture.predecessor);
    expect((await readFile(countFile, "utf8")).trim()).toBe("1");
  });

  it("contains no force-push flags or force refspec", async () => {
    const source = await readFile(pushScript, "utf8");
    expect(source).not.toMatch(/--force(?:-with-lease)?/);
    expect(source).not.toMatch(/\+refs\/heads\/main/);
  });
});
