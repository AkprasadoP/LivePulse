import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  TEST_DATABASE_URL,
  resetDatabase,
  startIndependentInstance,
  registerTestUser,
  bearerHeaders,
} from "./helpers.js";

/**
 * Phase 11 — HTTP control-plane authorization.
 *
 * Before Phase 11 the session-mutation routes were unauthenticated: any client
 * could drive ANY session's state machine or inject quizzes into it. These
 * routes are now creator-only, mirroring the WebSocket teacher/ownership rule
 * (creator == TEACHER authority). This suite pins the boundary:
 *
 *   - mutating a session or its quizzes requires a valid access token (401);
 *   - a valid token for a NON-owner is refused (403), not silently ignored;
 *   - a tampered token is 401, never a downgrade;
 *   - refused requests leave PostgreSQL untouched;
 *   - the owner succeeds;
 *   - reads (GET /sessions/:id, GET /quizzes/:id) remain open by design.
 *
 * WebSocket identity/authorization coverage already exists in ws-auth.test.ts
 * (spoofed ids, view-only rejection, ownership denial) and is not duplicated.
 */

const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
const stamp = (): string => Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

async function clean(): Promise<void> {
  await resetDatabase(prisma);
}

describe("HTTP control-plane authorization (Phase 11)", () => {
  it("mutating a session or its quizzes requires the authenticated creator", async () => {
    await clean();
    const instance = await startIndependentInstance(`ws-httpz-${stamp()}`);
    try {
      const inject = (
        method: "GET" | "POST",
        url: string,
        body?: unknown,
        headers?: Record<string, string>,
      ) =>
        instance.app.inject({
          method,
          url,
          ...(body === undefined
            ? {}
            : {
                payload: JSON.stringify(body),
                headers: { "content-type": "application/json", ...(headers ?? {}) },
              }),
          ...(body === undefined && headers !== undefined ? { headers } : {}),
        });

      // Owner registers and creates a session (creator comes from the token).
      const owner = await registerTestUser(`Owner-${stamp()}`, instance.app);
      const created = await inject(
        "POST",
        "/sessions",
        { name: "Guarded" },
        bearerHeaders(owner.accessToken),
      );
      expect(created.statusCode).toBe(201);
      const sessionId = created.json().session.id as string;

      const stranger = await registerTestUser(`Stranger-${stamp()}`, instance.app);
      const ownerHeaders = bearerHeaders(owner.accessToken);
      const strangerHeaders = bearerHeaders(stranger.accessToken);

      // 1) Unauthenticated: 401, never a silent downgrade.
      expect(
        (await inject("POST", `/sessions/${sessionId}/state`, { state: "LIVE" })).statusCode,
      ).toBe(401);
      expect(
        (await inject("POST", `/sessions/${sessionId}/quizzes`, { title: "Nope" })).statusCode,
      ).toBe(401);

      // 2) Authenticated non-owner: 403 for both mutations.
      expect(
        (await inject("POST", `/sessions/${sessionId}/state`, { state: "LIVE" }, strangerHeaders))
          .statusCode,
      ).toBe(403);
      expect(
        (await inject("POST", `/sessions/${sessionId}/quizzes`, { title: "Nope" }, strangerHeaders))
          .statusCode,
      ).toBe(403);

      // 3) Tampered token: 401 (auth runs before anything else).
      expect(
        (
          await inject(
            "POST",
            `/sessions/${sessionId}/state`,
            { state: "LIVE" },
            { authorization: "Bearer not-a-token" },
          )
        ).statusCode,
      ).toBe(401);

      // 4) Every refusal left PostgreSQL untouched.
      expect((await prisma.session.findUnique({ where: { id: sessionId } }))?.state).toBe(
        "CREATED",
      );
      expect(await prisma.quiz.count({ where: { sessionId } })).toBe(0);

      // 5) The owner succeeds, and a body-supplied identity claim is ignored
      //    (the creator is the token subject, never request input).
      expect(
        (await inject("POST", `/sessions/${sessionId}/state`, { state: "LIVE" }, ownerHeaders))
          .statusCode,
      ).toBe(200);
      const quizRes = await inject(
        "POST",
        `/sessions/${sessionId}/quizzes`,
        { title: "Mine", creator: { displayName: `Spoofer-${stamp()}` } },
        ownerHeaders,
      );
      expect(quizRes.statusCode).toBe(201);
      expect((await prisma.session.findUnique({ where: { id: sessionId } }))?.state).toBe("LIVE");

      // 6) Reads stay open: GET /sessions/:id and GET /quizzes/:id are
      //    id-addressed views, not mutations (deliberate boundary).
      expect((await inject("GET", `/sessions/${sessionId}`)).statusCode).toBe(200);
      expect((await inject("GET", `/quizzes/${quizRes.json().quiz.id}`)).statusCode).toBe(200);
    } finally {
      await instance.close();
      await clean();
    }
  });
});
