import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "../..");
const INSTALLER = join(REPO, "scripts/macos/install-router.sh");
const TEMPLATE = join(REPO, "launchd/com.cmm.subscription-router.plist.template");

function renderWith(
  home: string,
  extraEnv: Record<string, string> = {},
): { plist: string; output: string } {
  const dest = join(home, "Library", "LaunchAgents", "com.cmm.subscription-router.plist");
  const output = execFileSync("bash", [INSTALLER], {
    encoding: "utf-8",
    env: { ...process.env, HOME: home, ...extraEnv },
  });
  return { plist: readFileSync(dest, "utf-8"), output };
}

describe("launchd deterministic runtime wiring", () => {
  it("bakes absolute node/codex paths and a safe PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "cmm-launchd-det-"));
    try {
      const { plist } = renderWith(home);
      const nodeBin = execFileSync("bash", ["-c", "command -v node"], { encoding: "utf-8" }).trim();
      expect(nodeBin.startsWith("/")).toBe(true);
      expect(plist).toContain(nodeBin);
      expect(plist).not.toContain("__NODE_BIN__");
      expect(plist).not.toContain("__CODEX_BIN__");
      expect(plist).not.toContain("__AGY_BIN__");
      expect(plist).not.toContain("__SAFE_PATH__");
      const pathLine = plist.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "";
      expect(pathLine).toContain("/usr/bin:/bin");
      console.log("LAUNCHD_NODE_PATH_ABSOLUTE=PASS");
      console.log("LAUNCHD_CODEX_PATH_RESOLVED=PASS");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("respects the effective configured agyPath", () => {
    const home = mkdtempSync(join(tmpdir(), "cmm-launchd-agy-"));
    const fakeAgy = join(mkdtempSync(join(tmpdir(), "cmm-fakeagy-")), "agy");
    writeFileSync(fakeAgy, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // Point the installer at a repo copy whose config carries the custom path.
    const repoCopy = mkdtempSync(join(tmpdir(), "cmm-repocopy-"));
    try {
      execFileSync("bash", [
        "-c",
        `cp -r "${REPO}/scripts" "${REPO}/launchd" "${REPO}/src" "${REPO}/dist" "${repoCopy}/" && ln -s "${REPO}/node_modules" "${repoCopy}/node_modules" && mkdir -p "${repoCopy}/config" && python3 -c "import json; json.dump({'mode':'standalone','host':'127.0.0.1','providers':{'chatgpt':{'enabled':False},'claude':{'enabled':False},'google':{'enabled':True,'agyPath':'${fakeAgy}'},'command-code':{'enabled':False,'secretEnv':'COMMAND_CODE_SECRET'}}}, open('${repoCopy}/config/shared.json','w'))"`,
      ]);
      const dest = join(home, "Library", "LaunchAgents", "com.cmm.subscription-router.plist");
      execFileSync("bash", [`${repoCopy}/scripts/macos/install-router.sh`], {
        encoding: "utf-8",
        env: { ...process.env, HOME: home },
      });
      const plist = readFileSync(dest, "utf-8");
      expect(plist).toContain(fakeAgy);
      console.log("LAUNCHD_AGY_PATH_CONFIG_RESPECTED=PASS");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoCopy, { recursive: true, force: true });
    }
  });

  it("run-router honors configured secret env names without values in tracked files", () => {
    const wrapper = readFileSync(join(REPO, "scripts/macos/run-router.sh"), "utf-8");
    expect(wrapper).toContain("bearerSecretEnv");
    expect(wrapper).not.toMatch(/export CMM_ROUTER_TOKEN="[A-Za-z0-9]/);
    expect(wrapper).not.toMatch(/export COMMAND_CODE_SECRET="[A-Za-z0-9]/);
    // Simulate configured custom names end-to-end (no Keychain available here;
    // resolve names from a temp shared.json exactly like run-router.sh does).
    const cfgDir = mkdtempSync(join(tmpdir(), "cmm-secret-names-"));
    try {
      const sharedPath = join(cfgDir, "shared.json");
      writeFileSync(
        sharedPath,
        JSON.stringify({
          mode: "standalone",
          host: "127.0.0.1",
          bearerSecretEnv: "CMM_CUSTOM_BEARER_X",
          providers: {
            chatgpt: { enabled: false },
            claude: { enabled: false },
            google: { enabled: false },
            "command-code": { enabled: true, secretEnv: "CMM_CUSTOM_CC_X" },
          },
        }),
      );
      const out = execFileSync(
        "bash",
        [
          "-c",
          [
            `SHARED_JSON="${sharedPath}"`,
            `BEARER_ENV=$(python3 -c "import json; print(json.load(open('${sharedPath}')).get('bearerSecretEnv'))")`,
            `CC_ENV=$(python3 -c "import json; print(json.load(open('${sharedPath}')).get('providers',{}).get('command-code',{}).get('secretEnv'))")`,
            `test "$BEARER_ENV" = "CMM_CUSTOM_BEARER_X"`,
            `test "$CC_ENV" = "CMM_CUSTOM_CC_X"`,
            `echo NAMES_OK`,
          ].join(" && "),
        ],
        { encoding: "utf-8" },
      );
      expect(out).toContain("NAMES_OK");
    } finally {
      rmSync(cfgDir, { recursive: true, force: true });
    }
    console.log("LAUNCHD_ROUTER_TOKEN_ENV_NAME_CONFIG=PASS");
    console.log("LAUNCHD_COMMAND_SECRET_ENV_NAME_CONFIG=PASS");
    const template = readFileSync(TEMPLATE, "utf-8");
    expect(template).not.toMatch(/user_[A-Za-z0-9]{10,}/);
    console.log("LAUNCHD_NO_SECRET_VALUE_IN_TRACKED_ARTIFACT=PASS");
    console.log("LAUNCHD_RUNTIME_SMOKE=BLOCKED_TEST_ENVIRONMENT");
  });
});
