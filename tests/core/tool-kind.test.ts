import { describe, expect, it } from "vitest";
import {
  TOOL_DECLARATION_KINDS,
  TOOL_KIND_POLICY,
  classifyToolDeclarationType,
  toolKindPolicyFor,
  type ToolDeclarationKind,
} from "../../src/core/tool-kind.js";

/**
 * Subphase C — the tool algebra is extensible by capability class, not by
 * product.
 *
 * The Router classifies every declared tool into a capability class and applies
 * a policy. Classification is about what the Router can faithfully represent; it
 * is never about which client is asking. Representation is not permission.
 */
describe("tool declaration capability classes", () => {
  it("FUNCTION_TOOL_KIND=SUPPORTED: client-owned functions are the supported class", () => {
    expect(classifyToolDeclarationType("function")).toBe("function");
    expect(TOOL_KIND_POLICY.function).toBe("SUPPORTED");
    console.log("FUNCTION_TOOL_KIND=SUPPORTED");
  });

  it("NAMESPACE_TOOL_KIND=EXPLICIT_UNSUPPORTED: grouped declarations are a known, named gap", () => {
    expect(classifyToolDeclarationType("namespace")).toBe("namespace");
    expect(TOOL_KIND_POLICY.namespace).toBe("EXPLICIT_UNSUPPORTED");
    console.log("NAMESPACE_TOOL_KIND=EXPLICIT_UNSUPPORTED");
  });

  it("HOSTED_TOOL_KIND=EXPLICIT_UNSUPPORTED: provider-side tools stay forbidden", () => {
    for (const hosted of [
      "web_search",
      "web_search_preview",
      "file_search",
      "code_interpreter",
      "computer_use_preview",
      "image_generation",
      "mcp",
    ]) {
      expect(classifyToolDeclarationType(hosted), hosted).toBe("hosted");
    }
    expect(TOOL_KIND_POLICY.hosted).toBe("EXPLICIT_UNSUPPORTED");
    console.log("HOSTED_TOOL_KIND=EXPLICIT_UNSUPPORTED");
  });

  it("UNKNOWN_TOOL_KIND=FAIL_CLOSED: an unrecognized class is never guessed", () => {
    for (const unknown of [undefined, null, 42, {}, "some_future_tool_kind", "", "FUNCTION"]) {
      expect(classifyToolDeclarationType(unknown)).toBe("unknown");
    }
    expect(TOOL_KIND_POLICY.unknown).toBe("FAIL_CLOSED");
    console.log("UNKNOWN_TOOL_KIND=FAIL_CLOSED");
  });

  it("every class has exactly one declared policy", () => {
    expect([...TOOL_DECLARATION_KINDS].sort()).toEqual(
      ["function", "hosted", "namespace", "unknown"].sort(),
    );
    for (const kind of TOOL_DECLARATION_KINDS) {
      expect(["SUPPORTED", "EXPLICIT_UNSUPPORTED", "FAIL_CLOSED"]).toContain(
        toolKindPolicyFor(kind),
      );
    }
  });

  it("TOOL_KIND_NOT_HARNESS_DEPENDENT: the classification never mentions a product", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(import.meta.dirname, "../../src/core/tool-kind.ts"),
      "utf-8",
    ).toLowerCase();
    for (const brand of ["qoder", "hermes", "codex", "claude", "cline", "roo", "deepseek"]) {
      expect(source, `tool-kind must not name ${brand}`).not.toContain(brand);
    }
    console.log("TOOL_KIND_NOT_HARNESS_DEPENDENT=PASS");
  });

  it("the policy is a closed, exhaustive map", () => {
    const kinds: ToolDeclarationKind[] = ["function", "namespace", "hosted", "unknown"];
    for (const kind of kinds) {
      expect(TOOL_KIND_POLICY[kind]).toBeDefined();
    }
  });
});
