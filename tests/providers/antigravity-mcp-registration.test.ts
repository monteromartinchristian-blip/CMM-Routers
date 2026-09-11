import { beforeEach, describe, expect, it } from "vitest";
import { RouterError } from "../../src/core/errors.js";
import {
  CMM_QODER_TOOLS_MCP_SERVER_NAME,
  ensureAntigravityMcpRegistration,
  parseAgyMcpList,
  reconcileAntigravityMcpRegistration,
  resetAntigravityMcpRegistrationProcessState,
} from "../../src/providers/antigravity/mcp-registration.js";

const SERVER = "cmm-qoder-tools";
const LAUNCHER = "/repo/dist/bridge/mcp-bridge-launcher.js";
const NODE = "/opt/homebrew/bin/node";
const EXPECTED_ADD_ARGV = ["mcp", "add", SERVER, NODE, LAUNCHER];

interface FakeEntry {
  name: string;
  type: string;
  status: "enabled" | "disabled";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Minimal in-memory model of the observed `agy mcp` CLI: a name-keyed store
 * (so `add` replaces, exactly like the real "Add or update") plus a rendered
 * `mcp list` table in the real column layout.
 */
class FakeAgy {
  readonly calls: string[][] = [];
  /** Rendered rows, kept separately so duplicate rows can be simulated. */
  rows: FakeEntry[] = [];
  failure: string | undefined;

  seed(entry: FakeEntry): void {
    this.rows = this.rows.filter((row) => row.name !== entry.name);
    this.rows.push({ ...entry });
  }

  seedDuplicateRow(entry: FakeEntry): void {
    this.rows.push({ ...entry });
  }

  entriesFor(name: string): FakeEntry[] {
    return this.rows.filter((row) => row.name === name);
  }

  readonly run = (argv: string[]): { status: number | null; stdout: string; stderr: string } => {
    this.calls.push([...argv]);
    if (this.failure !== undefined) return { status: 1, stdout: "", stderr: this.failure };
    const [group, sub, ...rest] = argv;
    if (group !== "mcp") return { status: 2, stdout: "", stderr: `unknown command ${argv.join(" ")}` };
    if (sub === "list") return { status: 0, stdout: this.render(), stderr: "" };
    const name = rest[0];
    if (sub === "remove") {
      if (name === undefined || this.entriesFor(name).length === 0) {
        return { status: 1, stdout: "", stderr: `Error: MCP server "${name}" not found` };
      }
      this.rows = this.rows.filter((row) => row.name !== name);
      return { status: 0, stdout: `Removed MCP server "${name}"\n`, stderr: "" };
    }
    if (sub === "add") {
      let index = 0;
      const env: Record<string, string> = {};
      while (rest[index] !== undefined && rest[index]?.startsWith("-")) {
        const flag = rest[index] as string;
        const value = rest[index + 1];
        if (flag === "--env" || flag === "-e") {
          const [key, ...tail] = (value ?? "").split("=");
          if (key !== undefined && key.length > 0) env[key] = tail.join("=");
        }
        index += 2;
      }
      const addName = rest[index];
      const command = rest[index + 1];
      const args = rest.slice(index + 2);
      if (addName === undefined || command === undefined) {
        return { status: 1, stdout: "", stderr: "Error: missing arguments" };
      }
      const entry: FakeEntry = {
        name: addName,
        type: "stdio",
        status: "enabled",
        command,
        args,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
      this.seed(entry);
      return { status: 0, stdout: `Added MCP server "${addName}" (stdio)\n`, stderr: "" };
    }
    if (sub === "enable" || sub === "disable") {
      const entry = this.rows.find((row) => row.name === name);
      if (entry === undefined) {
        return { status: 1, stdout: "", stderr: `Error: MCP server "${name}" not found` };
      }
      entry.status = sub === "enable" ? "enabled" : "disabled";
      return { status: 0, stdout: `${sub === "enable" ? "Enabled" : "Disabled"} MCP server "${name}"\n`, stderr: "" };
    }
    return { status: 2, stdout: "", stderr: `unknown subcommand ${sub}` };
  };

  /** Renders the observed column layout: 2 spaces of padding between columns. */
  render(): string {
    if (this.rows.length === 0) return "No MCP servers configured.\n";
    const headers = ["NAME", "TYPE", "STATUS", "COMMAND/URL"];
    const cells = this.rows.map((row) => [
      row.name,
      row.type,
      row.status,
      [row.command, ...row.args].join(" "),
    ]);
    const widths = headers.map((header, column) =>
      Math.max(header.length, ...cells.map((row) => (row[column] as string).length)) + 2,
    );
    const line = (row: string[]): string =>
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] as number)))
        .join("");
    return [line(headers), ...cells.map(line)].join("\n") + "\n";
  }
}

