# ADR-009: Prometheus Metrics with Bounded Labels + Pino Structured Logs

- **Status:** Accepted and implemented (Phase 7)
- **Date:** 2026-09-25
- **Supersedes:** none
- **Related:** ADR-005 (Redis boundary), ADR-008 (presence),
  `docs/architecture/observability.md` (metric catalogue),
  `docs/testing/observability.md` (test evidence)

## Context

Phase 8 will generate real traffic. Before that, the system must be
*measurable* — without gaining a second source of truth, a new failure mode, or
unbounded memory. Constraints from AGENT.md and earlier phases:

- Metrics/logs are observation. They must never hold business state, never be
  read by handlers for decisions, and never make a request path depend on the
  monitoring system.
- Redis is notification-only; PostgreSQL is durable truth. Neither may become a
  metrics store, and the metrics endpoint must not add load to either.
- The stack is Node.js + Fastify + Pino. No Grafana, no OpenTelemetry, no
  external telemetry platform in this phase.

## Options

**1. Prometheus client library (`prom-client`)** — a process-local `Registry`
rendered as Prometheus text. Chosen.

**2. Custom JSON metrics endpoint.** Rejected: non-standard exposition means
every future scraper/dashboard needs adapter code, and we would re-implement
counters, histograms and label handling by hand.

**3. External telemetry platform / OpenTelemetry SDK.** Rejected as
overbuild for this phase: it requires an exporter, a collector, network egress
from every instance, and a vendor/cost decision — none of which the current
requirement (understand behavior, prepare for load testing) justifies. A
Prometheus text endpoint is scrapable by anything later without changing the
code.

## Decision

**Option 1.** `prom-client` with one `Registry` **per instance**, created once
in `buildApp` and exposed as `app.metrics` (null when `METRICS_ENABLED=false`).

- **Endpoint.** `GET /metrics` on the existing HTTP port, Prometheus text
  exposition, **unauthenticated** (ops/dev surface; auth is a later phase).
  When `METRICS_ENABLED=false` the route is registered but answers 404, so the
  route surface is stable and only behavior changes.
- **No dependencies.** The handler renders the in-memory registry only. It
  never queries PostgreSQL or Redis (asserted by test O9), so scraping cannot
  be affected by dependency health and cannot add load to the durable store.
- **`/health` is unchanged.** Still liveness-only. Dependency state is exposed
  through metrics and logs instead — this ADR deliberately does not convert
  `/health` into a readiness probe.
- **Metric set.** 31 families covering WebSocket transport, sessions, presence,
  Redis, durable operations, quiz, doubt queue and recovery. Each family has a
  reason to exist; the catalogue is in `docs/architecture/observability.md`.
- **Types.** Gauge for "how many right now" (connections, presence, Redis
  readiness, sessions with connections). Counter for monotonic events
  (messages, joins, publishes, answers, doubts, builds). Histogram for
  durations (handler, DB operation, answer, doubt operation, recovery).
- **Labels.** Only `operation`, `event`, `result`, `reason`, `status`, `role`,
  `connection`, `code`, `state` — every one of which takes values from a fixed
  enum defined in code. `sessionId`, `participantId`, `questionId`, `doubtId`,
  `requestId`, `eventId`, `instanceId` and any free-form value are forbidden as
  labels (enforced by unit tests scanning every series).
- **Buckets.** Two provisional bucket sets sized around expected local
  PostgreSQL/Redis latency: `FAST` (1 ms → 2.5 s) for handler/DB/doubt
  operations, `SLOW` (5 ms → 5 s) for answer election and recovery builds. No
  percentile claims are made from them; Phase 8 revises them from measured
  traffic.
- **Logs.** Existing Pino usage is standardized on an `instanceId` base field
  plus `event` / `operation` / `sessionId` / `participantId` / `durationMs` /
  `result` where relevant, and `requestId` / `eventId` / `originInstanceId` for
  correlation — always in **logs only**, never as metric labels. Answers,
  correct answers, raw payloads, credentials and connection URLs are never
  logged.

## Why

- **Cardinality is the failure mode of metrics.** One `sessionId` label is
  enough to produce unbounded series and kill a scrape target under load.
  Restricting labels to enums makes cardinality bounded *by construction*, and
  the tests assert it rather than trusting review.
- **Process-local registries keep the architecture intact.** Each instance is
  scraped separately; nothing crosses Redis, nothing lands in PostgreSQL, and
  no instance's metrics depend on another instance being reachable.
- **Histograms over summaries** so buckets can be aggregated across instances
  later; a quantile summary cannot be merged.
- **Failures are counted where they happen** (`dbOperationErrors`,
  `redisConnectionErrors`, `redisPublish{result="error"}`,
  `recoveryBuilds{result="error"}`, `wsProtocolErrors{code}`), which is what
  makes a degraded-mode incident readable from metrics alone.
- **Logs carry identities; metrics carry shapes.** That split is what lets an
  operator pivot from an alert to the specific session without ever exploding
  label cardinality.

## Trade-offs

- **Buckets are guesses.** Stated as provisional; wrong buckets cannot be
  retro-fixed for historical data.
- **No cross-instance aggregation in-process.** A fleet view requires scraping
  every instance (Prometheus' normal model). Accepted.
- **Unauthenticated `/metrics`** exposes operational shapes on the same port.
  Acceptable for the current deployment; documented rather than silently
  assumed, and the toggle exists.
- **Label-value enums are maintained by hand** — adding a new value means
  touching the code that emits it, and a typo creates a new series until
  noticed.
- **`presence_reconcile_total` counts digest/expiry outcomes**, not
  participants; per-participant presence churn is intentionally unlabelled to
  avoid cardinality tied to activity.

## Consequences

- Easier: Phase 8 can measure connection churn, throughput, latency, Redis
  propagation and recovery behavior without adding instrumentation.
- Easier: degraded-mode incidents (Redis down, recovery failing, protocol
  errors) are visible from counters instead of log spelunking.
- Harder: anything genuinely per-session must be investigated through logs,
  not metrics — a deliberate constraint, not an oversight.
- No fabricated numbers: this ADR claims no p95/p99, no scalability figure, and
  no throughput. Instrumentation is not a performance result.
