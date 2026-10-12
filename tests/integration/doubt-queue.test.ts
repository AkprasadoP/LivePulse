import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  TEST_DATABASE_URL,
  resetDatabase,
  startIndependentInstance,
  connectToInstance,
  joinAs,
  registerAndCreateSession,
  bearerHeaders,
  waitForAsync,
  type IndependentInstance,
} from "./helpers.js";

/**
 * Phase 6 doubt queue tests (ADR-007): PostgreSQL is the queue's source of
 * truth, ordering is the server-assigned per-session `enqueueSeq`, and Redis
 * is notification only.
 *
 * The decisive test is Q3: a 100-way create race split across two real
 * independent instances must produce enqueueSeq exactly {1..100} — proving the
 * ordering guarantee survives concurrent execution, not just in theory.
 */

/** A LIVE session with one teacher participant, created over HTTP. */
async function makeLiveSession(instance: IndependentInstance): Promise<{
  sessionId: string;
  teacherName: string;
}> {
  const request = async (
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => {
    const response = await instance.app.inject({
      method,
      url,
      ...(payload === undefined
        ? {}
        : {
            payload: JSON.stringify(payload),
            headers: { "content-type": "application/json", ...(headers ?? {}) },
          }),
    });
    let body: any = response.body;
    try {
      body = response.json();
    } catch {
      // non-JSON body: keep raw string
    }
    return { statusCode: response.statusCode, body };
  };

  // Phase 10.7: creation requires an authenticated owner; the registered
  // creator identity (teacherName) is reused by joinAs at the call sites.
  // Phase 11: the state transition is creator-only, so send the owner token.
  const {
    sessionId,
    creatorDisplayName: teacherName,
    accessToken,
  } = await registerAndCreateSession(
    instance.app,
    `Doubt ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  const live = await request(
    "POST",
    `/sessions/${sessionId}/state`,
    { state: "LIVE" },
    bearerHeaders(accessToken),
  );
  expect(live.statusCode).toBe(200);
  return { sessionId, teacherName };
}

describe("Doubt queue (integration, Phase 6)", () => {
  let wsA: IndependentInstance;
  let wsB: IndependentInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
    await prisma.$connect();
    wsA = await startIndependentInstance("ws-doubt-a");
    wsB = await startIndependentInstance("ws-doubt-b");
  });

  afterAll(async () => {
    await wsA.close();
    await wsB.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it("Q1 — create broadcasts to the session and persists one durable row", async () => {
    const { sessionId, teacherName } = await makeLiveSession(wsA);
    const teacher = await connectToInstance(wsA);
    const student = await connectToInstance(wsA);
    await joinAs(teacher, sessionId, teacherName);
    const joined = await joinAs(student, sessionId, "Student-1");

    student.send({
      type: "doubt.create",
      requestId: "d1",
      payload: { content: "Why is the sky blue?" },
    });
    const created = await student.waitFor(
      (m) => m.type === "doubt.created" && m.requestId === "d1",
    );
    expect(created.payload).toMatchObject({
      sessionId,
      doubt: {
        participantId: joined.participantId,
        displayName: "Student-1",
        content: "Why is the sky blue?",
        priority: 0,
        enqueueSeq: 1,
        status: "OPEN",
      },
    });
    // The teacher (same instance) observes the broadcast too.
    await teacher.waitFor((m) => m.type === "doubt.created" && m.requestId === null);

    const rows = await prisma.doubt.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ enqueueSeq: 1, status: "OPEN" });

    await teacher.close();
    await student.close();
  });

  it("Q2 — doubt created on WS-A is delivered to a student on WS-B", async () => {
    const { sessionId, teacherName } = await makeLiveSession(wsA);
    const teacher = await connectToInstance(wsA);
    const studentB = await connectToInstance(wsB);
    await joinAs(teacher, sessionId, teacherName);
    await joinAs(studentB, sessionId, "Student-1");

    teacher.send({
      type: "doubt.create",
      requestId: "d1",
      payload: { content: "cross-instance?" },
    });
    const seen = await studentB.waitFor((m) => m.type === "doubt.created");
    expect(seen.requestId).toBeNull(); // remote events are server-initiated
    expect(seen.payload).toMatchObject({
      sessionId,
      doubt: { content: "cross-instance?", enqueueSeq: 1, status: "OPEN" },
    });

    await teacher.close();
    await studentB.close();
  });

  it("Q3 — 100 concurrent creates across BOTH instances get enqueueSeq exactly 1..100", async () => {
    const { sessionId, teacherName } = await makeLiveSession(wsA);
    const teacher = await connectToInstance(wsA);
    await joinAs(teacher, sessionId, teacherName);

    const N = 100;
    const students = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const client = await connectToInstance(i % 2 === 0 ? wsA : wsB);
        await joinAs(client, sessionId, `Student-${i}`);
        return client;
      }),
    );

    // Fire all creates with no interleaved awaits: a genuine concurrency race.
    students.forEach((client, i) => {
      client.send({ type: "doubt.create", requestId: `c${i}`, payload: { content: `doubt-${i}` } });
    });

    await waitForAsync(
      async () => (await prisma.doubt.count({ where: { sessionId } })) === N,
      10_000,
    );

    const rows = await prisma.doubt.findMany({
      where: { sessionId },
      orderBy: { enqueueSeq: "asc" },
      select: { enqueueSeq: true },
    });
    // The ordering guarantee, proven under concurrent execution: every create
    // was durably accepted exactly once and enqueueSeq is a dense 1..N — no
    // duplicates (session row lock) and no gaps (sequence allocated in-tx).
    expect(rows.map((r) => r.enqueueSeq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    // The canonical queue read is a strict total order by enqueueSeq.
    const queue = await prisma.doubt.findMany({
      where: { sessionId, status: "OPEN" },
      orderBy: [{ priority: "desc" }, { enqueueSeq: "asc" }],
      select: { enqueueSeq: true },
    });
    expect(queue.map((r) => r.enqueueSeq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    await teacher.close();
    await Promise.all(students.map((c) => c.close()));
  });

  it("Q4 — retried create with the same clientDoubtId is idempotent (no second row, no re-broadcast)", async () => {
    const { sessionId, teacherName } = await makeLiveSession(wsA);
    const teacher = await connectToInstance(wsA);
    const student = await connectToInstance(wsA);
    await joinAs(teacher, sessionId, teacherName);
    await joinAs(student, sessionId, "Student-1");

    student.send({
      type: "doubt.create",
      requestId: "a",
      payload: { content: "retry me", clientDoubtId: "retry-1" },
    });
    const first = await student.waitFor((m) => m.type === "doubt.created" && m.requestId === "a");

    student.send({
      type: "doubt.create",
      requestId: "b",
      payload: { content: "retry me", clientDoubtId: "retry-1" },
    });
    const replay = await student.waitFor((m) => m.type === "doubt.created" && m.requestId === "b");
    expect((replay.payload as { doubt: { doubtId: string } }).doubt.doubtId).toBe(
      (first.payload as { doubt: { doubtId: string } }).doubt.doubtId,
    );

    // One durable row; the retry did not consume a new sequence number.
    const rows = await prisma.doubt.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enqueueSeq).toBe(1);

    // The teacher saw exactly ONE broadcast (the retry replayed privately only).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(teacher.drain().filter((m) => m.type === "doubt.created")).toHaveLength(1);

    await teacher.close();
    await student.close();
  });

  it("Q5 — concurrent identical creates with the same clientDoubtId produce exactly one row", async () => {
    const { sessionId, teacherName } = await makeLiveSession(wsA);
    const teacher = await connectToInstance(wsA);
    // Two sockets bound to the SAME participant (same displayName), fired
    // simultaneously with the same idempotency key: the in-lock check must
    // serialize them so only one row is inserted.
    const student1 = await connectToInstance(wsA);
    const student2 = await connectToInstance(wsB);
    await joinAs(teacher, sessionId, teacherName);
    const joined1 = await joinAs(student1, sessionId, "Student-1");
    const joined2 = await joinAs(student2, sessionId, "Student-1");
    expect(joined2.participantId).toBe(joined1.participantId);

    student1.send({
      type: "doubt.create",
      requestId: "x",
      payload: { content: "same", clientDoubtId: "dup" },
    });
    student2.send({
      type: "doubt.create",
      requestId: "y",
      payload: { content: "same", clientDoubtId: "dup" },
    });
    await Promise.all([
      student1.waitFor((m) => m.type === "doubt.created" && m.requestId === "x"),
      student2.waitFor((m) => m.type === "doubt.created" && m.requestId === "y"),
    ]);

    expect(await prisma.doubt.count({ where: { sessionId } })).toBe(1);

    await teacher.close();
    await student1.close();
    await student2.close();
  });

  it("Q6 — two teachers resolving the same doubt: exactly one transitions it", async () => {
    const { sessionId, teacherName } = await makeLiveSession(wsA);
    const teacher1 = await connectToInstance(wsA);
    const teacher2 = await connectToInstance(wsB);
    const watcher = await connectToInstance(wsA);
    await joinAs(teacher1, sessionId, teacherName);
    await joinAs(teacher2, sessionId, teacherName); // same teacher identity
    await joinAs(watcher, sessionId, "Watcher-1");

    watcher.send({ type: "doubt.create", requestId: "c", payload: { content: "resolve race" } });
    const created = await watcher.waitFor((m) => m.type === "doubt.created" && m.requestId === "c");
    const doubtId = (created.payload as { doubt: { doubtId: string } }).doubt.doubtId;

    teacher1.send({
      type: "doubt.resolve",
      requestId: "r1",
      payload: { doubtId, explanation: "Test explanation" },
    });
    teacher2.send({
      type: "doubt.resolve",
      requestId: "r2",
      payload: { doubtId, explanation: "Test explanation 2" },
    });

    // Both eventually observe the terminal state; exactly one of them got the
    // DOUBT_NOT_OPEN rejection. We must wait for the specific requestId to avoid
    // matching the session broadcast that both teachers receive.
    const [res1, res2] = await Promise.all([
      teacher1.waitFor(
        (m) => (m.type === "doubt.resolved" || m.type === "error") && m.requestId === "r1",
      ),
      teacher2.waitFor(
        (m) => (m.type === "doubt.resolved" || m.type === "error") && m.requestId === "r2",
      ),
    ]);
    console.log("Q6 res1:", JSON.stringify(res1));
    console.log("Q6 res2:", JSON.stringify(res2));
    const errors = [res1, res2].filter(
      (m) => m.type === "error" && m.payload.code === "DOUBT_NOT_OPEN",
    );
    expect(errors).toHaveLength(1);

    const row = await prisma.doubt.findUnique({ where: { id: doubtId } });
    expect(row?.status).toBe("RESOLVED");
    expect(row?.resolvedAt).not.toBeNull();

    // The watcher saw exactly one doubt.resolved broadcast (the loser is silent).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(watcher.drain().filter((m) => m.type === "doubt.resolved")).toHaveLength(1);

    await teacher1.close();
    await teacher2.close();
    await watcher.close();
  });

  it("Q7 — resolve racing dismiss never yields two terminal states", async () => {
    const { sessionId, teacherName } = await makeLiveSession(wsA);
    const teacher1 = await connectToInstance(wsA);
    const teacher2 = await connectToInstance(wsB);
    await joinAs(teacher1, sessionId, teacherName);
    await joinAs(teacher2, sessionId, teacherName);

    teacher1.send({ type: "doubt.create", requestId: "c", payload: { content: "r vs d" } });
    const created = await teacher1.waitFor(
      (m) => m.type === "doubt.created" && m.requestId === "c",
    );
    const doubtId = (created.payload as { doubt: { doubtId: string } }).doubt.doubtId;

    teacher1.send({
      type: "doubt.resolve",
      requestId: "r1",
      payload: { doubtId, explanation: "Resolving with explanation" },
    });
    teacher2.send({ type: "doubt.dismiss", requestId: "d2", payload: { doubtId } });
    await Promise.all([
      teacher1.waitFor(
        (m) => (m.type === "doubt.resolved" || m.type === "error") && m.requestId === "r1",
      ),
      teacher2.waitFor(
        (m) => (m.type === "doubt.dismissed" || m.type === "error") && m.requestId === "d2",
      ),
    ]);

    // Exactly one terminal status on the single row.
    const row = await prisma.doubt.findUnique({ where: { id: doubtId } });
    expect(["RESOLVED", "DISMISSED"]).toContain(row?.status);
    expect(
      await prisma.doubt.count({ where: { sessionId, status: { in: ["RESOLVED", "DISMISSED"] } } }),
    ).toBe(1);

    await teacher1.close();
    await teacher2.close();
  });

  it("Q8 — a student cannot resolve a doubt (TEACHER_REQUIRED)", async () => {
    const { sessionId, teacherName } = await makeLiveSession(wsA);
    const teacher = await connectToInstance(wsA);
    const s1 = await connectToInstance(wsA);
    const s2 = await connectToInstance(wsA);
    await joinAs(teacher, sessionId, teacherName);
    await joinAs(s1, sessionId, "Student-1");
    await joinAs(s2, sessionId, "Student-2");

    s1.send({ type: "doubt.create", requestId: "c", payload: { content: "mine" } });
    const created = await s1.waitFor((m) => m.type === "doubt.created" && m.requestId === "c");
    const doubtId = (created.payload as { doubt: { doubtId: string } }).doubt.doubtId;

    s2.send({
      type: "doubt.resolve",
      requestId: "bad",
      payload: { doubtId, explanation: "Student attempting to resolve" },
    });
    const error = await s2.waitFor((m) => m.type === "error");
    expect(error.payload).toMatchObject({ code: "TEACHER_REQUIRED" });

    const row = await prisma.doubt.findUnique({ where: { id: doubtId } });
    expect(row?.status).toBe("OPEN");

    await teacher.close();
    await s1.close();
    await s2.close();
  });

  it("Q9 — cross-session doubt is indistinguishable from unknown (DOUBT_NOT_FOUND)", async () => {
    const a = await makeLiveSession(wsA);
    const b = await makeLiveSession(wsA);
    const teacherA = await connectToInstance(wsA);
    const teacherB = await connectToInstance(wsA);
    await joinAs(teacherA, a.sessionId, a.teacherName);
    await joinAs(teacherB, b.sessionId, b.teacherName);

    teacherA.send({ type: "doubt.create", requestId: "c", payload: { content: "session A" } });
    const created = await teacherA.waitFor(
      (m) => m.type === "doubt.created" && m.requestId === "c",
    );
    const doubtId = (created.payload as { doubt: { doubtId: string } }).doubt.doubtId;

    // Teacher of session B tries to resolve a doubt that belongs to session A.
    teacherB.send({
      type: "doubt.resolve",
      requestId: "bad",
      payload: { doubtId, explanation: "Cross-session attempt" },
    });
    const error = await teacherB.waitFor((m) => m.type === "error");
    expect(error.payload).toMatchObject({ code: "DOUBT_NOT_FOUND" });

    expect((await prisma.doubt.findUnique({ where: { id: doubtId } }))?.status).toBe("OPEN");

    await teacherA.close();
    await teacherB.close();
  });

  it("Q10 — doubt.create on a non-LIVE session is refused (SESSION_NOT_LIVE)", async () => {
    // Session created but never moved to LIVE.
    const request = async (method: "GET" | "POST", url: string, payload?: unknown) => {
      const response = await wsA.app.inject({
        method,
        url,
        ...(payload === undefined
          ? {}
          : { payload: JSON.stringify(payload), headers: { "content-type": "application/json" } }),
      });
      return { statusCode: response.statusCode, body: response.json() as any };
    };
    const { sessionId, creatorDisplayName: teacherName } = await registerAndCreateSession(
      wsA.app,
      `NotLive ${Date.now()}`,
    );

    const teacher = await connectToInstance(wsA);
    await joinAs(teacher, sessionId, teacherName);
    teacher.send({ type: "doubt.create", requestId: "c", payload: { content: "too early" } });
    const error = await teacher.waitFor((m) => m.type === "error");
    expect(error.payload).toMatchObject({ code: "SESSION_NOT_LIVE" });
    expect(await prisma.doubt.count({ where: { sessionId } })).toBe(0);
    await teacher.close();
  });

  it("Q11 — recovery carries the OPEN queue in canonical order (cap is a payload bound)", async () => {
    const { sessionId, teacherName } = await makeLiveSession(wsA);
    const teacher = await connectToInstance(wsA);
    const student = await connectToInstance(wsA);
    await joinAs(teacher, sessionId, teacherName);
    await joinAs(student, sessionId, "Student-1");

    // 101 doubts: more than the 100-doubt snapshot cap.
    for (let i = 0; i < 101; i += 1) {
      student.send({
        type: "doubt.create",
        requestId: `c${i}`,
        payload: { content: `doubt-${i}` },
      });
      await student.waitFor((m) => m.type === "doubt.created" && m.requestId === `c${i}`);
    }

    // PostgreSQL keeps every row: the cap is transport, not capacity.
    expect(await prisma.doubt.count({ where: { sessionId, status: "OPEN" } })).toBe(101);

    const reconnected = await connectToInstance(wsB);
    const joined = await joinAs(reconnected, sessionId, "Student-2");
    const recovery = (
      joined.recovery as {
        doubts: { open: Array<{ enqueueSeq: number; content: string }>; truncated: boolean };
      }
    ).doubts;
    expect(recovery.open).toHaveLength(100);
    expect(recovery.truncated).toBe(true);
    expect(recovery.open.map((d) => d.enqueueSeq)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );

    await teacher.close();
    await student.close();
    await reconnected.close();
  });

  it("Q12 — doubt.queue.list returns the ordered OPEN queue privately (not broadcast)", async () => {
    const { sessionId, teacherName } = await makeLiveSession(wsA);
    const teacher = await connectToInstance(wsA);
    const student = await connectToInstance(wsA);
    await joinAs(teacher, sessionId, teacherName);
    await joinAs(student, sessionId, "Student-1");

    for (let i = 0; i < 3; i += 1) {
      student.send({ type: "doubt.create", requestId: `c${i}`, payload: { content: `q${i}` } });
      await student.waitFor((m) => m.type === "doubt.created" && m.requestId === `c${i}`);
    }

    student.send({ type: "doubt.queue.list", requestId: "list", payload: {} });
    const listed = await student.waitFor(
      (m) => m.type === "doubt.queue.updated" && m.requestId === "list",
    );
    expect(listed.payload).toMatchObject({ sessionId, truncated: false });
    expect(
      (listed.payload as { doubts: Array<{ enqueueSeq: number }> }).doubts.map((d) => d.enqueueSeq),
    ).toEqual([1, 2, 3]);

    // Private response: the teacher never receives doubt.queue.updated.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(teacher.drain().filter((m) => m.type === "doubt.queue.updated")).toHaveLength(0);

    await teacher.close();
    await student.close();
  });

  it("Q13 — resolve on WS-A propagates to a client on WS-B with the terminal status", async () => {
    const { sessionId, teacherName } = await makeLiveSession(wsA);
    const teacherA = await connectToInstance(wsA);
    const studentB = await connectToInstance(wsB);
    await joinAs(teacherA, sessionId, teacherName);
    await joinAs(studentB, sessionId, "Student-1");

    studentB.send({ type: "doubt.create", requestId: "c", payload: { content: "remote resolve" } });
    const created = await studentB.waitFor(
      (m) => m.type === "doubt.created" && m.requestId === "c",
    );
    const doubtId = (created.payload as { doubt: { doubtId: string } }).doubt.doubtId;

    teacherA.send({
      type: "doubt.resolve",
      requestId: "r",
      payload: { doubtId, explanation: "Remote resolution" },
    });
    const resolved = await studentB.waitFor(
      (m) => m.type === "doubt.resolved" && m.requestId === null,
    );
    expect(resolved.payload).toMatchObject({ sessionId, doubtId, status: "RESOLVED" });

    await teacherA.close();
    await studentB.close();
  });
});
