import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { PrismaClient } from "@prisma/client";
import {
  TEST_DATABASE_URL,
  resetDatabase,
  startIndependentInstance,
  startListeningServer,
  stopTestApp,
  connectToInstance,
  joinAs,
  registerAndCreateSession,
  bearerHeaders,
  waitFor,
  type IndependentInstance,
} from "./helpers.js";

/**
 * Phase 7 observability tests (ADR-009).
 *
 * Metrics are OBSERVATION, never business state: one process-local Prometheus
 * registry per instance, bounded labels only, and a /metrics endpoint that
 * touches neither PostgreSQL nor Redis. These tests assert exactly that —
 * against real sockets, real Redis and real PostgreSQL.
 *
 * Coverage map (docs/testing/observability.md):
 *   O1  /metrics returns valid Prometheus text
 *   O2  connection gauge + open/close counters track real connections
 *   O3  message counters increment on inbound frames and outbound frames
 *   O4  histogram families record observations
 *   O5  session join/leave counters carry bounded role/reason labels
 *   O6  recovery + doubt + quiz operation metrics increment
 *   O7  protocol errors are counted by bounded error code
 *   O8  every label in the live exposition is bounded
 *   O9  /metrics works with PostgreSQL disconnected (no dependency)
 *   O10 /metrics is 404 when METRICS_ENABLED=false
 *   O11 structured logs carry correlation fields and never payload secrets
 */

/** Collects Pino's structured output for log-hygiene assertions. */
class CapturingStream extends Writable {
  public readonly chunks: string[] = [];
  public override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }
  public lines(): string[] {
    return this.chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "");
  }
}

function requestOn(instance: IndependentInstance) {
  return async (
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ statusCode: number; body: any; raw: string }> => {
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
    return { statusCode: response.statusCode, body, raw: response.body };
  };
}

/** Value of one series from a Prometheus exposition (0 when absent). */
function seriesValue(text: string, series: string): number {
  const line = text.split("\n").find((candidate) => candidate.startsWith(`${series} `));
  if (line === undefined) return 0;
  return Number(line.slice(series.length + 1));
}

async function scrape(instance: IndependentInstance): Promise<string> {
  const response = await instance.app.inject({ method: "GET", url: "/metrics" });
  expect(response.statusCode).toBe(200);
  return response.body;
}

