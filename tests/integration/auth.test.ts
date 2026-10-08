import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { CredentialRepository } from "../../src/modules/auth/credential.repository.js";
import { AuthSessionRepository } from "../../src/modules/auth/auth-session.repository.js";
import { hashPassword, verifyPassword } from "../../src/modules/auth/password.js";
import { hashRefreshToken } from "../../src/modules/auth/token.service.js";
import { TEST_DATABASE_URL } from "./helpers.js";

/**
 * Phase 10.3 repository tests: new primitives only. Existing helpers and
 * suites are untouched. Auth tables are cleaned directly (resetDatabase
 * covers only the pre-auth tables) plus any users created here.
 */
describe("auth repositories (Phase 10.3)", () => {
  const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
  const credentials = new CredentialRepository(prisma);
  const sessions = new AuthSessionRepository(prisma);
  const madeUsers: string[] = [];

  async function makeUser(displayName: string): Promise<string> {
    const user = await prisma.user.create({ data: { displayName } });
    madeUsers.push(user.id);
    return user.id;
  }

  beforeEach(async () => {
    await prisma.authSession.deleteMany();
    await prisma.credential.deleteMany();
  });

  afterEach(async () => {
    await prisma.authSession.deleteMany();
    await prisma.credential.deleteMany();
    if (madeUsers.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: madeUsers.splice(0) } } });
    }
  });

  it("creates and finds credentials with canonicalized email", async () => {
    const userId = await makeUser(`auth-u-${Date.now()}`);
    const created = await credentials.create({
      userId,
      email: "  Mixed@Example.COM ",
      passwordHash: await hashPassword("secret-1"),
    });
    expect(created.email).toBe("mixed@example.com");

    // Lookup canonicalizes too: three spellings, one row.
    for (const spelling of ["mixed@example.com", "MIXED@EXAMPLE.COM", "  Mixed@Example.COM "]) {
      expect((await credentials.findByEmail(spelling))?.id).toBe(created.id);
    }
    expect((await credentials.findByUserId(userId))?.id).toBe(created.id);
    expect(await credentials.findByEmail("nobody@example.com")).toBeNull();
  });

  it("duplicate email surfaces P2002 (mapped by callers, mirroring codebase convention)", async () => {
    const a = await makeUser(`auth-a-${Date.now()}`);
    const b = await makeUser(`auth-b-${Date.now()}`);
    await credentials.create({ userId: a, email: "dup@example.com", passwordHash: "h" });
    await expect(
      credentials.create({ userId: b, email: "DUP@example.com", passwordHash: "h" }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("stored hashes verify and never equal the password", async () => {
    const userId = await makeUser(`auth-h-${Date.now()}`);
    const created = await credentials.create({
      userId,
      email: "hashcheck@example.com",
      passwordHash: await hashPassword("s3cr3t-pw"),
    });
    expect(created.passwordHash).not.toContain("s3cr3t-pw");
    expect(await verifyPassword(created.passwordHash, "s3cr3t-pw")).toBe(true);
    expect(await verifyPassword(created.passwordHash, "nope")).toBe(false);
  });

  it("session lifecycle: create, lookup by hash, revoke", async () => {
    const userId = await makeUser(`auth-s-${Date.now()}`);
    const created = await sessions.create({
      userId,
      refreshTokenHash: hashRefreshToken("raw-token-1"),
      expiresAt: new Date(Date.now() + 1000),
    });
    expect((await sessions.findByTokenHash(hashRefreshToken("raw-token-1")))?.id).toBe(created.id);
    expect(await sessions.findByTokenHash(hashRefreshToken("other"))).toBeNull();

    // The raw token is nowhere in the row.
    expect(JSON.stringify(created)).not.toContain("raw-token-1");

    await sessions.revokeById(created.id);
    expect(
      (await sessions.findByTokenHash(hashRefreshToken("raw-token-1")))?.revokedAt,
    ).not.toBeNull();
  });

  it("rotate is atomic: old revoked, replacement linked", async () => {
    const userId = await makeUser(`auth-r-${Date.now()}`);
    const old = await sessions.create({
      userId,
      refreshTokenHash: hashRefreshToken("old-raw"),
      expiresAt: new Date(Date.now() + 1000),
    });
    const { oldSession, newSession } = await sessions.rotate(old.id, {
      userId,
      refreshTokenHash: hashRefreshToken("new-raw"),
      expiresAt: new Date(Date.now() + 1000),
    });
    expect(oldSession.revokedAt).not.toBeNull();
    expect(newSession.rotatedFromId).toBe(old.id);
    expect(newSession.revokedAt).toBeNull();
  });

  it("revokeChain invalidates the whole user session set (reuse response)", async () => {
    const userId = await makeUser(`auth-c-${Date.now()}`);
    const mk = (t: string) =>
      sessions.create({
        userId,
        refreshTokenHash: hashRefreshToken(t),
        expiresAt: new Date(Date.now() + 1000),
      });
    const s1 = await mk("chain-1");
    const { newSession: s2 } = await sessions.rotate(s1.id, {
      userId,
      refreshTokenHash: hashRefreshToken("chain-2"),
      expiresAt: new Date(Date.now() + 1000),
    });
    const s3 = await mk("chain-3"); // unrelated second device
    // Reuse: chain-1's token presented after rotation.
    const presented = await sessions.findByTokenHash(hashRefreshToken("chain-1"));
    expect(presented?.revokedAt).not.toBeNull();
    const revoked = await sessions.revokeChain(presented!);
    expect(revoked).toBe(2); // s2 + s3 (s1 already revoked by rotate)
    expect((await sessions.findByTokenHash(hashRefreshToken("chain-2")))?.revokedAt).not.toBeNull();
    expect((await sessions.findByTokenHash(hashRefreshToken("chain-3")))?.revokedAt).not.toBeNull();
  });
});
