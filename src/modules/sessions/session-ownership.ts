import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { TokenService } from "../auth/token.service.js";
import { createAuthenticatePreHandler } from "../auth/authenticate.js";
import { sessionIdParamsSchema } from "./session.schemas.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";

/**
 * Phase 11: authenticated session-OWNER guard for mutating HTTP session routes.
 *
 * Mutating a session (`POST /sessions/:id/state`) or its quizzes
 * (`POST /sessions/:id/quizzes`) is a control-plane operation that must belong
 * to the session's creator — the same ownership rule the WebSocket teacher
 * path enforces (creator == TEACHER authority). Before Phase 11 these routes
 * were unauthenticated, so any client could end/start any session or inject
 * quizzes into it; this closes that gap.
 *
 * Order: authenticate (401 for a missing/invalid token, never a silent
 * downgrade) -> resolve the session (404 unknown) -> require ownership (403).
 * Reads (`GET /sessions/:id`, `GET /quizzes/:id`) stay open: they are
 * id-addressed views, not mutations.
 */
export function createSessionOwnerPreHandler(
  prisma: PrismaClient,
  tokens: TokenService,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const authenticate = createAuthenticatePreHandler(tokens);
  return async function requireSessionOwner(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await authenticate(request, reply);
    const { sessionId } = sessionIdParamsSchema.parse(request.params);
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { creatorId: true },
    });
    if (session === null) throw new NotFoundError("Session", sessionId);
    if (session.creatorId !== request.user?.id) {
      throw new ForbiddenError("Only the session creator can perform this action");
    }
  };
}
