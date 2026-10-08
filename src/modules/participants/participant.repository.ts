import { Prisma, type PrismaClient, type SessionParticipant } from "@prisma/client";
import { UserRepository } from "../users/user.repository.js";

/**
 * Data access for session participants.
 *
 * Identity seam (Phase 3): a connection binds to a participant by
 * displayName at session.join time. findOrCreate is idempotent and
 * race-safe: UNIQUE (sessionId, userId) means concurrent joins with the
 * same name resolve to ONE participant row.
 *
 * Known seam limitation (documented, temporary): displayName is the only
 * credential, so anyone joining with an existing teacher name binds to that
 * teacher identity. This is acceptable for development; the seam is the
 * single replacement point for JWT authentication.
 */
export class ParticipantRepository {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly users: UserRepository,
  ) {}

  /**
   * Idempotent find-or-create of user + membership. Returns the participant
   * and whether the user row was newly created (rejoin vs first join).
   */
  public async findOrCreate(
    sessionId: string,
    displayName: string,
    role: "TEACHER" | "STUDENT" = "STUDENT",
  ): Promise<{ participant: SessionParticipant; userCreated: boolean }> {
    const userBefore = await this.prisma.user.findUnique({ where: { displayName } });
    const user = await this.users.findOrCreateByDisplayName(displayName);
    const userCreated = userBefore === null;

    const existing = await this.prisma.sessionParticipant.findUnique({
      where: { sessionId_userId: { sessionId, userId: user.id } },
    });
    if (existing) return { participant: existing, userCreated };

    try {
      const participant = await this.prisma.sessionParticipant.create({
        data: { sessionId, userId: user.id, role },
      });
      return { participant, userCreated };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // Concurrent identical join: exactly one membership row exists.
        const winner = await this.prisma.sessionParticipant.findUnique({
          where: { sessionId_userId: { sessionId, userId: user.id } },
        });
        if (winner) return { participant: winner, userCreated };
      }
      throw error;
    }
  }

  public async getById(id: string): Promise<SessionParticipant | null> {
    return this.prisma.sessionParticipant.findUnique({ where: { id } });
  }

  /**
   * Phase 10.5: idempotent find-or-create of membership for an ALREADY
   * authenticated user. The userId comes from server-side token verification
   * (never from client payload). New memberships default to STUDENT —
   * TEACHER is granted only at session creation today (10.6 owns role
   * assignment). Same P2002 race handling as the displayName path.
   */
  public async findOrCreateByUserId(
    sessionId: string,
    userId: string,
    role: "TEACHER" | "STUDENT" = "STUDENT",
  ): Promise<{ participant: SessionParticipant }> {
    const existing = await this.prisma.sessionParticipant.findUnique({
      where: { sessionId_userId: { sessionId, userId } },
    });
    if (existing) return { participant: existing };

    try {
      const participant = await this.prisma.sessionParticipant.create({
        data: { sessionId, userId, role },
      });
      return { participant };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await this.prisma.sessionParticipant.findUnique({
          where: { sessionId_userId: { sessionId, userId } },
        });
        if (winner) return { participant: winner };
      }
      throw error;
    }
  }
}
