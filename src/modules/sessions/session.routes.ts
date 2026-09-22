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

export interface SessionRoutesOptions {
  prisma: PrismaClient;
}

export async function sessionRoutes(
  app: FastifyInstance,
  options: SessionRoutesOptions,
): Promise<void> {
  const sessions = new SessionRepository(options.prisma);
  const quizzes = new QuizRepository(options.prisma);

  app.post("/sessions", async (request, reply) => {
    const body = createSessionSchema.parse(request.body);

    const { session, creatorUser, teacherParticipant } = await sessions.createWithCreator({
      name: body.name,
      creatorDisplayName: body.creator?.displayName ?? "Teacher",
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
        creator: { id: creatorUser.id, displayName: creatorUser.displayName },
      },
      teacherParticipant: {
        id: teacherParticipant.id,
        role: teacherParticipant.role,
        userId: creatorUser.id,
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
