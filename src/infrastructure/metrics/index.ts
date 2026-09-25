import { Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * Phase 7 observability — one process-local Prometheus registry per instance.
 *
 * Boundaries (ADR-009):
 *   - Metrics are OBSERVATION only; they never hold business state.
 *   - The registry is per instance; instances are scraped separately.
 *   - Metrics never traverse Redis and are never stored in PostgreSQL.
 *   - GET /metrics reads this registry only — it never queries PG or Redis.
 *
 * Label discipline (critical):
 *   ALLOWED: operation, event, result, reason, status, role, connection, code, state
 *   FORBIDDEN: sessionId, participantId, userId, requestId, questionId, doubtId,
 *              eventId, originInstanceId, or any free-form value.
 *   Allowed label values come from fixed enums defined in code, so cardinality
 *   is bounded by construction (enforced by a test).
 *
 * Buckets are provisional and chosen around expected local PG/Redis latency
 * (sub-10 ms typical). Phase 8 revises them from measured traffic; no
 * percentile claims are made from them today.
 */

export const HISTOGRAM_BUCKETS_FAST = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5,
];
export const HISTOGRAM_BUCKETS_SLOW = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export interface Metrics {
  readonly registry: Registry;
  readonly contentType: string;
  render(): Promise<string>;

  // WebSocket transport
  readonly wsConnectionsActive: Gauge<"">;
  readonly wsConnectionsOpened: Counter<"">;
  readonly wsConnectionsClosed: Counter<"reason">;
  readonly wsMessagesReceived: Counter<"">;
  readonly wsMessagesSent: Counter<"">;
  readonly wsProtocolErrors: Counter<"code">;
  readonly wsHandlerDuration: Histogram<"event">;

  // Sessions
  readonly sessionsWithConnections: Gauge<"">;
  readonly sessionJoins: Counter<"role">;
  readonly sessionLeaves: Counter<"reason">;

  // Presence
  readonly presenceLocalParticipants: Gauge<"">;
  readonly presenceTransitions: Counter<"state">;
  readonly presenceRemoteInstances: Gauge<"">;
  readonly presenceReconcile: Counter<"result">;

  // Redis
  readonly redisConnected: Gauge<"connection">;
  readonly redisConnectionErrors: Counter<"connection">;
  readonly redisPublish: Counter<"result">;
  readonly redisEventsReceived: Counter<"">;
  readonly redisEventsIgnored: Counter<"reason">;
  readonly redisEventsRendered: Counter<"">;

  // Database-backed operations
  readonly dbOperationDuration: Histogram<"operation">;
  readonly dbOperationErrors: Counter<"operation">;

  // Quiz
  readonly quizAnswers: Counter<"result">;
  readonly quizAnswerDuration: Histogram<"">;
  readonly quizTransitions: Counter<"event">;

  // Doubt queue
  readonly doubtCreated: Counter<"result">;
  readonly doubtTransitions: Counter<"status">;
  readonly doubtOperationDuration: Histogram<"operation">;

  // Recovery
  readonly recoveryBuilds: Counter<"result">;
  readonly recoveryDuration: Histogram<"">;
  readonly recoveryTruncated: Counter<"">;
}

/**
 * Time a PostgreSQL-backed operation: records duration and failure count, then
 * rethrows so existing error mapping is untouched. No-op when metrics are off.
 * Labels use a fixed `operation` vocabulary (bounded cardinality).
 */
export async function timeOperation<T>(
  metrics: Metrics | undefined,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!metrics) return fn();
  const started = performance.now();
  try {
    return await fn();
  } catch (error) {
    metrics.dbOperationErrors.inc({ operation });
    throw error;
  } finally {
    metrics.dbOperationDuration.observe({ operation }, (performance.now() - started) / 1000);
  }
}

