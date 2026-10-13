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
 * First-correct-wins correctness audit — gap coverage.
 *
 * Verified before writing (see ADR-004, docs/api/websocket-protocol.md §5.6/§7,
 * src/modules/answers/answer.repository.ts, src/ws/quiz-handlers.ts):
 *  - Election is the question row lock (FOR NO KEY UPDATE) + read-then-insert
 *    inside one transaction; the partial unique index
 *    `answers_one_winner_per_question_key` is defense-in-depth.
 *  - Duplicate (same questionId/participantId/attemptNumber 1) replays the
 *    STORED verdict under the new requestId (answer.accepted, never an error),
 *    persists nothing new, and emits no re-broadcast ("broadcast once").
 *  - Answer-vs-close has exactly two documented outcomes: the answer commits
 *    first (accepted, then close succeeds) or the close commits first (answer
 *    rejected with QUESTION_NOT_ACCEPTING_ANSWERS, nothing persisted).
 *
 * Gaps this file closes (existing suites do NOT cover these):
 *  1. concurrency.test.ts `runRace` breaks after the FIRST leaderboard frame
 *     and never correlates targeted verdicts to requestIds — this suite checks
 *     every verdict and the FULL teacher leaderboard sequence against the DB.
 *  2. quiz-flow.test.ts ("replays the stored verdict...") and recovery.test.ts
 *     (R6/R7) retry with IDENTICAL content only — this suite retries with
 *     DIFFERENT content and verifies the stored verdict is still replayed.
 *  3. No existing test races quiz.answer against question.close (only the
 *     sequential "rejects answers after the question closes" and the
 *     session-end race exist) — this suite races them and accepts only the
 *     two documented outcomes.
 *
 * Cross-instance winner consistency lives in distributed.test.ts (the existing
 * cross-instance race test is extended there); this file stays single-instance
 * and reuses the concurrency-test infrastructure (listening server +
 * createLiveQuizScenario + real sockets). No sleeps: every wait terminates on
 * a server frame or a DB condition, except the single documented absence
 * check (no re-broadcast on duplicate) which no positive signal can end —
 * the same 300 ms convention recovery.test.ts uses for absence assertions.
 */

async function startPublish(
  teacher: WsTestClient,
  quizId: string,
  questionId: string,
): Promise<void> {
  teacher.send({ type: "quiz.start", requestId: "q0", payload: { quizId } });
  await teacher.waitFor((m) => m.type === "quiz.started");
  teacher.send({ type: "question.publish", requestId: "q1", payload: { questionId } });
  await teacher.waitFor((m) => m.type === "question.published");
}

