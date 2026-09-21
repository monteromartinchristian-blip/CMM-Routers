import { createHash, timingSafeEqual } from "node:crypto";

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * Constant-time comparison of two token values. Used both for verifying a
 * presented bearer and for validating that configured secrets are distinct.
 */
export function tokensEqual(provided: string, expected: string): boolean {
  const expectedHash = hashToken(expected);
  const providedHash = hashToken(provided);

  return (
    expectedHash.length === providedHash.length &&
    timingSafeEqual(expectedHash, providedHash)
  );
}

export function verifyBearer(
  authorizationHeader: string | undefined,
  expectedSecret: string,
): boolean {
  if (!authorizationHeader) {
    return false;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/);
  if (!match?.[1]) {
    return false;
  }

  return tokensEqual(match[1], expectedSecret);
}
