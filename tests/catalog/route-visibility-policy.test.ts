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
});
