import { Prisma, type PrismaClient, type User } from "@prisma/client";

/**
 * Data access for the development identity seam (Phase 3).
 *
 * Until authentication exists, a stable global identity is resolved by
 * displayName. The unique constraint on users.displayName makes
 * find-or-create race-safe: concurrent first joins with the same name cause
 * one INSERT to win and the loser to read the winner's row (P2002 path).
 *
 * This seam is explicitly temporary. When JWT auth arrives, the token's
 * subject replaces displayName at exactly this seam (find-or-create becomes
 * lookup by credential id); no protocol or answer-schema change is needed
 * because identity never travels on event payloads.
 */
export class UserRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findOrCreateByDisplayName(displayName: string): Promise<User> {
    const existing = await this.prisma.user.findUnique({ where: { displayName } });
    if (existing) return existing;
    try {
      return await this.prisma.user.create({ data: { displayName } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // Lost a create race with a concurrent identical displayName.
        const winner = await this.prisma.user.findUnique({ where: { displayName } });
        if (winner) return winner;
      }
      throw error;
    }
  }
}