export function createMetrics(): Metrics {
  const registry = new Registry();

  const wsConnectionsActive = new Gauge({
    name: "livepulse_ws_connections_active",
    help: "Current live WebSocket connections on this instance",
    registers: [registry],
  });
  const wsConnectionsOpened = new Counter({
    name: "livepulse_ws_connections_opened_total",
    help: "WebSocket connections accepted",
    registers: [registry],
  });
  const wsConnectionsClosed = new Counter({
    name: "livepulse_ws_connections_closed_total",
    help: "WebSocket connections closed, by reason",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
  const wsMessagesReceived = new Counter({
    name: "livepulse_ws_messages_received_total",
    help: "Inbound WebSocket frames received",
    registers: [registry],
  });
  const wsMessagesSent = new Counter({
    name: "livepulse_ws_messages_sent_total",
    help: "Outbound WebSocket frames sent",
    registers: [registry],
  });
  const wsProtocolErrors = new Counter({
    name: "livepulse_ws_protocol_errors_total",
    help: "Protocol errors rejected, by bounded error code",
    labelNames: ["code"] as const,
    registers: [registry],
  });
  const wsHandlerDuration = new Histogram({
    name: "livepulse_ws_handler_duration_seconds",
    help: "Client event handler duration",
    labelNames: ["event"] as const,
    buckets: HISTOGRAM_BUCKETS_FAST,
    registers: [registry],
  });

  const sessionsWithConnections = new Gauge({
    name: "livepulse_sessions_with_connections",
    help: "Sessions with at least one local connection on this instance",
    registers: [registry],
  });
  const sessionJoins = new Counter({
    name: "livepulse_session_joins_total",
    help: "session.join accepted, by bound role",
    labelNames: ["role"] as const,
    registers: [registry],
  });
  const sessionLeaves = new Counter({
    name: "livepulse_session_leaves_total",
    help: "session departures, by reason",
    labelNames: ["reason"] as const,
    registers: [registry],
  });

  const presenceLocalParticipants = new Gauge({
    name: "livepulse_presence_local_participants",
    help: "Participants with at least one healthy local connection (infrastructure state, not registered users)",
    registers: [registry],
  });
  const presenceTransitions = new Counter({
    name: "livepulse_presence_transitions_total",
    help: "Local presence transitions",
    labelNames: ["state"] as const,
    registers: [registry],
  });
  const presenceRemoteInstances = new Gauge({
    name: "livepulse_presence_remote_instances",
    help: "Peer instances currently contributing fresh presence",
    registers: [registry],
  });
  const presenceReconcile = new Counter({
    name: "livepulse_presence_reconcile_total",
    help: "Presence digest/reconcile outcomes",
    labelNames: ["result"] as const,
    registers: [registry],
  });

  const redisConnected = new Gauge({
    name: "livepulse_redis_connected",
    help: "Redis connection readiness (1 connected, 0 not), by connection",
    labelNames: ["connection"] as const,
    registers: [registry],
  });
  const redisConnectionErrors = new Counter({
    name: "livepulse_redis_connection_errors_total",
    help: "Redis connection errors observed, by connection",
    labelNames: ["connection"] as const,
    registers: [registry],
  });
  const redisPublish = new Counter({
    name: "livepulse_redis_publish_total",
    help: "Redis publish attempts, by result",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const redisEventsReceived = new Counter({
    name: "livepulse_redis_events_received_total",
    help: "Distribution notices received from Redis",
    registers: [registry],
  });
  const redisEventsIgnored = new Counter({
    name: "livepulse_redis_events_ignored_total",
    help: "Distribution notices not delivered locally, by reason",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
  const redisEventsRendered = new Counter({
    name: "livepulse_redis_events_rendered_total",
    help: "Remote events rendered to local connections",
    registers: [registry],
  });

  const dbOperationDuration = new Histogram({
    name: "livepulse_db_operation_duration_seconds",
    help: "Durable-operation duration (PostgreSQL-backed paths)",
    labelNames: ["operation"] as const,
    buckets: HISTOGRAM_BUCKETS_FAST,
    registers: [registry],
  });
  const dbOperationErrors = new Counter({
    name: "livepulse_db_operation_errors_total",
    help: "Durable-operation failures, by operation",
    labelNames: ["operation"] as const,
    registers: [registry],
  });

  const quizAnswers = new Counter({
    name: "livepulse_quiz_answers_total",
    help: "Answer submissions, by result",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const quizAnswerDuration = new Histogram({
    name: "livepulse_quiz_answer_duration_seconds",
    help: "Answer submission + election duration",
    buckets: HISTOGRAM_BUCKETS_SLOW,
    registers: [registry],
  });
  const quizTransitions = new Counter({
    name: "livepulse_quiz_transitions_total",
    help: "Teacher quiz/question lifecycle transitions",
    labelNames: ["event"] as const,
    registers: [registry],
  });

  const doubtCreated = new Counter({
    name: "livepulse_doubt_created_total",
    help: "Doubt create outcomes",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const doubtTransitions = new Counter({
    name: "livepulse_doubt_transitions_total",
    help: "Doubt terminal transitions, by status",
    labelNames: ["status"] as const,
    registers: [registry],
  });
  const doubtOperationDuration = new Histogram({
    name: "livepulse_doubt_operation_duration_seconds",
    help: "Doubt queue operation duration",
    labelNames: ["operation"] as const,
    buckets: HISTOGRAM_BUCKETS_FAST,
    registers: [registry],
  });

  const recoveryBuilds = new Counter({
    name: "livepulse_recovery_builds_total",
    help: "Recovery snapshot builds, by result",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const recoveryDuration = new Histogram({
    name: "livepulse_recovery_duration_seconds",
    help: "Recovery snapshot build duration",
    buckets: HISTOGRAM_BUCKETS_SLOW,
    registers: [registry],
  });
  const recoveryTruncated = new Counter({
    name: "livepulse_recovery_truncated_total",
    help: "Recovery snapshots whose doubt section hit the payload cap",
    registers: [registry],
  });

  return {
    registry,
    contentType: registry.contentType,
    render: () => registry.metrics(),
    wsConnectionsActive,
    wsConnectionsOpened,
    wsConnectionsClosed,
    wsMessagesReceived,
    wsMessagesSent,
    wsProtocolErrors,
    wsHandlerDuration,
    sessionsWithConnections,
    sessionJoins,
    sessionLeaves,
    presenceLocalParticipants,
    presenceTransitions,
    presenceRemoteInstances,
    presenceReconcile,
    redisConnected,
    redisConnectionErrors,
    redisPublish,
    redisEventsReceived,
    redisEventsIgnored,
    redisEventsRendered,
    dbOperationDuration,
    dbOperationErrors,
    quizAnswers,
    quizAnswerDuration,
    quizTransitions,
    doubtCreated,
    doubtTransitions,
    doubtOperationDuration,
    recoveryBuilds,
    recoveryDuration,
    recoveryTruncated,
  };
}
