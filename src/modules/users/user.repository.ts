import type { PrismaClient } from "@prisma/client";

/**
 * Data access for users (Phase 10.7).
 *
 * The displayName find-or-create identity path is retired: users are created
 * at registration (10.4) or session creation, and resolved by id or by
 * credential. displayName remains a unique presentation label, never a
 * lookup key for identity.
 */
export class UserRepository {
  public constructor(private readonly prisma: PrismaClient) {}
}
