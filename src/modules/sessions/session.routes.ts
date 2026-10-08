import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { SessionRepository } from "./session.repository.js";
import {
  createSessionSchema,
  sessionIdParamsSchema,
  sessionStateTransitionSchema,
} from "./session.schemas.js";
import { createQuizSchema } from "../quizzes/quiz.schemas.js";
import { QuizRepository } from "../quizzes/quiz.repository.js";
import { serializeQuiz } from "../quizzes/quiz.serializer.js";
import { NotFoundError } from "../../shared/errors.js";
import type { TokenService } from "../auth/token.service.js";
import { createAuthenticatePreHandler } from "../auth/authenticate.js";

export interface SessionRoutesOptions {
  prisma: PrismaClient;
  tokens: TokenService;
}

export async function sessionRoutes(
  app: FastifyInstance,
  options: SessionRoutesOptions,
): Promise<void> {
  const sessions = new SessionRepository(options.prisma);
  const quizzes = new QuizRepository(options.prisma);
  const authenticate = createAuthenticatePreHandler(options.tokens);

  app.post("/sessions", { preHandler: authenticate }, async (request, reply) => {
    const body = createSessionSchema.parse(request.body);

    // Phase 10.7: session creation requires authentication. The creator is
    // the verified token subject — there is no client-supplied identity left
    // (body.creator was removed from the schema). Legacy anonymous creation
    // is gone; historical sessions remain valid rows.
    const creator = await options.prisma.user.findUnique({
      where: { id: request.user?.id ?? "" },
    });
    if (creator === null) {
      const error = new Error("Authentication required") as Error & { statusCode?: number };
      error.statusCode = 401;
      throw error;
    }
    const { session, teacherParticipant } = await sessions.createWithExistingCreator({
      name: body.name,
      creatorId: creator.id,
    });
    reply.code(201);
    return {
      session: {
        id: session.id,
        name: session.name,
        state: session.state,
        startedAt: session.startedAt?.toISOString() ?? null,
        endedAt: session.endedAt?.toISOString() ?? null,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        creator: { id: creator.id, displayName: creator.displayName },
      },
      teacherParticipant: {
        id: teacherParticipant.id,
        role: teacherParticipant.role,
        userId: creator.id,
        joinedAt: teacherParticipant.joinedAt.toISOString(),
      },
    };
  });

  app.get("/sessions/:sessionId", async (request) => {
    const { sessionId } = sessionIdParamsSchema.parse(request.params);
    const found = await sessions.getByIdWithParticipants(sessionId);
    if (!found) throw new NotFoundError("Session", sessionId);

    return {
      session: {
        id: found.session.id,
        name: found.session.name,
        state: found.session.state,
        startedAt: found.session.startedAt?.toISOString() ?? null,
        endedAt: found.session.endedAt?.toISOString() ?? null,
        createdAt: found.session.createdAt.toISOString(),
        updatedAt: found.session.updatedAt.toISOString(),
        creator: {
          id: found.session.creatorId,
          // The creator is always the first participant in practice; fall back
          // gracefully if that ever changes.
          displayName:
            found.participants.find((p) => p.userId === found.session.creatorId)?.user
              .displayName ?? "(unknown)",
        },
      },
      participants: found.participants.map((p) => ({
        id: p.id,
        role: p.role,
        userId: p.user.id,
        displayName: p.user.displayName,
        joinedAt: p.joinedAt.toISOString(),
      })),
    };
  });

  // Explicit, approved state machine: CREATED -> LIVE -> ENDED (+ CREATED -> ENDED).
  app.post("/sessions/:sessionId/state", async (request) => {
    const { sessionId } = sessionIdParamsSchema.parse(request.params);
    const body = sessionStateTransitionSchema.parse(request.body);
    const session = await sessions.transitionState(sessionId, body.state);
    return {
      session: {
        id: session.id,
        name: session.name,
        state: session.state,
        startedAt: session.startedAt?.toISOString() ?? null,
        endedAt: session.endedAt?.toISOString() ?? null,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      },
    };
  });

  app.post("/sessions/:sessionId/quizzes", async (request, reply) => {
    const { sessionId } = sessionIdParamsSchema.parse(request.params);
    const body = createQuizSchema.parse(request.body);
    const quiz = await quizzes.createForSession(sessionId, body);
    reply.code(201);
    return { quiz: serializeQuiz(quiz) };
  });
}
