import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { startTestApp, stopTestApp, resetDatabase, type IntegrationContext } from "./helpers.js";

describe("Database constraints (integration, real PostgreSQL)", () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    ctx = await startTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await stopTestApp();
  });

  async function seedSessionWithQuiz() {
    const sessionId = (await ctx.request("POST", "/sessions", { name: "Constraint session" })).body
      .session.id;

    const quiz = await ctx.prisma.quiz.create({
      data: { sessionId, title: "Constraint quiz" },
    });
    const question = await ctx.prisma.question.create({
      data: { quizId: quiz.id, position: 1, prompt: "Q?", correctAnswer: "A" },
    });
    const studentUser = await ctx.prisma.user.create({ data: { displayName: "Student" } });
    const participant = await ctx.prisma.sessionParticipant.create({
      data: { sessionId, userId: studentUser.id, role: "STUDENT" },
    });
    return { sessionId, quiz, question, studentUser, participant };
  }

  it("enforces UNIQUE (sessionId, userId) on session_participants", async () => {
    const { sessionId, studentUser } = await seedSessionWithQuiz();

    await expect(
      ctx.prisma.sessionParticipant.create({
        data: { sessionId, userId: studentUser.id, role: "STUDENT" },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002",
    );
  });

  it("enforces UNIQUE (quizId, position) on questions", async () => {
    const { quiz } = await seedSessionWithQuiz();

    await expect(
      ctx.prisma.question.create({
        data: { quizId: quiz.id, position: 1, prompt: "Duplicate position" },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002",
    );
  });

  it("enforces UNIQUE (questionId, participantId, attemptNumber) on answers", async () => {
    const { question, participant } = await seedSessionWithQuiz();

    await ctx.prisma.answer.create({
      data: { questionId: question.id, participantId: participant.id, content: "first" },
    });

    await expect(
      ctx.prisma.answer.create({
        data: { questionId: question.id, participantId: participant.id, content: "duplicate" },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002",
    );

    // A different attempt number is allowed (retry policy headroom).
    const retry = await ctx.prisma.answer.create({
      data: {
        questionId: question.id,
        participantId: participant.id,
        content: "second try",
        attemptNumber: 2,
      },
    });
    expect(retry.attemptNumber).toBe(2);
  });

  it("rejects an answer for a nonexistent participant (FK)", async () => {
    const { question } = await seedSessionWithQuiz();

    await expect(
      ctx.prisma.answer.create({
        data: {
          questionId: question.id,
          participantId: "01900000-0000-7000-8000-000000000009",
          content: "ghost",
        },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003",
    );
  });

  it("rejects a session with a nonexistent creator (FK on creatorId)", async () => {
    await expect(
      ctx.prisma.session.create({
        data: {
          name: "No creator",
          creatorId: "01900000-0000-7000-8000-000000000010",
        },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003",
    );
  });

  it("rejects invalid enum state values at the database level", async () => {
    await expect(
      ctx.prisma.$executeRawUnsafe(
        `INSERT INTO sessions (id, name, state, "creatorId", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), 'bad', 'PAUSED', (SELECT id FROM users LIMIT 1), now(), now())`,
      ),
    ).rejects.toThrow();
  });

  it("cascades session deletion to quizzes, questions, participants, doubts", async () => {
    const { sessionId, question, participant } = await seedSessionWithQuiz();
    await ctx.prisma.answer.create({
      data: { questionId: question.id, participantId: participant.id, content: "will vanish" },
    });
    await ctx.prisma.doubt.create({
      // enqueueSeq is the Phase 6 server-assigned ordering key.
      data: { sessionId, participantId: participant.id, content: "vanishing doubt", enqueueSeq: 1 },
    });

    await ctx.prisma.session.delete({ where: { id: sessionId } });

    expect(await ctx.prisma.quiz.count()).toBe(0);
    expect(await ctx.prisma.question.count()).toBe(0);
    expect(await ctx.prisma.answer.count()).toBe(0);
    expect(await ctx.prisma.doubt.count()).toBe(0);
    expect(await ctx.prisma.sessionParticipant.count()).toBe(0);
    // Users survive (Restrict on participant.user); sessions are gone.
    expect(await ctx.prisma.user.count()).toBe(2);
  });

  it("restricts deletion of a user who created a session", async () => {
    const { body } = await ctx.request("POST", "/sessions", { name: "Keeper" });
    const creatorId = body.session.creator.id;

    await expect(ctx.prisma.user.delete({ where: { id: creatorId } })).rejects.toSatisfy(
      (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003",
    );
  });
});
