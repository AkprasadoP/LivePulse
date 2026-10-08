import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  startTestApp,
  stopTestApp,
  resetDatabase,
  registerAndCreateSession,
  bearerHeaders,
  type IntegrationContext,
} from "./helpers.js";

/** Create a session owned by a fresh user; return its id + the owner's headers. */
async function createSession(
  ctx: IntegrationContext,
  name = "Quiz session",
): Promise<{ sessionId: string; headers: Record<string, string> }> {
  // Phase 10.7: POST /sessions requires authentication; the creator owns it.
  // Phase 11: quiz creation is creator-only, so the same token is returned.
  const { sessionId, accessToken } = await registerAndCreateSession(ctx.app, name);
  return { sessionId, headers: bearerHeaders(accessToken) };
}

describe("Quizzes API (integration)", () => {
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

  describe("POST /sessions/:sessionId/quizzes", () => {
    it("creates a quiz with inline questions in DRAFT state", async () => {
      const { sessionId, headers } = await createSession(ctx);

      const { statusCode, body } = await ctx.request(
        "POST",
        `/sessions/${sessionId}/quizzes`,
        {
          title: "Electricity basics",
          questions: [
            { prompt: "Unit of current?", correctAnswer: "Ampere" },
            { prompt: "Ohm's law?", correctAnswer: "V = IR" },
            { prompt: "Open question without a key" },
          ],
        },
        headers,
      );

      expect(statusCode).toBe(201);
      expect(body.quiz).toMatchObject({
        sessionId,
        title: "Electricity basics",
        state: "DRAFT",
      });
      expect(body.quiz.questions).toHaveLength(3);
      expect(body.quiz.questions[0]).toMatchObject({
        position: 1,
        prompt: "Unit of current?",
        hasCorrectAnswer: true,
        firstCorrectWins: true,
        state: "DRAFT",
      });
      expect(body.quiz.questions[2]).toMatchObject({
        position: 3,
        hasCorrectAnswer: false,
      });
    });

    it("creates a quiz without questions", async () => {
      const { sessionId, headers } = await createSession(ctx);
      const { statusCode, body } = await ctx.request(
        "POST",
        `/sessions/${sessionId}/quizzes`,
        {
          title: "Empty quiz",
        },
        headers,
      );
      expect(statusCode).toBe(201);
      expect(body.quiz.questions).toHaveLength(0);
    });

    it("persists questions atomically with the quiz and hides correctAnswer from the API", async () => {
      const { sessionId, headers } = await createSession(ctx);
      const { body } = await ctx.request(
        "POST",
        `/sessions/${sessionId}/quizzes`,
        {
          title: "Secrecy check",
          questions: [{ prompt: "Secret answer question", correctAnswer: "classified" }],
        },
        headers,
      );

      const raw = await ctx.prisma.question.findFirst({
        where: { quizId: body.quiz.id },
      });
      expect(raw?.correctAnswer).toBe("classified"); // stored durably...

      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("classified"); // ...but never exposed
    });

    it("returns 404 when the session does not exist (and creates nothing)", async () => {
      const { headers } = await createSession(ctx);
      const unknownId = "01900000-0000-7000-8000-000000000003";
      const { statusCode } = await ctx.request(
        "POST",
        `/sessions/${unknownId}/quizzes`,
        {
          title: "Orphan",
        },
        headers,
      );
      expect(statusCode).toBe(404);
      expect(await ctx.prisma.quiz.count()).toBe(0);
    });

    it("rejects a missing title with 400", async () => {
      const { sessionId, headers } = await createSession(ctx);
      const { statusCode, body } = await ctx.request(
        "POST",
        `/sessions/${sessionId}/quizzes`,
        {},
        headers,
      );
      expect(statusCode).toBe(400);
      expect(body.details.some((d: any) => d.path === "title")).toBe(true);
    });

    it("rejects an empty question prompt with 400", async () => {
      const { sessionId, headers } = await createSession(ctx);
      const { statusCode } = await ctx.request(
        "POST",
        `/sessions/${sessionId}/quizzes`,
        {
          title: "Bad question",
          questions: [{ prompt: "" }],
        },
        headers,
      );
      expect(statusCode).toBe(400);
    });

    it("rejects a malformed session id with 400 before hitting the database", async () => {
      const { headers } = await createSession(ctx);
      const { statusCode } = await ctx.request(
        "POST",
        "/sessions/123/quizzes",
        {
          title: "Bad id",
        },
        headers,
      );
      expect(statusCode).toBe(400);
    });
  });

  describe("GET /quizzes/:quizId", () => {
    it("returns the quiz with questions ordered by position", async () => {
      const { sessionId, headers } = await createSession(ctx);
      const created = await ctx.request(
        "POST",
        `/sessions/${sessionId}/quizzes`,
        {
          title: "Ordered quiz",
          questions: [{ prompt: "Q3" }, { prompt: "Q1" }, { prompt: "Q2" }],
        },
        headers,
      );
      const quizId = created.body.quiz.id;

      const { statusCode, body } = await ctx.request("GET", `/quizzes/${quizId}`);
      expect(statusCode).toBe(200);
      expect(body.quiz.title).toBe("Ordered quiz");
      expect(body.quiz.questions.map((q: any) => q.prompt)).toEqual(["Q3", "Q1", "Q2"]);
      expect(body.quiz.questions.map((q: any) => q.position)).toEqual([1, 2, 3]);
    });

    it("returns 404 for an unknown quiz id", async () => {
      const unknownId = "01900000-0000-7000-8000-000000000004";
      const { statusCode, body } = await ctx.request("GET", `/quizzes/${unknownId}`);
      expect(statusCode).toBe(404);
      expect(body.error).toBe("Not Found");
    });

    it("returns 400 for a malformed quiz id", async () => {
      const { statusCode } = await ctx.request("GET", "/quizzes/not-a-uuid");
      expect(statusCode).toBe(400);
    });
  });
});
