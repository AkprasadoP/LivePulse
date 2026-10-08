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

/**
 * Phase 10.7: ONE shared test access-token secret across every test instance.
 * Tokens must verify on whichever instance a client lands on (especially
 * multi-instance suites) — per-instance ephemeral secrets would make
 * cross-instance tokens invalid. Test-only, never production-shaped.
 */
export const TEST_AUTH_ACCESS_SECRET = "test-access-secret-0123456789abcdef";

const testConfig = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: "redis://localhost:6380",
  PORT: "0", // ephemeral port: never collides with a dev server
  AUTH_ACCESS_SECRET: TEST_AUTH_ACCESS_SECRET,
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
    headers?: Record<string, string>,
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
 * Phase 10.7: every app currently open in this process (any flavour).
 * registerTestUser injects a registration into one of them when callers don't
 * pass an explicit app. Tokens verify on EVERY instance via the shared
 * TEST_AUTH_ACCESS_SECRET and users are global (shared test DB), so any OPEN
 * app is a valid target — tracking all of them keeps this correct when the
 * most recently started instance is closed (crash/shutdown tests) while
 * others remain serving.
 */
const openApps: FastifyInstance[] = [];
function trackApp(app: FastifyInstance): void {
  openApps.push(app);
}
function untrackApp(app: FastifyInstance): void {
  const index = openApps.indexOf(app);
  if (index >= 0) openApps.splice(index, 1);
}

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

    const request = async (
      method: "GET" | "POST",
      url: string,
      payload?: unknown,
      headers?: Record<string, string>,
    ) => {
      const response = await app.inject({
        method,
        url,
        // Conditional spread: exactOptionalPropertyTypes forbids explicit undefined.
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

    current = { app, prisma, port: null, request };
    trackApp(app);
  }
  const { app, prisma, request } = current;
  return { app, prisma, request };
}

/** A listening TestServer always has a concrete TCP port. */
export interface ListeningServer extends TestServer {
  port: number;
}

/**
 * Phase 4: an INDEPENDENT app instance (own Fastify, own WS layer, own Redis
 * connections, own registry) for multi-instance tests. Deliberately not tied
 * to the single `current` server: two of these run simultaneously.
 */
export interface IndependentInstance {
  app: FastifyInstance;
  port: number;
  instanceId: string;
  /** Resolves when the Redis subscribe attempt has completed. */
  distributionReady: Promise<void>;
  close(): Promise<void>;
}

/**
 * Boot one fully independent instance with a distinct INSTANCE_ID on an
 * ephemeral port, sharing the compose PostgreSQL + Redis.
 */
export async function startIndependentInstance(
  instanceId: string,
  overrides: {
    distributionEnabled?: boolean;
    /** Phase 7: cadence of the presence digest (staleness = 3 × this). */
    presenceDigestIntervalMs?: number;
    /** Phase 7: disable GET /metrics entirely (route then answers 404). */
    metricsEnabled?: boolean;
    /** Phase 7: heartbeat cadence for presence-removal-on-sweep tests. */
    wsHeartbeatIntervalMs?: number;
    /** Test seam: capture structured log lines instead of discarding them. */
    logStream?: NodeJS.WritableStream;
  } = {},
): Promise<IndependentInstance> {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: process.env.LIVEPULSE_TEST_REDIS_URL ?? "redis://localhost:6380",
    PORT: "0",
    INSTANCE_ID: instanceId,
    AUTH_ACCESS_SECRET: TEST_AUTH_ACCESS_SECRET,
    DISTRIBUTION_ENABLED: (overrides.distributionEnabled ?? true) ? "true" : "false",
    // Conditional spread: exactOptionalPropertyTypes forbids explicit undefined.
    ...(overrides.presenceDigestIntervalMs === undefined
      ? {}
      : { PRESENCE_DIGEST_INTERVAL_MS: String(overrides.presenceDigestIntervalMs) }),
    ...(overrides.metricsEnabled === undefined
      ? {}
      : { METRICS_ENABLED: overrides.metricsEnabled ? "true" : "false" }),
    ...(overrides.wsHeartbeatIntervalMs === undefined
      ? {}
      : { WS_HEARTBEAT_INTERVAL_MS: String(overrides.wsHeartbeatIntervalMs) }),
  });
  const app = await buildApp({
    config,
    listen: true,
    ...(overrides.logStream === undefined ? {} : { logStream: overrides.logStream }),
  });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the instance to listen on a TCP port");
  }
  const layer = app.wsLayer;
  if (layer === null) throw new Error("WS layer missing after listen");
  await layer.distributionReady;
  trackApp(app);
  return {
    app,
    port: address.port,
    instanceId,
    distributionReady: Promise.resolve(),
    close: async () => {
      untrackApp(app);
      await app.close();
    },
  };
}

