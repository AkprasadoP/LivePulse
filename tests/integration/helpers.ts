import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app/app.js";
import { loadConfig } from "../../src/config/index.js";

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
});

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

let current: IntegrationContext | null = null;

export async function startTestApp(): Promise<IntegrationContext> {
  if (current) return current;
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

  current = { app, prisma, request };
  return current;
}

export async function stopTestApp(): Promise<void> {
  if (!current) return;
  await current.app.close(); // runs Prisma plugin onClose -> app client $disconnect
  await current.prisma.$disconnect(); // the harness's own client
  current = null;
}

/** Wipes all domain data between tests. Order is irrelevant thanks to CASCADE. */
export async function resetDatabase(): Promise<void> {
  if (!current) throw new Error("startTestApp() must run before resetDatabase()");
  await current.prisma.$executeRawUnsafe(
    `TRUNCATE TABLE answers, doubts, questions, quizzes, session_participants, sessions, users RESTART IDENTITY CASCADE`,
  );
}
