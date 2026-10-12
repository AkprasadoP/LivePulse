/**
 * Read-only decoding of the access token's `exp` claim.
 *
 * This is NOT verification — the backend verifies signatures. The client only
 * needs to know whether its own token is still fresh enough to use, so it does
 * not have to refresh (and rotate the refresh token) on every reconnect.
 */
export function isAccessTokenExpired(token: string, skewSeconds = 30): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return true;
  const encoded = parts[1];
  if (!encoded) return true;
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const json = decodeBase64(padded);
    const payload = JSON.parse(json) as { exp?: unknown };
    if (typeof payload.exp !== "number") return false;
    return Date.now() / 1000 >= payload.exp - skewSeconds;
  } catch {
    return true;
  }
}

function decodeBase64(value: string): string {
  if (typeof atob === "function") return atob(value);
  // Node fallback (used by the test runner).
  return Buffer.from(value, "base64").toString("binary");
}