function options(fake: FakeAgy): {
  agyPath: string;
  command: string;
  args: string[];
  run: FakeAgy["run"];
} {
  return { agyPath: "/fake/agy", command: NODE, args: [LAUNCHER], run: fake.run };
}

function addCalls(fake: FakeAgy): string[][] {
  return fake.calls.filter((argv) => argv[1] === "add");
}

function removeCalls(fake: FakeAgy): string[][] {
  return fake.calls.filter((argv) => argv[1] === "remove");
}

describe("agy mcp list parsing", () => {
  it("parses the real observed list output for an enabled server", () => {
    const output = [
      "NAME             TYPE   STATUS   COMMAND/URL",
      "cmm-qoder-tools  stdio  enabled  /opt/homebrew/bin/node /Users/example/CMM-Routers/dist/bridge/mcp-bridge-launcher.js",
      "",
    ].join("\n");
    expect(parseAgyMcpList(output)).toEqual([
      {
        name: "cmm-qoder-tools",
        type: "stdio",
        status: "enabled",
        enabled: true,
        command: "/opt/homebrew/bin/node",
        args: ["/Users/example/CMM-Routers/dist/bridge/mcp-bridge-launcher.js"],
      },
    ]);
  });

  it("parses the real observed list output for a disabled server among others", () => {
    const output = [
      "NAME             TYPE   STATUS    COMMAND/URL",
      "cmm-qoder-tools  stdio  disabled  /opt/homebrew/bin/node /tmp/launcher.js",
      "other-server     stdio  enabled   /opt/homebrew/bin/node -e",
    ].join("\n");
    const parsed = parseAgyMcpList(output);
    expect(parsed.map((entry) => entry.name)).toEqual(["cmm-qoder-tools", "other-server"]);
    expect(parsed[0]).toMatchObject({ status: "disabled", enabled: false, args: ["/tmp/launcher.js"] });
    expect(parsed[1]).toMatchObject({ enabled: true, command: "/opt/homebrew/bin/node", args: ["-e"] });
  });

  it("treats the empty store, blank input and CRLF as no registrations", () => {
    expect(parseAgyMcpList("No MCP servers configured.\n")).toEqual([]);
    expect(parseAgyMcpList("")).toEqual([]);
    expect(parseAgyMcpList("\n\n")).toEqual([]);
    expect(
      parseAgyMcpList("NAME   TYPE   STATUS   COMMAND/URL\r\nsrv    stdio  enabled  /bin/echo hi\r\n"),
    ).toEqual([
      {
        name: "srv",
        type: "stdio",
        status: "enabled",
        enabled: true,
        command: "/bin/echo",
        args: ["hi"],
      },
    ]);
  });
});

