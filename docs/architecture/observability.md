# Observability — Phase 7

> **Status: implemented (Phase 7).** Only what exists and is tested is
> documented here. Per AGENT.md's honesty rule, deferred items are labelled as
> such. Decision record: ADR-009; test evidence:
> `docs/testing/observability.md`.

## 1. Layering

```
PostgreSQL   = durable business state
Presence     = ephemeral connection state
Redis        = cross-instance notification
Metrics/logs = OBSERVATION ONLY (never business state, never read by handlers)
```

Metrics and logs are write-only from the application's perspective: nothing in
the request path reads them, and neither PostgreSQL nor Redis is consulted to
produce them.

## 2. `/metrics` contract

| Property        | Behavior                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Route           | `GET /metrics` on the existing HTTP port (same server as HTTP + `/ws`)                                    |
| Format          | Prometheus text exposition (`text/plain; version=0.0.4`)                                                  |
| Authentication  | **none** in Phase 7 — an ops/dev endpoint; auth arrives with the auth phase                               |
| Scope           | this instance's process-local registry only; instances are scraped separately                             |
| Dependencies    | **none** — the handler renders memory only; it never queries PostgreSQL or Redis                          |
| Disabled mode   | `METRICS_ENABLED=false` registers the route but answers `404`; `app.metrics` is `null`                    |
| Failure mode    | a metrics failure can never affect a request path; handlers call `.inc()`/`.observe()` without awaiting   |

`GET /health` is deliberately **unchanged**: liveness only, no PostgreSQL, no
Redis, no readiness semantics. Dependency state is exposed through metrics and
logs instead.

## 3. Metric catalogue

`instanceId` is **not** a label (each instance is its own scrape target); it is
a log field and the target's identity in the scrape configuration.

### WebSocket transport

| Metric                                                                                  | Type      | Labels   | Purpose                                                            |
| --------------------------------------------------------------------------------------- | --------- | -------- | ------------------------------------------------------------------ |
| `livepulse_ws_connections_active`                                                       | Gauge     | –        | live sockets on this instance right now                            |
| `livepulse_ws_connections_opened_total`                                                 | Counter   | –        | accepted upgrades (churn / load driver)                            |
| `livepulse_ws_connections_closed_total`                                                 | Counter   | `reason` | `client` (peer closed / error) vs `heartbeat` (liveness sweep)      |
| `livepulse_ws_messages_received_total`                                                  | Counter   | –        | inbound frames (throughput)                                        |
| `livepulse_ws_messages_sent_total`                                                      | Counter   | –        | frames this instance wrote (local + remote-rendered + presence)     |
| `livepulse_ws_protocol_errors_total`                                                    | Counter   | `code`   | rejected frames by protocol error code                             |
| `livepulse_ws_handler_duration_seconds`                                                 | Histogram | `event`  | time inside one client-event handler (incl. durable work)          |

### Sessions

| Metric                                 | Type    | Labels   | Purpose                                                     |
| -------------------------------------- | ------- | -------- | ----------------------------------------------------------- |
| `livepulse_sessions_with_connections`  | Gauge   | –        | sessions with ≥1 local connection (fan-out scope)           |
| `livepulse_session_joins_total`        | Counter | `role`   | accepted joins: `TEACHER` / `STUDENT` / `viewer`             |
| `livepulse_session_leaves_total`       | Counter | `reason` | `leave` (explicit) / `switch` (re-join) / `disconnect`       |

### Presence (ADR-008)

| Metric                                    | Type    | Labels   | Purpose                                                       |
| ----------------------------------------- | ------- | -------- | ------------------------------------------------------------- |
| `livepulse_presence_local_participants`   | Gauge   | –        | distinct participants with a bound local connection right now |
| `livepulse_presence_transitions_total`    | Counter | `state`  | local participant transitions: `online` / `offline`           |
| `livepulse_presence_remote_instances`     | Gauge   | –        | peer instances currently contributing fresh presence          |
| `livepulse_presence_reconcile_total`      | Counter | `result` | `digest` (tick with local sessions) / `expired` (peer dropped) |

These describe **infrastructure state**, not registered users: they must never
be read as "total participants in the system".

### Redis

