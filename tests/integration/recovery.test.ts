import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  TEST_DATABASE_URL,
  resetDatabase,
  startIndependentInstance,
  connectToInstance,
  joinAs,
  registerAndCreateSession,
  waitForAsync,
  WsTestClient,
  type IndependentInstance,
} from "./helpers.js";

/**
 * Phase 5 recovery tests (ADR-006): disconnect -> reconnect (any instance)
 * -> authoritative PostgreSQL snapshot -> live delivery resumes.
 *
 * Everything runs against real PostgreSQL + real sockets + independent
 * instances. No sleeps for state: tests synchronize on server frames and
 * database reads. The 300 ms settles exist only where the assertion is the
 * ABSENCE of further frames (no-replay / no-duplicate), which no positive
 * signal can terminate early — documented in docs/testing/recovery.md.
 */

interface RecoveryPayload {
  quizzes: Array<{ quizId: string; state: string; startedAt: string | null }>;
  question: {
    quizId: string;
    questionId: string;
    position: number;
    prompt: string;
    firstCorrectWins: boolean;
    state: "PUBLISHED" | "CLOSED";
    acceptingAnswers: boolean;
  } | null;
  ownAnswer: {
    questionId: string;
    content: string;
    isCorrect: boolean | null;
    isWinner: boolean;
    attemptNumber: number;
    submittedAt: string;
  } | null;
  standings: Array<{
    participantId: string;
    displayName: string;
    correctCount: number;
    isWinner: boolean;
  }>;
}

/**
 * Narrow the `recovery` value returned by helpers.joinAs (undefined means the
 * server omitted the field on session.joined — a contract bug).
 */
function recoveryOf(recovery: unknown): RecoveryPayload | null {
  expect(recovery, "session.joined must always carry a recovery field").not.toBeUndefined();
  return (recovery as RecoveryPayload | null) ?? null;
}

/** Teacher-driven: start quiz, publish question, await on the teacher's own acks. */
async function startQuizAndPublish(
  teacher: WsTestClient,
  quizId: string,
  questionId: string,
): Promise<void> {
  teacher.send({ type: "quiz.start", requestId: "tq0", payload: { quizId } });
  await teacher.waitFor((m) => m.type === "quiz.started" && m.requestId === "tq0");
  teacher.send({ type: "question.publish", requestId: "tq1", payload: { questionId } });
  await teacher.waitFor((m) => m.type === "question.published" && m.requestId === "tq1");
}

/** HTTP helper bound to one instance (session/quiz/state setup). */
function requestOn(instance: IndependentInstance) {
  return async (
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: any }> => {
    const response = await instance.app.inject({
      method,
      url,
      ...(payload === undefined
        ? {}
        : { payload: JSON.stringify(payload), headers: { "content-type": "application/json" } }),
    });
    let body: any = response.body;
    try {
      body = response.json();
    } catch {
      // non-JSON body: keep raw string
    }
    return { statusCode: response.statusCode, body };
  };
}

interface Scenario {
  sessionId: string;
  teacherName: string;
  quizId: string;
  questionId: string;
  correctAnswer: string;
}

