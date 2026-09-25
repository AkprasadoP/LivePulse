import { describe, expect, it } from "vitest";
import {
  createMetrics,
  HISTOGRAM_BUCKETS_FAST,
  HISTOGRAM_BUCKETS_SLOW,
  type Metrics,
} from "../../src/infrastructure/metrics/index.js";

/**
 * Touch every labeled series once with a representative enum value. Needed
 * because prom-client omits never-used label combinations from the exposition,
 * and the cardinality assertions must see every label dimension.
 */
function touchEverySeries(metrics: Metrics): void {
  metrics.wsConnectionsClosed.inc({ reason: "client" });
  metrics.wsProtocolErrors.inc({ code: "INVALID_REQUEST" });
  metrics.wsHandlerDuration.observe({ event: "session.join" }, 0.01);
  metrics.sessionJoins.inc({ role: "STUDENT" });
  metrics.sessionLeaves.inc({ reason: "leave" });
  metrics.presenceTransitions.inc({ state: "online" });
  metrics.presenceReconcile.inc({ result: "digest" });
  metrics.redisConnected.set({ connection: "publisher" }, 1);
  metrics.redisConnectionErrors.inc({ connection: "publisher" });
  metrics.redisPublish.inc({ result: "ok" });
  metrics.redisEventsIgnored.inc({ reason: "echo" });
  metrics.dbOperationDuration.observe({ operation: "session.join" }, 0.01);
  metrics.dbOperationErrors.inc({ operation: "session.join" });
  metrics.quizAnswers.inc({ result: "accepted" });
  metrics.quizAnswerDuration.observe(0.05);
  metrics.quizTransitions.inc({ event: "quiz.start" });
  metrics.doubtCreated.inc({ result: "created" });
  metrics.doubtTransitions.inc({ status: "RESOLVED" });
  metrics.doubtOperationDuration.observe({ operation: "create" }, 0.01);
  metrics.recoveryBuilds.inc({ result: "ok" });
  metrics.recoveryDuration.observe(0.02);
  metrics.recoveryTruncated.inc();
}

/**
 * Phase 7 observability — unit tests for the metric registry.
 *
 * The important properties are structural, not behavioral: every metric has
 * the documented type, duration histograms use the documented buckets, and NO
 * metric may carry an unbounded label (session/participant/question/doubt/
 * request/event ids). Those rules are what keep /metrics cheap at 100+ clients.
 */

const ALLOWED_LABELS = new Set([
  "operation",
  "event",
  "result",
  "reason",
  "status",
  "role",
  "connection",
  "code",
  "state",
]);

const FORBIDDEN_LABELS = [
  "sessionId",
  "session_id",
  "participantId",
  "participant_id",
  "userId",
  "user_id",
  "questionId",
  "question_id",
  "quizId",
  "quiz_id",
  "doubtId",
  "doubt_id",
  "requestId",
  "request_id",
  "eventId",
  "event_id",
  "instanceId",
  "instance_id",
  "originInstanceId",
  "displayName",
  "ip",
  "path",
  "url",
];

/** name -> expected prom-client type. Each entry is an explicit design decision. */
const EXPECTED: Record<string, "counter" | "gauge" | "histogram"> = {
  livepulse_ws_connections_active: "gauge",
  livepulse_ws_connections_opened_total: "counter",
  livepulse_ws_connections_closed_total: "counter",
  livepulse_ws_messages_received_total: "counter",
  livepulse_ws_messages_sent_total: "counter",
  livepulse_ws_protocol_errors_total: "counter",
  livepulse_ws_handler_duration_seconds: "histogram",
  livepulse_sessions_with_connections: "gauge",
  livepulse_session_joins_total: "counter",
  livepulse_session_leaves_total: "counter",
  livepulse_presence_local_participants: "gauge",
  livepulse_presence_transitions_total: "counter",
  livepulse_presence_remote_instances: "gauge",
  livepulse_presence_reconcile_total: "counter",
  livepulse_redis_connected: "gauge",
  livepulse_redis_connection_errors_total: "counter",
  livepulse_redis_publish_total: "counter",
  livepulse_redis_events_received_total: "counter",
  livepulse_redis_events_ignored_total: "counter",
  livepulse_redis_events_rendered_total: "counter",
  livepulse_db_operation_duration_seconds: "histogram",
  livepulse_db_operation_errors_total: "counter",
  livepulse_quiz_answers_total: "counter",
  livepulse_quiz_answer_duration_seconds: "histogram",
  livepulse_quiz_transitions_total: "counter",
  livepulse_doubt_created_total: "counter",
  livepulse_doubt_transitions_total: "counter",
  livepulse_doubt_operation_duration_seconds: "histogram",
  livepulse_recovery_builds_total: "counter",
  livepulse_recovery_duration_seconds: "histogram",
  livepulse_recovery_truncated_total: "counter",
};

