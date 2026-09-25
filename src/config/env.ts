import { z } from "zod";

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
});

export type AppConfig = z.infer<typeof envSchema>;

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
  return result.data;
}
