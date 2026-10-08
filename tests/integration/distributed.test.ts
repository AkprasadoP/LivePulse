import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  TEST_DATABASE_URL,
  resetDatabase,
  startIndependentInstance,
  connectToInstance,
  joinAs,
  registerAndCreateSession,
  WsTestClient,
  waitForAsync,
  type IndependentInstance,
} from "./helpers.js";

/**
 * Phase 4 distributed tests: two REAL independent app instances (separate
 * processes-worth of state: own registries, own Redis connections) sharing
 * the Dockerized PostgreSQL + Redis. Proves the milestone: an event caused
 * by a client on WS-A is observed by a client on WS-B, while PostgreSQL
 * remains the only source of truth.
 */
describe("Cross-instance distribution (integration)", () => {
  let wsA: IndependentInstance;
  let wsB: IndependentInstance;
  let prisma: PrismaClient;

  /** HTTP helper bound to a specific instance. */
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

  /** Full scenario setup bound to specific instances. */
  async function makeScenario(a: IndependentInstance, b: IndependentInstance) {
    const requestA = requestOn(a);
    // Correct answer deliberately NON-hex ("Berlin") so the no-leak assertion
    // cannot collide with UUID hex characters.
    const correctAnswer = "Berlin";
    // Phase 10.7: creation requires an authenticated owner; the registered
    // creator identity (teacherName) is reused by joinAs below.
    const { sessionId, creatorDisplayName: teacherName } = await registerAndCreateSession(
      a.app,
      `Dist ${Date.now()}`,
    );

    const quizResponse = await requestA("POST", `/sessions/${sessionId}/quizzes`, {
      title: "Distribution quiz",
      questions: [{ prompt: "Q1", correctAnswer }],
    });
    expect(quizResponse.statusCode).toBe(201);
    const quiz = quizResponse.body.quiz as { id: string; questions: Array<{ id: string }> };

    const live = await requestA("POST", `/sessions/${sessionId}/state`, { state: "LIVE" });
    expect(live.statusCode).toBe(200);
    void b;
    // correctAnswer stays non-hex ("Berlin") so the no-leak assertion in
    // Test A cannot collide with UUID hex characters; submissions send it
    // verbatim so isWinner/exactly-one-winner assertions hold.
    return {
      sessionId,
      teacherName,
      quizId: quiz.id,
      questionId: quiz.questions[0]!.id,
      correctAnswer,
    };
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
    await prisma.$connect();
    wsA = await startIndependentInstance("ws-test-a");
    wsB = await startIndependentInstance("ws-test-b");
  });

  afterAll(async () => {
    await wsA.close();
    await wsB.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it("Test A — teacher on WS-A publishes; student on WS-B receives the question", async () => {
    const scenario = await makeScenario(wsA, wsB);
    const teacher = await connectToInstance(wsA);
    const student = await connectToInstance(wsB);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);
    await joinAs(student, scenario.sessionId, "Student-1");

    teacher.send({ type: "quiz.start", requestId: "q0", payload: { quizId: scenario.quizId } });
    await student.waitFor((m) => m.type === "quiz.started");

    teacher.send({
      type: "question.publish",
      requestId: "q1",
      payload: { questionId: scenario.questionId },
    });
    const published = await student.waitFor((m) => m.type === "question.published");
    expect(published.payload).toMatchObject({
      sessionId: scenario.sessionId,
      questionId: scenario.questionId,
      acceptingAnswers: true,
    });
    expect(JSON.stringify(published.payload)).not.toContain(scenario.correctAnswer); // no answer leak
    expect(published.requestId).toBeNull(); // remote events are server-initiated

    await teacher.close();
    await student.close();
  });

  it("Test B — student on WS-A answers; teacher on WS-B receives the verdict", async () => {
    const scenario = await makeScenario(wsA, wsB);
    const teacher = await connectToInstance(wsB);
    const student = await connectToInstance(wsA);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);
    await joinAs(student, scenario.sessionId, "Student-1");

    teacher.send({ type: "quiz.start", requestId: "q0", payload: { quizId: scenario.quizId } });
    await student.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q1",
      payload: { questionId: scenario.questionId },
    });
    await student.waitFor((m) => m.type === "question.published");

    student.send({
      type: "quiz.answer",
      requestId: "a1",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });
    const broadcast = await teacher.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === null,
    );
    expect(broadcast.payload).toMatchObject({
      sessionId: scenario.sessionId,
      questionId: scenario.questionId,
      isCorrect: true,
      isWinner: true,
    });
    // The submitting student still got the targeted verdict from WS-A.
    const verdict = await student.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a1",
    );
    expect(verdict.payload).toMatchObject({ isWinner: true });

    await teacher.close();
    await student.close();
  });

  it("Test C — leaderboard.updated reaches clients on the other instance", async () => {
    const scenario = await makeScenario(wsA, wsB);
    const teacher = await connectToInstance(wsB);
    const student = await connectToInstance(wsA);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);
    await joinAs(student, scenario.sessionId, "Student-1");

    teacher.send({ type: "quiz.start", requestId: "q0", payload: { quizId: scenario.quizId } });
    await student.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q1",
      payload: { questionId: scenario.questionId },
    });
    await student.waitFor((m) => m.type === "question.published");

    student.send({
      type: "quiz.answer",
      requestId: "a1",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });
    const leaderboard = await teacher.waitFor(
      (m) =>
        m.type === "leaderboard.updated" &&
        Array.isArray((m.payload as { standings: unknown[] }).standings) &&
        (m.payload as { standings: unknown[] }).standings.length > 0,
    );
    expect(leaderboard.payload).toMatchObject({
      sessionId: scenario.sessionId,
      questionId: scenario.questionId,
      standings: [{ displayName: "Student-1", correctCount: 1, isWinner: true }],
    });

    await teacher.close();
    await student.close();
  });

  it("Test D — the originating instance still delivers to its own local clients", async () => {
    const scenario = await makeScenario(wsA, wsB);
    const teacherA = await connectToInstance(wsA);
    const studentA = await connectToInstance(wsA); // BOTH on the origin instance
    await joinAs(teacherA, scenario.sessionId, scenario.teacherName);
    await joinAs(studentA, scenario.sessionId, "Student-1");

    teacherA.send({ type: "quiz.start", requestId: "q0", payload: { quizId: scenario.quizId } });
    await studentA.waitFor((m) => m.type === "quiz.started");
    teacherA.send({
      type: "question.publish",
      requestId: "q1",
      payload: { questionId: scenario.questionId },
    });
    const published = await studentA.waitFor((m) => m.type === "question.published");
    expect(published.payload).toMatchObject({ questionId: scenario.questionId });

    await teacherA.close();
    await studentA.close();
  });

  it("Test E — no duplicate delivery: a local client sees exactly one broadcast per event", async () => {
    const scenario = await makeScenario(wsA, wsB);
    const teacherA = await connectToInstance(wsA);
    const studentA = await connectToInstance(wsA); // local client on origin
    const studentB = await connectToInstance(wsB); // remote client
    await joinAs(teacherA, scenario.sessionId, scenario.teacherName);
    await joinAs(studentA, scenario.sessionId, "Student-1");
    await joinAs(studentB, scenario.sessionId, "Student-2");

    teacherA.send({ type: "quiz.start", requestId: "q0", payload: { quizId: scenario.quizId } });
    await studentA.waitFor((m) => m.type === "quiz.started");
    await studentB.waitFor((m) => m.type === "quiz.started");
    teacherA.send({
      type: "question.publish",
      requestId: "q1",
      payload: { questionId: scenario.questionId },
    });
    await studentA.waitFor((m) => m.type === "question.published");
    await studentB.waitFor((m) => m.type === "question.published");

    studentA.send({
      type: "quiz.answer",
      requestId: "a1",
      payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
    });
    const verdict = await studentA.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a1",
    );
    expect(verdict.payload).toMatchObject({ isWinner: true });

    // Let everything settle (local broadcasts + the Redis round-trip).
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The local client received exactly ONE broadcast answer.accepted
    // (requestId null). The submitter's targeted verdict was requestId "a1"
    // and is counted separately.
    const localFrames = studentA.drain().concat(); // drain collects leftovers
    const broadcastAccepts = localFrames.filter(
      (m) => m.type === "answer.accepted" && m.requestId === null,
    );
    expect(broadcastAccepts).toHaveLength(1);

    // Remote client: exactly one broadcast copy as well.
    const remoteFrames = studentB.drain();
    const remoteAccepts = remoteFrames.filter((m) => m.type === "answer.accepted");
    expect(remoteAccepts).toHaveLength(1);

    await teacherA.close();
    await studentA.close();
    await studentB.close();
  });

  it("cross-instance race: concurrent answers on BOTH instances still elect exactly one winner", async () => {
    const scenario = await makeScenario(wsA, wsB);
    const teacher = await connectToInstance(wsA);
    await joinAs(teacher, scenario.sessionId, scenario.teacherName);
    teacher.send({ type: "quiz.start", requestId: "q0", payload: { quizId: scenario.quizId } });
    await teacher.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q1",
      payload: { questionId: scenario.questionId },
    });
    await teacher.waitFor((m) => m.type === "question.published");

    // 20 students, split across the two instances, all answering in one tick.
    const clients: WsTestClient[] = [];
    try {
      for (let i = 0; i < 20; i += 1) {
        const instance = i % 2 === 0 ? wsA : wsB;
        const client = await connectToInstance(instance);
        clients.push(client);
        await joinAs(client, scenario.sessionId, `Racer-${i}`);
      }
      for (const [index, client] of clients.entries()) {
        client.send({
          type: "quiz.answer",
          requestId: `a-${index}`,
          payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
        });
      }

      // All 20 answers persisted; exactly one winner (PostgreSQL-enforced).
      await waitForAsync(
        () =>
          prisma.answer.count({ where: { questionId: scenario.questionId } }).then((n) => n === 20),
        10_000,
      );
      const winners = await prisma.answer.count({
        where: { questionId: scenario.questionId, isWinner: true },
      });
      expect(winners).toBe(1);
      const total = await prisma.answer.count({ where: { questionId: scenario.questionId } });
      expect(total).toBe(20);
    } finally {
      await Promise.allSettled(clients.map((c) => c.close()));
      await teacher.close();
    }
  });

  it("shutdown closes Redis connections and resolves cleanly (regression)", async () => {
    const instance = await startIndependentInstance("ws-test-shutdown");
    const client = await connectToInstance(instance);
    const scenario = await makeScenario(instance, wsB);
    await joinAs(client, scenario.sessionId, "Student-1");
    const openBefore = instance.app.wsLayer?.connectionCount ?? -1;
    expect(openBefore).toBe(1);

    // Register the close expectation BEFORE shutdown: instance.close()
    // resolves only after the sockets are already gone, so awaiting 'close'
    // afterwards would attach to a socket that already fired 'close' and
    // hang forever.
    const clientClosed = client.closed();
    const closePromise = instance.close();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("shutdown hung")), 5_000),
    );
    await Promise.race([closePromise, timeout]);
    // A second close (Fastify re-entry) must be safe/no-op-ish, not hang.
    await instance.close().catch(() => {});
    await clientClosed;
  });
});