| Metric                                 | Type    | Labels        | Purpose                                                    |
| -------------------------------------- | ------- | ------------- | ---------------------------------------------------------- |
| `livepulse_redis_connected`            | Gauge   | `connection`  | `1` when usable; `0` on `end`/`reconnecting`               |
| `livepulse_redis_connection_errors_total` | Counter | `connection` | errors observed, including failed reconnect attempts      |
| `livepulse_redis_publish_total`        | Counter | `result`      | `ok` / `error` — post-commit notice publish attempts       |
| `livepulse_redis_events_received_total`| Counter | –             | notices received from Redis                                |
| `livepulse_redis_events_ignored_total` | Counter | `reason`      | `echo` / `schema_version` / `unknown_type` / `invalid_payload` / `no_local_subscribers` |
| `livepulse_redis_events_rendered_total`| Counter | –             | notices rendered to ≥1 local connection                    |

Publish failures and subscription problems are distinguishable (result labels
vs connection gauges), which is what makes a degraded-mode incident readable.

### Durable operations

| Metric                                      | Type      | Labels      | Purpose                                                      |
| ------------------------------------------- | --------- | ----------- | ------------------------------------------------------------ |
| `livepulse_db_operation_duration_seconds`   | Histogram | `operation` | PostgreSQL-backed path duration                              |
| `livepulse_db_operation_errors_total`       | Counter   | `operation` | failures by operation (currently `session.join`, `quiz.answer`) |

`operation` values are fixed in code (`session.join`, `quiz.answer`), not
derived from user input.

### Quiz

| Metric                                   | Type      | Labels  | Purpose                                                       |
| ---------------------------------------- | --------- | ------- | ------------------------------------------------------------- |
| `livepulse_quiz_answers_total`           | Counter   | `result`| `accepted` (incl. winner) / `duplicate` / `rejected`          |
| `livepulse_quiz_answer_duration_seconds` | Histogram | –       | submission + election duration (the Phase 3 critical section)  |
| `livepulse_quiz_transitions_total`       | Counter   | `event` | `quiz.start` / `question.publish` / `question.close`           |

### Doubt queue (ADR-007)

| Metric                                        | Type      | Labels      | Purpose                                             |
| --------------------------------------------- | --------- | ----------- | --------------------------------------------------- |
| `livepulse_doubt_created_total`               | Counter   | `result`    | `created` / `duplicate` (idempotent retry)          |
| `livepulse_doubt_transitions_total`           | Counter   | `status`    | `RESOLVED` / `DISMISSED`                            |
| `livepulse_doubt_operation_duration_seconds`  | Histogram | `operation` | `create` / `resolve` / `dismiss`                    |

### Recovery (ADR-006)

| Metric                                | Type      | Labels   | Purpose                                            |
| ------------------------------------- | --------- | -------- | -------------------------------------------------- |
| `livepulse_recovery_builds_total`     | Counter   | `result` | `ok` / `error` (error = join continued without it) |
| `livepulse_recovery_duration_seconds` | Histogram | –        | snapshot build duration                            |
| `livepulse_recovery_truncated_total`  | Counter   | –        | snapshots whose doubt section hit the payload cap  |

## 4. Type choices

- **Gauge** — a value that can go up or down and is meaningful at the instant of
  the scrape: live connections, sessions with connections, local participants,
  fresh remote instances, Redis readiness.
- **Counter** — monotonic totals, only ever incremented: frames, joins, leaves,
  publishes, received/ignored/rendered notices, answers, transitions, builds.
- **Histogram** — observations of a duration with bucket-based aggregation:
  handler, DB operation, answer election, doubt operation, recovery build.
  Histograms (not summaries) are used so buckets can be aggregated across
  instances by the scraper.

## 5. Buckets (provisional)

```
FAST = 1ms, 2.5ms, 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s   (+Inf)
SLOW = 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s          (+Inf)
```

- `FAST` is used for handler duration, durable-operation duration and doubt
  operations: these are expected to be local-ish PostgreSQL/Redis round trips.
- `SLOW` is used for answer election (row locking under contention) and
  recovery builds (several reads).
- Chosen from expected latency **shape**, not from measured traffic — no load
  test has been run. **Phase 8 revises these buckets from real data.**
