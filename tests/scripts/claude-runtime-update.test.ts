import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end tests for the Claude runtime updater.
 *
 * Every external effect is isolated: a throwaway Git repository, stub
 * `npm`/`launchctl`/`lsof`/`security`/`openssl`, and two local fake Routers
 * (canary + live). Nothing touches the real LaunchAgent, Keychain or Router.
 */

// These tests start real local processes; under a loaded full suite they need
// more than the default 5 s.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const REPO = join(import.meta.dirname, "../..");
const SCRIPT = join(REPO, "scripts/macos/update-claude-runtime.sh");
const ARCH = execFileSync("uname", ["-m"], { encoding: "utf-8" }).trim();
const PLATFORM = `darwin-${ARCH}`;

interface Sandbox {
  root: string;
  repo: string;
  stub: string;
  log: string;
  testPort: number;
  livePort: number;
  live?: ChildProcess;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function write(path: string, content: string, mode = 0o644): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, { mode });
}

function stub(path: string, body: string): void {
  write(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`, 0o755);
}

const FAKE_ROUTER = `
import http from "node:http";
const port = Number(process.argv[2]);
const mode = process.env.FAKE_ROUTER_MODE || "ok";
const token = process.env.CMM_ROUTER_TOKEN || "";
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
http
  .createServer((req, res) => {
    const url = req.url || "/";
    if (url === "/health") return json(res, 200, { status: "ok" });
    if (url === "/ready") {
      if (mode === "fail-ready") return json(res, 503, { status: "not_ready" });
      return json(res, 200, { status: "ready" });
    }
    if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
      if (!req.headers.authorization) return json(res, 401, { error: { type: "router_unauthorized" } });
      return json(res, 200, { choices: [] });
    }
    if (url === "/v1/models") {
      if (req.headers.authorization !== "Bearer " + token) return json(res, 401, {});
      const data =
        mode === "empty-catalog"
          ? []
          : [
              { id: "claude/claude-sonnet-5", availability: "available" },
              { id: "claude/claude-opus-5-5", availability: "available" },
              { id: "claude/sonnet", isAlias: true, availability: "available" },
            ];
      return json(res, 200, { object: "list", data });
    }
    return json(res, 404, {});
  })
  .listen(port, "127.0.0.1");
`;

function pickPorts(): { testPort: number; livePort: number } {
  const base = 20000 + Math.floor(Math.random() * 20000);
  return { testPort: base, livePort: base + 1 };
}

function makeSandbox(options: { latest?: string; runtime?: string; policy?: string } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "cmm-runtime-update-"));
  const repo = join(root, "repo");
  const stubDir = join(root, "stub");
  const log = join(root, "logs");
  const { testPort, livePort } = pickPorts();
  mkdirSync(join(repo, "scripts/macos"), { recursive: true });
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(log, { recursive: true });

  const latest = options.latest ?? "0.3.317";
  const runtime = options.runtime ?? "2.1.317";

  // Real updater under test.
  cpSync(SCRIPT, join(repo, "scripts/macos/update-claude-runtime.sh"));
  chmodSync(join(repo, "scripts/macos/update-claude-runtime.sh"), 0o755);

  // Fake production entrypoint used by the canary.
  write(join(repo, "scripts/macos/fake-router.mjs"), FAKE_ROUTER);
  write(
    join(repo, "scripts/macos/run-router.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
CONF="\${CMM_CONFIG_DIR:?}"
PORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("port",0))' "$CONF/shared.json")"
exec node "$(dirname "$0")/fake-router.mjs" "$PORT"
`,
    0o755,
  );

  write(
    join(repo, "package.json"),
    JSON.stringify(
      {
        name: "fake-router",
        private: true,
        type: "module",
        dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.316" },
        scripts: { typecheck: "true", build: "true", test: "true" },
      },
      null,
      2,
    ) + "\n",
  );
  write(
    join(repo, "package-lock.json"),
    JSON.stringify(
      {
        name: "fake-router",
        lockfileVersion: 3,
        packages: {
          "": { name: "fake-router", dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.316" } },
          "node_modules/@anthropic-ai/claude-agent-sdk": {
            version: "0.3.316",
            integrity: "sha512-CURRENT",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
  write(
    join(repo, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.316" }),
  );
  write(
    join(repo, "node_modules/@anthropic-ai/claude-agent-sdk/manifest.json"),
    JSON.stringify({
      version: "2.1.316",
      platforms: { [PLATFORM]: { binary: "claude", checksum: "a".repeat(64), size: 1 } },
    }),
  );
  write(join(repo, "dist/index.js"), "// built\n");
  write(
    join(repo, "config/shared.json"),
    JSON.stringify(
      {
        mode: "standalone",
        host: "127.0.0.1",
        port: livePort,
        bearerSecretEnv: "CMM_ROUTER_TOKEN",
        providers: {},
      },
      null,
      2,
    ) + "\n",
  );
  if (options.policy !== undefined) {
    write(join(repo, "config/claude-runtime-update-policy.json"), options.policy);
  }

  // Stub metadata.
  write(
    join(stubDir, "latest.json"),
    JSON.stringify({
      version: latest,
      "dist.integrity": "sha512-NEWINTEGRITY",
      "dist.tarball": `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-${latest}.tgz`,
    }),
  );
  write(join(stubDir, "runtime"), runtime);
  write(join(stubDir, "lock-integrity"), "sha512-NEWINTEGRITY");
  write(join(stubDir, "live-token"), "live-secret-token\n");
  write(join(stubDir, "live-repo"), execFileSync("pwd", ["-P"], { cwd: repo, encoding: "utf-8" }).trim());

  stub(
    join(stubDir, "npm"),
    `STUB="${stubDir}"
cmd="\${1:-}"; shift || true
case "$cmd" in
  view)
    cat "$STUB/latest.json"
    ;;
  install|ci)
    [ -f "$STUB/fail-install" ] && exit 1
    version="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$STUB/latest.json")"
    runtime="$(cat "$STUB/runtime")"
    lock_integrity="$(cat "$STUB/lock-integrity")"
    python3 - "$PWD/package.json" "$version" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["dependencies"]["@anthropic-ai/claude-agent-sdk"]=sys.argv[2]
json.dump(d,open(p,"w"),indent=2); open(p,"a").write("\\n")
PY
    mkdir -p node_modules/@anthropic-ai/claude-agent-sdk
    printf '{"name":"@anthropic-ai/claude-agent-sdk","version":"%s"}\\n' "$version" > node_modules/@anthropic-ai/claude-agent-sdk/package.json
    printf '{"version":"%s","platforms":{"${PLATFORM}":{"binary":"claude","checksum":"%s","size":1}}}\\n' "$runtime" "$(printf 'a%.0s' $(seq 1 64))" > node_modules/@anthropic-ai/claude-agent-sdk/manifest.json
    python3 - "$PWD/package-lock.json" "$version" "$lock_integrity" <<'PY2'
import json,sys
p,version,integrity=sys.argv[1:4]; d=json.load(open(p))
d["packages"]["node_modules/@anthropic-ai/claude-agent-sdk"]={"version":version,"integrity":integrity}
json.dump(d,open(p,"w"),indent=2); open(p,"a").write("\\n")
PY2
    ;;
  run)
    if [ "\${1:-}" = "-s" ]; then shift; fi
    script="\${1:-}"
    if [ "$script" = "build" ]; then
      if [ -f "$STUB/fail-live-build" ] && [ "$(pwd -P)" = "$(cat "$STUB/live-repo")" ]; then exit 1; fi
      mkdir -p dist; echo built > dist/index.js
    fi
    [ "$script" = "typecheck" ] && [ -f "$STUB/fail-typecheck" ] && exit 1
    [ "$script" = "test" ] && [ -f "$STUB/fail-tests" ] && exit 1
    ;;
  audit)
    [ -f "$STUB/fail-signatures" ] && exit 1
    ;;
esac
exit 0
`,
  );
  stub(join(stubDir, "launchctl"), `echo "$@" >> "${stubDir}/launchctl.log"`);
  stub(join(stubDir, "lsof"), `exit 0`);
  stub(join(stubDir, "security"), `cat "${stubDir}/live-token"`);
  stub(join(stubDir, "openssl"), `printf 'deadbeef%.0s' $(seq 1 6)`);

  write(join(repo, ".gitignore"), "node_modules/\ndist/\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"],
    { cwd: repo },
  );

  return { root, repo, stub: stubDir, log, testPort, livePort };
}

function startLive(s: Sandbox, mode = "ok"): void {
  s.live = spawn("node", [join(s.repo, "scripts/macos/fake-router.mjs"), String(s.livePort)], {
    env: { ...process.env, FAKE_ROUTER_MODE: mode, CMM_ROUTER_TOKEN: "live-secret-token" },
    stdio: "ignore",
  });
  cleanups.push(() => s.live?.kill());
}

function runUpdater(s: Sandbox, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [join(s.repo, "scripts/macos/update-claude-runtime.sh"), ...args], {
    encoding: "utf-8",
    timeout: 120000,
    env: {
      ...process.env,
      HOME: s.root,
      CMM_RUNTIME_UPDATE_LOG_DIR: s.log,
      CMM_RUNTIME_UPDATE_PORT: String(s.testPort),
      CMM_RUNTIME_UPDATE_POLICY: join(s.repo, "config/claude-runtime-update-policy.json"),
      CMM_NPM_BIN: join(s.stub, "npm"),
      CMM_LAUNCHCTL_BIN: join(s.stub, "launchctl"),
      CMM_LSOF_BIN: join(s.stub, "lsof"),
      CMM_SECURITY_BIN: join(s.stub, "security"),
      CMM_OPENSSL_BIN: join(s.stub, "openssl"),
      CMM_ROUTER_KEYCHAIN_SERVICE: "test-service",
      CMM_ROUTER_KEYCHAIN_ACCOUNT: "test-account",
      ...env,
    },
  });
}

function evidence(s: Sandbox): Array<Record<string, unknown>> {
  const path = join(s.log, "claude-runtime-update-evidence.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function head(repo: string): string {
  return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
}

function pin(repo: string): string {
  return (
    JSON.parse(readFileSync(join(repo, "package.json"), "utf-8")) as {
      dependencies: Record<string, string>;
    }
  ).dependencies["@anthropic-ai/claude-agent-sdk"] ?? "";
}

const APPLY_POLICY = JSON.stringify({
  mode: "apply",
  allowedMajorMinor: ["0.3"],
  requireProvenance: true,
  minimumRuntimeVersion: "2.1.280",
  requiredAliases: [],
});

describe("Claude runtime updater", () => {
  it("validates and prepares without a deployment policy, never applying", () => {
    const s = makeSandbox();
    const before = head(s.repo);
    const result = runUpdater(s, ["--apply"]);
    expect(result.status, result.stderr).toBe(0);
    const last = evidence(s).at(-1)!;
    expect(last.result).toBe("prepared");
    expect(last.reason).toBe("policy-requires-explicit-approval");
    expect(last.to_sdk).toBe("0.3.317");
    expect(last.to_runtime).toBe("2.1.317");
    expect(head(s.repo)).toBe(before);
    expect(pin(s.repo)).toBe("0.3.316");
    const refs = execFileSync("git", ["-C", s.repo, "branch", "--list", "cmm/prepared-*"], {
      encoding: "utf-8",
    });
    expect(refs).toContain("cmm/prepared-claude-runtime-0.3.317");
    console.log("RUNTIME_UPDATE_PREPARE_WITHOUT_POLICY=PASS");
  });

  it("refuses a dirty live checkout before doing anything", () => {
    const s = makeSandbox();
    writeFileSync(join(s.repo, "package.json"), "{}\n");
    const result = runUpdater(s, ["--apply"]);
    expect(result.status).toBe(1);
    expect(evidence(s).at(-1)!.reason).toBe("live-checkout-has-tracked-changes");
    console.log("RUNTIME_UPDATE_DIRTY_CHECKOUT_REFUSED=PASS");
  });

  it("refuses to run concurrently", () => {
    const s = makeSandbox();
    const lock = join(s.log, "claude-runtime-update.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    const result = runUpdater(s, ["--apply"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("another update is running");
    expect(evidence(s)).toHaveLength(0);
    console.log("RUNTIME_UPDATE_CONCURRENCY_LOCK=PASS");
  });

  it("keeps the operative runtime when the install fails", () => {
    const s = makeSandbox({ policy: APPLY_POLICY });
    const before = head(s.repo);
    writeFileSync(join(s.stub, "fail-install"), "");
    const result = runUpdater(s, ["--apply"]);
    expect(result.status).toBe(1);
    expect(evidence(s).at(-1)!.reason).toBe("install-or-version-verification-failed");
    expect(head(s.repo)).toBe(before);
    expect(pin(s.repo)).toBe("0.3.316");
    console.log("RUNTIME_UPDATE_INSTALL_FAILURE_PRESERVES_RUNTIME=PASS");
  });

  it("blocks a runtime older than the deployment policy minimum", () => {
    const s = makeSandbox({ policy: APPLY_POLICY, runtime: "2.0.0" });
    const result = runUpdater(s, ["--apply"]);
    expect(result.status).toBe(1);
    expect(evidence(s).at(-1)!.reason).toBe("runtime-below-policy-minimum");
    console.log("RUNTIME_UPDATE_INCOMPATIBLE_RUNTIME_BLOCKED=PASS");
  });

  it("blocks when registry signatures cannot be verified", () => {
    const s = makeSandbox({ policy: APPLY_POLICY });
    writeFileSync(join(s.stub, "fail-signatures"), "");
    const result = runUpdater(s, ["--apply"]);
    expect(result.status).toBe(1);
    expect(evidence(s).at(-1)!.reason).toBe("registry-signature-verification-failed");
    console.log("RUNTIME_UPDATE_PROVENANCE_BLOCKED=PASS");
  });

  it("blocks a lock integrity that does not match the registry", () => {
    const s = makeSandbox({ policy: APPLY_POLICY });
    writeFileSync(join(s.stub, "lock-integrity"), "sha512-TAMPERED");
    const result = runUpdater(s, ["--apply"]);
    expect(result.status).toBe(1);
    expect(evidence(s).at(-1)!.reason).toBe("lock-integrity-verification-failed");
    console.log("RUNTIME_UPDATE_INTEGRITY_MISMATCH_BLOCKED=PASS");
  });

  it("does not apply when the isolated canary catalog is empty", () => {
    const s = makeSandbox({ policy: APPLY_POLICY });
    const before = head(s.repo);
    const result = runUpdater(s, ["--apply"], { FAKE_ROUTER_MODE: "empty-catalog" });
    expect(result.status).toBe(1);
    expect(evidence(s).at(-1)!.reason).toBe("canary-failed");
    expect(head(s.repo)).toBe(before);
    expect(pin(s.repo)).toBe("0.3.316");
    console.log("RUNTIME_UPDATE_CANARY_FAILURE_BLOCKS_APPLY=PASS");
  });

  it("applies a fully validated update when the policy authorizes it", () => {
    const s = makeSandbox({ policy: APPLY_POLICY });
    startLive(s);
    const before = head(s.repo);
    const result = runUpdater(s, ["--apply"]);
    expect(result.status, result.stderr).toBe(0);
    const last = evidence(s).at(-1)!;
    expect(last.result).toBe("applied");
    expect(last.from_sdk).toBe("0.3.316");
    expect(last.to_sdk).toBe("0.3.317");
    expect(last.from_runtime).toBe("2.1.316");
    expect(last.to_runtime).toBe("2.1.317");
    expect(head(s.repo)).not.toBe(before);
    expect(pin(s.repo)).toBe("0.3.317");
    expect(existsSync(join(s.repo, "node_modules.prev"))).toBe(false);
    console.log("RUNTIME_UPDATE_APPLY_VALID=PASS");
  });

  it("rolls back to the previous runtime when post-deploy build fails", () => {
    const s = makeSandbox({ policy: APPLY_POLICY });
    startLive(s);
    const before = head(s.repo);
    writeFileSync(join(s.stub, "fail-live-build"), "");
    const result = runUpdater(s, ["--apply"]);
    expect(result.status).toBe(1);
    const last = evidence(s).at(-1)!;
    expect(last.result).toBe("rolled-back");
    expect(last.reason).toBe("post-deploy-build-failed");
    expect(last.rollback_available).toBe(true);
    expect(head(s.repo)).toBe(before);
    expect(pin(s.repo)).toBe("0.3.316");
    const restored = JSON.parse(
      readFileSync(join(s.repo, "node_modules/@anthropic-ai/claude-agent-sdk/manifest.json"), "utf-8"),
    ) as { version: string };
    expect(restored.version).toBe("2.1.316");
    console.log("RUNTIME_UPDATE_ROLLBACK_ON_POST_DEPLOY_FAILURE=PASS");
  });

  it("prepares without a policy and applies the prepared ref on explicit approval", () => {
    const s = makeSandbox();
    startLive(s);
    const prepared = runUpdater(s, ["--apply"]);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(pin(s.repo)).toBe("0.3.316");
    // The operator opts in afterwards.
    writeFileSync(join(s.repo, "config/claude-runtime-update-policy.json"), APPLY_POLICY);
    const applied = runUpdater(s, ["--apply-prepared", "cmm/prepared-claude-runtime-0.3.317"]);
    expect(applied.status, applied.stderr).toBe(0);
    expect(evidence(s).at(-1)!.result).toBe("applied");
    expect(pin(s.repo)).toBe("0.3.317");
    console.log("RUNTIME_UPDATE_APPLY_PREPARED_APPROVAL=PASS");
  }, 60000);
});
