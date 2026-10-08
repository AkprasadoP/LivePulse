import type { Credential, PrismaClient } from "@prisma/client";
import { canonicalizeEmail } from "./email.js";

/**
 * Credential data access (Phase 10.3): email + password-hash login identity.
 *
 * The repository canonicalizes email on EVERY path (create and lookup) so
 * no caller can smuggle an unnormalized form past the unique index.
 * Uniqueness races surface as Prisma P2002 (same convention as the rest of
 * the codebase — the HTTP layer of Phase 10.4 maps it, mirroring the
 * existing global P2002 → 409 handler). No passwords or hashes are logged.
 */
export interface CreateCredentialInput {
  userId: string;
  email: string;
  passwordHash: string;
}

export class CredentialRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async create(input: CreateCredentialInput): Promise<Credential> {
    return this.prisma.credential.create({
      data: {
        userId: input.userId,
        email: canonicalizeEmail(input.email),
        passwordHash: input.passwordHash,
      },
    });
  }

  public async findByEmail(email: string): Promise<Credential | null> {
    return this.prisma.credential.findUnique({
      where: { email: canonicalizeEmail(email) },
    });
  }

  public async findByUserId(userId: string): Promise<Credential | null> {
    return this.prisma.credential.findUnique({ where: { userId } });
  }
}