- No percentile is claimed anywhere in this document. Any p95/p99 statement
  would have to come from an actual measurement, which does not exist yet.

## 6. Label cardinality strategy

**Allowed labels (complete list):**

`operation`, `event`, `result`, `reason`, `status`, `role`, `connection`,
`code`, `state` — plus `le`, which prom-client adds to histogram bucket series
itself (finite numeric bounds).

**Forbidden labels (enforced by tests):**

`sessionId`, `participantId`, `userId`, `questionId`, `quizId`, `doubtId`,
`requestId`, `eventId`, `instanceId`, `originInstanceId`, `displayName`, IP,
URL, path — anything whose value set grows with usage.

Rules that keep cardinality bounded **by construction**:

1. Every label value comes from a fixed enum defined in code (the lists in
   §3). A value is never interpolated from a payload, an id, or an error
   message.
2. No label carries a duration, a size, a timestamp or a free-form string.
3. Identities used for correlation (`sessionId`, `participantId`, `requestId`,
   `eventId`, `originInstanceId`) appear in **logs only**.
4. The unit tests enumerate every series on a registry after touching every
   family and assert that only allowed label names appear, and that no
   forbidden name appears anywhere in the exposition.

Cardinality bounds for a single instance are therefore the product of the enum
sizes (e.g. `ws_protocol_errors_total` has one series per protocol error code).

## 7. Structured logging

Existing Pino usage is standardized rather than rebuilt. Every line carries:

| Field                                          | When                                                         |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `instanceId`                                   | always (logger `base` — attributes multi-instance logs)      |
| `event` / `operation`                          | handler and lifecycle lines                                  |
| `sessionId`, `participantId`                   | where the operation is bound to one (business ids in **logs** only) |
| `eventId`, `originInstanceId`                  | Redis distribution lines (correlate a notice across instances) |
| `requestId`                                    | protocol-error and internal-error lines                      |
| `result`, `reason`, `code`, `status`           | where a line reports an outcome                              |
| `durationMs`-style values                      | where a duration is logged (not a metric label)              |

**Never logged:** answer content or any submitted content, `correctAnswer`,
credentials/tokens, `DATABASE_URL` / `REDIS_URL` or any connection string, raw
WebSocket payloads, and full request bodies. Internal errors log the error
object server-side but never echo payload data to the client.

Recovery-specific logging is minimal by design: connection open/close (with
`reason`), join, presence snapshot/build outcomes, and duplicate/retry replays.
Noisy per-frame logging is avoided deliberately — per-frame detail belongs in
metrics, not logs.

## 8. Multi-instance model

- One registry per process; **no** shared metrics state, **no** metrics over
  Redis, **no** metrics in PostgreSQL.
- Each instance exposes its own `/metrics`; the scraper aggregates.
- No cross-instance aggregation happens in-process — that is the scraper's job
  and keeps instances independent.
- `instanceId` distinguishes targets in the scrape configuration (and in logs).

## 9. What this gives Phase 8

Measurable without new instrumentation:

- active connections and connection churn (`ws_connections_active/opened/closed`),
- message throughput (`ws_messages_received/sent`),
- operation latency (`ws_handler_duration`, `db_operation_duration`,
  `quiz_answer_duration`, `doubt_operation_duration`, `recovery_duration`),
- Redis propagation behavior (`redis_publish`, `redis_events_*`,
  `redis_connected`),
- error rates (`ws_protocol_errors`, `db_operation_errors`, `redis_publish{result="error"}`),
- recovery behavior (`recovery_builds`, `recovery_truncated`, `recovery_duration`),
- presence fan-out (`presence_local_participants`, `presence_remote_instances`).

**Explicitly not claimed:** no throughput, latency percentile or scalability
figure appears in this document, because no load test has been run. That is
Phase 8's job, using this instrumentation.

## 10. Deferred (not implemented)

- Grafana dashboards, alerting rules, recording rules.
- OpenTelemetry tracing / spans / distributed context propagation.
- k6 (or any) load-test scripts and results.
- Histogram bucket tuning from measured traffic.
- Authentication for `/metrics`, network isolation, or a separate ops port.
- Log shipping/aggregation infrastructure, log sampling, redaction pipelines.
- Per-session or per-participant metric dimensions (deliberately forbidden).
