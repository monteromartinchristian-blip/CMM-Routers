import { describe, expect, it } from "vitest";
import { RouterError } from "../../src/core/errors.js";
import { ensureAntigravityMcpRegistration } from "../../src/providers/antigravity/mcp-registration.js";

/**
 * Regression for the audit finding F6/F7: `agy mcp list` never prints env, so a
 * persisted entry that LOOKS canonical can still hide a stale secret, and a
 * non-stdio transport can be accepted as canonical. The managed registration
 * must be rewritten by construction on the first ensure of a new Router process.
 */

const SERVER = "cmm-qoder-tools";
const NODE = "/opt/homebrew/bin/node";
const LAUNCHER = "/repo/dist/bridge/mcp-bridge-launcher.js";
const EXPECTED_ADD_ARGV = ["mcp", "add", SERVER, NODE, LAUNCHER];

interface FakeEntry {
  name: string;
  type: string;
  status: "enabled" | "disabled";
  command: string;
  args: string[];
  /** Persisted but NEVER printed by `mcp list` — models hidden provider env. */
  env?: Record<string, string>;
}

/** Minimal name-keyed model of the observed `agy mcp` CLI. */
class FakeAgy {
  readonly calls: string[][] = [];
  rows: FakeEntry[] = [];

  seed(entry: FakeEntry): void {
    this.rows = this.rows.filter((row) => row.name !== entry.name);
    this.rows.push({ ...entry });
  }

  entriesFor(name: string): FakeEntry[] {
    return this.rows.filter((row) => row.name === name);
  }

  run = (argv: string[]): { status: number | null; stdout: string; stderr: string } => {
    this.calls.push([...argv]);
    const [group, sub, ...rest] = argv;
    if (group !== "mcp") return { status: 2, stdout: "", stderr: `unknown command` };
    if (sub === "list") return { status: 0, stdout: this.render(), stderr: "" };
    const name = rest[0];
    if (sub === "remove") {
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
      const addName = rest[index] as string;
      const command = rest[index + 1] as string;
      const args = rest.slice(index + 2);
      this.seed({
        name: addName,
        type: "stdio",
        status: "enabled",
        command,
        args,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      });
      return { status: 0, stdout: `Added MCP server "${addName}" (stdio)\n`, stderr: "" };
    }
    return { status: 2, stdout: "", stderr: `unknown subcommand ${sub}` };
  };

  /** Column layout exactly like the real CLI: header + 2-space padding, no env. */
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

describe("Antigravity registration truth (hidden env + transport type)", () => {
  it("rewrites a visible-canonical entry whose persisted env is hidden, clearing it", () => {
    const fake = new FakeAgy();
    fake.seed({
      name: SERVER,
      type: "stdio",
      status: "enabled",
      command: NODE,
      args: [LAUNCHER],
      env: { OLD_SESSION_SECRET: "CANARY" },
    });

    const result = ensureAntigravityMcpRegistration(options(fake));

    // The stale secret must not survive: canonical add is re-issued without env.
    expect(result.action).not.toBe("noop");
    expect(addCalls(fake)).toEqual([EXPECTED_ADD_ARGV]);
    expect(fake.entriesFor(SERVER)).toHaveLength(1);
    expect(fake.entriesFor(SERVER)[0]?.env).toBeUndefined();
    expect(fake.entriesFor(SERVER)[0]).toMatchObject({
      type: "stdio",
      status: "enabled",
      command: NODE,
      args: [LAUNCHER],
    });
    for (const argv of fake.calls) {
      expect(argv).not.toContain("--env");
      expect(argv).not.toContain("-e");
    }
    console.log("ANTIGRAVITY_MCP_HIDDEN_ENV_RECONCILIATION=PASS");
    console.log("ANTIGRAVITY_MCP_REGISTRATION_SECRET_FREE_BY_CONSTRUCTION=PASS");
  });

  it("does not accept a non-stdio transport as canonical and repairs it", () => {
    const fake = new FakeAgy();
    fake.seed({
      name: SERVER,
      type: "sse",
      status: "enabled",
      command: NODE,
      args: [LAUNCHER],
    });

    const result = ensureAntigravityMcpRegistration(options(fake));

    expect(result.action).not.toBe("noop");
    expect(addCalls(fake)).toEqual([EXPECTED_ADD_ARGV]);
    expect(fake.entriesFor(SERVER)).toHaveLength(1);
    expect(fake.entriesFor(SERVER)[0]?.type).toBe("stdio");
    console.log("ANTIGRAVITY_MCP_CANONICAL_TYPE_STDIO_REQUIRED=PASS");
  });

  it("fails closed when the CLI cannot produce a canonical stdio registration", () => {
    const fake = new FakeAgy();
    // A CLI whose `add` silently does nothing: the post-write verify must fail.
    fake.run = () => ({ status: 0, stdout: "No MCP servers configured.\n", stderr: "" });
    let thrown: unknown;
    try {
      ensureAntigravityMcpRegistration(options(fake));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RouterError);
    expect((thrown as RouterError).code).toBe("provider_unavailable");
  });
});
