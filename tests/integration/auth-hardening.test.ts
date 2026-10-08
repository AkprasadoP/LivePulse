import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import * as jose from "jose";
import {
  TEST_DATABASE_URL,
  TEST_AUTH_ACCESS_SECRET,
  resetDatabase,
  startIndependentInstance,
  connectToInstance,
  joinAs,
  registerAndCreateSession,
  bearerHeaders,
  WsTestClient,
  type IndependentInstance,
} from "./helpers.js";

/**
 * Phase 10.8 — authentication integration hardening.
 *
 * Proves that introducing real identity (Phase 10.7) did not break the systems
 * built before authentication existed, and that the remaining seams behave as
 * the accepted design says they do:
 *
 *  - A-1  a different authenticated user never recovers another user's state
 *  - B-1  revoking a refresh session does NOT kill an existing WS connection
 *         (no proactive socket kill; the access token stays valid to expiry)
 *  - C-1  logout, then reconnect with the still-valid access token, resolves
 *         the SAME participant row
 *  - D-1  an expired access token is rejected on reconnect and never falls
 *         back to a view-only identity-bearing path
 *
 * Cross-instance recovery, instance-failure recovery, presence online/offline,
 * view-only exclusion, Redis-degraded operation and historical credential-less
 * users are already covered by recovery.test.ts, presence.test.ts and
 * ws-auth.test.ts; they are deliberately not duplicated here.
 */

const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
const stamp = (): string => Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

async function clean(): Promise<void> {
  // resetDatabase TRUNCATEs users/credentials/auth_sessions too (CASCADE).
  await resetDatabase(prisma);
}

