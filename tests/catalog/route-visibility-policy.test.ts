import { describe, expect, it } from "vitest";
import { RouteVisibilityPolicy } from "../../src/catalog/route-visibility-policy.js";

describe("RouteVisibilityPolicy", () => {
  it("prefers an exact route rule while restrictive ambiguous legacy input fails closed", () => {
    const policy = new RouteVisibilityPolicy(
      [
        {
          routeId: "route_aaaaaaaaaaaaaaaa",
          visibleOn: ["admin_console"],
        },
      ],
      [
        {
          providerId: "test-provider",
          providerModelId: "provider/model-a",
          visibleOn: [],
        },
      ],
    );

    expect(
      policy.resolve({
        routeId: "route_aaaaaaaaaaaaaaaa",
        providerId: "test-provider",
        providerModelId: "provider/model-a",
        toolCapable: false,
        exactRouteExecutable: true,
      }),
    ).toEqual({ visibleOn: ["admin_console"] });

    expect(
      policy.resolve({
        routeId: "route_bbbbbbbbbbbbbbbb",
        providerId: "test-provider",
        providerModelId: "provider/model-a",
        toolCapable: false,
        exactRouteExecutable: true,
      }),
    ).toEqual({ visibleOn: [] });
  });

  it("applies an exact rule written after construction without touching siblings", () => {
    const policy = new RouteVisibilityPolicy();
    const target = {
      routeId: "route_aaaaaaaaaaaaaaaa",
      providerId: "test-provider",
      providerModelId: "provider/model-a",
      toolCapable: true,
      exactRouteExecutable: true,
    };

    expect(policy.resolve(target)).toEqual({
      visibleOn: ["cmmchat_model_picker", "cmmcode_model_picker", "admin_console"],
    });

    expect(policy.setExactRule(target.routeId, ["admin_console"])).toBeUndefined();
    expect(policy.resolve(target)).toEqual({ visibleOn: ["admin_console"] });

    expect(policy.resolve({ ...target, routeId: "route_bbbbbbbbbbbbbbbb" })).toEqual({
      visibleOn: ["cmmchat_model_picker", "cmmcode_model_picker", "admin_console"],
    });
  });

  it("keeps legacy migration input losing to an exact rule written after construction", () => {
    const policy = new RouteVisibilityPolicy([], [
      {
        providerId: "test-provider",
        providerModelId: "provider/model-a",
        visibleOn: ["cmmcode_model_picker", "admin_console"],
      },
    ]);
    const target = {
      routeId: "route_aaaaaaaaaaaaaaaa",
      providerId: "test-provider",
      providerModelId: "provider/model-a",
      toolCapable: true,
      exactRouteExecutable: true,
    };

    expect(policy.resolve(target)).toEqual({
      visibleOn: ["cmmcode_model_picker", "admin_console"],
    });

    policy.setExactRule(target.routeId, ["admin_console"]);
    expect(policy.resolve(target)).toEqual({ visibleOn: ["admin_console"] });
  });

  it("keeps the exact-execution capability ceiling over an exact rule written after construction", () => {
    const policy = new RouteVisibilityPolicy();
    policy.setExactRule("route_aaaaaaaaaaaaaaaa", [
      "cmmchat_model_picker",
      "cmmcode_model_picker",
      "admin_console",
    ]);

    expect(
      policy.resolve({
        routeId: "route_aaaaaaaaaaaaaaaa",
        providerId: "test-provider",
        providerModelId: "provider/model-a",
        toolCapable: true,
        exactRouteExecutable: false,
      }),
    ).toEqual({ visibleOn: ["admin_console"] });
  });

  it("returns the replaced rule so a failed write can restore it", () => {
    const policy = new RouteVisibilityPolicy([
      { routeId: "route_aaaaaaaaaaaaaaaa", visibleOn: ["cmmchat_model_picker"] },
    ]);
    const target = {
      routeId: "route_aaaaaaaaaaaaaaaa",
      providerId: "test-provider",
      providerModelId: "provider/model-a",
      toolCapable: true,
      exactRouteExecutable: true,
    };

    const previous = policy.setExactRule(target.routeId, ["admin_console"]);
    expect(previous).toEqual(["cmmchat_model_picker"]);
    expect(policy.resolve(target)).toEqual({ visibleOn: ["admin_console"] });

    policy.setExactRule(target.routeId, previous!);
    expect(policy.resolve(target)).toEqual({ visibleOn: ["cmmchat_model_picker"] });
  });

  it("clears a rule that had no predecessor instead of leaving it behind", () => {
    const policy = new RouteVisibilityPolicy();
    const target = {
      routeId: "route_bbbbbbbbbbbbbbbb",
      providerId: "test-provider",
      providerModelId: "provider/model-a",
      toolCapable: false,
      exactRouteExecutable: true,
    };

    expect(policy.setExactRule(target.routeId, ["admin_console"])).toBeUndefined();
    expect(policy.resolve(target)).toEqual({ visibleOn: ["admin_console"] });

    policy.clearExactRule(target.routeId);
    expect(policy.resolve(target)).toEqual({
      visibleOn: ["cmmchat_model_picker", "admin_console"],
    });
  });
});
