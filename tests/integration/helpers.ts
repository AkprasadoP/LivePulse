import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import WebSocket from "ws";
import { once } from "node:events";
import { buildApp } from "../../src/app/app.js";
import { loadConfig } from "../../src/config/index.js";
import type { ServerEnvelope } from "../../src/ws/index.js";

/**
 * Shared setup for integration tests.
 *
 * All suites run against the dedicated test database (livepulse_test in the
 * compose PostgreSQL instance) — the real persistence layer, never mocks.
 * Suites run sequentially in one fork (vitest.integration.config.ts), so
 * TRUNCATE between tests cannot race another suite's queries.
 */
export const TEST_DATABASE_URL =
  process.env.LIVEPULSE_TEST_DATABASE_URL ??
  "postgresql://livepulse:livepulse@localhost:5433/livepulse_test";

const testConfig = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: "redis://localhost:6380",
  PORT: "0", // ephemeral port: never collides with a dev server
});

/** Poll until the predicate holds; used for async server-side state (registry cleanup, heartbeats). */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  stepMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/** Async variant of waitFor for conditions that need database reads. */
export async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
  stepMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

export interface IntegrationContext {
  app: FastifyInstance;
  prisma: PrismaClient;
  /** HTTP helper: injects a request and returns status + parsed body. */
  request: (
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
  ) => Promise<{
    statusCode: number;
    body: any;
  }>;
}

interface TestServer {
  app: FastifyInstance;
  prisma: PrismaClient;
  /** Set only for listening servers (required for real WS connections). */
  port: number | null;
  request: IntegrationContext["request"];
}

let current: TestServer | null = null;

/**
 * Start the app for HTTP-only suites: fastify.inject() needs no listener and
 * keeps tests faster and port-free. Unchanged from Phase 1 behavior.
 */