describe("Concurrent verdicts and full broadcast sequence (correctness audit)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    const server = await startListeningServer();
    app = server.app;
    prisma = server.prisma;
    void app;
  });

  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("every verdict correlates to its own requestId; exactly one DB winner; full leaderboard sequence names that winner", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: "42" });
    const questionId = scenario.questions[0]!.id;
    const teacher = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    await startPublish(teacher, scenario.quizId, questionId);

    const N = 15;
    const clients: WsTestClient[] = [];
    try {
      for (let i = 0; i < N; i += 1) {
        const c = await connectWsClient();
        clients.push(c);
        await joinAs(c, scenario.sessionId, `AuditRacer-${i}`);
      }

      // One synchronous release tick: genuine concurrency for one Node process.
      for (const [index, client] of clients.entries()) {
        client.send({
          type: "quiz.answer",
          requestId: `a-${index}`,
          payload: { questionId, content: "42" },
        });
      }

      // All N answers durably committed (serialization on the row lock means
      // the winner commits first while the rest queue — waiting for N, not
      // just the winner, is what makes this deterministic).
      await waitForAsync(
        () => prisma.answer.count({ where: { questionId } }).then((n) => n === N),
        10_000,
      );

      const dbRows = await prisma.answer.findMany({ where: { questionId } });
      expect(dbRows).toHaveLength(N);
      const dbWinners = dbRows.filter((a) => a.isWinner);
      expect(dbWinners).toHaveLength(1);
      expect(dbWinners[0]!.isCorrect).toBe(true);
      const dbWinnerParticipantId = dbWinners[0]!.participantId;

      // Every submission gets exactly one targeted verdict correlated to its
      // OWN requestId (protocol §5.6: answer.accepted echoes requestId).
      const verdicts = await Promise.all(
        clients.map((c, i) =>
          c.waitFor((m) => m.type === "answer.accepted" && m.requestId === `a-${i}`, 10_000),
        ),
      );
      expect(verdicts).toHaveLength(N);
      const winnerVerdicts = verdicts.filter(
        (v) => (v.payload as { isWinner: boolean }).isWinner === true,
      );
      expect(winnerVerdicts).toHaveLength(1);
      expect((winnerVerdicts[0]!.payload as { participantId: string }).participantId).toBe(
        dbWinnerParticipantId,
      );
      for (const v of verdicts) {
        if (v === winnerVerdicts[0]) continue;
        expect((v.payload as { isWinner: boolean }).isWinner).toBe(false);
      }

      // FULL teacher leaderboard sequence: 1 empty (publish, requestId q1) +
      // N answer broadcasts (requestId null). Collect by awaiting frames —
      // never by sleeping — so a missing broadcast fails instead of passing.
      const teacherLeaderboards: typeof verdicts = [];
      for (let k = 0; k < N + 1; k += 1) {
        teacherLeaderboards.push(
          await teacher.waitFor((m) => m.type === "leaderboard.updated", 10_000),
        );
      }
      const nonEmpty = teacherLeaderboards.filter(
        (f) =>
          Array.isArray((f.payload as { standings: unknown[] }).standings) &&
          (f.payload as { standings: unknown[] }).standings.length > 0,
      );
      expect(nonEmpty.length).toBeGreaterThanOrEqual(1);
      for (const frame of teacherLeaderboards) {
        const standings = (frame.payload as { standings: Array<{ isWinner: boolean }> }).standings;
        expect(standings.filter((s) => s.isWinner).length).toBeLessThanOrEqual(1);
      }
      for (const frame of nonEmpty) {
        const standings = (
          frame.payload as { standings: Array<{ participantId: string; isWinner: boolean }> }
        ).standings;
        for (const row of standings.filter((s) => s.isWinner)) {
          expect(row.participantId).toBe(dbWinnerParticipantId);
        }
      }

      // Each observer also converges: every client sees at least one
      // non-empty leaderboard naming the DB winner (awaited, not slept).
      for (const c of clients) {
        const seen = await c.waitFor(
          (m) =>
            m.type === "leaderboard.updated" &&
            Array.isArray((m.payload as { standings: unknown[] }).standings) &&
            (m.payload as { standings: unknown[] }).standings.length > 0,
          10_000,
        );
        const standings = (
          seen.payload as { standings: Array<{ participantId: string; isWinner: boolean }> }
        ).standings;
        for (const row of standings.filter((s) => s.isWinner)) {
          expect(row.participantId).toBe(dbWinnerParticipantId);
        }
      }
    } finally {
      await Promise.allSettled(clients.map((c) => c.close()));
      await teacher.close();
    }
  });
});

describe("Duplicate retry with different content (correctness audit)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    const server = await startListeningServer();
    app = server.app;
    prisma = server.prisma;
    void app;
  });

  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("correct answer retried with wrong content replays the stored winning verdict; one row; no re-broadcast", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: "Berlin" });
    const questionId = scenario.questions[0]!.id;
    const teacher = await connectWsClient();
    const student = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    await joinAs(student, scenario.sessionId, "DupStudent");
    await startPublish(teacher, scenario.quizId, questionId);

    student.send({
      type: "quiz.answer",
      requestId: "dup-first",
      payload: { questionId, content: "Berlin" },
    });
    const first = await student.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "dup-first",
    );
    expect(first.payload).toMatchObject({ isCorrect: true, isWinner: true, attemptNumber: 1 });

    // Observe the first broadcast BEFORE retrying, so the post-retry drain
    // below measures only retry-caused frames.
    await teacher.waitFor((m) => m.type === "answer.accepted" && m.requestId === null);
    await teacher.waitFor(
      (m) =>
        m.type === "leaderboard.updated" &&
        (m.payload as { standings: unknown[] }).standings.length > 0,
    );
    teacher.drain();

    // Same participant, same question/attempt, DIFFERENT content. Contract
    // (protocol §7, repository "Idempotent-replay", handler "duplicate replay
    // re-sends the private verdict"): answer.accepted replaying the ORIGINAL
    // verdict — never a duplicate error.
    student.send({
      type: "quiz.answer",
      requestId: "dup-retry",
      payload: { questionId, content: "Paris" },
    });
    const replay = await student.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "dup-retry",
    );
    expect(replay.payload).toMatchObject({ isCorrect: true, isWinner: true, attemptNumber: 1 });

    const rows = await prisma.answer.findMany({ where: { questionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isWinner: true, isCorrect: true, content: "Berlin" });

    // Absence check: a duplicate must not re-broadcast. No positive signal
    // can end this wait, so the 300 ms settle from recovery.test.ts applies.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const leftovers = teacher.drain();
    expect(leftovers.filter((m) => m.type === "answer.accepted")).toHaveLength(0);
    expect(leftovers.filter((m) => m.type === "leaderboard.updated")).toHaveLength(0);

    await teacher.close();
    await student.close();
  });

  it("incorrect answer retried with different incorrect content replays the stored incorrect verdict; one row", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: "Berlin" });
    const questionId = scenario.questions[0]!.id;
    const teacher = await connectWsClient();
    const student = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    await joinAs(student, scenario.sessionId, "DupWrong");
    await startPublish(teacher, scenario.quizId, questionId);

    student.send({
      type: "quiz.answer",
      requestId: "w-first",
      payload: { questionId, content: "Paris" },
    });
    const first = await student.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "w-first",
    );
    expect(first.payload).toMatchObject({ isCorrect: false, isWinner: false });

    student.send({
      type: "quiz.answer",
      requestId: "w-retry",
      payload: { questionId, content: "Madrid" },
    });
    const replay = await student.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "w-retry",
    );
    // New content is ignored: the stored incorrect verdict is replayed.
    expect(replay.payload).toMatchObject({ isCorrect: false, isWinner: false, attemptNumber: 1 });

    const rows = await prisma.answer.findMany({ where: { questionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("Paris");

    await teacher.close();
    await student.close();
  });
});

