import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PUBLIC_SAFE_DEMO_MANAGEMENT_TOKEN,
  PUBLIC_SAFE_DEMO_READ_TOKEN,
} from "../../../src/usage/demo/public-safe-catalog-fixture.js";
import { createProductionUsageRuntime } from "../../../src/usage/runtime/production-runtime.js";

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("public-safe CMM Usage demo fixture", () => {
  it("boots without personal config or credential resolution and exposes representative catalog state", async () => {
    vi.stubEnv("CMM_USAGE_DEMO_FIXTURE", "1");
    const dir = mkdtempSync(join(tmpdir(), "cmm-usage-demo-"));
    dirs.push(dir);
    writeFileSync(join(dir, "usage.json"), "this must never be parsed");
    let credentialReads = 0;

    const production = await createProductionUsageRuntime({
      configDir: dir,
      credentialResolver: {
        resolve() {
          credentialReads += 1;
          throw new Error("demo mode must never call the real credential resolver");
        },
      },
    });

    try {
      expect(credentialReads).toBe(0);
      expect(await production.resolveApiToken()).toBe(PUBLIC_SAFE_DEMO_READ_TOKEN);
      expect(await production.resolveManagementApiToken()).toBe(PUBLIC_SAFE_DEMO_MANAGEMENT_TOKEN);

      const routes = await production.presentationCatalog.listRoutes();
      const providers = await production.presentationCatalog.listProviders();
      const quotas = await production.presentationCatalog.listQuotaSummaries();

      expect(new Set(routes.map((route) => route.offer.kind))).toEqual(
        new Set(["FREE", "PROMO", "INCLUDED", "TRIAL", "PAYG", "UNKNOWN"]),
      );
      expect(providers.find((provider) => provider.directory.integrationType === "command-code")?.directory.state)
        .toBe("connected");

      const commandCode = routes.find((route) => route.routeId === "route:demo:command-code");
      expect(commandCode?.product.displayName).toBe("GOAT");
      expect(commandCode?.quota.map((quota) => quota.displayName)).toEqual(expect.arrayContaining([
        "Monthly plan credits",
        "5-hour window",
        "Weekly window",
      ]));
      expect(commandCode?.quota.some((quota) => quota.displayName === "Purchased credits")).toBe(false);
      expect(commandCode?.quota.some((quota) => quota.displayName === "Free credits")).toBe(false);

      const supplemental = quotas.filter((quota) =>
        quota.displayName === "Purchased credits" || quota.displayName === "Free credits");
      expect(supplemental).toHaveLength(2);
      expect(supplemental.every((quota) => quota.constraining === false)).toBe(true);

      const sharedPool = quotas.find((quota) => quota.displayName === "Shared prepaid pool");
      expect(sharedPool?.affectedRouteIds).toHaveLength(2);
      expect(sharedPool?.resetAt).toBeUndefined();
      expect(sharedPool?.limit).toBeUndefined();

      const kiraFreeRoutes = routes.filter((route) =>
        route.provider.displayName === "Kira AI" && route.offer.kind === "FREE");
      expect(kiraFreeRoutes.map((route) => route.model.displayName)).toEqual([
        "Qwen 3.7-27B Free",
        "Qwen 3.8 Flash Free",
      ]);
      expect(kiraFreeRoutes.every((route) =>
        route.quota.some((quota) => quota.scope.kind === "shared_pool"))).toBe(true);
      expect(kiraFreeRoutes.every((route) =>
        route.quota.some((quota) => quota.scope.kind === "route"))).toBe(true);

      const claimable = quotas.find((quota) => quota.entitlement?.state === "claimable");
      expect(claimable).toMatchObject({
        displayName: "Check-in bonus",
        constraining: false,
        entitlement: {
          amount: 50_000_000,
          unit: "tokens",
          eligibility: "requires_auth",
          requiresExplicitUserAction: true,
        },
      });
      expect(claimable?.entitlement?.appliesToRouteIds).toEqual([
        "route:demo:kira-qwen-37",
        "route:demo:kira-qwen-38",
      ]);

      const safePayload = JSON.stringify({ routes, providers, quotas });
      expect(safePayload).not.toMatch(/credentialRef|keychain:\/\/|managementApiCredentialRef|apiCredentialRef/i);
    } finally {
      await production.close();
    }
  });
});