/**
 * Phase 7 presence helper: wait for the next `presence.snapshot` for a session
 * whose participant set satisfies the predicate. Errors after the timeout, so
 * a missing snapshot is a test failure rather than a silent pass.
 */
export async function waitForPresence(
  client: WsTestClient,
  sessionId: string,
  predicate: (participantIds: string[]) => boolean,
  timeoutMs = 5_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `No matching presence.snapshot within ${timeoutMs}ms (last seen: ${JSON.stringify(last)})`,
      );
    }
    const message = await client.waitFor(
      (m) =>
        m.type === "presence.snapshot" &&
        (m.payload as { sessionId?: string }).sessionId === sessionId,
      remaining,
    );
    last = (
      (message.payload as { participants: Array<{ participantId: string }> }).participants ?? []
    ).map((p) => p.participantId);
    if (predicate(last)) return last;
  }
}

/** WsTestClient connected to a SPECIFIC instance (not the shared `current`). */
export async function connectToInstance(instance: IndependentInstance): Promise<WsTestClient> {
  const client = new WsTestClient();
  await client.connect(instance.port);
  return client;
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

  const request = async (
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => {
    const response = await app.inject({
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

  current = { app, prisma, port: address.port, request };
  trackApp(app);
  return current as ListeningServer;
}

export async function stopTestApp(): Promise<void> {
  if (!current) return;
  // app.close() runs our onClose hook (WS layer teardown) before Prisma's.
  const stopped = current.app;
  untrackApp(stopped);
  await current.app.close();
  await current.prisma.$disconnect(); // the harness's own client
  current = null;
}

/**
 * Wipes all domain data between tests. Order is irrelevant thanks to CASCADE.
 * Accepts an explicit client (multi-instance suites, which own their own
 * Prisma connection and do not use the shared `current` server).
 */
export async function resetDatabase(explicitPrisma?: PrismaClient): Promise<void> {
  const target = explicitPrisma ?? current?.prisma;
  if (!target)
    throw new Error("resetDatabase() needs a running test app or an explicit prisma client");
  // TRUNCATE takes ACCESS EXCLUSIVE locks on every table; a still-in-flight
  // server transaction (e.g. an answer submission mid-election) can hold a
  // conflicting lock, and Postgres resolves the resulting cycle by aborting
  // the TRUNCATE with 40P01. Never a correctness signal — retry a few times.
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await target.$executeRawUnsafe(
        `TRUNCATE TABLE answers, doubts, questions, quizzes, session_participants, sessions, users, credentials, auth_sessions RESTART IDENTITY CASCADE`,
      );
      // Phase 10.7: user rows are gone, so cached test identities (userIds +
      // tokens pointing at deleted rows) must go too — otherwise a later
      // joinAs with the same displayName would authenticate as a ghost.
      testUsers.clear();
      testUserCounter = 0;
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

// ---------------------------------------------------------------------------
// Phase 10.7 authenticated test identity.
// ---------------------------------------------------------------------------

/** One registered test user per displayName, cached process-wide. */
const testUsers = new Map<string, { userId: string; accessToken: string; email: string }>();
let testUserCounter = 0;

function resolveHelperApp(explicit?: FastifyInstance): FastifyInstance {
  const app = explicit ?? openApps[openApps.length - 1] ?? current?.app;
  if (!app) throw new Error("no test app available for authenticated helper");
  return app;
}

/**
 * Register (once per displayName) and return credentials usable on ANY test
 * instance: users are global (shared test DB) and tokens verify everywhere
 * via TEST_AUTH_ACCESS_SECRET. Password is a fixed test secret — these are
 * throwaway rows, never real credentials.
 */
export async function registerTestUser(
  displayName: string,
  app?: FastifyInstance,
): Promise<{ userId: string; accessToken: string; email: string }> {
  const cached = testUsers.get(displayName);
  if (cached) return cached;
  testUserCounter += 1;
  // Random suffix: some suites run without resetDatabase() between tests, so
  // the counter alone can repeat an email across a file boundary (409).
  const email = `testuser-${testUserCounter}-${Math.random().toString(36).slice(2, 10)}@test.local`;
  const target = resolveHelperApp(app);
  const response = await target.inject({
    method: "POST",
    url: "/auth/register",
    payload: JSON.stringify({ email, password: "test-password-12", displayName }),
    headers: { "content-type": "application/json" },
  });
  if (response.statusCode !== 201) {
    throw new Error(
      `test user registration failed: ${response.statusCode} ${response.body.slice(0, 200)}`,
    );
  }
  const body = response.json() as any;
  const entry = { userId: body.user.id as string, accessToken: body.accessToken as string, email };
  testUsers.set(displayName, entry);
  return entry;
}

/** Bearer headers for an access token (session creation etc.). */
export function bearerHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

/**
 * Phase 10.7: create a session as an authenticated user (POST /sessions
 * requires a token; creator comes from the token subject). Response shape
 * is unchanged from the legacy endpoint (session + teacherParticipant).
 */
export async function createAuthedSession(
  app: FastifyInstance,
  name: string,
  accessToken: string,
): Promise<{ statusCode: number; body: any }> {
  const response = await app.inject({
    method: "POST",
    url: "/sessions",
    payload: JSON.stringify({ name }),
    headers: { "content-type": "application/json", ...bearerHeaders(accessToken) },
  });
  return { statusCode: response.statusCode, body: response.json() as any };
}

/**
 * Phase 10.7: register a fresh test user and create a session owned by it.
 * The creator identity is the returned `creatorDisplayName`, which callers
 * pass to `joinAs(...)` — the shared identity cache resolves it to the SAME
 * registered user, so the join binds the TEACHER participant. Retires the
 * old anonymous auto-provisioned creator path in tests.
 */
export async function registerAndCreateSession(
  app: FastifyInstance,
  name: string,
  displayName?: string,
): Promise<{
  sessionId: string;
  creatorUserId: string;
  creatorDisplayName: string;
  accessToken: string;
}> {
  const creatorDisplayName = displayName ?? `Teacher-${Math.random().toString(36).slice(2, 10)}`;
  const identity = await registerTestUser(creatorDisplayName, app);
  const response = await app.inject({
    method: "POST",
    url: "/sessions",
    payload: JSON.stringify({ name }),
    headers: { "content-type": "application/json", ...bearerHeaders(identity.accessToken) },
  });
  if (response.statusCode !== 201) {
    throw new Error(`session create failed: ${response.statusCode} ${response.body.slice(0, 200)}`);
  }
  const body = response.json() as any;
  return {
    sessionId: body.session.id as string,
    creatorUserId: body.session.creator.id as string,
    creatorDisplayName: body.session.creator.displayName as string,
    accessToken: identity.accessToken,
  };
}

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
  // Phase 10.7: creation requires authentication — the registered teacher
  // owns the session (no client-supplied creator identity remains).
  const teacher = await registerTestUser(teacherDisplayName);
  const created = await request(
    "POST",
    "/sessions",
    {
      name: `Scenario ${Date.now()}`,
    },
    bearerHeaders(teacher.accessToken),
  );
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

/**
 * Join a session over WS and await the ack. Phase 10.7: with a displayName,
 * authenticates first (registered test user) and joins WITHOUT any identity
 * payload — the server resolves the participant by (sessionId, userId).
 * Without a displayName the join is view-only (no participant bound).
 * Returns the full session.joined payload; `recovery` is the Phase 5 snapshot
 * (null when the session has no quizzes yet). Consumes exactly one
 * session.joined frame, so callers can drain afterwards and assert that no
 * duplicate join frames arrived.
 */
export async function joinAs(
  client: WsTestClient,
  sessionId: string,
  displayName?: string,
  app?: FastifyInstance,
): Promise<{
  participantId: string | null;
  role: string | null;
  state: string;
  recovery: unknown;
}> {
  const requestId = `join-${++joinCounter}`;
  if (displayName !== undefined) {
    const identity = await registerTestUser(displayName, app);
    client.send({
      type: "auth.authenticate",
      requestId: `auth-${requestId}`,
      payload: { token: identity.accessToken },
    });
    await client.waitFor(
      (m) => m.type === "auth.authenticated" && m.requestId === `auth-${requestId}`,
    );
  }
  client.send({
    type: "session.join",
    requestId,
    payload: { sessionId },
  });
  const joined = await client.waitFor(
    (m) => m.type === "session.joined" && m.requestId === requestId,
  );
  const payload = joined.payload as {
    participantId: string | null;
    role: string | null;
    state: string;
    recovery: unknown;
  };
  return {
    participantId: payload.participantId,
    role: payload.role,
    state: payload.state,
    recovery: payload.recovery,
  };
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

  /**
   * Freeze the transport: stop reading, so server pings are never answered.
   * This is what a hung/frozen client looks like — the heartbeat sweep kills
   * it without any cooperative close. Pair with resume() to revive.
   */
  public freeze(): void {
    this.socket?.pause();
  }

  /** Undo freeze(). */
  public resume(): void {
    this.socket?.resume();
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
