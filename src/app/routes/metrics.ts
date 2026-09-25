import type { FastifyInstance } from "fastify";
import type { Metrics } from "../../infrastructure/metrics/index.js";

export interface MetricsRouteOptions {
  /** Null when METRICS_ENABLED=false — the route then answers 404. */
  metrics: Metrics | null;
}

/**
 * GET /metrics — Prometheus text exposition.
 *
 * Contract (ADR-009, docs/architecture/observability.md):
 *   - Renders ONLY this instance's process-local registry.
 *   - Never queries PostgreSQL or Redis: scraping cannot be affected by (or
 *     affect) dependency health, and a metrics read must never create load on
 *     the durable store.
 *   - Unauthenticated by design in Phase 7 (ops/dev endpoint on the same
 *     port). Authentication arrives with the auth phase.
 *   - Registered but 404 when METRICS_ENABLED=false, so the route surface is
 *     identical and only the behavior differs.
 *
 * /health stays liveness-only; dependency state is surfaced through these
 * metrics (and logs) instead.
 */
export async function metricsRoutes(
  app: FastifyInstance,
  options: MetricsRouteOptions,
): Promise<void> {
  app.get("/metrics", async (_request, reply) => {
    if (options.metrics === null) {
      return reply.code(404).send({
        statusCode: 404,
        error: "Not Found",
        message: "Metrics are disabled",
      });
    }
    const body = await options.metrics.render();
    return reply.header("content-type", options.metrics.contentType).send(body);
  });
}