/** Session (LIVE) + quiz with one keyed question; returns the sentinels used. */
async function makeScenario(instance: IndependentInstance) {
  const request = requestOn(instance);
  const correctAnswer = "correct-horse-battery-staple";
  // Phase 10.7: creation requires an authenticated owner. Joining with the
  // registered creator's display name resolves the TEACHER participant; a
  // fresh name would be a STUDENT.
  const {
    sessionId,
    creatorDisplayName: teacherDisplayName,
    accessToken,
  } = await registerAndCreateSession(
    instance.app,
    `Observability ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );

  // Phase 11: quiz/state are creator-only, so use the owner's token.
  const quizResponse = await request(
    "POST",
    `/sessions/${sessionId}/quizzes`,
    {
      title: "Observability quiz",
      questions: [{ prompt: "Secret prompt sentinel", correctAnswer }],
    },
    bearerHeaders(accessToken),
  );
  expect(quizResponse.statusCode).toBe(201);
  const quiz = quizResponse.body.quiz as { id: string; questions: Array<{ id: string }> };
  await request(
    "POST",
    `/sessions/${sessionId}/state`,
    { state: "LIVE" },
    bearerHeaders(accessToken),
  );

  return {
    sessionId,
    teacherDisplayName,
    quizId: quiz.id,
    questionId: quiz.questions[0]!.id,
    correctAnswer,
  };
}

describe("Observability (integration, Phase 7)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
    await prisma.$connect();
    // The shared HTTP-only server also exposes /metrics (same route surface).
    await startListeningServer();
  });

  afterAll(async () => {
    await stopTestApp();
    await prisma.$disconnect();
  });

  // Phase 10.7: identity is registered, so users must be unique per test.
  // Residue from an earlier file would 409 a fixed displayName like
  // "Student-1"; resetting here keeps each observability test self-contained.
  beforeEach(async () => {
    await resetDatabase();
  });

  it("O1 — GET /metrics returns valid Prometheus text for every installed family", async () => {
    const server = await startListeningServer();
    const response = await server.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");

    const families = [...response.body.matchAll(/^# TYPE (\S+) (\S+)$/gm)].map((match) => ({
      name: match[1]!,
      type: match[2]!,
    }));
    expect(families.length).toBeGreaterThanOrEqual(30);
    // Every TYPE line is immediately preceded by a HELP line (valid exposition).
    const lines = response.body.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.startsWith("# TYPE ")) continue;
      expect(lines[index - 1]?.startsWith("# HELP ")).toBe(true);
      // "# TYPE <name> <type>" -> index 3 is the type token.
      expect(["counter", "gauge", "histogram"]).toContain(line.split(" ")[3]);
    }
    const names = families.map((family) => family.name);
    expect(names).toContain("livepulse_ws_connections_active");
    expect(names).toContain("livepulse_recovery_builds_total");
    expect(names).toContain("livepulse_doubt_transitions_total");
  });

  it("O2 — connection gauge and open/close counters track real connections", async () => {
    const instance = await startIndependentInstance("ws-obs-conn");
    try {
      expect(seriesValue(await scrape(instance), "livepulse_ws_connections_active")).toBe(0);

      const client = await connectToInstance(instance);
      let text = await scrape(instance);
      expect(seriesValue(text, "livepulse_ws_connections_active")).toBe(1);
      expect(seriesValue(text, "livepulse_ws_connections_opened_total")).toBe(1);

      await client.close();
      await waitFor(() => instance.app.wsLayer!.registry.connectionCount === 0);
      text = await scrape(instance);
      expect(seriesValue(text, "livepulse_ws_connections_active")).toBe(0);
      expect(seriesValue(text, 'livepulse_ws_connections_closed_total{reason="client"}')).toBe(1);
      expect(seriesValue(text, 'livepulse_ws_connections_closed_total{reason="heartbeat"}')).toBe(
        0,
      );
    } finally {
      await instance.close();
    }
  });

  it("O3 — message counters increment on inbound and outbound frames", async () => {
    const instance = await startIndependentInstance("ws-obs-msgs");
    try {
      const sessionId = await makeScenario(instance).then((scenario) => scenario.sessionId);
      const client = await connectToInstance(instance);
      await joinAs(client, sessionId, "Student-1");

      const text = await scrape(instance);
      // session.join in, session.joined + session.state out at minimum.
      expect(seriesValue(text, "livepulse_ws_messages_received_total")).toBeGreaterThanOrEqual(1);
      expect(seriesValue(text, "livepulse_ws_messages_sent_total")).toBeGreaterThanOrEqual(2);

      await client.close();
    } finally {
      await instance.close();
    }
  });

  it("O4 — histogram families record observations with bounded labels", async () => {
    const instance = await startIndependentInstance("ws-obs-hist");
    try {
      const sessionId = await makeScenario(instance).then((scenario) => scenario.sessionId);
      const client = await connectToInstance(instance);
      await joinAs(client, sessionId, "Student-1");

      const text = await scrape(instance);
      expect(
        seriesValue(text, 'livepulse_ws_handler_duration_seconds_count{event="session.join"}'),
      ).toBe(1);
      expect(
        seriesValue(
          text,
          'livepulse_db_operation_duration_seconds_count{operation="session.join"}',
        ),
      ).toBe(1);
      // Recovery snapshot build is measured on the same join path.
      expect(seriesValue(text, "livepulse_recovery_duration_seconds_count")).toBe(1);
      expect(seriesValue(text, 'livepulse_recovery_builds_total{result="ok"}')).toBe(1);
      expect(seriesValue(text, 'livepulse_recovery_builds_total{result="error"}')).toBe(0);

      await client.close();
    } finally {
      await instance.close();
    }
  });

  it("O5 — session join/leave counters carry bounded role and reason labels", async () => {
    const instance = await startIndependentInstance("ws-obs-sessions");
    try {
      const scenario = await makeScenario(instance);
      const teacher = await connectToInstance(instance);
      const teacherJoined = await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
      expect(teacherJoined.role).toBe("TEACHER");
      const viewer = await connectToInstance(instance);
      await joinAs(viewer, scenario.sessionId); // view-only join has no participant

      let text = await scrape(instance);
      expect(seriesValue(text, 'livepulse_session_joins_total{role="TEACHER"}')).toBe(1);
      expect(seriesValue(text, 'livepulse_session_joins_total{role="viewer"}')).toBe(1);
      expect(seriesValue(text, "livepulse_sessions_with_connections")).toBe(1);

      await viewer.close();
      await teacher.close();
      await waitFor(() => instance.app.wsLayer!.registry.connectionCount === 0);
      text = await scrape(instance);
      expect(seriesValue(text, 'livepulse_session_leaves_total{reason="disconnect"}')).toBe(2);
      expect(seriesValue(text, "livepulse_sessions_with_connections")).toBe(0);
    } finally {
      await instance.close();
    }
  });

  it("O6 — quiz, doubt and recovery operations are measured", async () => {
    const instance = await startIndependentInstance("ws-obs-ops");
    try {
      const scenario = await makeScenario(instance);
      const teacher = await connectToInstance(instance);
      const teacherJoined = await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
      expect(teacherJoined.role).toBe("TEACHER");

      teacher.send({ type: "quiz.start", requestId: "s1", payload: { quizId: scenario.quizId } });
      await teacher.waitFor((m) => m.type === "quiz.started" && m.requestId === "s1");
      teacher.send({
        type: "question.publish",
        requestId: "s2",
        payload: { questionId: scenario.questionId },
      });
      await teacher.waitFor((m) => m.type === "question.published" && m.requestId === "s2");

      teacher.send({
        type: "quiz.answer",
        requestId: "a1",
        payload: { questionId: scenario.questionId, content: "answer-content-sentinel" },
      });
      await teacher.waitFor((m) => m.type === "answer.accepted" && m.requestId === "a1");

      teacher.send({ type: "doubt.create", requestId: "d1", payload: { content: "Why?" } });
      const doubtFrame = await teacher.waitFor(
        (m) => m.type === "doubt.created" && m.requestId === "d1",
      );
      const doubtId = (doubtFrame.payload as { doubt: { doubtId: string } }).doubt.doubtId;
      teacher.send({ type: "doubt.resolve", requestId: "d2", payload: { doubtId } });
      await teacher.waitFor((m) => m.type === "doubt.resolved" && m.requestId === "d2");

      const text = await scrape(instance);
      expect(seriesValue(text, 'livepulse_quiz_transitions_total{event="quiz.start"}')).toBe(1);
      expect(seriesValue(text, 'livepulse_quiz_transitions_total{event="question.publish"}')).toBe(
        1,
      );
      expect(seriesValue(text, 'livepulse_quiz_answers_total{result="accepted"}')).toBe(1);
      expect(seriesValue(text, "livepulse_quiz_answer_duration_seconds_count")).toBe(1);
      expect(seriesValue(text, 'livepulse_doubt_created_total{result="created"}')).toBe(1);
      expect(
        seriesValue(text, 'livepulse_doubt_operation_duration_seconds_count{operation="create"}'),
      ).toBe(1);
      expect(seriesValue(text, 'livepulse_doubt_transitions_total{status="RESOLVED"}')).toBe(1);
      expect(
        seriesValue(text, 'livepulse_doubt_operation_duration_seconds_count{operation="resolve"}'),
      ).toBe(1);

      await teacher.close();
    } finally {
      await instance.close();
    }
  });

  it("O7 — protocol errors are counted per bounded error code", async () => {
    const instance = await startIndependentInstance("ws-obs-errors");
    try {
      const client = await connectToInstance(instance);
      client.send({ type: "not.a.real.event", requestId: "e1", payload: {} });
      await client.waitFor((m) => m.type === "error" && m.requestId === "e1");

      const text = await scrape(instance);
      expect(
        seriesValue(text, 'livepulse_ws_protocol_errors_total{code="UNSUPPORTED_EVENT"}'),
      ).toBe(1);
      // The error code label is the ONLY label on that family.
      const series = text
        .split("\n")
        .filter((line) => line.startsWith("livepulse_ws_protocol_errors_total{"));
      expect(series).toHaveLength(1);

      await client.close();
    } finally {
      await instance.close();
    }
  });

  it("O8 — every label in the live exposition is bounded (no ids)", async () => {
    const instance = await startIndependentInstance("ws-obs-labels");
    try {
      const scenario = await makeScenario(instance);
      const client = await connectToInstance(instance);
      await joinAs(client, scenario.sessionId, "Student-1");
      client.send({ type: "doubt.create", requestId: "x1", payload: { content: "Q?" } });
      await client.waitFor((m) => m.type === "doubt.created" && m.requestId === "x1");

      const text = await scrape(instance);
      const labelPattern = /([a-zA-Z_][a-zA-Z0-9_]*)="/g;
      const seen = new Set<string>();
      for (const match of text.matchAll(labelPattern))
        if (match[1] !== undefined) seen.add(match[1]);
      const allowed = new Set([
        "code",
        "connection",
        "event",
        "le",
        "operation",
        "reason",
        "result",
        "role",
        "state",
        "status",
      ]);
      for (const label of seen) {
        expect(allowed.has(label), `label "${label}" must be bounded`).toBe(true);
      }
      expect(seen.size).toBeGreaterThanOrEqual(3);
      for (const forbidden of [
        "sessionId",
        "participantId",
        "doubtId",
        "questionId",
        "requestId",
        "eventId",
      ]) {
        expect(text.includes(`${forbidden}="`), `${forbidden} must not be a metric label`).toBe(
          false,
        );
      }
      // The concrete ids that flowed through the system are NOT in the output.
      expect(text).not.toContain(scenario.sessionId);
      expect(text).not.toContain(scenario.questionId);

      await client.close();
    } finally {
      await instance.close();
    }
  });

  it("O9 — /metrics does not depend on PostgreSQL being connected", async () => {
    const instance = await startIndependentInstance("ws-obs-nodb");
    try {
      await instance.app.prisma.$disconnect();
      const response = await instance.app.inject({ method: "GET", url: "/metrics" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("livepulse_ws_connections_active");
    } finally {
      await instance.close();
    }
  });

  it("O10 — METRICS_ENABLED=false disables the endpoint and the registry", async () => {
    const instance = await startIndependentInstance("ws-obs-off", { metricsEnabled: false });
    try {
      expect(instance.app.metrics).toBeNull();
      const response = await instance.app.inject({ method: "GET", url: "/metrics" });
      expect(response.statusCode).toBe(404);
      // The rest of the surface is unaffected.
      expect((await instance.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      await instance.close();
    }
  });

  it("O11 — logs carry correlation fields and never leak payload secrets", async () => {
    await resetDatabase(prisma);
    const stream = new CapturingStream();
    const instance = await startIndependentInstance("ws-obs-logs", { logStream: stream });
    try {
      const scenario = await makeScenario(instance);
      const teacher = await connectToInstance(instance);
      await joinAs(teacher, scenario.sessionId, scenario.teacherDisplayName);
      const student = await connectToInstance(instance);
      await joinAs(student, scenario.sessionId, "Student-Log");

      teacher.send({ type: "quiz.start", requestId: "l1", payload: { quizId: scenario.quizId } });
      await teacher.waitFor((m) => m.type === "quiz.started" && m.requestId === "l1");
      teacher.send({
        type: "question.publish",
        requestId: "l2",
        payload: { questionId: scenario.questionId },
      });
      await teacher.waitFor((m) => m.type === "question.published" && m.requestId === "l2");
      student.send({
        type: "quiz.answer",
        requestId: "l3",
        payload: { questionId: scenario.questionId, content: "answer-content-sentinel" },
      });
      await student.waitFor((m) => m.type === "answer.accepted" && m.requestId === "l3");

      await teacher.close();
      await student.close();
      await waitFor(() => instance.app.wsLayer!.registry.connectionCount === 0);

      const lines = stream.lines();
      expect(lines.length).toBeGreaterThan(5);
      const messages = lines.map((line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed.instanceId).toBe("ws-obs-logs"); // correlation field
        return JSON.stringify(parsed);
      });
      const joined = messages.join("\n");
      expect(joined).toContain("WebSocket session joined");
      expect(joined).toContain("WebSocket connection closed");
      // No payload secrets, and no infrastructure credentials.
      expect(joined).not.toContain(scenario.correctAnswer);
      expect(joined).not.toContain("answer-content-sentinel");
      expect(joined).not.toContain("postgresql://");
      expect(joined).not.toContain("redis://");
      // startListeningServer's config uses the test database URL — the app's
      // logger must never echo DATABASE_URL/REDIS_URL anywhere.
      expect(joined).not.toContain(TEST_DATABASE_URL);
    } finally {
      await instance.close();
    }
  }, 20_000);
});
