import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");
const RUN_ROUTER = join(REPO, "scripts", "macos", "run-router.sh");
const PREFLIGHT = join(REPO, "scripts", "preflight.sh");

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeShared(configDir: string, cavotiEnabled = true): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "shared.json"),
    JSON.stringify(
      {
        mode: "standalone",
        host: "127.0.0.1",
        port: 8790,
        bearerSecretEnv: "CMM_ROUTER_TOKEN",
        providers: {
          chatgpt: { enabled: false },
          claude: { enabled: false },
          google: { enabled: false },
          "command-code": {
            enabled: false,
            baseUrl: "https://api.commandcode.ai/provider/v1",
            secretEnv: "COMMAND_CODE_SECRET",
          },
          cavoti: {
            enabled: cavotiEnabled,
            baseUrl: "https://cavoti.com/v1",
            secretEnv: "CAVOTI_API_KEY",
            model: "deepseek-v4.1-flash",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
}

function writeAck(path: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        version: 1,
        provider: "cavoti",
        billing: "PAYG",
        model: "deepseek-v4.1-flash",
        automaticFallback: false,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}

function makeFakeSecurity(binDir: string): string {
  const path = join(binDir, "security");
  writeFileSync(
    path,
    `#!/bin/bash
set -u
account=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -a)
      account="\${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
case "$account" in
  router-bearer)
    printf '%s\\n' 'router-secret-sentinel'
    ;;
  cavoti-api-key)
    if [ "\${FAKE_CAVOTI_KEY:-1}" = "1" ]; then
      printf '%s\\n' 'cavoti-secret-sentinel'
    fi
    ;;
  qoder-bearer)
    printf '%s\\n' 'qoder-secret-sentinel'
    ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

function makeFakeNode(binDir: string): string {
  const path = join(binDir, "fake-node");
  writeFileSync(
    path,
    `#!/bin/bash
set -u
if [ -n "\${CMM_ROUTER_TOKEN:-}" ]; then
  echo "FAKE_ROUTER_BEARER=SET"
else
  echo "FAKE_ROUTER_BEARER=ABSENT"
fi
if [ -n "\${CAVOTI_API_KEY:-}" ]; then
  echo "FAKE_CAVOTI_SECRET=SET"
else
  echo "FAKE_CAVOTI_SECRET=ABSENT"
fi
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Cavoti persistent macOS runtime", () => {
  it("loads the enabled Cavoti secret from the legacy Keychain service without printing it", () => {
    const root = tempRoot("cmm-cavoti-runtime-");
    const home = join(root, "home");
    const configDir = join(root, "config");
    const binDir = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeShared(configDir);
    makeFakeSecurity(binDir);
    const fakeNode = makeFakeNode(binDir);

    const ackPath = join(
      home,
      "Library",
      "Application Support",
      "CMM",
      "SubscriptionRouter",
      "cavoti-payg-ack.json",
    );
    writeAck(ackPath);

    const result = spawnSync("bash", [RUN_ROUTER], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CMM_CONFIG_DIR: configDir,
        CMM_ROUTER_NODE_BIN: fakeNode,
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("FAKE_ROUTER_BEARER=SET");
    expect(output).toContain("FAKE_CAVOTI_SECRET=SET");
    expect(output).not.toContain("router-secret-sentinel");
    expect(output).not.toContain("cavoti-secret-sentinel");
    expect(readFileSync(RUN_ROUTER, "utf8")).toContain("cavoti-api-key");
  });

  it("fails closed before starting Node when enabled Cavoti has no Keychain secret", () => {
    const root = tempRoot("cmm-cavoti-runtime-missing-");
    const home = join(root, "home");
    const configDir = join(root, "config");
    const binDir = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeShared(configDir);
    makeFakeSecurity(binDir);
    const fakeNode = makeFakeNode(binDir);
    writeAck(join(root, "ack.json"));

    const result = spawnSync("bash", [RUN_ROUTER], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CMM_CONFIG_DIR: configDir,
        CMM_ROUTER_NODE_BIN: fakeNode,
        CMM_CAVOTI_ACK_PATH: join(root, "ack.json"),
        FAKE_CAVOTI_KEY: "0",
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("Cavoti secret unavailable");
    expect(output).not.toContain("FAKE_CAVOTI_SECRET=");
  });

  it("fails closed before starting Node when enabled Cavoti lacks a valid PAYG acknowledgement", () => {
    const root = tempRoot("cmm-cavoti-runtime-noack-");
    const home = join(root, "home");
    const configDir = join(root, "config");
    const binDir = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeShared(configDir);
    makeFakeSecurity(binDir);
    const fakeNode = makeFakeNode(binDir);

    const result = spawnSync("bash", [RUN_ROUTER], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CMM_CONFIG_DIR: configDir,
        CMM_ROUTER_NODE_BIN: fakeNode,
        CMM_CAVOTI_ACK_PATH: join(root, "missing-ack.json"),
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("Cavoti PAYG acknowledgement invalid or missing");
    expect(output).not.toContain("FAKE_CAVOTI_SECRET=");
  });
});

describe("Cavoti provider-aware preflight", () => {
  it("blocks enabled Cavoti when the dedicated secret is absent", () => {
    const root = tempRoot("cmm-cavoti-preflight-secret-");
    const configDir = join(root, "config");
    writeShared(configDir);
    const result = spawnSync("bash", [PREFLIGHT], {
      encoding: "utf8",
      env: {
        ...process.env,
        CMM_CONFIG_DIR: configDir,
        CMM_CAVOTI_ACK_PATH: join(root, "missing.json"),
        CAVOTI_API_KEY: "",
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain("CAVOTI_PROVIDER=ENABLED");
    expect(output).toContain("CAVOTI_SECRET=ABSENT");
    expect(output).toContain("CAVOTI_STATE=AUTH_REQUIRED");
  });

  it("blocks enabled Cavoti when the PAYG acknowledgement is absent", () => {
    const root = tempRoot("cmm-cavoti-preflight-ack-");
    const configDir = join(root, "config");
    writeShared(configDir);
    const result = spawnSync("bash", [PREFLIGHT], {
      encoding: "utf8",
      env: {
        ...process.env,
        CMM_CONFIG_DIR: configDir,
        CMM_CAVOTI_ACK_PATH: join(root, "missing.json"),
        CAVOTI_API_KEY: "present-but-never-printed",
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain("CAVOTI_SECRET=SET");
    expect(output).toContain("CAVOTI_ACK=INVALID_OR_MISSING");
    expect(output).toContain("CAVOTI_STATE=ACK_REQUIRED");
    expect(output).not.toContain("present-but-never-printed");
  });

  it("accepts enabled Cavoti only with the exact secret + PAYG acknowledgement contract", () => {
    const root = tempRoot("cmm-cavoti-preflight-ready-");
    const configDir = join(root, "config");
    const ackPath = join(root, "ack.json");
    writeShared(configDir);
    writeAck(ackPath);

    const result = spawnSync("bash", [PREFLIGHT], {
      encoding: "utf8",
      env: {
        ...process.env,
        CMM_CONFIG_DIR: configDir,
        CMM_CAVOTI_ACK_PATH: ackPath,
        CAVOTI_API_KEY: "present-but-never-printed",
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toContain("CAVOTI_PROVIDER=ENABLED");
    expect(output).toContain("CAVOTI_SECRET_ENV=CAVOTI_API_KEY");
    expect(output).toContain("CAVOTI_SECRET=SET");
    expect(output).toContain("CAVOTI_ACK=VALID");
    expect(output).toContain("CAVOTI_STATE=READY");
    expect(output).toContain("PREFLIGHT=PASS");
    expect(output).not.toContain("present-but-never-printed");
  });
});
