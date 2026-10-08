import { z } from "zod";
import { randomBytes } from "node:crypto";

/**
 * Typed application configuration, parsed from environment variables.
 *
 * Parsing happens exactly once at process start. An invalid or missing
 * configuration fails fast with an explicit error instead of letting the
 * server come up in a half-configured state (AGENT.md: explicit failure handling).
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // 0 is allowed and means "OS-assigned ephemeral port" (used by tests);
  // real deployments should always pin a concrete port.
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) => value.startsWith("postgresql://") || value.startsWith("postgres://"),
      "DATABASE_URL must be a postgresql:// connection string",
    ),
  REDIS_URL: z
    .string()
    .min(1, "REDIS_URL is required")
    .refine(
      (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
      "REDIS_URL must be a redis:// connection string",
    ),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  /**
   * WebSocket server-side heartbeat interval (ms). The server pings every
   * connection on this cadence; a connection that misses one pong is
   * considered dead and terminated. See docs/architecture/websocket-architecture.md.
   */
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  /**
   * Unique application-instance identity (Phase 4). Never derived from a
   * hostname: it names the LOGICAL instance for echo suppression, tracing
   * and ops. Random per process by default; pinned per service in compose.
   */
  INSTANCE_ID: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "INSTANCE_ID must be alphanumeric with - or _")
    .default(
      // Random suffix per boot; not a restart-stable identity on purpose.
      `ws-${Math.random().toString(36).slice(2, 10)}`,
    ),
  /**
   * Master switch for the Phase 4 distribution layer. On (default) the
   * instance subscribes to the global channel and publishes post-commit
   * notices; off = single-instance mode (tests, local development).
   */
  DISTRIBUTION_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /**
   * Phase 7 presence: cadence at which each instance re-publishes its local
   * presence digest. Redis Pub/Sub is at-most-once, so the digest is how a
   * missed `presence.update` (and a crashed peer) is reconciled. A remote
   * instance is considered dead — and its contribution dropped — after
   * 3 × this interval. Min 50 ms so tests can use a small, deterministic value.
   */
  PRESENCE_DIGEST_INTERVAL_MS: z.coerce.number().int().min(50).max(600_000).default(10_000),
  /**
   * Phase 10 access-token signing secret (HS256, minimum 32 bytes).
   * Production MUST set this explicitly — no ephemeral default, fail fast.
   * Development/test get a random per-boot secret (tokens invalidate on
   * restart, which is fine outside production).
   */
  AUTH_ACCESS_SECRET: z
    .string()
    .min(32, "AUTH_ACCESS_SECRET must be at least 32 characters")
    .optional(),
  /**
   * Phase 9.6 graceful draining: after SIGTERM, the instance stops accepting
   * NEW WebSocket connections and reports unready (/ready 503) while existing
   * connections finish for up to this long before teardown. Must fit inside
   * the orchestrator's stop grace period (compose: 30 s). Zero means the
   * previous immediate-teardown behavior.
   */
  DRAIN_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(10_000),
  /**
   * Phase 7 observability: whether GET /metrics is registered. Unauthenticated
   * by design (ops/dev endpoint; auth arrives in a later phase). Default on.
   */
  METRICS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export type AppConfig = Omit<z.infer<typeof envSchema>, "AUTH_ACCESS_SECRET"> & {
  AUTH_ACCESS_SECRET: string;
};

export class ConfigValidationError extends Error {
  public readonly issues: string[];

  public constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

/**
 * Parse configuration from an arbitrary record (defaults to `process.env`).
 * Accepting the source explicitly keeps this trivially unit-testable.
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigValidationError(formatIssues(result.error));
  }
  const provided = result.data.AUTH_ACCESS_SECRET;
  if (provided !== undefined) return { ...result.data, AUTH_ACCESS_SECRET: provided };
  if (result.data.NODE_ENV === "production") {
    throw new ConfigValidationError([
      "AUTH_ACCESS_SECRET: explicit secret required in production (no ephemeral default)",
    ]);
  }
  return { ...result.data, AUTH_ACCESS_SECRET: randomBytes(32).toString("base64url") };
}
