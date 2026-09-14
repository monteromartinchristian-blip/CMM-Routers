import { verifyBearer } from "../../security/bearer-auth.js";

export function isUsageMutationPath(url: string): boolean {
  return /^\/v1\/cmm\/usage\/(?:connections(?:[/?]|$)|catalog\/visibility(?:[/?]|$))/.test(url);
}

export function verifyUsageManagementBearer(
  authorizationHeader: string | undefined,
  managementToken: string | undefined,
): boolean {
  return managementToken !== undefined && verifyBearer(authorizationHeader, managementToken);
}
