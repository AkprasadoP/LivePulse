import type { FastifyReply, FastifyRequest } from "fastify";
import type { TokenService } from "./token.service.js";

/**
 * Phase 10.4 HTTP authentication middleware factory.
 *
 * Reads `Authorization: Bearer <access-token>`, verifies it, and attaches
 * `request.user = { id }`. Anything else (missing/malformed/expired/tampered)
 * throws 401 via the app's global error contract — the handler body never
 * distinguishes cases, so there is no token-validity oracle beyond the code.
 * No Redis, no database lookup: access tokens are self-contained by design
 * (revocation takes effect at the 15-minute expiry — the deliberate 10.1
 * tradeoff). Authorization (roles, ownership) is a later phase; this
 * establishes identity only.
 */
export interface AuthenticatedUser {
  id: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

function unauthorized(): Error {
  const error = new Error("Authentication required") as Error & { statusCode?: number };
  error.statusCode = 401;
  return error;
}

export function createAuthenticatePreHandler(tokens: TokenService) {
  return async function authenticateRequest(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;
    const token =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : null;
    if (token === null || token.length === 0) throw unauthorized();
    const verified = await tokens.verifyAccessToken(token);
    if (!verified.ok) throw unauthorized();
    request.user = { id: verified.userId };
  };
}
