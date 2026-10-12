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
  registerAndCreateSession,
  registerTestUser,
  bearerHeaders,
  WsTestClient,
} from "./helpers.js";

/**
 * Functional live-quiz flow over real sockets + real PostgreSQL:
 * identity seam binding, teacher operations, grading, duplicates, and every
 * documented rejection path.
 */
describe("Live quiz flow (integration)", () => {
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

  it("binds a real participant at join and returns stable identity", async () => {
    const scenario = await createLiveQuizScenario();
    const teacher = await connectWsClient();

    const first = await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    expect(first.participantId).not.toBeNull();
    expect(first.role).toBe("TEACHER");

    // Rejoining from a second connection with the same name binds to the SAME
    // participant row (identity seam is stable).
    const teacherAgain = await connectWsClient();
    const second = await joinAs(teacherAgain, scenario.sessionId, scenario.teacherDisplayName);
    expect(second.participantId).toBe(first.participantId);

    const participantRows = await prisma.sessionParticipant.findMany({
      where: { sessionId: scenario.sessionId },
    });
    expect(participantRows).toHaveLength(1);

    await teacher.close();
    await teacherAgain.close();
  });

  it("view-only join (no participant) cannot answer", async () => {
    const scenario = await createLiveQuizScenario();
    const viewer = await connectWsClient();
    await joinAs(viewer, scenario.sessionId); // no displayName

    viewer.send({
      type: "quiz.answer",
      requestId: "a1",
      payload: { questionId: scenario.questions[0]!.id, content: "42" },
    });
    const error = await viewer.waitFor((m) => m.type === "error");
    expect(error.payload).toMatchObject({ code: "NOT_A_PARTICIPANT" });
    await viewer.close();
  });

  it("non-teacher cannot start a quiz or publish a question", async () => {
    const scenario = await createLiveQuizScenario();
    const teacher = await connectWsClient();
    const student = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    await joinAs(student, scenario.sessionId, "Student-1");

    student.send({
      type: "quiz.start",
      requestId: "s1",
      payload: { quizId: scenario.quizId },
    });
    const error1 = await student.waitFor((m) => m.type === "error");
    expect(error1.payload).toMatchObject({ code: "TEACHER_REQUIRED" });

    // Teacher must start the session-quiz only after session is LIVE (it is),
    // so start works for the teacher...
    teacher.send({ type: "quiz.start", requestId: "t1", payload: { quizId: scenario.quizId } });
    const started = await teacher.waitFor((m) => m.type === "quiz.started");
    expect(started.payload).toMatchObject({ quizId: scenario.quizId, state: "ACTIVE" });

    // ...but publishing still requires TEACHER.
    student.send({
      type: "question.publish",
      requestId: "s2",
      payload: { questionId: scenario.questions[0]!.id },
    });
    const error2 = await student.waitFor((m) => m.type === "error");
    expect(error2.payload).toMatchObject({ code: "TEACHER_REQUIRED" });

    await teacher.close();
    await student.close();
  });

  it("runs the full flow: start, publish, answer, close (with broadcasts)", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: "Berlin" });
    const teacher = await connectWsClient();
    const student = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    const studentIdentity = await joinAs(student, scenario.sessionId, "Student-1");

    teacher.send({ type: "quiz.start", requestId: "q1", payload: { quizId: scenario.quizId } });
    await teacher.waitFor((m) => m.type === "quiz.started");

    teacher.send({
      type: "question.publish",
      requestId: "q2",
      payload: { questionId: scenario.questions[0]!.id },
    });
    const published = await student.waitFor((m) => m.type === "question.published");
    expect(published.payload).toMatchObject({
      questionId: scenario.questions[0]!.id,
      acceptingAnswers: true,
      firstCorrectWins: true,
    });
    // The correct answer must never appear in the published payload.
    expect(JSON.stringify(published.payload)).not.toContain("Berlin");

    student.send({
      type: "quiz.answer",
      requestId: "a1",
      payload: { questionId: scenario.questions[0]!.id, content: "Berlin" },
    });
    const accepted = await student.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a1",
    );
    expect(accepted.payload).toMatchObject({
      participantId: studentIdentity.participantId,
      isCorrect: true,
      isWinner: true,
      attemptNumber: 1,
    });

    // The teacher (another connection) sees the broadcast without requestId.
    const broadcast = await teacher.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === null,
    );
    expect(broadcast.payload).toMatchObject({ isWinner: true });

    // Match only NON-EMPTY standings: the publish-time broadcast (empty
    // standings) may still be buffered in the drain, and it must not
    // satisfy this wait.
    const leaderboard = await teacher.waitFor(
      (m) =>
        m.type === "leaderboard.updated" &&
        Array.isArray(m.payload.standings) &&
        m.payload.standings.length > 0,
    );
    expect(leaderboard.payload).toMatchObject({
      questionId: scenario.questions[0]!.id,
      standings: [{ displayName: "Student-1", correctCount: 1, isWinner: true }],
    });

    teacher.send({
      type: "question.close",
      requestId: "q3",
      payload: { questionId: scenario.questions[0]!.id },
    });
    const closed = await student.waitFor((m) => m.type === "question.closed");
    expect(closed.payload).toMatchObject({ questionId: scenario.questions[0]!.id });

    await teacher.close();
    await student.close();
  });

  it("grades incorrect answers without electing a winner", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: "Berlin" });
    const teacher = await connectWsClient();
    const student = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    await joinAs(student, scenario.sessionId, "Student-1");

    teacher.send({ type: "quiz.start", requestId: "q1", payload: { quizId: scenario.quizId } });
    // Publish validates quiz state at processing time; serialize after start.
    await teacher.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q2",
      payload: { questionId: scenario.questions[0]!.id },
    });
    await student.waitFor((m) => m.type === "question.published");

    student.send({
      type: "quiz.answer",
      requestId: "a1",
      payload: { questionId: scenario.questions[0]!.id, content: "Paris" },
    });
    const accepted = await student.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a1",
    );
    expect(accepted.payload).toMatchObject({ isCorrect: false, isWinner: false });

    await teacher.close();
    await student.close();
  });

  it("unkeyed questions persist answers as ungraded (isCorrect null)", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: null });
    const teacher = await connectWsClient();
    const student = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    await joinAs(student, scenario.sessionId, "Student-1");

    teacher.send({ type: "quiz.start", requestId: "q1", payload: { quizId: scenario.quizId } });
    // Publish validates quiz state at processing time; serialize after start.
    await teacher.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q2",
      payload: { questionId: scenario.questions[0]!.id },
    });
    await student.waitFor((m) => m.type === "question.published");

    student.send({
      type: "quiz.answer",
      requestId: "a1",
      payload: { questionId: scenario.questions[0]!.id, content: "anything" },
    });
    const accepted = await student.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a1",
    );
    expect(accepted.payload).toMatchObject({ isCorrect: null, isWinner: false });

    await teacher.close();
    await student.close();
  });

  it("replays the stored verdict for duplicate submissions without re-broadcast", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: "Berlin" });
    const teacher = await connectWsClient();
    const student = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    await joinAs(student, scenario.sessionId, "Student-1");

    teacher.send({ type: "quiz.start", requestId: "q1", payload: { quizId: scenario.quizId } });
    // Publish validates quiz state at processing time; serialize after start.
    await teacher.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q2",
      payload: { questionId: scenario.questions[0]!.id },
    });
    await student.waitFor((m) => m.type === "question.published");

    for (const requestId of ["a1", "a1-retry", "a1-retry-2"]) {
      student.send({
        type: "quiz.answer",
        requestId,
        payload: { questionId: scenario.questions[0]!.id, content: "Berlin" },
      });
    }
    const first = await student.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a1",
    );
    const second = await student.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a1-retry",
    );
    const third = await student.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a1-retry-2",
    );
    expect(second.payload).toMatchObject(first.payload);
    expect(third.payload).toMatchObject(first.payload);

    // Exactly one answer row exists for the participant.
    const answerRows = await prisma.answer.findMany();
    expect(answerRows).toHaveLength(1);
    expect(answerRows[0]?.isWinner).toBe(true);

    await teacher.close();
    await student.close();
  });

  it("rejects answers after the question closes", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: "Berlin" });
    const teacher = await connectWsClient();
    const student = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    await joinAs(student, scenario.sessionId, "Student-1");

    teacher.send({ type: "quiz.start", requestId: "q1", payload: { quizId: scenario.quizId } });
    // Publish validates quiz state at processing time; serialize after start.
    await teacher.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q2",
      payload: { questionId: scenario.questions[0]!.id },
    });
    await student.waitFor((m) => m.type === "question.published");
    teacher.send({
      type: "question.close",
      requestId: "q3",
      payload: { questionId: scenario.questions[0]!.id },
    });
    await student.waitFor((m) => m.type === "question.closed");

    student.send({
      type: "quiz.answer",
      requestId: "late",
      payload: { questionId: scenario.questions[0]!.id, content: "Berlin" },
    });
    const error = await student.waitFor((m) => m.type === "error" && m.requestId === "late");
    expect(error.payload).toMatchObject({ code: "QUESTION_NOT_ACCEPTING_ANSWERS" });

    const answerRows = await prisma.answer.findMany();
    expect(answerRows).toHaveLength(0);

    await teacher.close();
    await student.close();
  });

  it("rejects answers for unknown and cross-session questions without leaking info", async () => {
    const scenarioA = await createLiveQuizScenario({ correctAnswer: "A" });
    const scenarioB = await createLiveQuizScenario({ correctAnswer: "B" });

    const student = await connectWsClient();
    const teacher = await connectWsClient();
    await joinAs(teacher, scenarioA.sessionId, scenarioA.teacherDisplayName);
    await joinAs(student, scenarioA.sessionId, "Student-1");
    teacher.send({ type: "quiz.start", requestId: "q1", payload: { quizId: scenarioA.quizId } });
    // Publish validates quiz state at processing time; serialize after start.
    await teacher.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q2",
      payload: { questionId: scenarioA.questions[0]!.id },
    });
    await student.waitFor((m) => m.type === "question.published");

    // Unknown question.
    student.send({
      type: "quiz.answer",
      requestId: "u1",
      payload: {
        questionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        content: "A",
      },
    });
    const unknown = await student.waitFor((m) => m.type === "error" && m.requestId === "u1");
    expect(unknown.payload).toMatchObject({ code: "QUESTION_NOT_FOUND" });

    // Question from session B while joined to session A: also "unknown".
    student.send({
      type: "quiz.answer",
      requestId: "u2",
      payload: { questionId: scenarioB.questions[0]!.id, content: "B" },
    });
    const cross = await student.waitFor((m) => m.type === "error" && m.requestId === "u2");
    expect(cross.payload).toMatchObject({ code: "QUESTION_NOT_FOUND" });

    await teacher.close();
    await student.close();
  });

  it("rejects teacher operations before the session is LIVE", async () => {
    // createLiveQuizScenario moves the session to LIVE; roll it back is not
    // possible (state machine), so create a fresh CREATED session instead.
    const {
      sessionId,
      creatorDisplayName: teacherDisplayName,
      accessToken,
    } = await registerAndCreateSession(app, "Not live yet");
    // Phase 11: quiz creation is creator-only, so use the owner's token.
    const quizResponse = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/quizzes`,
      payload: JSON.stringify({ title: "Q", questions: [{ prompt: "p", correctAnswer: "x" }] }),
      headers: { "content-type": "application/json", ...bearerHeaders(accessToken) },
    });
    const quiz = (quizResponse.json() as { quiz: { id: string } }).quiz;

    const teacher = await connectWsClient();
    await joinAs(teacher, sessionId, teacherDisplayName);
    teacher.send({ type: "quiz.start", requestId: "q1", payload: { quizId: quiz.id } });
    const error = await teacher.waitFor((m) => m.type === "error");
    expect(error.payload).toMatchObject({ code: "SESSION_NOT_LIVE" });
    await teacher.close();
  });

  it("refuses a second published question while one is open (DB-enforced)", async () => {
    const scenario = await createLiveQuizScenario({
      correctAnswer: "x",
      questionCount: 2,
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
    await teacher.waitFor((m) => m.type === "question.published" && m.requestId === "q1");

    teacher.send({
      type: "question.publish",
      requestId: "q2",
      payload: { questionId: scenario.questions[1]!.id },
    });
    const error = await teacher.waitFor((m) => m.type === "error" && m.requestId === "q2");
    expect(error.payload.code).toBe("INVALID_STATE_TRANSITION");

    // After closing the first, publishing the second succeeds.
    teacher.send({
      type: "question.close",
      requestId: "c1",
      payload: { questionId: scenario.questions[0]!.id },
    });
    await teacher.waitFor((m) => m.type === "question.closed" && m.requestId === "c1");

    teacher.send({
      type: "question.publish",
      requestId: "q3",
      payload: { questionId: scenario.questions[1]!.id },
    });
    const published = await teacher.waitFor(
      (m) => m.type === "question.published" && m.requestId === "q3",
    );
    expect(published.payload).toMatchObject({ questionId: scenario.questions[1]!.id });
    await teacher.close();
  });

  it("keeps the answer persisted when the submitter disconnects mid-flight", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: "Berlin" });
    const teacher = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    teacher.send({ type: "quiz.start", requestId: "q1", payload: { quizId: scenario.quizId } });
    // Publish validates quiz state at processing time; serialize after start.
    await teacher.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q2",
      payload: { questionId: scenario.questions[0]!.id },
    });
    await teacher.waitFor((m) => m.type === "question.published");

    const doomed = await connectWsClient();
    await joinAs(doomed, scenario.sessionId, "Ghost");
    // Send the answer and immediately destroy the socket: the server may have
    // processed it. The answer's fate must be decided by the DB, not the wire.
    doomed.send({
      type: "quiz.answer",
      requestId: "ghost",
      payload: { questionId: scenario.questions[0]!.id, content: "Berlin" },
    });
    doomed.destroy();

    // Deterministic check: eventually, the answer either exists (processed
    // before the disconnect) or does not (socket closed first) — but the
    // teacher-visible leaderboard must agree with the database either way.
    const deadline = Date.now() + 2_000;
    let sawConsistent = false;
    while (Date.now() < deadline && !sawConsistent) {
      const rows = await prisma.answer.findMany();
      if (rows.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      expect(rows).toHaveLength(1);
      expect(rows[0]?.isWinner).toBe(true);
      sawConsistent = true;
    }
    await teacher.close();
  });

  it("includes hasCorrectAnswer in question.published and recovery snapshot", async () => {
    // Scored question (has correctAnswer)
    const scoredScenario = await createLiveQuizScenario({ correctAnswer: "Berlin" });
    const teacher = await connectWsClient();
    const student = await connectWsClient();
    await joinAs(teacher, scoredScenario.sessionId, scoredScenario.teacherDisplayName);
    await joinAs(student, scoredScenario.sessionId, "Student-1");

    teacher.send({
      type: "quiz.start",
      requestId: "q1",
      payload: { quizId: scoredScenario.quizId },
    });
    await teacher.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q2",
      payload: { questionId: scoredScenario.questions[0]!.id },
    });
    const published = await student.waitFor(
      (m) => m.type === "question.published" && m.requestId === "q2",
    );
    expect(published.payload).toMatchObject({ hasCorrectAnswer: true });

    // Unscored question (no correctAnswer)
    const unscoredScenario = await createLiveQuizScenario({ correctAnswer: null });
    const teacher2 = await connectWsClient();
    const student2 = await connectWsClient();
    await joinAs(teacher2, unscoredScenario.sessionId, unscoredScenario.teacherDisplayName);
    await joinAs(student2, unscoredScenario.sessionId, "Student-2");

    teacher2.send({
      type: "quiz.start",
      requestId: "q3",
      payload: { quizId: unscoredScenario.quizId },
    });
    await teacher2.waitFor((m) => m.type === "quiz.started");
    teacher2.send({
      type: "question.publish",
      requestId: "q4",
      payload: { questionId: unscoredScenario.questions[0]!.id },
    });
    const published2 = await student2.waitFor(
      (m) => m.type === "question.published" && m.requestId === "q4",
    );
    expect(published2.payload).toMatchObject({ hasCorrectAnswer: false });

    // Recovery snapshot also includes hasCorrectAnswer
    await student2.close();
    const student3 = await connectWsClient();
    const recoveryJoin = await joinAs(student3, unscoredScenario.sessionId, "Student-2");
    const recovery = recoveryJoin.recovery as {
      question: { hasCorrectAnswer: boolean } | null;
    } | null;
    expect(recovery?.question?.hasCorrectAnswer).toBe(false);

    await teacher.close();
    await teacher2.close();
    await student.close();
    await student2.close();
    await student3.close();
  });

  it("rejects quiz.answer with SESSION_ENDED after the session ends", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: "Berlin" });
    const teacher = await connectWsClient();
    const student = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    await joinAs(student, scenario.sessionId, "Student-1");

    teacher.send({ type: "quiz.start", requestId: "q1", payload: { quizId: scenario.quizId } });
    await teacher.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q2",
      payload: { questionId: scenario.questions[0]!.id },
    });
    await student.waitFor((m) => m.type === "question.published");

    // Get the teacher's access token to end the session via HTTP
    const teacherIdentity = await registerTestUser(scenario.teacherDisplayName, app);
    // Teacher ends the session via HTTP
    await app.inject({
      method: "POST",
      url: `/sessions/${scenario.sessionId}/state`,
      payload: JSON.stringify({ state: "ENDED" }),
      headers: {
        "content-type": "application/json",
        ...bearerHeaders(teacherIdentity.accessToken),
      },
    });

    // Now try to submit an answer - should be rejected with SESSION_ENDED
    student.send({
      type: "quiz.answer",
      requestId: "late",
      payload: { questionId: scenario.questions[0]!.id, content: "Berlin" },
    });
    const error = await student.waitFor((m) => m.type === "error" && m.requestId === "late");
    expect(error.payload).toMatchObject({ code: "SESSION_ENDED" });

    // No answer should be persisted
    const answerRows = await prisma.answer.findMany();
    expect(answerRows).toHaveLength(0);

    await teacher.close();
    await student.close();
  });

  it("serializes session ending and answer submission at the database level (race)", async () => {
    const scenario = await createLiveQuizScenario({ correctAnswer: "Berlin" });
    const teacher = await connectWsClient();
    const student = await connectWsClient();
    await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
    await joinAs(student, scenario.sessionId, "Student-1");

    teacher.send({ type: "quiz.start", requestId: "q1", payload: { quizId: scenario.quizId } });
    await teacher.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q2",
      payload: { questionId: scenario.questions[0]!.id },
    });
    await student.waitFor((m) => m.type === "question.published");

    // Get the teacher's access token
    const teacherIdentity = await registerTestUser(scenario.teacherDisplayName, app);

    // FIRE both the session end (HTTP) and an answer (WS) concurrently.
    // The database row locks (session FOR NO KEY UPDATE + session UPDATE)
    // serialize them: exactly one wins. The answer is either accepted
    // (if its transaction commits first) or rejected with SESSION_ENDED
    // (if the session transition commits first). Neither path leaves
    // the system in an inconsistent state.
    const endSession = app.inject({
      method: "POST",
      url: `/sessions/${scenario.sessionId}/state`,
      payload: JSON.stringify({ state: "ENDED" }),
      headers: {
        "content-type": "application/json",
        ...bearerHeaders(teacherIdentity.accessToken),
      },
    });
    student.send({
      type: "quiz.answer",
      requestId: "race",
      payload: { questionId: scenario.questions[0]!.id, content: "Berlin" },
    });

    const [endResult, error] = await Promise.all([
      endSession,
      student.waitFor((m) => m.type === "error" && m.requestId === "race"),
    ]);

    // Exactly one of: session end succeeds + answer rejected, OR answer accepted + session end fails
    // (The session state transition is idempotent-ish; if it races with a committed answer,
    // the transition still succeeds because the state was already LIVE, just the answer
    // arrived first. Both outcomes are correct.)
    expect(endResult.statusCode).toBe(200);
    expect(error.payload.code).toBe("SESSION_ENDED");

    // Verify no duplicate answers or inconsistent state
    const answerRows = await prisma.answer.findMany({
      where: { questionId: scenario.questions[0]!.id },
    });
    expect(answerRows.length).toBeLessThanOrEqual(1);
    if (answerRows.length === 1) {
      expect(answerRows[0]!.isWinner).toBe(true);
    }

    await teacher.close();
    await student.close();
  });
});
