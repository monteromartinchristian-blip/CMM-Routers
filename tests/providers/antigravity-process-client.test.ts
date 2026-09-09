import { describe, expect, it } from "vitest";
import {
  AGY_PATH,
  FORBIDDEN_PAYG_VARS,
  GLOBAL_SETTINGS_PATH,
  buildAgyChildEnv,
  readGlobalSettingsState,
} from "../../src/providers/antigravity/process-client.js";

describe("Antigravity process client", () => {
  it("strips GEMINI_API_KEY from poisoned parent", () => {
    const original = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "dummy";
    try {
      const env = buildAgyChildEnv();
      expect(env.GEMINI_API_KEY).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = original;
    }
  });

  it("strips GOOGLE_GEMINI_BASE_URL from poisoned parent", () => {
    const original = process.env.GOOGLE_GEMINI_BASE_URL;
    process.env.GOOGLE_GEMINI_BASE_URL = "https://example.invalid";
    try {
      const env = buildAgyChildEnv();
      expect(env.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
      else process.env.GOOGLE_GEMINI_BASE_URL = original;
    }
  });

  it("strips GOOGLE_API_KEY from poisoned parent", () => {
    const original = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = "dummy";
    try {
      const env = buildAgyChildEnv();
      expect(env.GOOGLE_API_KEY).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = original;
    }
  });

  it("child environment contains NONE of the poisoned PAYG variables", () => {
    const originals: Record<string, string | undefined> = {};
    for (const key of FORBIDDEN_PAYG_VARS) {
      originals[key] = process.env[key];
    }
    process.env.GEMINI_API_KEY = "dummy";
    process.env.GOOGLE_GEMINI_BASE_URL = "https://example.invalid";
    process.env.GOOGLE_API_KEY = "dummy";
    try {
      const env = buildAgyChildEnv();
      for (const key of FORBIDDEN_PAYG_VARS) {
        expect(key in env).toBe(false);
      }
      expect(Object.values(env)).not.toContain("dummy");
      expect(Object.values(env)).not.toContain("https://example.invalid");
      console.log("GOOGLE_PAYG_POISONING_TEST=PASS");
    } finally {
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("leaves host process.env unchanged", () => {
    const before = { ...process.env };
    buildAgyChildEnv();
    expect(process.env).toEqual(before);
  });

  it("preserves safe variables in the child environment", () => {
    const env = buildAgyChildEnv();
    if (process.env.PATH !== undefined) {
      expect(env.PATH).toBe(process.env.PATH);
    }
    if (process.env.HOME !== undefined) {
      expect(env.HOME).toBe(process.env.HOME);
    }
  });

  it("uses the official agy binary path", () => {
    expect(AGY_PATH.endsWith("/.local/bin/agy")).toBe(true);
  });

  it("reads global settings state with safe fields only", () => {
    const state = readGlobalSettingsState();
    expect(GLOBAL_SETTINGS_PATH.endsWith("antigravity-cli/settings.json")).toBe(true);
    expect(["ABSENT", "string", "boolean", "number"].includes(typeof state.modelProvider) || state.modelProvider === null).toBe(true);
    if (state.exists) {
      expect(state.sha256).toMatch(/^[0-9a-f]{64}$/);
    } else {
      expect(state.sha256).toBeNull();
    }
  });
});
