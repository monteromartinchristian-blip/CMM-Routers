import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ACK_PATH,
  loadSpendAcknowledgement,
  parseSpendAcknowledgement,
} from "../../src/providers/command-code/spend-guard.js";
import { RouterError } from "../../src/core/errors.js";

describe("Command Code spend guard", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmm-cc-ack-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ackPath(contents: unknown): string {
    const path = join(dir, "ack.json");
    writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
    return path;
  }

  it("accepts the exact GOAT acknowledgement schema", () => {
    const ack = parseSpendAcknowledgement({
      version: 1,
      plan: "GOAT",
      autoTopUpDisabled: true,
      allowOnDemandCredits: false,
    });
    expect(ack).toEqual({
      version: 1,
      plan: "GOAT",
      autoTopUpDisabled: true,
      allowOnDemandCredits: false,
    });
  });

  it("rejects missing acknowledgement file", () => {
    expect(() => loadSpendAcknowledgement(join(dir, "absent.json"))).toThrow(RouterError);
  });

  it("rejects non-GOAT plan", () => {
    const path = ackPath({
      version: 1,
      plan: "PROVIDER",
      autoTopUpDisabled: true,
      allowOnDemandCredits: false,
    });
    expect(() => loadSpendAcknowledgement(path)).toThrow(/GOAT/);
  });

  it("rejects autoTopUpDisabled=false", () => {
    const path = ackPath({
      version: 1,
      plan: "GOAT",
      autoTopUpDisabled: false,
      allowOnDemandCredits: false,
    });
    expect(() => loadSpendAcknowledgement(path)).toThrow(/autoTopUpDisabled/);
  });

  it("rejects allowOnDemandCredits=true", () => {
    const path = ackPath({
      version: 1,
      plan: "GOAT",
      autoTopUpDisabled: true,
      allowOnDemandCredits: true,
    });
    expect(() => loadSpendAcknowledgement(path)).toThrow(/allowOnDemandCredits/);
  });

  it("rejects unknown fields (strict schema)", () => {
    const path = ackPath({
      version: 1,
      plan: "GOAT",
      autoTopUpDisabled: true,
      allowOnDemandCredits: false,
      extra: true,
    });
    expect(() => loadSpendAcknowledgement(path)).toThrow(/unknown field/);
  });

  it("rejects malformed JSON", () => {
    const path = ackPath("{not json");
    expect(() => loadSpendAcknowledgement(path)).toThrow(RouterError);
  });

  it("uses a machine-local default ack path, never a synced location", () => {
    expect(DEFAULT_ACK_PATH).toContain("Application Support");
    expect(DEFAULT_ACK_PATH).toContain("command-code-spend-ack.json");
  });
});
