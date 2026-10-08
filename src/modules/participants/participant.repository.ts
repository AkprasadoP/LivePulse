import { Prisma, type PrismaClient, type SessionParticipant } from "@prisma/client";

/**
 * Data access for session participants.
 *
 * Phase 10.7: membership is resolved exclusively by authenticated userId
 * (findOrCreateByUserId). The displayName find-or-create path is retired —
 * displayName is presentation data, never identity.
 */
export class ParticipantRepository {
  public constructor(private readonly prisma: PrismaClient) {}

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
