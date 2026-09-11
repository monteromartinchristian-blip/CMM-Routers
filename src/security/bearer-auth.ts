import { createHash, timingSafeEqual } from "node:crypto";

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
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

  const providedToken = match[1];
  const expectedHash = hashToken(expectedSecret);
  const providedHash = hashToken(providedToken);

  return (
    expectedHash.length === providedHash.length &&
    timingSafeEqual(expectedHash, providedHash)
  );
}
