import { verifyBearer } from "../../security/bearer-auth.js";

/**
 * Router-administration mutation paths reachable through the legacy CMM Usage
 * compatibility endpoints: connections, custom endpoints and exact-route
 * visibility.
 *
 * The privileged credential means "authorized to mutate Router administration".
 * These paths are compatibility delegates to `RouterAdministrationService`, so
 * they belong to that privileged surface and never to the read-only CMM Usage
 * credential.
 */
export function isUsageMutationPath(url: string): boolean {
  return /^\/v1\/cmm\/usage\/(?:connections(?:[/?]|$)|catalog\/visibility(?:[/?]|$))/.test(url);
}

/**
 * True when a request is a privileged Router-administration mutation on a
 * legacy CMM Usage path.
 *
 * The legacy visibility path carries both a read (`GET`) and a mutation
 * (`PATCH`), so a read-only credential has to be refused by method as well as
 * by path: the path alone cannot distinguish reading visibility from changing
 * it.
 */
export function isUsageMutationRequest(method: string, url: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return isUsageMutationPath(url);
}

/**
 * Verifies the privileged Router-administration credential.
 *
 * It authorizes Router administrative mutation only: it is never a read
 * credential, and it stays distinct from the read-only CMM Usage bearer.
 */
export function verifyUsageManagementBearer(
  authorizationHeader: string | undefined,
  managementToken: string | undefined,
): boolean {
  return managementToken !== undefined && verifyBearer(authorizationHeader, managementToken);
}
