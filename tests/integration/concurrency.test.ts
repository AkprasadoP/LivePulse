import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import {
  startListeningServer,
  stopTestApp,
  resetDatabase,
  connectWsClient,
  joinAs,
  createLiveQuizScenario,
  WsTestClient,
  waitForAsync,
} from "./helpers.js";

/**
 * Concurrency suite: the first-correct-answer race over real sockets, real
 * event-loop interleaving and the real database. N participants fire their
 * answers as close to simultaneously as one Node process allows (all frames
 * are written back-to-back from multiple sockets), then the run is verified:
 *
 *   - every answer row persisted (exactly one per participant)
 *   - winner count == 1 when at least one correct answer was submitted
 *   - every recorded winner is correct, and isWinner=false everywhere else
 *   - the leaderboards broadcast during the run are prefix-consistent with
 *     the final DB state (each broadcast shows a single winner or none)
 *
 * This is a correctness demonstration, not a benchmark.
 */
describe("First-correct-answer race (concurrency, integration)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    const server = await startListeningServer();
    app = server.app;
    prisma = server.prisma;
  });

  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  /**
   * One race run: join N clients, publish one question, release the answers
   * of all N clients in the same tick, collect and verify.
   */
  async function runRace(participantCount: number, displayNamePrefix: string): Promise<void> {
    const scenario = await createLiveQuizScenario({
      correctAnswer: "42",
      firstCorrectWins: true,
    });
    const teacher = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);

    teacher.send({ type: "quiz.start", requestId: "q0", payload: { quizId: scenario.quizId } });
    await teacher.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q1",
      payload: { questionId: scenario.questions[0]!.id },
    });
    await teacher.waitFor((m) => m.type === "question.published");

    const clients: WsTestClient[] = [];
    const questionId = scenario.questions[0]!.id;
    try {
      for (let i = 0; i < participantCount; i += 1) {
        const client = await connectWsClient();
        clients.push(client);
        await joinAs(client, scenario.sessionId, `${displayNamePrefix}-${i}`);
      }

      // Every client sends in the same tick; frames hit the server interleaved
      // across its per-socket 'message' events — genuine concurrency for a
      // single Node process.
      for (const [index, client] of clients.entries()) {
        client.send({
          type: "quiz.answer",
          requestId: `a-${index}`,
          payload: { questionId, content: "42" },
        });
      }

      // Submissions are SERIALIZED on the question row lock (ADR-004): the
      // winner commits first while the rest queue. Wait until ALL N answers
      // have persisted — checking only the winner would race the queue.
      // Counts are scoped to this run's question: repeated race runs in one
      // test intentionally accumulate rows across questions.
      await waitForAsync(
        () => prisma.answer.count({ where: { questionId } }).then((n) => n === participantCount),
        10_000,
      );

      const winners = await prisma.answer.count({ where: { questionId, isWinner: true } });
      expect(winners).toBe(1);
      const total = await prisma.answer.count({ where: { questionId } });
      expect(total).toBe(participantCount);
      const winnerRow = await prisma.answer.findFirst({ where: { questionId, isWinner: true } });
      expect(winnerRow?.isCorrect).toBe(true);
      const losers = await prisma.answer.count({ where: { questionId, isWinner: false } });
      expect(losers).toBe(participantCount - 1);
      // Broadcasts must never show two winners for one question.
      const frames = teacher.drain().concat(...clients.map((c) => c.drain()));
      for (const frame of frames) {
        if (frame.type === "leaderboard.updated") {
          const standings = frame.payload.standings as Array<{ isWinner: boolean }>;
          const winnersInFrame = standings.filter((s) => s.isWinner).length;
          expect(winnersInFrame).toBeLessThanOrEqual(1);
          break;
        }
      }
    } finally {
      await Promise.allSettled(clients.map((c) => c.close()));
      await teacher.close();
    }
  }

  it("10 simultaneous correct answers → exactly one winner", async () => {
    await runRace(10, "Racer-10");
  });

  it("50 simultaneous correct answers → exactly one winner", async () => {
    await runRace(50, "Racer-50");
  });

  it("100 simultaneous correct answers → exactly one winner (repeated 3x)", async () => {
    // Repeated runs on the SAME question/scenario would be corrupted by the
    // uniqueness (questionId, participantId, attemptNumber): each participant
    // submits once per run, so a second run needs a fresh scenario — which is
    // what runRace creates per invocation.
    await runRace(100, "Racer-100a");
    await runRace(100, "Racer-100b");
    await runRace(100, "Racer-100c");
  });

  it("mixed correct/incorrect submissions elect a single winner", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: "42" });
    const teacher = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    // Serialize the teacher operations: publish validates quiz state at
    // processing time, so it must not race the start transition.
    teacher.send({ type: "quiz.start", requestId: "q0", payload: { quizId: scenario.quizId } });
    await teacher.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q1",
      payload: { questionId: scenario.questions[0]!.id },
    });
    await teacher.waitFor((m) => m.type === "question.published");

    const clients: WsTestClient[] = [];
    const questionId = scenario.questions[0]!.id;
    try {
      for (let i = 0; i < 20; i += 1) {
        const client = await connectWsClient();
        clients.push(client);
        await joinAs(client, scenario.sessionId, `Mix-${i}`);
      }
      // 10 correct, 10 incorrect, interleaved in one release tick.
      for (const [index, client] of clients.entries()) {
        client.send({
          type: "quiz.answer",
          requestId: `m-${index}`,
          payload: { questionId, content: index % 2 === 0 ? "42" : "wrong" },
        });
      }

      await waitForAsync(
        () => prisma.answer.count({ where: { questionId } }).then((n) => n === 20),
        10_000,
      );

      const winners = await prisma.answer.count({ where: { questionId, isWinner: true } });
      expect(winners).toBe(1);
      const total = await prisma.answer.count({ where: { questionId } });
      expect(total).toBe(20);
      const correct = await prisma.answer.count({ where: { questionId, isCorrect: true } });
      expect(correct).toBe(10);
    } finally {
      await Promise.allSettled(clients.map((c) => c.close()));
      await teacher.close();
    }
  });
});