/** Session (LIVE) + quiz with one keyed question, created over HTTP. */
async function makeScenario(instance: IndependentInstance): Promise<Scenario> {
  const request = requestOn(instance);
  // Non-hex correct answer so no-leak assertions cannot collide with UUIDs.
  const correctAnswer = "Berlin";
  // Phase 10.7: creation requires an authenticated owner; the registered
  // creator identity (teacherName) is reused by joinAs below.
  const { sessionId, creatorDisplayName: teacherName } = await registerAndCreateSession(
    instance.app,
    `Recovery ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );

  const quizResponse = await request("POST", `/sessions/${sessionId}/quizzes`, {
    title: "Recovery quiz",
    questions: [{ prompt: "Capital of Germany?", correctAnswer }],
  });
  expect(quizResponse.statusCode).toBe(201);
  const quiz = quizResponse.body.quiz as { id: string; questions: Array<{ id: string }> };
  await request("POST", `/sessions/${sessionId}/state`, { state: "LIVE" });

  return {
    sessionId,
    teacherName,
    quizId: quiz.id,
    questionId: quiz.questions[0]!.id,
    correctAnswer,
  };
}

describe("Reconnect & recovery (integration, Phase 5)", () => {
  let wsA: IndependentInstance;
  let wsB: IndependentInstance;
  let wsSolo: IndependentInstance; // distribution disabled: Redis-free recovery proof
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
    await prisma.$connect();
    wsA = await startIndependentInstance("ws-rec-a");
    wsB = await startIndependentInstance("ws-rec-b");
    wsSolo = await startIndependentInstance("ws-rec-solo", { distributionEnabled: false });
  });

  afterAll(async () => {
    await wsA.close();
    await wsB.close();
    await wsSolo.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it("R1 — basic disconnect/reconnect: same participant record, snapshot present", async () => {
    const scenario = await makeScenario(wsA);
    const first = await connectToInstance(wsA);
    const joined1 = await joinAs(first, scenario.sessionId, "Student-1");
    expect(joined1.participantId).not.toBeNull();

    await first.destroy(); // abrupt transport loss, no close handshake

    const second = await connectToInstance(wsA);
    const joined = await joinAs(second, scenario.sessionId, "Student-1");
    expect(joined.participantId).toBe(joined1.participantId); // record continuity
    const recovery = recoveryOf(joined.recovery);
    expect(recovery).not.toBeNull();
    expect(recovery!.quizzes).toHaveLength(1);
    expect(recovery!.quizzes[0]).toMatchObject({ quizId: scenario.quizId, state: "DRAFT" });
    expect(recovery!.question).toBeNull(); // nothing published yet
    expect(recovery!.ownAnswer).toBeNull();
    expect(recovery!.standings).toEqual([]);
    await second.close();
  });

  it("R2 — reconnect to a DIFFERENT instance recovers state and resumes participation", async () => {
    const scenario = await makeScenario(wsA);
    const teacher = await connectToInstance(wsA);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);

    const student = await connectToInstance(wsA);
    await joinAs(student, scenario.sessionId, "Student-1");
    await startQuizAndPublish(teacher, scenario.quizId, scenario.questionId);
    await student.waitFor((m) => m.type === "question.published");

    await student.destroy(); // drops AFTER publish: missed everything since

    // Reconnect to WS-B — never to the origin instance.
    const reconnected = await connectToInstance(wsB);
    const joined = await joinAs(reconnected, scenario.sessionId, "Student-1");
    expect(joined).toMatchObject({ state: "LIVE" });
    const recovery = recoveryOf(joined.recovery);
    expect(recovery!.question).toMatchObject({
      quizId: scenario.quizId,
      questionId: scenario.questionId,
      state: "PUBLISHED",
      acceptingAnswers: true,
      prompt: "Capital of Germany?",
    });

    // Participation continues on WS-B: the answer lands in PostgreSQL and the
    // teacher on WS-A still sees the verdict + leaderboard via Redis.
    reconnected.send({
      type: "quiz.answer",
      requestId: "a-after-reconnect",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });
    const verdict = await reconnected.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a-after-reconnect",
    );
    expect(verdict.payload).toMatchObject({ isCorrect: true, isWinner: true });
    const teacherSeen = await teacher.waitFor(
      (m) =>
        m.type === "leaderboard.updated" &&
        (m.payload as { standings: unknown[] }).standings.length > 0,
    );
    expect(teacherSeen.payload).toMatchObject({
      sessionId: scenario.sessionId,
      questionId: scenario.questionId,
    });

    await teacher.close();
    await reconnected.close();
  });

  it("R3 — events missed while disconnected are recovered from PostgreSQL, not replayed", async () => {
    const scenario = await makeScenario(wsA);
    const teacher = await connectToInstance(wsA);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);

    const student = await connectToInstance(wsA);
    await joinAs(student, scenario.sessionId, "Student-1");
    await student.destroy(); // BEFORE the events fire

    await startQuizAndPublish(teacher, scenario.quizId, scenario.questionId);

    const reconnected = await connectToInstance(wsB);
    const joined = await joinAs(reconnected, scenario.sessionId, "Student-1");
    const recovery = recoveryOf(joined.recovery);
    // The client never saw quiz.started / question.published; the snapshot
    // still reflects both durable effects.
    expect(recovery!.quizzes[0]).toMatchObject({ state: "ACTIVE" });
    expect(recovery!.question).toMatchObject({ state: "PUBLISHED", acceptingAnswers: true });

    // And NO missed event frames are replayed on top of the snapshot.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const leftovers = reconnected.drain();
    expect(leftovers.filter((m) => m.type === "quiz.started")).toHaveLength(0);
    expect(leftovers.filter((m) => m.type === "question.published")).toHaveLength(0);

    await teacher.close();
    await reconnected.close();
  });

  it("R4 — reconnect during an active quiz (question open) allows answering immediately", async () => {
    const scenario = await makeScenario(wsA);
    const teacher = await connectToInstance(wsA);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);

    const student = await connectToInstance(wsA);
    await joinAs(student, scenario.sessionId, "Student-1");
    await startQuizAndPublish(teacher, scenario.quizId, scenario.questionId);
    await student.destroy();

    const reconnected = await connectToInstance(wsA);
    const joined = await joinAs(reconnected, scenario.sessionId, "Student-1");
    expect(recoveryOf(joined.recovery)!.question).toMatchObject({ state: "PUBLISHED" });

    reconnected.send({
      type: "quiz.answer",
      requestId: "a-active",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });
    const verdict = await reconnected.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a-active",
    );
    expect(verdict.payload).toMatchObject({ isCorrect: true, isWinner: true });
    await teacher.close();
    await reconnected.close();
  });

  it("R5 — reconnect after question closure: snapshot shows CLOSED + standings; late answer rejected", async () => {
    const scenario = await makeScenario(wsA);
    const teacher = await connectToInstance(wsA);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);

    const early = await connectToInstance(wsA);
    await joinAs(early, scenario.sessionId, "Student-1");
    await startQuizAndPublish(teacher, scenario.quizId, scenario.questionId);
    early.send({
      type: "quiz.answer",
      requestId: "a-early",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });
    await early.waitFor((m) => m.type === "answer.accepted" && m.requestId === "a-early");

    // A second participant joins and drops before the question closes.
    const absent = await connectToInstance(wsA);
    await joinAs(absent, scenario.sessionId, "Student-2");
    await absent.destroy();

    teacher.send({
      type: "question.close",
      requestId: "tq2",
      payload: { questionId: scenario.questionId },
    });
    await teacher.waitFor((m) => m.type === "question.closed" && m.requestId === "tq2");

    const reconnected = await connectToInstance(wsB);
    const joined = await joinAs(reconnected, scenario.sessionId, "Student-2");
    const recovery = recoveryOf(joined.recovery);
    expect(recovery!.question).toMatchObject({
      questionId: scenario.questionId,
      state: "CLOSED",
      acceptingAnswers: false,
    });
    // Standings reflect the early answer (Student-1, the winner).
    expect(recovery!.standings).toHaveLength(1);
    expect(recovery!.standings[0]).toMatchObject({
      displayName: "Student-1",
      correctCount: 1,
      isWinner: true,
    });
    expect(recovery!.ownAnswer).toBeNull(); // Student-2 never answered

    // A late answer is correctly rejected (converged view says closed).
    reconnected.send({
      type: "quiz.answer",
      requestId: "a-late",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });
    const error = await reconnected.waitFor((m) => m.type === "error");
    expect(error.payload).toMatchObject({ code: "QUESTION_NOT_ACCEPTING_ANSWERS" });

    await teacher.close();
    await early.close();
    await reconnected.close();
  });

  it("R6 — lost answer verdict: committed answer is in recovery.ownAnswer; retry replays idempotently", async () => {
    const scenario = await makeScenario(wsA);
    const teacher = await connectToInstance(wsA);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);
    await startQuizAndPublish(teacher, scenario.quizId, scenario.questionId);

    const student = await connectToInstance(wsA);
    await joinAs(student, scenario.sessionId, "Student-1");
    // Answer and destroy before reading the verdict: the transaction commits
    // server-side, the client never learns the outcome.
    student.send({
      type: "quiz.answer",
      requestId: "a-lost",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });
    await student.destroy();

    // The answer is durable despite the dead socket (server success ≠ client ack).
    await waitForAsync(
      async () => (await prisma.answer.count({ where: { questionId: scenario.questionId } })) === 1,
    );

    const reconnected = await connectToInstance(wsB);
    const joined = await joinAs(reconnected, scenario.sessionId, "Student-1");
    const recovery = recoveryOf(joined.recovery);
    expect(recovery!.ownAnswer).toMatchObject({
      questionId: scenario.questionId,
      content: scenario.correctAnswer,
      isCorrect: true,
      isWinner: true,
      attemptNumber: 1,
    });

    // Retry after reconnect: idempotent replay of the stored verdict.
    reconnected.send({
      type: "quiz.answer",
      requestId: "a-retry",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });
    const replay = await reconnected.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a-retry",
    );
    expect(replay.payload).toMatchObject({ isCorrect: true, isWinner: true, attemptNumber: 1 });

    // Exactly one answer row, exactly one winner — a retry is not a second answer.
    expect(await prisma.answer.count({ where: { questionId: scenario.questionId } })).toBe(1);
    expect(
      await prisma.answer.count({ where: { questionId: scenario.questionId, isWinner: true } }),
    ).toBe(1);

    // No second broadcast: the teacher saw the original event frames only.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const teacherFrames = teacher.drain();
    expect(
      teacherFrames.filter((m) => m.type === "answer.accepted" && m.requestId === null),
    ).toHaveLength(1);

    await teacher.close();
    await reconnected.close();
  });

  it("R7 — duplicate connection with the same displayName: submissions stay idempotent, one winner", async () => {
    const scenario = await makeScenario(wsA);
    const teacher = await connectToInstance(wsA);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);
    await startQuizAndPublish(teacher, scenario.quizId, scenario.questionId);

    const clientA = await connectToInstance(wsA);
    const joinedA = await joinAs(clientA, scenario.sessionId, "Student-1");
    const clientB = await connectToInstance(wsB); // second socket, SAME displayName
    const joinedB = await joinAs(clientB, scenario.sessionId, "Student-1");
    expect(joinedB.participantId).toBe(joinedA.participantId); // same participant row

    clientA.send({
      type: "quiz.answer",
      requestId: "a-1",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });
    clientB.send({
      type: "quiz.answer",
      requestId: "b-1",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });

    const verdictA = await clientA.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a-1",
    );
    const verdictB = await clientB.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "b-1",
    );
    expect(verdictA.payload).toMatchObject({ isWinner: true });
    expect(verdictB.payload).toMatchObject({ isWinner: true }); // replayed stored verdict

    expect(await prisma.answer.count({ where: { questionId: scenario.questionId } })).toBe(1);
    expect(
      await prisma.answer.count({ where: { questionId: scenario.questionId, isWinner: true } }),
    ).toBe(1);

    await teacher.close();
    await clientA.close();
    await clientB.close();
  });

  it("R8 — multiple missed events: one rejoin returns quiz + closed question + standings", async () => {
    const scenario = await makeScenario(wsA);
    const teacher = await connectToInstance(wsA);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);

    const absent = await connectToInstance(wsA);
    await joinAs(absent, scenario.sessionId, "Student-1");
    await absent.destroy();

    // Four durable events fire while the client is gone.
    await startQuizAndPublish(teacher, scenario.quizId, scenario.questionId);
    teacher.send({
      type: "quiz.answer",
      requestId: "t-answer",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });
    await teacher.waitFor((m) => m.type === "answer.accepted" && m.requestId === "t-answer");
    teacher.send({
      type: "question.close",
      requestId: "tq2",
      payload: { questionId: scenario.questionId },
    });
    await teacher.waitFor((m) => m.type === "question.closed" && m.requestId === "tq2");

    const reconnected = await connectToInstance(wsB);
    const joined = await joinAs(reconnected, scenario.sessionId, "Student-1");
    const recovery = recoveryOf(joined.recovery);
    expect(recovery!.quizzes[0]).toMatchObject({ state: "ACTIVE" });
    expect(recovery!.question).toMatchObject({ state: "CLOSED", acceptingAnswers: false });
    expect(recovery!.standings).toHaveLength(1);
    expect(recovery!.standings[0]).toMatchObject({
      displayName: scenario.teacherName,
      isWinner: true,
    });
    expect(recovery!.ownAnswer).toBeNull(); // this participant never answered

    await teacher.close();
    await reconnected.close();
  });

  it("R9 — Redis-free instance: recovery works with the distribution layer disabled", async () => {
    const scenario = await makeScenario(wsSolo);
    const teacher = await connectToInstance(wsSolo);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);

    const student = await connectToInstance(wsSolo);
    await joinAs(student, scenario.sessionId, "Student-1");
    await startQuizAndPublish(teacher, scenario.quizId, scenario.questionId);
    await student.destroy();

    const reconnected = await connectToInstance(wsSolo);
    const joined = await joinAs(reconnected, scenario.sessionId, "Student-1");
    const recovery = recoveryOf(joined.recovery);
    expect(recovery!.question).toMatchObject({ state: "PUBLISHED" });

    reconnected.send({
      type: "quiz.answer",
      requestId: "a-solo",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });
    const verdict = await reconnected.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a-solo",
    );
    expect(verdict.payload).toMatchObject({ isCorrect: true, isWinner: true });
    expect(
      await prisma.answer.count({ where: { questionId: scenario.questionId, isWinner: true } }),
    ).toBe(1);

    await teacher.close();
    await reconnected.close();
  });

  it("R10 — completion criterion: participate on WS-A, WS-A stops, reconnect to WS-B, recover, continue", async () => {
    // Dedicated instances: stopping "A" must not tear down the shared
    // WS-A/WS-B that the other scenarios in this file still use.
    const instanceA = await startIndependentInstance("ws-rec-r10-a");
    const instanceB = await startIndependentInstance("ws-rec-r10-b");
    const scenario = await makeScenario(instanceA);
    const teacher = await connectToInstance(instanceA);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);
    await startQuizAndPublish(teacher, scenario.quizId, scenario.questionId);

    const student = await connectToInstance(instanceA);
    await joinAs(student, scenario.sessionId, "Student-1");
    student.send({
      type: "quiz.answer",
      requestId: "a-first",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });
    await student.waitFor((m) => m.type === "answer.accepted" && m.requestId === "a-first");

    // WS-A goes away; every local socket dies (graceful shutdown closes 1001).
    const studentClosed = student.closed();
    await instanceA.close();
    const closeInfo = await studentClosed;
    expect(closeInfo.code).toBe(1001);

    // Teacher reconnects to WS-B (their old instance no longer exists) and
    // recovers: quiz ACTIVE, question PUBLISHED, verdicts durable.
    const teacherB = await connectToInstance(instanceB);
    const joined = await joinAs(teacherB, scenario.sessionId, scenario.teacherName);
    const recovery = recoveryOf(joined.recovery);
    expect(recovery!.quizzes[0]).toMatchObject({ quizId: scenario.quizId, state: "ACTIVE" });
    expect(recovery!.question).toMatchObject({
      questionId: scenario.questionId,
      state: "PUBLISHED",
    });
    expect(recovery!.ownAnswer).toBeNull(); // the teacher did not answer; the student did

    // The student (new socket, WS-B) recovers their verdict from the snapshot.
    const studentB = await connectToInstance(instanceB);
    const studentJoined = await joinAs(studentB, scenario.sessionId, "Student-1");
    const studentRecovery = recoveryOf(studentJoined.recovery);
    expect(studentRecovery!.ownAnswer).toMatchObject({
      questionId: scenario.questionId,
      isCorrect: true,
      isWinner: true,
    });
    expect(studentRecovery!.standings).toHaveLength(1);

    // Live delivery resumes through WS-B: a close on B reaches both.
    teacherB.send({
      type: "question.close",
      requestId: "tb-close",
      payload: { questionId: scenario.questionId },
    });
    await teacherB.waitFor((m) => m.type === "question.closed" && m.requestId === "tb-close");
    await studentB.waitFor((m) => m.type === "question.closed");

    // Durable state stayed consistent across the whole crash/reconnect cycle.
    expect(
      await prisma.answer.count({ where: { questionId: scenario.questionId, isWinner: true } }),
    ).toBe(1);

    await teacherB.close();
    await studentB.close();
    await instanceB.close();
  });

  it("R11 — recovery adds no replay channel and no duplicate join frames", async () => {
    const scenario = await makeScenario(wsA);
    const teacher = await connectToInstance(wsA);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);

    const watcher = await connectToInstance(wsB);
    await joinAs(watcher, scenario.sessionId, "Watcher-1");
    await startQuizAndPublish(teacher, scenario.quizId, scenario.questionId);
    await watcher.waitFor((m) => m.type === "question.published");

    const reconnected = await connectToInstance(wsB);
    const joined = await joinAs(reconnected, scenario.sessionId, "Student-1");
    expect(recoveryOf(joined.recovery)!.question).toMatchObject({ state: "PUBLISHED" });

    // joinAs consumed exactly one session.joined; after the paired
    // session.state arrives, nothing else may be pending.
    await reconnected.waitFor((m) => m.type === "session.state");
    const joinFrames = reconnected.drain();
    expect(joinFrames.filter((m) => m.type === "session.joined")).toHaveLength(0);
    expect(joinFrames.filter((m) => m.type === "session.state")).toHaveLength(0);
    // No missed-event replay frames arrive with the snapshot.
    expect(joinFrames.filter((m) => m.type === "quiz.started")).toHaveLength(0);
    expect(joinFrames.filter((m) => m.type === "question.published")).toHaveLength(0);

    // One fresh event after recovery: exactly one copy to the recovering client.
    teacher.send({
      type: "question.close",
      requestId: "tq-close",
      payload: { questionId: scenario.questionId },
    });
    await reconnected.waitFor((m) => m.type === "question.closed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The close was delivered exactly once overall: waitFor consumed one,
    // and the drain must not contain another.
    expect(reconnected.drain().filter((m) => m.type === "question.closed")).toHaveLength(0);

    await teacher.close();
    await watcher.close();
    await reconnected.close();
  });
});

describe("Recovery edge cases (integration, Phase 5)", () => {
  let wsA: IndependentInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
    await prisma.$connect();
    wsA = await startIndependentInstance("ws-rec-edge");
  });

  afterAll(async () => {
    await wsA.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it("recovery is null before any quiz exists; DRAFT questions never appear in the snapshot", async () => {
    const request = requestOn(wsA);
    const { sessionId } = await registerAndCreateSession(
      wsA.app,
      `Edge ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );

    const client = await connectToInstance(wsA);
    const joined = await joinAs(client, sessionId);
    expect(joined.recovery).toBeNull(); // no quizzes yet

    // A quiz exists now; a second connection gets a snapshot with quizzes,
    // but DRAFT questions never appear as the current question.
    await request("POST", `/sessions/${sessionId}/quizzes`, {
      title: "Late quiz",
      questions: [{ prompt: "Q", correctAnswer: "42" }],
    });
    const second = await connectToInstance(wsA);
    const joined2 = await joinAs(second, sessionId, "Student-1");
    const recovery = recoveryOf(joined2.recovery);
    expect(recovery).not.toBeNull();
    expect(recovery!.quizzes).toHaveLength(1);
    expect(recovery!.quizzes[0]).toMatchObject({ state: "DRAFT" });
    expect(recovery!.question).toBeNull();
    expect(recovery!.standings).toEqual([]);

    await client.close();
    await second.close();
  });

  it("view-only joins get a snapshot without ownAnswer", async () => {
    const request = requestOn(wsA);
    const { sessionId } = await registerAndCreateSession(
      wsA.app,
      `View ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    await request("POST", `/sessions/${sessionId}/quizzes`, {
      title: "Viewed quiz",
      questions: [{ prompt: "Q", correctAnswer: "42" }],
    });

    const viewer = await connectToInstance(wsA);
    const joined = await joinAs(viewer, sessionId); // no participant: view-only
    const recovery = recoveryOf(joined.recovery);
    expect(recovery).not.toBeNull();
    expect(recovery!.quizzes).toHaveLength(1);
    expect(recovery!.ownAnswer).toBeNull();
    await viewer.close();
  });
});
