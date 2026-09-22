import type { FastifyInstance } from "fastify";

/**
 * GET /health
 *
 * Liveness probe: the process is up and its event loop is responsive.
 * Deliberately does NOT check PostgreSQL/Redis — a failing dependency should
 * not make an orchestrator kill an otherwise functional process. A richer
 * dependency-aware readiness endpoint comes in a later phase when there is
 * real state to report.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    return { status: "ok" };
  });
}