describe("Redis-unavailable degradation (integration)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it("a disabled-distribution instance serves its local clients fully", async () => {
    // DISTRIBUTION_ENABLED=false = the degraded-mode shape without needing to
    // kill the shared compose Redis mid-run: no Redis usage at all, local
    // delivery and PostgreSQL commit unaffected.
    const solo = await startIndependentInstance("ws-solo", { distributionEnabled: false });
    const peer = await startIndependentInstance("ws-peer");

    const requestSolo = async (method: "GET" | "POST", url: string, payload?: unknown) => {
      const response = await solo.app.inject({
        method,
        url,
        ...(payload === undefined
          ? {}
          : { payload: JSON.stringify(payload), headers: { "content-type": "application/json" } }),
      });
      return { statusCode: response.statusCode, body: response.json() as any };
    };
    const { sessionId, creatorDisplayName: teacherName } = await registerAndCreateSession(
      solo.app,
      `Solo ${Date.now()}`,
    );
    const quizResponse = await requestSolo("POST", `/sessions/${sessionId}/quizzes`, {
      title: "Solo quiz",
      questions: [{ prompt: "Q", correctAnswer: "42" }],
    });
    const quiz = quizResponse.body.quiz as { id: string; questions: Array<{ id: string }> };
    await requestSolo("POST", `/sessions/${sessionId}/state`, { state: "LIVE" });

    const teacher = await connectToInstance(solo);
    const student = await connectToInstance(solo);
    const remote = await connectToInstance(peer);
    await joinAs(teacher, sessionId, teacherName);
    await joinAs(student, sessionId, "Student-1");
    await joinAs(remote, sessionId, "Student-2");

    teacher.send({ type: "quiz.start", requestId: "q0", payload: { quizId: quiz.id } });
    await student.waitFor((m) => m.type === "quiz.started");
    teacher.send({
      type: "question.publish",
      requestId: "q1",
      payload: { questionId: quiz.questions[0]!.id },
    });
    await student.waitFor((m) => m.type === "question.published");

    student.send({
      type: "quiz.answer",
      requestId: "a1",
      payload: { questionId: quiz.questions[0]!.id, content: "42" },
    });
    const verdict = await student.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === "a1",
    );
    expect(verdict.payload).toMatchObject({ isWinner: true });
    // Local broadcast still works.
    const local = await teacher.waitFor(
      (m) => m.type === "answer.accepted" && m.requestId === null,
    );
    expect(local.payload).toMatchObject({ isWinner: true });

    // The peer instance never receives anything (its Redis subscription gets
    // no publish from the degraded instance).
    const remoteFrames = remote.drain();
    expect(remoteFrames.filter((m) => m.type === "answer.accepted")).toHaveLength(0);

    // PostgreSQL has the truth regardless.
    const winners = await prisma.answer.count({ where: { isWinner: true } });
    expect(winners).toBe(1);

    await solo.close();
    await peer.close();
  });
});