describe("Answer-versus-close race (correctness audit)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    const server = await startListeningServer();
    app = server.app;
    prisma = server.prisma;
    void app;
  });

  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("one answer racing one close ends in exactly one documented outcome with consistent DB state", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: "Berlin" });
    const questionId = scenario.questions[0]!.id;
    const teacher = await connectWsClient();
    const student = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    await joinAs(student, scenario.sessionId, "RaceStudent");
    await startPublish(teacher, scenario.quizId, questionId);

    // Same-tick release: the row lock serializes these atomically.
    student.send({
      type: "quiz.answer",
      requestId: "race-answer",
      payload: { questionId, content: "Berlin" },
    });
    teacher.send({
      type: "question.close",
      requestId: "race-close",
      payload: { questionId },
    });

    const studentResponse = await student.waitFor(
      (m) =>
        (m.type === "answer.accepted" && m.requestId === "race-answer") ||
        (m.type === "error" && m.requestId === "race-answer"),
      8_000,
    );
    // Only the two documented outcomes are acceptable — any other code fails.
    const landed = studentResponse.type === "answer.accepted";
    if (landed) {
      expect(studentResponse.payload).toMatchObject({ isCorrect: true, isWinner: true });
    } else {
      expect(studentResponse.payload).toMatchObject({ code: "QUESTION_NOT_ACCEPTING_ANSWERS" });
    }
    await teacher.waitFor((m) => m.type === "question.closed" && m.requestId === "race-close");

    const question = await prisma.question.findUnique({ where: { id: questionId } });
    expect(question?.state).toBe("CLOSED");
    const answers = await prisma.answer.findMany({ where: { questionId } });
    expect(answers.filter((a) => a.isWinner).length).toBeLessThanOrEqual(1);
    if (landed) {
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({ isWinner: true, isCorrect: true });
    } else {
      // Close won: the transaction saw CLOSED under the lock and persisted nothing.
      expect(answers).toHaveLength(0);
    }

    await teacher.close();
    await student.close();
  });

  it("many answers racing one close elect at most one winner; persisted rows equal accepted verdicts", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: "Berlin" });
    const questionId = scenario.questions[0]!.id;
    const teacher = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    await startPublish(teacher, scenario.quizId, questionId);

    const N = 8;
    const clients: WsTestClient[] = [];
    try {
      for (let i = 0; i < N; i += 1) {
        const c = await connectWsClient();
        clients.push(c);
        await joinAs(c, scenario.sessionId, `CloseRacer-${i}`);
      }
      for (const [i, c] of clients.entries()) {
        c.send({
          type: "quiz.answer",
          requestId: `mr-${i}`,
          payload: { questionId, content: "Berlin" },
        });
      }
      teacher.send({ type: "question.close", requestId: "mr-close", payload: { questionId } });

      const responses = await Promise.all(
        clients.map((c, i) =>
          c.waitFor(
            (m) =>
              (m.type === "answer.accepted" && m.requestId === `mr-${i}`) ||
              (m.type === "error" && m.requestId === `mr-${i}`),
            10_000,
          ),
        ),
      );
      await teacher.waitFor((m) => m.type === "question.closed" && m.requestId === "mr-close");

      for (const r of responses) {
        if (r.type === "answer.accepted") continue;
        // Rejected answers must carry exactly this documented code.
        expect(r.payload).toMatchObject({ code: "QUESTION_NOT_ACCEPTING_ANSWERS" });
      }

      const question = await prisma.question.findUnique({ where: { id: questionId } });
      expect(question?.state).toBe("CLOSED");
      const answers = await prisma.answer.findMany({ where: { questionId } });
      const acceptedCount = responses.filter((r) => r.type === "answer.accepted").length;
      expect(answers).toHaveLength(acceptedCount);
      expect(answers.filter((a) => a.isWinner).length).toBeLessThanOrEqual(1);
      for (const w of answers.filter((a) => a.isWinner)) {
        expect(w.isCorrect).toBe(true);
      }
    } finally {
      await Promise.allSettled(clients.map((c) => c.close()));
      await teacher.close();
    }
  });
});
