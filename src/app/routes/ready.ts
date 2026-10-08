import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

/**
 * Phase 9.5: bounded PostgreSQL readiness probe. Must stay materially below
 * the Nginx healthcheck interval (10 s) — SELECT 1 is millisecond-scale, so
 * 1 s bounds even a wedged pool without risking false unready flaps.
 */
const PG_READINESS_TIMEOUT_MS = 1_000;

export interface ReadyRoutesOptions {
  prisma: PrismaClient;
}

/**
 * GET /ready — traffic readiness (distinct from /health liveness).
 *
 * - 200 `ready:true` iff PostgreSQL answers. Redis NEVER flips the code:
 *   both connections ready → `redis:"ok"`, anything else → `"degraded"`
 *   (local serving continues; cross-instance propagation is degraded).
 * - 503 `ready:false, postgres:"unavailable"` when PostgreSQL is unreachable.
 * - Fixed enum strings only — no connection strings, errors, hostnames, or
 *   stack traces ever leave the process.
 *
 * The PG probe is one read-only `SELECT 1` with a hard timeout: no business
 * repository, no interactive transaction, no migrations, no extra pool.
 */
export async function readyRoutes(
  app: FastifyInstance,
  options: ReadyRoutesOptions,
): Promise<void> {
  app.get("/ready", async (_request, reply) => {
    let postgresOk = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        options.prisma.$queryRaw`SELECT 1`,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("pg readiness timeout")),
            PG_READINESS_TIMEOUT_MS,
          );
          // Never keep the process alive for a hung probe.
          timer.unref?.();
        }),
      ]);
      postgresOk = true;
    } catch {
      postgresOk = false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // Same connections the app publishes/subscribes on — read, never created
    // here. Absent layer (non-listening/test) or never-connected both read as
    // degraded: propagation is unavailable either way.
    const redis = app.wsLayer?.redis;
    const redisOk =
      redis !== undefined && redis !== null ? redis.publisherReady && redis.subscriberReady : false;

    return reply.code(postgresOk ? 200 : 503).send({
      ready: postgresOk,
      postgres: postgresOk ? "ok" : "unavailable",
      redis: redisOk ? "ok" : "degraded",
    });
  });
}
