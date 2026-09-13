import { verifyBearer } from "../../security/bearer-auth.js";

export function isUsageApiPath(url: string): boolean {
  return /^\/v1\/cmm\/usage(?:[/?]|$)/.test(url);
}

export function verifyUsageBearer(
  authorizationHeader: string | undefined,
  usageToken: string | undefined,
): boolean {
  return usageToken !== undefined && verifyBearer(authorizationHeader, usageToken);
}