describe("metrics registry (unit)", () => {
  const metrics = createMetrics();
  const all = metrics.registry.getMetricsAsArray();
  const byName = new Map(all.map((metric) => [metric.name, metric]));

  it("registers exactly the designed metric set with the designed types", () => {
    expect([...byName.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [name, type] of Object.entries(EXPECTED)) {
      const metric = byName.get(name);
      expect(metric, `metric ${name} is registered`).toBeDefined();
      expect(metric?.type, `type of ${name}`).toBe(type);
    }
  });

  it("uses only bounded label names on every metric series", async () => {
    touchEverySeries(metrics);
    const json = await metrics.registry.getMetricsAsJSON();
    const seen = new Map<string, Set<string>>();
    for (const metric of json) {
      for (const value of metric.values) {
        for (const label of Object.keys(value.labels)) {
          // `le` is prom-client's own histogram bucket bound, not a label the
          // application supplies; it is a fixed numeric set, not free-form.
          const allowed = ALLOWED_LABELS.has(label) || label === "le";
          expect(allowed, `${metric.name} label "${label}" is allowed`).toBe(true);
          const labels = seen.get(metric.name) ?? new Set<string>();
          labels.add(label);
          seen.set(metric.name, labels);
        }
      }
    }
    // Sanity: the scan actually saw the labeled families (not an empty list).
    expect(seen.size).toBeGreaterThan(15);
  });

  it("never uses an id or free-form value as a label", async () => {
    touchEverySeries(metrics);
    const json = await metrics.registry.getMetricsAsJSON();
    for (const metric of json) {
      for (const value of metric.values) {
        for (const forbidden of FORBIDDEN_LABELS) {
          expect(
            Object.keys(value.labels).includes(forbidden),
            `${metric.name} must not use label "${forbidden}"`,
          ).toBe(false);
        }
      }
    }
  });

  it("uses the documented buckets for fast and slow histograms", async () => {
    // Histogram series only appear once observed (prom-client omits empty
    // histograms when a label value has never been used).
    metrics.wsHandlerDuration.observe({ event: "session.join" }, 0.01);
    metrics.quizAnswerDuration.observe(0.05);
    const text = await metrics.render();
    // Histograms render every bucket (count 0) even before the first observation.
    const lines = text.split("\n");
    const fastBuckets = lines
      .filter((line) => line.startsWith("livepulse_ws_handler_duration_seconds_bucket{"))
      .join("\n");
    expect(fastBuckets).not.toBe("");
    for (const bound of HISTOGRAM_BUCKETS_FAST) {
      expect(fastBuckets).toContain(`le="${bound}"`);
    }
    const slowBuckets = lines
      .filter((line) => line.startsWith("livepulse_quiz_answer_duration_seconds_bucket{"))
      .join("\n");
    expect(slowBuckets).not.toBe("");
    for (const bound of HISTOGRAM_BUCKETS_SLOW) {
      expect(slowBuckets).toContain(`le="${bound}"`);
    }
    // The +Inf bucket is always present, so quantile math stays honest.
    expect(fastBuckets).toContain('le="+Inf"');
    // Buckets are strictly increasing and finite (no accidental duplicate).
    expect([...HISTOGRAM_BUCKETS_FAST].sort((a, b) => a - b)).toEqual([...HISTOGRAM_BUCKETS_FAST]);
    expect(new Set(HISTOGRAM_BUCKETS_SLOW).size).toBe(HISTOGRAM_BUCKETS_SLOW.length);
  });

  it("exposes all metric families with HELP and TYPE lines", async () => {
    const text = await metrics.render();
    for (const [name, type] of Object.entries(EXPECTED)) {
      expect(text, `HELP for ${name}`).toContain(`# HELP ${name} `);
      expect(text, `TYPE for ${name}`).toContain(`# TYPE ${name} ${type}\n`);
    }
    expect(metrics.contentType).toContain("text/plain");
  });

  it("renders only known label names in the exposition text", async () => {
    const text = await metrics.render();
    const labelPattern = /([a-zA-Z_][a-zA-Z0-9_]*)="/g;
    const seen = new Set<string>();
    for (const match of text.matchAll(labelPattern)) {
      if (match[1] !== undefined) seen.add(match[1]);
    }
    for (const label of seen) {
      expect(ALLOWED_LABELS.has(label) || label === "le", `label "${label}" is bounded`).toBe(true);
    }
  });

  it("keeps label cardinality bounded for a fixed enum label (no growth per call)", async () => {
    // A fresh registry: cardinality is only meaningful without prior touches.
    const fresh = createMetrics();
    fresh.wsProtocolErrors.inc({ code: "UNSUPPORTED_EVENT" });
    fresh.wsProtocolErrors.inc({ code: "UNSUPPORTED_EVENT" });
    fresh.wsProtocolErrors.inc({ code: "NOT_JOINED" });
    const text = await fresh.render();
    const series = text
      .split("\n")
      .filter((line) => line.startsWith("livepulse_ws_protocol_errors_total{"));
    // Two distinct code values -> exactly two series, not three.
    expect(series).toHaveLength(2);
  });

  it("counts observations against the right label set", async () => {
    const fresh = createMetrics();
    fresh.doubtCreated.inc({ result: "created" });
    fresh.doubtCreated.inc({ result: "duplicate" });
    const text = await fresh.render();
    expect(text).toContain('livepulse_doubt_created_total{result="created"} 1');
    expect(text).toContain('livepulse_doubt_created_total{result="duplicate"} 1');
  });
});
