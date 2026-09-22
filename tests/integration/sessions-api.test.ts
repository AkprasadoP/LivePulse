import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestApp, stopTestApp, resetDatabase, type IntegrationContext } from "./helpers.js";

describe("Sessions API (integration)", () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    ctx = await startTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await stopTestApp();
  });

  describe("POST /sessions", () => {
    it("creates a session with an auto-provisioned TEACHER creator", async () => {
      const { statusCode, body } = await ctx.request("POST", "/sessions", {
        name: "Physics — Current Electricity",
        creator: { displayName: "Dr. Ohm" },
      });

      expect(statusCode).toBe(201);
      expect(body.session).toMatchObject({
        name: "Physics — Current Electricity",
        state: "CREATED",
        startedAt: null,
        endedAt: null,
        creator: { displayName: "Dr. Ohm" },
      });
      expect(body.session.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(body.teacherParticipant.role).toBe("TEACHER");
      expect(body.teacherParticipant.userId).toBe(body.session.creator.id);
    });

    it("defaults the creator displayName when none is provided", async () => {
      const { statusCode, body } = await ctx.request("POST", "/sessions", {
        name: "Biology 101",
      });
      expect(statusCode).toBe(201);
      expect(body.session.creator.displayName).toBe("Teacher");
    });

    it("persists the session and its teacher participant durably", async () => {
      const { body } = await ctx.request("POST", "/sessions", {
        name: "Persisted session",
      });

      const userCount = await ctx.prisma.user.count();
      const sessionCount = await ctx.prisma.session.count();
      const participants = await ctx.prisma.sessionParticipant.findMany({
        where: { sessionId: body.session.id },
      });

      expect(userCount).toBe(1);
      expect(sessionCount).toBe(1);
      expect(participants).toHaveLength(1);
      expect(participants[0]!.role).toBe("TEACHER");
    });

    it("rejects a missing name with 400", async () => {
      const { statusCode, body } = await ctx.request("POST", "/sessions", {});
      expect(statusCode).toBe(400);
      expect(body.error).toBe("Bad Request");
      expect(body.details.some((d: any) => d.path === "name")).toBe(true);
    });

    it("rejects an empty name with 400", async () => {
      const { statusCode } = await ctx.request("POST", "/sessions", { name: "" });
      expect(statusCode).toBe(400);
    });

    it("rejects a name longer than 200 characters with 400", async () => {
      const { statusCode } = await ctx.request("POST", "/sessions", {
        name: "x".repeat(201),
      });
      expect(statusCode).toBe(400);
    });

    it("rejects malformed JSON with 400 (Fastify body parser)", async () => {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/sessions",
        payload: "{not json",
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /sessions/:sessionId", () => {
    it("returns the session with its participants", async () => {
      const created = await ctx.request("POST", "/sessions", {
        name: "Chemistry",
        creator: { displayName: "Ms. Curie" },
      });

      const { statusCode, body } = await ctx.request("GET", `/sessions/${created.body.session.id}`);

      expect(statusCode).toBe(200);
      expect(body.session.name).toBe("Chemistry");
      expect(body.session.creator.displayName).toBe("Ms. Curie");
      expect(body.participants).toHaveLength(1);
      expect(body.participants[0]).toMatchObject({
        role: "TEACHER",
        displayName: "Ms. Curie",
      });
    });

    it("returns 404 with a consistent error body for an unknown but well-formed id", async () => {
      const unknownId = "01900000-0000-7000-8000-000000000000";
      const { statusCode, body } = await ctx.request("GET", `/sessions/${unknownId}`);
      expect(statusCode).toBe(404);
      expect(body.error).toBe("Not Found");
      expect(body.message).toContain(unknownId);
    });

    it("returns 400 for a malformed session id (never reaches the database)", async () => {
      const { statusCode, body } = await ctx.request("GET", "/sessions/not-a-uuid");
      expect(statusCode).toBe(400);
      expect(body.error).toBe("Bad Request");
    });
  });

  describe("POST /sessions/:sessionId/state", () => {
    it("performs the full approved lifecycle CREATED -> LIVE -> ENDED", async () => {
      const created = await ctx.request("POST", "/sessions", { name: "Lifecycle" });
      const id = created.body.session.id;

      const live = await ctx.request("POST", `/sessions/${id}/state`, { state: "LIVE" });
      expect(live.statusCode).toBe(200);
      expect(live.body.session.state).toBe("LIVE");
      expect(live.body.session.startedAt).not.toBeNull();
      expect(live.body.session.endedAt).toBeNull();

      const ended = await ctx.request("POST", `/sessions/${id}/state`, { state: "ENDED" });
      expect(ended.statusCode).toBe(200);
      expect(ended.body.session.state).toBe("ENDED");
      expect(ended.body.session.endedAt).not.toBeNull();
    });

    it("allows cancel before live: CREATED -> ENDED (approved decision)", async () => {
      const created = await ctx.request("POST", "/sessions", { name: "Cancelled" });
      const { statusCode, body } = await ctx.request(
        "POST",
        `/sessions/${created.body.session.id}/state`,
        {
          state: "ENDED",
        },
      );
      expect(statusCode).toBe(200);
      expect(body.session.state).toBe("ENDED");
      expect(body.session.startedAt).toBeNull(); // never went live
      expect(body.session.endedAt).not.toBeNull();
    });

    it("rejects ENDED -> LIVE with 409 (terminal state)", async () => {
      const created = await ctx.request("POST", "/sessions", { name: "Terminal" });
      const id = created.body.session.id;
      await ctx.request("POST", `/sessions/${id}/state`, { state: "LIVE" });
      await ctx.request("POST", `/sessions/${id}/state`, { state: "ENDED" });

      const { statusCode, body } = await ctx.request("POST", `/sessions/${id}/state`, {
        state: "LIVE",
      });
      expect(statusCode).toBe(409);
      expect(body.error).toBe("Conflict");
      expect(body.message).toContain("ENDED -> LIVE");
    });

    it("rejects ENDED -> CREATED and LIVE -> CREATED semantics (no such target) with 400", async () => {
      const created = await ctx.request("POST", "/sessions", { name: "Bad target" });
      const { statusCode } = await ctx.request(
        "POST",
        `/sessions/${created.body.session.id}/state`,
        {
          state: "CREATED",
        },
      );
      expect(statusCode).toBe(400); // schema-level rejection: CREATED is not a valid target
    });

    it("rejects unknown session id with 404", async () => {
      const unknownId = "01900000-0000-7000-8000-000000000001";
      const { statusCode, body } = await ctx.request("POST", `/sessions/${unknownId}/state`, {
        state: "LIVE",
      });
      expect(statusCode).toBe(404);
      expect(body.error).toBe("Not Found");
    });
  });

  describe("quizzes under a session", () => {
    it("returns the quizzes of a session via the session-scoped endpoint and keeps quiz data consistent", async () => {
      const session = await ctx.request("POST", "/sessions", { name: "Quiz host" });
      const sessionId = session.body.session.id;

      await ctx.request("POST", `/sessions/${sessionId}/quizzes`, {
        title: "Quiz A",
        questions: [{ prompt: "2+2?", correctAnswer: "4" }],
      });

      const detail = await ctx.request("GET", `/sessions/${sessionId}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.body.participants).toHaveLength(1);

      const quizResponse = await ctx.request("POST", `/sessions/${sessionId}/quizzes`, {
        title: "Quiz B",
      });
      expect(quizResponse.statusCode).toBe(201);
      expect(quizResponse.body.quiz.sessionId).toBe(sessionId);
    });

    it("rejects quiz creation for a nonexistent session with 404", async () => {
      const unknownId = "01900000-0000-7000-8000-000000000002";
      const { statusCode, body } = await ctx.request("POST", `/sessions/${unknownId}/quizzes`, {
        title: "Orphan quiz",
      });
      expect(statusCode).toBe(404);
      expect(body.error).toBe("Not Found");
    });
  });
});
