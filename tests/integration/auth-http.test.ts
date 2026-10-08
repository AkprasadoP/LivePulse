import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  TEST_DATABASE_URL,
  startIndependentInstance,
  type IndependentInstance,
} from "./helpers.js";

/**
 * Phase 10.4 HTTP authentication contract. New file only; existing helpers
 * and suites are untouched. Auth tables + created users are cleaned here
 * (resetDatabase covers only pre-auth tables).
 */
describe("HTTP authentication (Phase 10.4)", () => {
  const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
  let instance: IndependentInstance;
  const madeUsers: string[] = [];
  const madeSessions: string[] = [];

  async function start(): Promise<void> {
    instance = await startIndependentInstance(`ws-auth-http-${Date.now()}`);
  }

  async function stop(): Promise<void> {
    await instance.close();
    await prisma.authSession.deleteMany();
    await prisma.credential.deleteMany();
    if (madeSessions.length > 0) {
      // Cascades to participants/quizzes/questions/answers/doubts.
      await prisma.session.deleteMany({ where: { id: { in: madeSessions.splice(0) } } });
    }
    if (madeUsers.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: madeUsers.splice(0) } } });
    }
  }

  async function post(path: string, body: unknown, token?: string) {
    const response = await instance.app.inject({
      method: "POST",
      url: path,
      payload: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    });
    let parsed: any = null;
    try {
      parsed = response.json();
    } catch {
      // No JSON body (e.g. 204) — callers check statusCode.
    }
    return { statusCode: response.statusCode, body: parsed };
  }

  const stamp = () => Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

  it("register → login → refresh → logout → /me lifecycle", async () => {
    await start();
    try {
      const email = `lifecycle-${stamp()}@example.com`;
      const reg = await post("/auth/register", {
        email: `  ${email.toUpperCase()} `,
        password: "register-pw-1",
        displayName: `Lifecycle-${stamp()}`,
      });
      expect(reg.statusCode).toBe(201);
      expect(reg.body.user.email).toBe(email);
      expect(reg.body.accessToken).toBeTypeOf("string");
      expect(reg.body.refreshToken).toBeTypeOf("string");
      expect(reg.body.expiresIn).toBe(900);
      // No secret material anywhere in the response.
      expect(JSON.stringify(reg.body)).not.toMatch(/register-pw-1|passwordHash/i);
      madeUsers.push(reg.body.user.id);

      // Duplicate email (any casing) and duplicate displayName both 409.
      expect(
        (
          await post("/auth/register", {
            email,
            password: "other-pw-12",
            displayName: `Other-${stamp()}`,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await post("/auth/register", {
            email: `fresh-${stamp()}@example.com`,
            password: "other-pw-12",
            displayName: reg.body.user.displayName,
          })
        ).statusCode,
      ).toBe(409);
      // Shape validation.
      expect(
        (
          await post("/auth/register", {
            email: "not-an-email",
            password: "register-pw-1",
            displayName: "X",
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await post("/auth/register", {
            email: `s-${stamp()}@example.com`,
            password: "short",
            displayName: "X",
          })
        ).statusCode,
      ).toBe(400);

      // Login works; /me resolves identity from the access token.
      const login = await post("/auth/login", { email, password: "register-pw-1" });
      expect(login.statusCode).toBe(200);
      expect(login.body.user.id).toBe(reg.body.user.id);
      const me = await instance.app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${login.body.accessToken}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toEqual({
        user: { id: reg.body.user.id, email, displayName: reg.body.user.displayName },
      });

      // Refresh rotates the refresh token (the security property); the old
      // refresh token dies. Access tokens carry only sub/iat/exp (no jti),
      // so two issued within the same second are identical by construction —
      // assert usability of the new access token instead of inequality.
      const refreshed = await post("/auth/refresh", { refreshToken: login.body.refreshToken });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.body.refreshToken).not.toBe(login.body.refreshToken);
      const meRefreshed = await instance.app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${refreshed.body.accessToken}` },
      });
      expect(meRefreshed.statusCode).toBe(200);
      expect(
        (await post("/auth/refresh", { refreshToken: login.body.refreshToken })).statusCode,
      ).toBe(401);

      // Logout is 204 and kills the current refresh token (idempotent).
      const logout = await post("/auth/logout", { refreshToken: refreshed.body.refreshToken });
      expect(logout.statusCode).toBe(204);
      expect((await post("/auth/logout", { refreshToken: "bogus-token" })).statusCode).toBe(204);
      expect(
        (await post("/auth/refresh", { refreshToken: refreshed.body.refreshToken })).statusCode,
      ).toBe(401);
    } finally {
      await stop();
    }
  });

  it("login failures are fully generic (no email oracle)", async () => {
    await start();
    try {
      const email = `oracle-${stamp()}@example.com`;
      const reg = await post("/auth/register", {
        email,
        password: "oracle-pw-12",
        displayName: `Oracle-${stamp()}`,
      });
      expect(reg.statusCode).toBe(201);
      madeUsers.push(reg.body.user.id);

      const wrongPw = await post("/auth/login", { email, password: "wrong-password" });
      const unknown = await post("/auth/login", {
        email: `nobody-${stamp()}@example.com`,
        password: "wrong-password",
      });
      expect(wrongPw.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(wrongPw.body).toEqual(unknown.body);
      expect(JSON.stringify(wrongPw.body)).not.toMatch(/oracle|hash/i);
    } finally {
      await stop();
    }
  });

  it("refresh-token reuse revokes the whole user session set", async () => {
    await start();
    try {
      const email = `reuse-${stamp()}@example.com`;
      const reg = await post("/auth/register", {
        email,
        password: "reuse-pw-123",
        displayName: `Reuse-${stamp()}`,
      });
      madeUsers.push(reg.body.user.id);
      const loginA = await post("/auth/login", { email, password: "reuse-pw-123" });
      const loginB = await post("/auth/login", { email, password: "reuse-pw-123" });
      // Rotate A once (A.old dies legitimately), then replay A.old = reuse.
      const rotated = await post("/auth/refresh", { refreshToken: loginA.body.refreshToken });
      expect(rotated.statusCode).toBe(200);
      expect(
        (await post("/auth/refresh", { refreshToken: loginA.body.refreshToken })).statusCode,
      ).toBe(401);
      // Chain response: B's independent session is dead too.
      expect(
        (await post("/auth/refresh", { refreshToken: loginB.body.refreshToken })).statusCode,
      ).toBe(401);
      expect(
        (await post("/auth/refresh", { refreshToken: rotated.body.refreshToken })).statusCode,
      ).toBe(401);
    } finally {
      await stop();
    }
  });

  it("/me rejects missing, malformed, and tampered tokens", async () => {
    await start();
    try {
      const email = `me-${stamp()}@example.com`;
      const reg = await post("/auth/register", {
        email,
        password: "me-pw-12345",
        displayName: `Me-${stamp()}`,
      });
      madeUsers.push(reg.body.user.id);
      const good = reg.body.accessToken as string;

      expect((await instance.app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
      expect(
        (
          await instance.app.inject({
            method: "GET",
            url: "/me",
            headers: { authorization: "Bearer not-a-token" },
          })
        ).statusCode,
      ).toBe(401);
      const tampered = good.slice(0, -2) + (good.endsWith("aa") ? "bb" : "aa");
      expect(
        (
          await instance.app.inject({
            method: "GET",
            url: "/me",
            headers: { authorization: `Bearer ${tampered}` },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await instance.app.inject({
            method: "GET",
            url: "/me",
            headers: { authorization: "Token " + good },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await stop();
    }
  });

  it("authenticated session creation binds ownership to the token user (body.creator ignored)", async () => {
    await start();
    try {
      const email = `owner-${stamp()}@example.com`;
      const displayName = `Owner-${stamp()}`;
      const reg = await post("/auth/register", { email, password: "owner-pw-123", displayName });
      expect(reg.statusCode).toBe(201);
      const userId = reg.body.user.id as string;
      madeUsers.push(userId);

      // Authenticated: creator comes from the token, not the body.
      const created = await post(
        "/sessions",
        { name: `Owned ${stamp()}`, creator: { displayName: "Someone-Else" } },
        reg.body.accessToken,
      );
      expect(created.statusCode).toBe(201);
      expect(created.body.session.creator.id).toBe(userId);
      expect(created.body.session.creator.displayName).toBe(displayName);
      expect(created.body.teacherParticipant.userId).toBe(userId);
      expect(created.body.teacherParticipant.role).toBe("TEACHER");
      madeSessions.push(created.body.session.id as string);

      // Present-but-bad token is 401, never a silent legacy fallback.
      const bad = await post("/sessions", { name: `Bad ${stamp()}` }, "bogus-token");
      expect(bad.statusCode).toBe(401);

      // Absent token keeps the legacy auto-provisioned path byte-identical.
      const legacy = await post("/sessions", {
        name: `Legacy ${stamp()}`,
        creator: { displayName: `LegacyCreator-${stamp()}` },
      });
      expect(legacy.statusCode).toBe(201);
      expect(legacy.body.session.creator.id).not.toBe(userId);
      madeUsers.push(legacy.body.session.creator.id as string);
      madeSessions.push(legacy.body.session.id as string);
    } finally {
      await stop();
    }
  });
});