describe("agy mcp registration restart idempotence", () => {
  beforeEach(() => resetAntigravityMcpRegistrationProcessState());

  it("adds the CMM-owned server when it is absent", () => {
    const fake = new FakeAgy();
    const result = ensureAntigravityMcpRegistration(options(fake));

    expect(result.action).toBe("added");
    expect(result.duplicates).toBe(0);
    expect(addCalls(fake)).toEqual([EXPECTED_ADD_ARGV]);
    const entries = fake.entriesFor(SERVER);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ command: NODE, args: [LAUNCHER], status: "enabled" });
    expect(entries[0]?.env).toBeUndefined();
    console.log("ANTIGRAVITY_MCP_REGISTRATION_RESTART_IDEMPOTENCE=PASS");
  });

  it("canonicalizes once on the first ensure of a process, then no-ops", () => {
    const fake = new FakeAgy();
    fake.seed({ name: SERVER, type: "stdio", status: "enabled", command: NODE, args: [LAUNCHER] });

    const first = ensureAntigravityMcpRegistration(options(fake));
    const second = ensureAntigravityMcpRegistration(options(fake));

    // The first ensure rewrites even a visible-canonical entry, because a
    // hidden persisted env cannot be ruled out from `mcp list` alone.
    expect(first.action).toBe("canonicalized");
    expect(addCalls(fake)).toEqual([EXPECTED_ADD_ARGV]);
    expect(second.action).toBe("noop");
    expect(addCalls(fake)).toEqual([EXPECTED_ADD_ARGV]);
    expect(fake.entriesFor(SERVER)).toHaveLength(1);
    console.log("ANTIGRAVITY_MCP_NEW_PROCESS_CANONICALIZATION=PASS");
  });

  it("re-canonicalizes after a simulated Router restart", () => {
    const fake = new FakeAgy();
    fake.seed({ name: SERVER, type: "stdio", status: "enabled", command: NODE, args: [LAUNCHER] });

    ensureAntigravityMcpRegistration(options(fake));
    expect(addCalls(fake)).toHaveLength(1);

    // A new Router process starts with no canonicalization marker.
    resetAntigravityMcpRegistrationProcessState();
    const restarted = ensureAntigravityMcpRegistration(options(fake));
    expect(restarted.action).toBe("canonicalized");
    expect(addCalls(fake)).toHaveLength(2);
  });

  it("repairs a stale registration idempotently without a restart", () => {
    const fake = new FakeAgy();
    fake.seed({ name: SERVER, type: "stdio", status: "enabled", command: "/bin/echo", args: ["stale"] });

    const repaired = ensureAntigravityMcpRegistration(options(fake));
    expect(repaired.action).toBe("repaired");
    expect(addCalls(fake)).toEqual([EXPECTED_ADD_ARGV]);
    expect(fake.entriesFor(SERVER)).toHaveLength(1);
    expect(fake.entriesFor(SERVER)[0]).toMatchObject({ command: NODE, args: [LAUNCHER] });

    // A second run converges to a no-op: repair is itself idempotent.
    const settled = ensureAntigravityMcpRegistration(options(fake));
    expect(settled.action).toBe("noop");
    expect(addCalls(fake)).toHaveLength(1);
  });

  it("re-enables a disabled registration and clears a non-secret env", () => {
    const fake = new FakeAgy();
    fake.seed({
      name: SERVER,
      type: "stdio",
      status: "disabled",
      command: NODE,
      args: [LAUNCHER],
      env: { LEFTOVER: "value" },
    });

    const result = ensureAntigravityMcpRegistration(options(fake));
    expect(result.action).toBe("repaired");
    expect(fake.entriesFor(SERVER)[0]).toMatchObject({ status: "enabled", command: NODE });
    expect(fake.entriesFor(SERVER)[0]?.env).toBeUndefined();
  });

  it("reconciles duplicate registrations down to exactly one", () => {
    const fake = new FakeAgy();
    fake.seed({ name: SERVER, type: "stdio", status: "enabled", command: NODE, args: [LAUNCHER] });
    fake.seedDuplicateRow({
      name: SERVER,
      type: "stdio",
      status: "enabled",
      command: "/bin/echo",
      args: ["duplicate"],
    });

    const result = ensureAntigravityMcpRegistration(options(fake));
    expect(result.duplicates).toBe(1);
    expect(result.action).toBe("reconciled");
    expect(fake.entriesFor(SERVER)).toHaveLength(1);
    expect(fake.entriesFor(SERVER)[0]).toMatchObject({ command: NODE, args: [LAUNCHER] });
    // Only the CMM-owned name is ever referenced by a mutating command.
    for (const argv of removeCalls(fake)) expect(argv[2]).toBe(SERVER);
    console.log("ANTIGRAVITY_MCP_REGISTRATION_DUPLICATES=NONE");
  });

  it("never touches another server's registration", () => {
    const fake = new FakeAgy();
    fake.seed({ name: "other-server", type: "stdio", status: "enabled", command: "/bin/echo", args: ["keep"] });
    fake.seed({ name: SERVER, type: "stdio", status: "enabled", command: "/bin/echo", args: ["stale"] });

    ensureAntigravityMcpRegistration(options(fake));

    const other = fake.entriesFor("other-server");
    expect(other).toHaveLength(1);
    expect(other[0]).toMatchObject({ command: "/bin/echo", args: ["keep"], status: "enabled" });
    for (const argv of [...addCalls(fake), ...removeCalls(fake)]) expect(argv[2]).toBe(SERVER);
  });

  it("never passes an env flag or secret to the real CLI contract", () => {
    const fake = new FakeAgy();
    ensureAntigravityMcpRegistration(options(fake));
    expect(addCalls(fake)).toEqual([EXPECTED_ADD_ARGV]);
    for (const argv of fake.calls) {
      expect(argv).not.toContain("--env");
      expect(argv).not.toContain("-e");
      expect(argv.join(" ")).not.toMatch(/token|secret/i);
    }
  });

  it("fails closed when the CLI cannot list registrations", () => {
    const fake = new FakeAgy();
    fake.failure = "Error: MCP store unavailable";
    let thrown: unknown;
    try {
      ensureAntigravityMcpRegistration(options(fake));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RouterError);
    expect((thrown as RouterError).code).toBe("provider_unavailable");
    expect(addCalls(fake)).toEqual([]);
  });
});

