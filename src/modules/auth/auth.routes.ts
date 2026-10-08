import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { CredentialRepository } from "./credential.repository.js";
import { canonicalizeEmail } from "./email.js";
import { AuthSessionRepository } from "./auth-session.repository.js";
import { hashPassword, verifyPassword } from "./password.js";
import { TokenService, hashRefreshToken, REFRESH_TOKEN_TTL_MS } from "./token.service.js";
import { createAuthenticatePreHandler } from "./authenticate.js";
import { registerSchema, loginSchema, refreshSchema, logoutSchema } from "./auth.schemas.js";

export interface AuthRoutesOptions {
  prisma: PrismaClient;
  tokens: TokenService;
}

/**
 * Phase 10.4 HTTP authentication. No authorization here (roles/ownership are
 * 10.6), no WebSocket changes, no Redis state — pure credential/token HTTP.
 *
 * - Duplicate email/displayName surfaces as the existing global 409
 *   (P2002 → "Resource already exists"); registration inherently reveals
 *   email-taken, which is standard and unavoidable.
 * - Login failures are fully generic ("Invalid email or password") for both
 *   unknown emails and wrong passwords, with a dummy Argon2 verify on the
 *   unknown-email path so response timing does not oracle existence.
 * - Refresh rotates on EVERY success; presenting an already-revoked token
 *   triggers chain revocation (logout-everywhere) and a generic 401.
 * - Logout is 204 even for unknown tokens (no validity oracle).
 * - Passwords and hashes never leave this module: never logged, never in
 *   responses (only `{ id, email, displayName }` user views).
 */
export async function authRoutes(app: FastifyInstance, options: AuthRoutesOptions): Promise<void> {
  const { prisma, tokens } = options;
  const credentials = new CredentialRepository(prisma);
  const sessions = new AuthSessionRepository(prisma);
  const authenticate = createAuthenticatePreHandler(tokens);

  // Lazily-initialized dummy hash so unknown-email logins cost one Argon2
  // verify like real ones (timing uniformity, computed once per process).
  let dummyHash: Promise<string> | null = null;
  const dummyVerify = (password: string): Promise<boolean> => {
    if (dummyHash === null) {
      dummyHash = hashPassword(`dummy-secret-${Math.random().toString(36).slice(2)}`);
    }
    return dummyHash.then((hash) => verifyPassword(hash, password));
  };

  const issueSession = async (userId: string) => {
    const accessToken = await tokens.issueAccessToken(userId);
    const { token: refreshToken, tokenHash } = tokens.mintRefreshToken();
    await sessions.create({
      userId,
      refreshTokenHash: tokenHash,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });
    return { accessToken, refreshToken, expiresIn: 900 };
  };

  const unauthorized = (message: string): Error => {
    const error = new Error(message) as Error & { statusCode?: number };
    error.statusCode = 401;
    return error;
  };

  app.post("/auth/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);
    // Canonicalize through the shared function (the single choke point —
    // CredentialRepository applies the same function on its own paths).
    const email = canonicalizeEmail(body.email);
    const passwordHash = await hashPassword(body.password);
    // One atomic nested write: user + credential or neither. A P2002 on
    // EITHER unique (email or displayName) becomes the global 409.
    const user = await prisma.user.create({
      data: {
        displayName: body.displayName,
        credentials: { create: { email, passwordHash } },
      },
      select: { id: true, displayName: true },
    });
    const tokensOut = await issueSession(user.id);
    reply.code(201);
    return {
      user: { id: user.id, email, displayName: user.displayName },
      ...tokensOut,
    };
  });

  app.post("/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const credential = await credentials.findByEmail(body.email);
    // Uniform failure: unknown email costs one dummy verify, wrong password
    // costs a real one — timing and message reveal nothing either way.
    if (credential === null) {
      await dummyVerify(body.password);
      throw unauthorized("Invalid email or password");
    }
    if (!(await verifyPassword(credential.passwordHash, body.password))) {
      throw unauthorized("Invalid email or password");
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: credential.userId } });
    const tokensOut = await issueSession(user.id);
    reply.code(200);
    return {
      user: { id: user.id, email: credential.email, displayName: user.displayName },
      ...tokensOut,
    };
  });

  app.post("/auth/refresh", async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const presented = await sessions.findByTokenHash(hashRefreshToken(body.refreshToken));
    if (presented === null || presented.expiresAt.getTime() <= Date.now()) {
      // Unknown or expired: generic failure, no state change.
      throw unauthorized("Invalid refresh token");
    }
    if (presented.revokedAt !== null) {
      // Reuse of a rotated (or logged-out) token: compromise signal.
      // Logout-everywhere, then fail generically.
      await sessions.revokeChain(presented);
      throw unauthorized("Invalid refresh token");
    }
    // Mint once: the raw token goes to the client, its hash to storage.
    // rotate() atomically revokes the old session and links the replacement.
    const replacement = tokens.mintRefreshToken();
    await sessions.rotate(presented.id, {
      userId: presented.userId,
      refreshTokenHash: replacement.tokenHash,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });
    const accessToken = await tokens.issueAccessToken(presented.userId);
    reply.code(200);
    return { accessToken, refreshToken: replacement.token, expiresIn: 900 };
  });

  app.post("/auth/logout", async (request, reply) => {
    const body = logoutSchema.parse(request.body);
    const presented = await sessions.findByTokenHash(hashRefreshToken(body.refreshToken));
    // Idempotent: unknown tokens still get 204 (no validity oracle).
    if (presented !== null && presented.revokedAt === null) {
      await sessions.revokeById(presented.id);
    }
    reply.code(204).send();
  });

  app.get("/me", { preHandler: authenticate }, async (request, reply) => {
    const userId = request.user?.id;
    if (userId === undefined) throw unauthorized("Authentication required");
    const credential = await credentials.findByUserId(userId);
    if (credential === null) throw unauthorized("Authentication required");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    reply.code(200);
    return { user: { id: user.id, email: credential.email, displayName: user.displayName } };
  });
}
