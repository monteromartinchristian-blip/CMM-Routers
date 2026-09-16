import { describe, expect, it } from "vitest";
import type { RouterTelemetryStatus } from "../../../src/usage/service/router-telemetry-bridge.js";

describe("RouterTelemetryStatus billing state contract", () => {
  it("preserves billing_blocked as a first-class router telemetry status", () => {
    const status: RouterTelemetryStatus = "billing_blocked";
    expect(status).toBe("billing_blocked");
  });
});