function post(
  instance: IndependentInstance,
  url: string,
  body: unknown,
  headers?: Record<string, string>,
) {
  return instance.app.inject({
    method: "POST",
    url,
    payload: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

/** Register a user and return its full token set (refresh token included). */
async function registerUser(
  instance: IndependentInstance,
  displayName: string,
): Promise<{ userId: string; accessToken: string; refreshToken: string }> {
  const email = `hard-${stamp()}@example.com`;
  const res = await post(instance, "/auth/register", {
    email,
    password: "hardening-pw-12",
    displayName,
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as any;
  return {
    userId: body.user.id as string,
    accessToken: body.accessToken as string,
    refreshToken: body.refreshToken as string,
  };
}

/** Session moved to LIVE (creator registered as its TEACHER). */
async function makeLiveSession(instance: IndependentInstance): Promise<string> {
  const { sessionId, accessToken } = await registerAndCreateSession(
    instance.app,
    `HardLive ${stamp()}`,
  );
  // Phase 11: the state transition is creator-only.
  const live = await post(
    instance,
    `/sessions/${sessionId}/state`,
    { state: "LIVE" },
    bearerHeaders(accessToken),
  );
  expect(live.statusCode).toBe(200);
  return sessionId;
}

/** LIVE session + quiz with one keyed question, owned by a registered teacher. */
async function makeQuestionScenario(instance: IndependentInstance): Promise<{
  sessionId: string;
  teacherDisplayName: string;
  quizId: string;
  questionId: string;
  correctAnswer: string;
}> {
  const correctAnswer = "Berlin";
  const {
    sessionId,
    creatorDisplayName: teacherDisplayName,
    accessToken,
  } = await registerAndCreateSession(instance.app, `Hardening ${stamp()}`);
  // Phase 11: quiz/state are creator-only, so use the owner's token.
  const quizRes = await post(
    instance,
    `/sessions/${sessionId}/quizzes`,
    {
      title: "Hardening quiz",
      questions: [{ prompt: "Capital of Germany?", correctAnswer }],
    },
    bearerHeaders(accessToken),
  );
  expect(quizRes.statusCode).toBe(201);
  const quiz = (quizRes.json() as any).quiz as { id: string; questions: Array<{ id: string }> };
  const live = await post(
    instance,
    `/sessions/${sessionId}/state`,
    { state: "LIVE" },
    bearerHeaders(accessToken),
  );
  expect(live.statusCode).toBe(200);
  return {
    sessionId,
    teacherDisplayName,
    quizId: quiz.id,
    questionId: quiz.questions[0]!.id,
    correctAnswer,
  };
}

describe("Authentication hardening (Phase 10.8)", () => {
  it("A-1 — a different authenticated user never recovers another user's participant state", async () => {
    await clean();
    const instance = await startIndependentInstance(`ws-hard-a-${stamp()}`);
    try {
      const scenario = await makeQuestionScenario(instance);
      const teacher = await connectToInstance(instance);
      await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
      teacher.send({ type: "quiz.start", requestId: "q0", payload: { quizId: scenario.quizId } });
      await teacher.waitFor((m) => m.type === "quiz.started" && m.requestId === "q0");
      teacher.send({
        type: "question.publish",
        requestId: "q1",
        payload: { questionId: scenario.questionId },
      });
      await teacher.waitFor((m) => m.type === "question.published" && m.requestId === "q1");

      // User A answers correctly.
      const a = await connectToInstance(instance);
      const joinedA = await joinAs(a, scenario.sessionId, "HardA");
      a.send({
        type: "quiz.answer",
        requestId: "a1",
        payload: { questionId: scenario.questionId, content: scenario.correctAnswer },
      });
      await a.waitFor((m) => m.type === "answer.accepted" && m.requestId === "a1");

      // A reconnecting recovers its OWN verdict (same participant row).
      const a2 = await connectToInstance(instance);
      const rejoinedA = await joinAs(a2, scenario.sessionId, "HardA");
      expect(rejoinedA.participantId).toBe(joinedA.participantId);
      expect((rejoinedA.recovery as any).ownAnswer).toMatchObject({
        isCorrect: true,
        isWinner: true,
      });

      // A DIFFERENT authenticated user gets its own participant and NO
      // ownAnswer — it can never inherit A's stored state.
      const b = await connectToInstance(instance);
      const joinedB = await joinAs(b, scenario.sessionId, "HardB");
      expect(joinedB.role).toBe("STUDENT");
      expect(joinedB.participantId).not.toBe(joinedA.participantId);
      expect((joinedB.recovery as any).ownAnswer).toBeNull();

      await teacher.close();
      await a.close();
      await a2.close();
      await b.close();
    } finally {
      await instance.close();
      await clean();
    }
  });

  it("B-1 — revoking a refresh session does not kill an existing authenticated WS connection", async () => {
    await clean();
    const instance = await startIndependentInstance(`ws-hard-b-${stamp()}`);
    try {
      const sessionId = await makeLiveSession(instance);
      const user = await registerUser(instance, `HardRevoke-${stamp()}`);

      const client = new WsTestClient();
      await client.connect(instance.port);
      client.send({
        type: "auth.authenticate",
        requestId: "b-auth",
        payload: { token: user.accessToken },
      });
      await client.waitFor((m) => m.type === "auth.authenticated");
      client.send({ type: "session.join", requestId: "b-join", payload: { sessionId } });
      const joined = await client.waitFor(
        (m) => m.type === "session.joined" && (m as any).requestId === "b-join",
      );
      expect((joined.payload as any).participantId).toBeTypeOf("string");

      // Revoke the refresh session (logout).
      const logout = await post(instance, "/auth/logout", { refreshToken: user.refreshToken });
      expect(logout.statusCode).toBe(204);
      // The refresh token is now dead...
      expect(
        (await post(instance, "/auth/refresh", { refreshToken: user.refreshToken })).statusCode,
      ).toBe(401);

      // ...but the live WS connection and its access token are untouched — no
      // proactive socket kill (accepted design: revocation lands at expiry).
      expect(client.isOpen).toBe(true);
      client.send({
        type: "doubt.create",
        requestId: "b-doubt",
        payload: { content: "still here" },
      });
      const created = await client.waitFor(
        (m) => m.type === "doubt.created" && (m as any).requestId === "b-doubt",
      );
      expect((created.payload as any).doubt.content).toBe("still here");

      await client.close();
    } finally {
      await instance.close();
      await clean();
    }
  });

  it("C-1 — logout, then reconnect with the still-valid access token, resolves the same participant", async () => {
    await clean();
    const instance = await startIndependentInstance(`ws-hard-c-${stamp()}`);
    try {
      const sessionId = await makeLiveSession(instance);
      const user = await registerUser(instance, `HardRelogin-${stamp()}`);

      const first = new WsTestClient();
      await first.connect(instance.port);
      first.send({
        type: "auth.authenticate",
        requestId: "c-auth1",
        payload: { token: user.accessToken },
      });
      await first.waitFor((m) => m.type === "auth.authenticated");
      first.send({ type: "session.join", requestId: "c-join1", payload: { sessionId } });
      const joined1 = await first.waitFor(
        (m) => m.type === "session.joined" && (m as any).requestId === "c-join1",
      );
      const participantId = (joined1.payload as any).participantId as string;
      expect(participantId).toBeTypeOf("string");
      await first.close();

      const logout = await post(instance, "/auth/logout", { refreshToken: user.refreshToken });
      expect(logout.statusCode).toBe(204);

      // Access tokens are self-contained (no jti/session lookup): reconnecting
      // with the same unexpired token still authenticates and resolves the
      // SAME participant row. Logout revoked the refresh chain, not identity.
      const second = new WsTestClient();
      await second.connect(instance.port);
      second.send({
        type: "auth.authenticate",
        requestId: "c-auth2",
        payload: { token: user.accessToken },
      });
      const authed = await second.waitFor((m) => m.type === "auth.authenticated");
      expect((authed.payload as any).userId).toBe(user.userId);
      second.send({ type: "session.join", requestId: "c-join2", payload: { sessionId } });
      const joined2 = await second.waitFor(
        (m) => m.type === "session.joined" && (m as any).requestId === "c-join2",
      );
      expect((joined2.payload as any).participantId).toBe(participantId);

      await second.close();
    } finally {
      await instance.close();
      await clean();
    }
  });

  it("D-1 — an expired access token is rejected on reconnect, never a fallback", async () => {
    await clean();
    const instance = await startIndependentInstance(`ws-hard-d-${stamp()}`);
    try {
      const sessionId = await makeLiveSession(instance);
      const user = await registerUser(instance, `HardExpired-${stamp()}`);

      // A genuinely expired but otherwise well-formed HS256 token signed with
      // the shared test secret — exactly what a stale client token looks like.
      const nowSeconds = Math.floor(Date.now() / 1000);
      const expired = await new jose.SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(user.userId)
        .setIssuedAt(nowSeconds - 3600)
        .setExpirationTime(nowSeconds - 60)
        .sign(new TextEncoder().encode(TEST_AUTH_ACCESS_SECRET));

      const client = new WsTestClient();
      await client.connect(instance.port);
      client.send({
        type: "auth.authenticate",
        requestId: "d-auth",
        payload: { token: expired },
      });
      const err = await client.waitFor(
        (m) => m.type === "error" && (m as any).requestId === "d-auth",
      );
      expect((err.payload as any).code).toBe("UNAUTHENTICATED");

      // Still unauthenticated: a join is view-only (binds no participant),
      // never an identity-bearing fallback.
      client.send({ type: "session.join", requestId: "d-join", payload: { sessionId } });
      const joined = await client.waitFor(
        (m) => m.type === "session.joined" && (m as any).requestId === "d-join",
      );
      expect((joined.payload as any).participantId).toBeNull();

      await client.close();
    } finally {
      await instance.close();
      await clean();
    }
  });
});
