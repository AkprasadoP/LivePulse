import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import type { AppConfig } from "../config/index.js";
import { prismaPlugin } from "../infrastructure/prisma/index.js";
import { healthRoutes } from "./routes/health.js";
import { sessionRoutes } from "../modules/sessions/session.routes.js";
import { quizRoutes } from "../modules/quizzes/quiz.routes.js";
import { NotFoundError, InvalidStateTransitionError } from "../shared/errors.js";

export interface BuildAppOptions {
  config: AppConfig;
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

  const app = Fastify({
    logger:
      config.NODE_ENV === "test"
        ? false // keep test output clean; assertions use the HTTP responses
        : config.NODE_ENV === "development"
          ? {
              level: config.LOG_LEVEL,
              // Human-friendly logs locally; production keeps single-line JSON.
              transport: { target: "pino-pretty" },
            }
          : { level: config.LOG_LEVEL },
  });

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
  await app.register(sessionRoutes, { prisma: app.prisma });
  await app.register(quizRoutes, { prisma: app.prisma });

  app.get("/", async () => {
    return { name: "livepulse", status: "ok" };
  });

  return app;
}
