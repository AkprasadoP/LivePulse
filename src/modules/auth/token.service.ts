import { createHash, randomBytes } from "node:crypto";
import * as jose from "jose";

/**
 * Token service (Phase 10.3): short-lived signed access JWTs + opaque
 * refresh tokens. No HTTP, no storage here — persistence lives in
 * AuthSessionRepository, which receives HASHES only.
 *
 * - Access: HS256 JWT `{ sub: userId }`, TTL 15 min. Stateless verification;
 *   revocation takes effect at expiry (bounded window — the deliberate
 *   10.1 tradeoff, no revocation fan-out).
 * - Refresh: 32 random bytes (base64url, 43 chars), stored as SHA-256 hex.
 *   The raw token is shown to the client once and never persisted — a
 *   database read yields hashes an attacker cannot present.
 * - Refresh sessions live 30 days (`expiresAt`); rotation/revocation semantics
 *   in AuthSessionRepository.
 * - Secrets arrive via constructor (Phase 10.4 wires them from config):
 *   minimum 32 bytes; never logged, never embedded in tokens.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_ALG = "HS256";

export type AccessVerification =
  { ok: true; userId: string } | { ok: false; reason: "expired" | "invalid" };

export class TokenService {
  private readonly secret: Uint8Array;

  public constructor(accessSecret: string | Uint8Array) {
    this.secret =
      typeof accessSecret === "string" ? new TextEncoder().encode(accessSecret) : accessSecret;
    if (this.secret.length < 32) {
      throw new Error("access secret must be at least 32 bytes");
    }
  }

  public async issueAccessToken(userId: string): Promise<string> {
    return new jose.SignJWT({})
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALG })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.secret);
  }

  public async verifyAccessToken(token: string): Promise<AccessVerification> {
    try {
      const { payload } = await jose.jwtVerify(token, this.secret, {
        algorithms: [ACCESS_TOKEN_ALG],
      });
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        return { ok: false, reason: "invalid" };
      }
      return { ok: true, userId: payload.sub };
    } catch (error) {
      if (error instanceof jose.errors.JWTExpired) return { ok: false, reason: "expired" };
      return { ok: false, reason: "invalid" };
    }
  }

  public mintRefreshToken(): { token: string; tokenHash: string } {
    const token = randomBytes(32).toString("base64url");
    return { token, tokenHash: hashRefreshToken(token) };
  }
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
