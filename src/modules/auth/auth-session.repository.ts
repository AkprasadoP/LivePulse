import type { AuthSession, PrismaClient } from "@prisma/client";

/**
 * Refresh-token session data access (Phase 10.3): server-side revocable
 * sessions. Only token HASHES reach this repository — minting and hashing
 * live in the token service; a raw refresh token must never be persisted.
 *
 * Rotation semantics (deliberate, minimal):
 * - `rotate`: atomically revokes the old session (`revokedAt = now`) and
 *   creates its replacement (`rotatedFromId = old.id`) in one transaction.
 *   Both-or-neither: a crash between the two is impossible to observe.
 * - Reuse detection is a read, not a write: presenting a token whose session
 *   already has `revokedAt` set means the token was used twice. The caller
 *   (Phase 10.4 refresh handler) then calls `revokeChain` and rejects.
 * - `revokeChain`: revokes the presented session plus every live session
 *   derived from it (forward walk over `rotatedFromId`), then every OTHER
 *   live session of the same user. Rationale: a reused token means the
 *   rotation chain is compromised and its holder is unknown — the only safe
 *   response is logout-everywhere for that user, which is also the simplest
 *   correct semantic (no per-device family bookkeeping).
 * - Explicit per-session `revokeById` (logout of one device) touches only
 *   that row and never cascades.
 */
export interface CreateAuthSessionInput {
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  rotatedFromId?: string;
}

export class AuthSessionRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async create(input: CreateAuthSessionInput): Promise<AuthSession> {
    return this.prisma.authSession.create({
      data: {
        userId: input.userId,
        refreshTokenHash: input.refreshTokenHash,
        expiresAt: input.expiresAt,
        ...(input.rotatedFromId === undefined ? {} : { rotatedFromId: input.rotatedFromId }),
      },
    });
  }

  public async findByTokenHash(refreshTokenHash: string): Promise<AuthSession | null> {
    return this.prisma.authSession.findUnique({ where: { refreshTokenHash } });
  }

  public async revokeById(id: string, now: Date = new Date()): Promise<AuthSession> {
    return this.prisma.authSession.update({
      where: { id },
      data: { revokedAt: now },
    });
  }

  /**
   * Atomically revoke `oldId` and create its replacement, or return `null`
   * when `oldId` was not live (already rotated/revoked).
   *
   * The revoke is a CONDITIONAL update (`WHERE revokedAt IS NULL`, the same
   * check-and-set discipline as the session/quiz state machines): under
   * PostgreSQL ReadCommitted a concurrent rotate blocks on the row lock and,
   * once the winner commits, its WHERE no longer matches — `count === 0`.
   * That makes rotation single-use even under a concurrent double-submit of
   * the same refresh token, which the caller treats as reuse. An
   * unconditional UPDATE (the earlier shape) would let both racers "rotate"
   * and silently mint two live sessions instead of surfacing the reuse.
   */
  public async rotate(
    oldId: string,
    replacement: CreateAuthSessionInput,
    now: Date = new Date(),
  ): Promise<{ oldSession: AuthSession; newSession: AuthSession } | null> {
    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.authSession.updateMany({
        where: { id: oldId, revokedAt: null },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) return null;
      const oldSession = await tx.authSession.findUniqueOrThrow({ where: { id: oldId } });
      const newSession = await tx.authSession.create({
        data: {
          userId: replacement.userId,
          refreshTokenHash: replacement.refreshTokenHash,
          expiresAt: replacement.expiresAt,
          rotatedFromId: oldId,
        },
      });
      return { oldSession, newSession };
    });
  }

  /**
   * Logout-everywhere for a compromised user: revoke every live session of
   * the user, including the presented one and anything derived from it.
   * Rationale: a reused token means the rotation chain is compromised and
   * its holder is unknown — the only safe (and simplest) response is to
   * invalidate the whole user session set rather than track per-device
   * family bookkeeping. Returns the number of sessions newly revoked.
   */
  public async revokeChain(session: AuthSession, now: Date = new Date()): Promise<number> {
    const result = await this.prisma.authSession.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: now },
    });
    return result.count;
  }
}
