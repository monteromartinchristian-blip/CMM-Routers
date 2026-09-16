import { describe, expect, it } from "vitest";
import { RouteVisibilityPolicy } from "../../src/catalog/route-visibility-policy.js";

describe("RouteVisibilityPolicy", () => {
  it("prefers an exact route rule and does not broaden ambiguous siblings from legacy input", () => {
    const policy = new RouteVisibilityPolicy([
      {
        routeId: "route_aaaaaaaaaaaaaaaa",
        visibleOn: ["admin_console"],
      },
      {
        providerId: "test-provider",
        providerModelId: "provider/model-a",
        visibleOn: ["cmmcode_model_picker", "admin_console"],
      },
    ]);

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
    ).toEqual({ visibleOn: ["cmmchat_model_picker", "admin_console"] });
  });
});
