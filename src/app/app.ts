import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import type { AppConfig } from "../config/index.js";
import { prismaPlugin } from "../infrastructure/prisma/index.js";
import { createMetrics, type Metrics } from "../infrastructure/metrics/index.js";
import { healthRoutes } from "./routes/health.js";
import { readyRoutes } from "./routes/ready.js";
import { metricsRoutes } from "./routes/metrics.js";
import { sessionRoutes } from "../modules/sessions/session.routes.js";
import { quizRoutes } from "../modules/quizzes/quiz.routes.js";
import { NotFoundError, InvalidStateTransitionError } from "../shared/errors.js";
import { attachWebSocketLayer, type WebSocketLayer } from "../ws/index.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Present (non-null) only when the app was built with listen: true. */
    wsLayer: WebSocketLayer | null;
    /** Phase 7 per-instance Prometheus registry; null when METRICS_ENABLED=false. */
    metrics: Metrics | null;
  }
}

export interface BuildAppOptions {
  config: AppConfig;
  /**
   * When true, buildApp starts the HTTP listener and attaches the WebSocket
   * layer to the same server (Phase 2). Default false: tests use fastify
   * inject() over HTTP and explicit WS suites pass listen: true.
   */
  listen?: boolean;
  /**
   * Test seam (Phase 7): capture Pino's structured output into a stream so
   * suites can assert on what is (and is NOT) logged. When absent, the usual
   * environment-driven logger configuration applies (off under NODE_ENV=test).
   */
  logStream?: NodeJS.WritableStream | undefined;
}

/**
 * Build the Fastify application with configuration-driven logging,
 * plugins, domain routes and centralized error mapping.
 *
 * The returned app is NOT listening yet — `server.ts` owns the process-level
 * concerns (listen, signals, shutdown), and tests own their own lifecycle.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;

  const logStream = options.logStream;
  const app = Fastify({
    logger:
      logStream !== undefined
        ? { level: config.LOG_LEVEL, stream: logStream, base: { instanceId: config.INSTANCE_ID } }
        : config.NODE_ENV === "test"
          ? false // keep test output clean; assertions use the HTTP responses
          : config.NODE_ENV === "development"
            ? {
                level: config.LOG_LEVEL,
                // Log correlation (ADR-009): every line carries the logical
                // instance id so multi-instance logs can be attributed.
                base: { instanceId: config.INSTANCE_ID },
                // Human-friendly logs locally; production keeps single-line JSON.
                transport: { target: "pino-pretty" },
              }
            : { level: config.LOG_LEVEL, base: { instanceId: config.INSTANCE_ID } },
  });

  // One process-local registry per instance (never shared, never in Redis/PG).
  app.decorate("metrics", config.METRICS_ENABLED ? createMetrics() : null);

  // Helpful HTTP errors (httpErrors.notFound(), 4xx/5xx constructors) for later phases.
  await app.register(sensible);

  await app.register(prismaPlugin, { databaseUrl: config.DATABASE_URL });

  // Centralized error mapping: domain errors -> predictable HTTP responses.
  // Keeps handlers free of try/catch noise and guarantees a consistent shape:
  // { statusCode, error, message } (+ optional details for validation).
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: "Request validation failed",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    if (error instanceof NotFoundError) {
      return reply.code(404).send({ statusCode: 404, error: "Not Found", message: error.message });
    }
    if (error instanceof InvalidStateTransitionError) {
      return reply.code(409).send({
        statusCode: 409,
        error: "Conflict",
        message: error.message,
      });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002: unique constraint violation (e.g., concurrent duplicate membership).
      if (error.code === "P2002") {
        return reply.code(409).send({
          statusCode: 409,
          error: "Conflict",
          message: "Resource already exists",
          details: { targets: error.meta?.target },
        });
      }
      // P2025: record not found during a nested write.
      if (error.code === "P2025") {
        return reply
          .code(404)
          .send({ statusCode: 404, error: "Not Found", message: "Resource not found" });
      }
    }
    // Framework errors (malformed JSON body, unsupported media type, Fastify's
    // own 404, ...) already carry an HTTP status code — pass them through in
    // the same consistent body shape instead of masking them as 500s.
    const httpStatus = typeof error.statusCode === "number" ? error.statusCode : undefined;
    if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
      const labels: Record<number, string> = {
        400: "Bad Request",
        401: "Unauthorized",
        403: "Forbidden",
        404: "Not Found",
        409: "Conflict",
        413: "Payload Too Large",
        415: "Unsupported Media Type",
      };
      return reply.code(httpStatus).send({
        statusCode: httpStatus,
        error: labels[httpStatus] ?? "Error",
        message: error.message,
      });
    }
    request.log.error({ err: error }, "Unhandled error");
    return reply.code(500).send({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Internal Server Error",
    });
  });

  await app.register(healthRoutes);
  await app.register(readyRoutes, { prisma: app.prisma });
  await app.register(metricsRoutes, { metrics: app.metrics });
  await app.register(sessionRoutes, { prisma: app.prisma });
  await app.register(quizRoutes, { prisma: app.prisma });

  app.get("/", async () => {
    return { name: "livepulse", status: "ok" };
  });

  app.decorate("wsLayer", null);

  // Plain-HTTP GET /ws without an Upgrade header -> 426 (curl-able, testable).
  // Registered with the other routes, BEFORE listening — Fastify rejects
  // routes added after the server has started.
  app.get("/ws", async (_request, reply) => {
    return reply.code(426).send({
      statusCode: 426,
      error: "Upgrade Required",
      message: "WebSocket connections must use the ws:// protocol at /ws",
    });
  });

  // WebSocket teardown must happen BEFORE the HTTP server closes: Node's
  // server.close() waits for open (upgraded) TCP sockets, and only the WS
  // layer can close them. Fastify runs "preClose" hooks before server.close
  // and "onClose" hooks after — using onClose here would deadlock shutdown.
  // Async preClose handlers take no arguments (Fastify's documented pattern).
  app.addHook("preClose", async () => {
    await app.wsLayer?.close();
  });

  await app.ready();

  if (options.listen === true) {
    // Attach the WS layer BEFORE listening: it registers the upgrade listener
    // on Fastify's shared HTTP server (one port serves HTTP and WS). It must
    // run after ready() because it reads app.prisma and app.log.
    app.wsLayer = attachWebSocketLayer({ config, httpServer: app.server, app });
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
  }

  return app;
}
