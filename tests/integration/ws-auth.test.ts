import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  TEST_DATABASE_URL,
  resetDatabase,
  startIndependentInstance,
  WsTestClient,
  type IndependentInstance,
} from "./helpers.js";
import { hashPassword } from "../../src/modules/auth/password.js";

/**
 * Phase 10.5 WebSocket authentication. New file only; existing helpers and
 * suites are untouched. Auth tables + created rows are cleaned here
 * (resetDatabase covers only pre-auth tables).
 */
describe("WS authentication (Phase 10.5)", () => {
  const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
  const stamp = () => Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

  async function clean(): Promise<void> {
    await prisma.authSession.deleteMany();
    await prisma.credential.deleteMany();
    await resetDatabase(prisma);
  }

  async function register(
    instance: IndependentInstance,
    email: string,
    displayName: string,
  ): Promise<{ userId: string; accessToken: string }> {
    const res = await instance.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: JSON.stringify({ email, password: "ws-auth-pw-12", displayName }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as any;
    return { userId: body.user.id as string, accessToken: body.accessToken as string };
  }

  async function makeSession(
    instance: IndependentInstance,
    creatorDisplayName: string,
  ): Promise<string> {
    const res = await instance.app.inject({
      method: "POST",
      url: "/sessions",
      payload: JSON.stringify({
        name: `WSAuth ${stamp()}`,
        creator: { displayName: creatorDisplayName },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as any).session.id as string;
  }

  async function authJoin(
    instance: IndependentInstance,
    accessToken: string,
    sessionId: string,
    extraJoinPayload: Record<string, unknown> = {},
  ): Promise<{ client: WsTestClient; joined: any }> {
    const client = new WsTestClient();
    await client.connect(instance.port);
    client.send({
      type: "auth.authenticate",
      requestId: "auth-1",
      payload: { token: accessToken },
    });
    const authed = await client.waitFor((m) => m.type === "auth.authenticated");
    expect((authed.payload as any).userId).toBeTypeOf("string");
    client.send({
      type: "session.join",
      requestId: "join-1",
      payload: { sessionId, ...extraJoinPayload },
    });
    const joined = await client.waitFor(
      (m) => m.type === "session.joined" && (m as any).requestId === "join-1",
    );
    return { client, joined };
  }

  it("authenticates and binds the participant server-side (no client IDs)", async () => {
    await clean();
    const instance = await startIndependentInstance(`ws-auth-bind-${stamp()}`);
    try {
      const email = `bind-${stamp()}@example.com`;
      const { userId, accessToken } = await register(instance, email, `Bind-${stamp()}`);
      const sessionId = await makeSession(instance, `Creator-${stamp()}`);
      const { client, joined } = await authJoin(instance, accessToken, sessionId);
      try {
        const payload = joined.payload as any;
        expect(payload.participantId).toBeTypeOf("string");
        // Server-resolved: matches the DB participant for (session, user).
        const row = await prisma.sessionParticipant.findUniqueOrThrow({
          where: { sessionId_userId: { sessionId, userId } },
        });
        expect(payload.participantId).toBe(row.id);
        expect(payload.role).toBe("STUDENT");
      } finally {
        await client.close();
      }
    } finally {
      await instance.close();
      await clean();
    }
  });

  it("HIJACK REGRESSION: spoofed userId/participantId/role/displayName are all powerless", async () => {
    await clean();
    const instance = await startIndependentInstance(`ws-auth-hijack-${stamp()}`);
    try {
      // Victim teacher: real session creator (TEACHER in DB).
      const teacherName = `VictimTeacher-${stamp()}`;
      const sessionId = await makeSession(instance, teacherName);
      const teacherUser = await prisma.user.findUniqueOrThrow({
        where: { displayName: teacherName },
      });
      const teacherParticipant = await prisma.sessionParticipant.findUniqueOrThrow({
        where: { sessionId_userId: { sessionId, userId: teacherUser.id } },
      });
      expect(teacherParticipant.role).toBe("TEACHER");

      // Attacker: registered student.
      const { userId: attackerId, accessToken } = await register(
        instance,
        `attacker-${stamp()}@example.com`,
        `Attacker-${stamp()}`,
      );

      const attacker = new WsTestClient();
      try {
        await attacker.connect(instance.port);
        attacker.send({
          type: "auth.authenticate",
          requestId: "a-auth",
          payload: { token: accessToken },
        });
        await attacker.waitFor((m) => m.type === "auth.authenticated");

        // 1) Unknown top-level identity fields are schema-rejected (no join).
        attacker.send({
          type: "session.join",
          requestId: "a-spoof-ids",
          payload: {
            sessionId,
            userId: teacherUser.id,
            participantId: teacherParticipant.id,
            role: "TEACHER",
          },
        });
        const rejected = await attacker.waitFor(
          (m) => m.type === "error" && (m as any).requestId === "a-spoof-ids",
        );
        expect((rejected.payload as any).code).toBe("INVALID_REQUEST");
        // Still unjoined: privileged action is refused.
        attacker.send({
          type: "quiz.start",
          requestId: "a-evil",
          payload: { quizId: "00000000-0000-0000-0000-000000000000" },
        });
        const notParticipant = await attacker.waitFor(
          (m) => m.type === "error" && (m as any).requestId === "a-evil",
        );
        expect((notParticipant.payload as any).code).toBe("NOT_A_PARTICIPANT");

        // 2) Known-field displayName spoof is IGNORED when authenticated:
        // naming the victim binds the ATTACKER's own participant, as STUDENT.
        attacker.send({
          type: "session.join",
          requestId: "a-spoof-name",
          payload: { sessionId, participant: { displayName: teacherName } },
        });
        const joined = await attacker.waitFor(
          (m) => m.type === "session.joined" && (m as any).requestId === "a-spoof-name",
        );
        const bound = (joined.payload as any).participantId as string;
        const attackerParticipant = await prisma.sessionParticipant.findUniqueOrThrow({
          where: { sessionId_userId: { sessionId, userId: attackerId } },
        });
        expect(bound).toBe(attackerParticipant.id);
        expect(bound).not.toBe(teacherParticipant.id);
        expect((joined.payload as any).role).toBe("STUDENT");
        expect((joined.payload as any).displayName).not.toBe(teacherName);
      } finally {
        await attacker.close();
      }
    } finally {
      await instance.close();
      await clean();
    }
  });

  it("reconnect with the same user resolves the same participant; another user cannot take it", async () => {
    await clean();
    const instance = await startIndependentInstance(`ws-auth-rejoin-${stamp()}`);
    try {
      const { userId, accessToken } = await register(
        instance,
        `re-${stamp()}@example.com`,
        `Re-${stamp()}`,
      );
      const sessionId = await makeSession(instance, `Creator-${stamp()}`);
      const first = await authJoin(instance, accessToken, sessionId);
      const firstPid = ((first.joined.payload as any).participantId ?? null) as string | null;
      expect(firstPid).toBeTypeOf("string");
      await first.client.close();

      const second = await authJoin(instance, accessToken, sessionId);
      try {
        expect((second.joined.payload as any).participantId).toBe(firstPid);
      } finally {
        await second.client.close();
      }

      const other = await register(instance, `other-${stamp()}@example.com`, `Other-${stamp()}`);
      const third = await authJoin(instance, other.accessToken, sessionId);
      try {
        expect((third.joined.payload as any).participantId).not.toBe(firstPid);
        // ...and it belongs to the OTHER user, not the first.
        const otherRow = await prisma.sessionParticipant.findUniqueOrThrow({
          where: { sessionId_userId: { sessionId, userId: other.userId } },
        });
        expect((third.joined.payload as any).participantId).toBe(otherRow.id);
        // First user's row is untouched: still exactly one participant row.
        const firstRow = await prisma.sessionParticipant.findUniqueOrThrow({
          where: { sessionId_userId: { sessionId, userId } },
        });
        expect(firstRow.id).toBe(firstPid);
      } finally {
        await third.client.close();
      }
    } finally {
      await instance.close();
      await clean();
    }
  });

  it("expired/tampered tokens fail with UNAUTHENTICATED and leave join on the legacy path", async () => {
    await clean();
    const instance = await startIndependentInstance(`ws-auth-bad-${stamp()}`);
    try {
      const { accessToken } = await register(
        instance,
        `bad-${stamp()}@example.com`,
        `Bad-${stamp()}`,
      );
      const sessionId = await makeSession(instance, `Creator-${stamp()}`);
      const client = new WsTestClient();
      try {
        await client.connect(instance.port);
        const tampered = accessToken.slice(0, -2) + (accessToken.endsWith("aa") ? "bb" : "aa");
        client.send({
          type: "auth.authenticate",
          requestId: "bad-1",
          payload: { token: tampered },
        });
        const err = await client.waitFor(
          (m) => m.type === "error" && (m as any).requestId === "bad-1",
        );
        expect((err.payload as any).code).toBe("UNAUTHENTICATED");
        // Still unauthenticated: a displayName join binds the legacy identity.
        const legacyName = `Legacy-${stamp()}`;
        client.send({
          type: "session.join",
          requestId: "bad-join",
          payload: { sessionId, participant: { displayName: legacyName } },
        });
        const joined = await client.waitFor(
          (m) => m.type === "session.joined" && (m as any).requestId === "bad-join",
        );
        expect((joined.payload as any).displayName).toBe(legacyName);
      } finally {
        await client.close();
      }
    } finally {
      await instance.close();
      await clean();
    }
  });

  it("authenticated TEACHER (session creator credential) keeps privileged actions working", async () => {
    await clean();
    const instance = await startIndependentInstance(`ws-auth-teacher-${stamp()}`);
    try {
      // Credential claimed directly onto the auto-provisioned creator user
      // (test-only setup; claiming flow is a later phase).
      const teacherName = `CreatorTeacher-${stamp()}`;
      const sessionId = await makeSession(instance, teacherName);
      const creator = await prisma.user.findUniqueOrThrow({ where: { displayName: teacherName } });
      const creatorEmail = `creator-${stamp()}@example.com`;
      await prisma.credential.create({
        data: {
          userId: creator.id,
          email: creatorEmail,
          passwordHash: await hashPassword("teacher-pw-12"),
        },
      });
      const login = await instance.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: JSON.stringify({ email: creatorEmail, password: "teacher-pw-12" }),
        headers: { "content-type": "application/json" },
      });
      expect(login.statusCode).toBe(200);
      const token = (login.json() as any).accessToken as string;

      const client = new WsTestClient();
      try {
        await client.connect(instance.port);
        client.send({ type: "auth.authenticate", requestId: "t-auth", payload: { token } });
        await client.waitFor((m) => m.type === "auth.authenticated");
        // Sessions start CREATED; quiz.start requires LIVE (state machine).
        const live = await instance.app.inject({
          method: "POST",
          url: `/sessions/${sessionId}/state`,
          payload: JSON.stringify({ state: "LIVE" }),
          headers: { "content-type": "application/json" },
        });
        expect(live.statusCode).toBe(200);
        client.send({ type: "session.join", requestId: "t-join", payload: { sessionId } });
        const joined = await client.waitFor(
          (m) => m.type === "session.joined" && (m as any).requestId === "t-join",
        );
        expect((joined.payload as any).role).toBe("TEACHER");
        // Privileged path derives role from the DB row, not client claims.
        const quiz = await instance.app.inject({
          method: "POST",
          url: `/sessions/${sessionId}/quizzes`,
          payload: JSON.stringify({ title: "Q" }),
          headers: { "content-type": "application/json" },
        });
        expect(quiz.statusCode).toBe(201);
        const quizId = (quiz.json() as any).quiz.id as string;
        client.send({ type: "quiz.start", requestId: "t-start", payload: { quizId } });
        const started = await client.waitFor(
          (m) =>
            (m.type === "quiz.started" || m.type === "error") && (m as any).requestId === "t-start",
        );
        expect(started.type).toBe("quiz.started");
      } finally {
        await client.close();
      }
    } finally {
      await instance.close();
      await clean();
    }
  });

  it("ownership (Phase 10.6): authenticated non-owner is denied teacher actions", async () => {
    await clean();
    const instance = await startIndependentInstance(`ws-authz-${stamp()}`);
    try {
      // Session A with a real quiz, owned by its auto-provisioned creator.
      const sessA = await instance.app.inject({
        method: "POST",
        url: "/sessions",
        payload: JSON.stringify({
          name: `AuthzA ${stamp()}`,
          creator: { displayName: `OwnerA-${stamp()}` },
        }),
        headers: { "content-type": "application/json" },
      });
      const sessionA = (sessA.json() as any).session.id as string;
      const quizA = await instance.app.inject({
        method: "POST",
        url: `/sessions/${sessionA}/quizzes`,
        payload: JSON.stringify({ title: "Q" }),
        headers: { "content-type": "application/json" },
      });
      const quizId = (quizA.json() as any).quiz.id as string;

      // Stranger authenticates and joins A: STUDENT, not owner.
      const stranger = await register(
        instance,
        `stranger-${stamp()}@example.com`,
        `Stranger-${stamp()}`,
      );
      const client = new WsTestClient();
      try {
        await client.connect(instance.port);
        client.send({
          type: "auth.authenticate",
          requestId: "o-auth",
          payload: { token: stranger.accessToken },
        });
        await client.waitFor((m) => m.type === "auth.authenticated");
        client.send({
          type: "session.join",
          requestId: "o-join",
          payload: { sessionId: sessionA },
        });
        const joined = await client.waitFor(
          (m) => m.type === "session.joined" && (m as any).requestId === "o-join",
        );
        expect((joined.payload as any).role).toBe("STUDENT");
        // Ownership denial (not merely role): valid quiz, wrong owner.
        client.send({ type: "quiz.start", requestId: "o-evil", payload: { quizId } });
        const denied = await client.waitFor(
          (m) => m.type === "error" && (m as any).requestId === "o-evil",
        );
        expect((denied.payload as any).code).toBe("TEACHER_REQUIRED");
      } finally {
        await client.close();
      }
    } finally {
      await instance.close();
      await clean();
    }
  });
});