describe("agy mcp registration startup reconciliation", () => {
  beforeEach(() => resetAntigravityMcpRegistrationProcessState());

  it("reports duplicates without throwing and converges the store", () => {
    const fake = new FakeAgy();
    fake.seed({ name: SERVER, type: "stdio", status: "enabled", command: NODE, args: [LAUNCHER] });
    fake.seedDuplicateRow({ name: SERVER, type: "stdio", status: "enabled", command: NODE, args: [LAUNCHER] });

    const report = reconcileAntigravityMcpRegistration(options(fake));
    expect(report.duplicates).toBe(1);
    expect(report.action).toBe("reconciled");
    expect(fake.entriesFor(SERVER)).toHaveLength(1);
    console.log("ANTIGRAVITY_MCP_REGISTRATION_RECONCILIATION=PASS");
  });

  it("reports a CLI failure instead of throwing, so startup is not broken", () => {
    const fake = new FakeAgy();
    fake.failure = "Error: MCP store unavailable";
    const report = reconcileAntigravityMcpRegistration(options(fake));
    expect(report.action).toBe("failed");
    expect(report.error).toContain("MCP store unavailable");
    expect(report.duplicates).toBe(0);
  });

  it("keeps the managed server name aligned with the adapter constant", async () => {
    expect(CMM_QODER_TOOLS_MCP_SERVER_NAME).toBe("cmm-qoder-tools");
    const adapter = (await import("../../src/providers/antigravity/adapter.js")) as {
      ANTIGRAVITY_MCP_SERVER_NAME: string;
    };
    expect(adapter.ANTIGRAVITY_MCP_SERVER_NAME).toBe(CMM_QODER_TOOLS_MCP_SERVER_NAME);
  });
});