export async function startTestApp(): Promise<IntegrationContext> {
  if (!current) {
    const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
    await prisma.$connect();
    const app = await buildApp({ config: testConfig });
    await app.ready();

    const request = async (method: "GET" | "POST", url: string, payload?: unknown) => {
      const response = await app.inject({
        method,
        url,
        // Conditional spread: exactOptionalPropertyTypes forbids explicit undefined.
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

    current = { app, prisma, port: null, request };
  }
  const { app, prisma, request } = current;
  return { app, prisma, request };
}

/** A listening TestServer always has a concrete TCP port. */
export interface ListeningServer extends TestServer {
  port: number;
}

/**
 * Start the app with a real listener and return its port. WebSocket suites
 * connect real ws clients here — no socket mocking anywhere.
 */
export async function startListeningServer(): Promise<ListeningServer> {
  if (current) {
    if (current.port === null) throw new Error("A non-listening test app is already running");
    return current as ListeningServer;
  }

  const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
  await prisma.$connect();
  const app = await buildApp({ config: testConfig, listen: true });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to listen on a TCP port");
  }

  const request = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const response = await app.inject({
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

  current = { app, prisma, port: address.port, request };
  return current as ListeningServer;
}

export async function stopTestApp(): Promise<void> {
  if (!current) return;
  // app.close() runs our onClose hook (WS layer teardown) before Prisma's.
  await current.app.close();
  await current.prisma.$disconnect(); // the harness's own client
  current = null;
}

/** Wipes all domain data between tests. Order is irrelevant thanks to CASCADE. */
export async function resetDatabase(): Promise<void> {
  if (!current) throw new Error("startTestApp() must run before resetDatabase()");
  // TRUNCATE takes ACCESS EXCLUSIVE locks on every table; a still-in-flight
  // server transaction (e.g. an answer submission mid-election) can hold a
  // conflicting lock, and Postgres resolves the resulting cycle by aborting
  // the TRUNCATE with 40P01. Never a correctness signal — retry a few times.
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await current.prisma.$executeRawUnsafe(
        `TRUNCATE TABLE answers, doubts, questions, quizzes, session_participants, sessions, users RESTART IDENTITY CASCADE`,
      );
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : "";
      if (code === "40P01" && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 3 scenario helpers
// ---------------------------------------------------------------------------

let joinCounter = 0;

export interface QuizScenario {
  sessionId: string;
  teacherDisplayName: string;
  quizId: string;
  questions: Array<{
    id: string;
    prompt: string;
    correctAnswer: string | null;
    firstCorrectWins: boolean;
  }>;
}

/**
 * Create a session (creator = TEACHER participant), a quiz with questions,
 * and move the session to LIVE — ready for quiz.start over WS.
 */
export async function createLiveQuizScenario(
  options: {
    correctAnswer?: string | null;
    firstCorrectWins?: boolean;
    questionCount?: number;
  } = {},
): Promise<QuizScenario> {
  if (!current) throw new Error("startListeningServer() must run first");
  const { request } = current;
  const correctAnswer = options.correctAnswer === undefined ? "42" : options.correctAnswer;
  const questionCount = options.questionCount ?? 1;
  // correctAnswer is optional (string), NOT nullable, in the Phase 1 API:
  // an unkeyed question omits the field entirely.
  const questionBody =
    correctAnswer === null
      ? { firstCorrectWins: options.firstCorrectWins ?? true }
      : { correctAnswer, firstCorrectWins: options.firstCorrectWins ?? true };

  const teacherDisplayName = `Teacher-${Math.random().toString(36).slice(2, 10)}`;
  const created = await request("POST", "/sessions", {
    name: `Scenario ${Date.now()}`,
    creator: { displayName: teacherDisplayName },
  });
  if (created.statusCode !== 201) throw new Error(`session create failed: ${created.statusCode}`);
  const sessionId = created.body.session.id as string;

  const quizResponse = await request("POST", `/sessions/${sessionId}/quizzes`, {
    title: "Race quiz",
    questions: Array.from({ length: questionCount }, (_, i) => ({
      prompt: `Question ${i + 1}: what is the answer?`,
      ...questionBody,
    })),
  });
  if (quizResponse.statusCode !== 201) {
    throw new Error(`quiz create failed: ${quizResponse.statusCode}`);
  }
  const quiz = quizResponse.body.quiz;

  const live = await request("POST", `/sessions/${sessionId}/state`, { state: "LIVE" });
  if (live.statusCode !== 200) throw new Error(`session start failed: ${live.statusCode}`);

  return {
    sessionId,
    teacherDisplayName,
    quizId: quiz.id,
    questions: (quiz.questions as Array<Record<string, unknown>>).map((q) => ({
      id: q.id as string,
      prompt: q.prompt as string,
      correctAnswer: (q.correctAnswer as string | null) ?? null,
      firstCorrectWins: q.firstCorrectWins as boolean,
    })),
  };
}

/** Join a session over WS (optionally binding a participant) and await the ack. */
export async function joinAs(
  client: WsTestClient,
  sessionId: string,
  displayName?: string,
): Promise<{ participantId: string | null; role: string | null; state: string }> {
  const requestId = `join-${++joinCounter}`;
  client.send({
    type: "session.join",
    requestId,
    payload: {
      sessionId,
      ...(displayName === undefined ? {} : { participant: { displayName } }),
    },
  });
  const joined = await client.waitFor(
    (m) => m.type === "session.joined" && m.requestId === requestId,
  );
  const payload = joined.payload as {
    participantId: string | null;
    role: string | null;
    state: string;
  };
  return { participantId: payload.participantId, role: payload.role, state: payload.state };
}

// ---------------------------------------------------------------------------
// WebSocket test client
// ---------------------------------------------------------------------------

/**
 * Minimal deterministic client over a REAL socket. Collects server frames so
 * tests can assert on them; open/close are awaited, not guessed at.
 */
export class WsTestClient {
  private socket: WebSocket | null = null;
  private readonly received: ServerEnvelope[] = [];
  private readonly waiters: Array<{
    predicate: (message: ServerEnvelope) => boolean;
    resolve: (message: ServerEnvelope) => void;
    timer: NodeJS.Timeout;
  }> = [];

  public async connect(port: number): Promise<void> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.on("message", (data) => {
      let message: ServerEnvelope;
      try {
        message = JSON.parse(String(data)) as ServerEnvelope;
      } catch {
        return; // a broken server frame is a test failure via timeout instead
      }
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const waiter = this.waiters[waiterIndex];
        if (waiter === undefined) return; // unreachable: index was just found
        this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
      this.received.push(message);
    });
    await once(socket, "open");
    this.socket = socket;
  }

  public send(message: unknown): void {
    if (!this.socket) throw new Error("WsTestClient.connect() must run before send()");
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  /** Wait for the next message (default) or the first matching one. */
  public waitFor(
    predicate: (message: ServerEnvelope) => boolean = () => true,
    timeoutMs = 3_000,
  ): Promise<ServerEnvelope> {
    const bufferedIndex = this.received.findIndex(predicate);
    if (bufferedIndex >= 0) {
      const buffered = this.received[bufferedIndex];
      if (buffered !== undefined) {
        this.received.splice(bufferedIndex, 1);
        return Promise.resolve(buffered);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for a matching server message`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  /** Collected frames minus any that an earlier waitFor() consumed. */
  public drain(): ServerEnvelope[] {
    return this.received.splice(0, this.received.length);
  }

  public get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Resolves when the CURRENT socket closes, with the close code. */
  public closed(): Promise<{ code: number; reason: string }> {
    if (!this.socket) return Promise.reject(new Error("WsTestClient is not connected"));
    return once(this.socket, "close").then(([code, reason]) => ({
      code: code as number,
      reason: typeof reason === "string" ? reason : Buffer.from(reason ?? []).toString(),
    }));
  }

  /** Abrupt transport teardown (no close handshake) — simulates a crash/mid-flight disconnect. */
  public async destroy(): Promise<void> {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    socket.terminate();
    await once(socket, "close").catch(() => {});
  }

  /** Graceful client-side close with code 1000; resolves on 'close'. */
  public async close(code = 1000): Promise<void> {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    if (socket.readyState === WebSocket.OPEN) socket.close(code);
    await once(socket, "close");
  }
}

/** Convenience: create + connect one client to the current listening test server. */
export async function connectWsClient(): Promise<WsTestClient> {
  if (!current || current.port === null) {
    throw new Error("startListeningServer() must run before connectWsClient()");
  }
  const client = new WsTestClient();
  await client.connect(current.port);
  return client;
}

/** Awaitable close for raw sockets (used for half-open liveness tests). */
export async function closeSocket(socket: WebSocket, code = 1000): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) socket.close(code);
  await once(socket, "close");
}
