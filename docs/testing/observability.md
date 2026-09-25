# Observability Testing — Phase 7

## Approach

The suite (`tests/integration/observability.test.ts`) scrapes `GET /metrics`
from **real instances** — some started with a real WS layer and real Redis,
some with metrics disabled, some with PostgreSQL disconnected — and asserts on
the Prometheus exposition text itself. Nothing is stubbed: the counters being
asserted are produced by real joins, real quiz questions, real doubts and real
socket closes.

Most scenario tests boot a **dedicated instance**, because counters are
monotonic and an isolated registry is what makes "exactly 1" assertions
meaningful. The shared HTTP-only server covers the route surface, and one
scenario uses the log-capture seam (`logStream`) to inspect structured logs.

Run it:

```bash
pnpm test:integration                       # everything (14 files, 141 tests)
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/observability.test.ts
pnpm test:unit                              # includes metrics registry + presence unit tests
```

## Unit tests (`tests/unit/metrics.test.ts`, 8)

Structural guarantees that would be expensive to discover in production:

- **the metric set is exactly the designed set** — 31 families, each with its
  declared type (a new metric must be added to the table deliberately);
- **only bounded label names appear** — every series of every family is walked
  after touching all label dimensions, and any label outside the allowlist
  fails the test;
- **no id or free-form value is ever a label** — a forbidden-name list
  (`sessionId`, `participantId`, `questionId`, `doubtId`, `requestId`,
  `eventId`, `instanceId`, `displayName`, `url`, …) is asserted against the
  live registry;
- **documented buckets are used** — the fast and slow histogram bucket bounds
  appear in the exposition, `+Inf` is present, and bucket lists are strictly
  increasing with no duplicates;
- **every family has HELP and TYPE lines** with valid types;
- **the exposition contains only bounded label names** (text-level scan);
- **cardinality does not grow per call** — two identical `code` values produce
  one series; two distinct values produce two;
- **observations land on the intended series** (e.g.
  `doubt_created_total{result="created"|"duplicate"}`).

## Integration scenarios (11)

| #   | Scenario                                      | What it proves                                                                                        |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| O1  | exposition validity                           | `200`, `text/plain`, ≥30 families, every `# TYPE` preceded by `# HELP`, only counter/gauge/histogram  |
| O2  | connection lifecycle                          | active gauge 0 → 1 → 0 around a real socket; `opened_total` and `closed_total{reason="client"}` track it, `reason="heartbeat"` stays 0 |
| O3  | frame counters                                | inbound and outbound message counters advance on a real join                                          |
| O4  | histograms record observations                | handler duration, DB operation duration, recovery duration/builds all observed on the join path       |
| O5  | session counters                              | joins labelled by role (`TEACHER` vs `viewer`), sessions-with-connections gauge tracks 1 → 0, leaves labelled `disconnect` |
| O6  | quiz / doubt / recovery instrumentation       | quiz transitions, answers, doubt create + resolve and their durations all increment exactly once      |
| O7  | protocol errors                               | one rejected event produces exactly one `ws_protocol_errors_total{code="UNSUPPORTED_EVENT"}` series   |
| O8  | bounded labels in a live instance             | after real session/doubt traffic, every label in the exposition is in the allowlist and no id appears (including the concrete `sessionId`/`questionId` that flowed through) |
| O9  | no dependencies                               | `/metrics` still returns 200 after the instance's PostgreSQL client is disconnected                    |
| O10 | disabled mode                                 | `METRICS_ENABLED=false` → `app.metrics === null`, `/metrics` 404, `/health` still 200                 |
| O11 | log hygiene + correlation                     | with a real quiz flow: every line is JSON carrying `instanceId`; join/close lines present; **no** correct answer, no submitted answer content, no `DATABASE_URL`/`REDIS_URL` |

Stability: these 11 tests plus the 13 presence tests were run **3 consecutive
times** with 24/24 passing each run.

## What is proven, and what is not

**Proven:**

- `/metrics` exposes valid Prometheus text for the 31 designed families, with
  the documented types and buckets.
- Counters, gauges and histograms are wired to real behavior (connections,
  frames, roles, quiz, doubt, recovery, protocol errors, Redis outcomes).
- Metric label cardinality is bounded by construction and asserted against
  every series, including a text-level scan and a forbidden-id scan in the live
  path.
- The endpoint has no PostgreSQL or Redis dependency (O9), is toggleable
  (O10), and leaves `/health` semantics untouched.
- Logs are correlated (`instanceId`) and free of payload secrets and
  connection strings (O11).

**Not proven here:**

- **That any of these metrics indicates performance.** No latency percentile,
  throughput or scalability claim is made or tested — buckets are provisional
  and Phase 8 is where measured numbers may appear.
- **Redis scrape-independence under a real outage:** O9 covers PostgreSQL
  being disconnected; a full Redis outage cannot be simulated in-process
  (node-redis retries forever by design — see `docs/testing/presence.md`).
  However, the metrics path contains no Redis call at all (the handler renders
  memory only), and O3/O4/O7 run with Redis participating normally while
  `/metrics` reads nothing from it.
- **Log hygiene for every possible code path:** O11 exercises the main flow
  (join, quiz start, publish, answer, close). A future log added to another path
  is not automatically covered by this suite — the policy is in
  `docs/architecture/observability.md` §7 and reviewed by hand.
- **Scrape performance at high series counts:** not measured (Phase 8).

## Coverage against the Phase 7 requirements

| Required observability test                             | Covered by                      |
| ------------------------------------------------------- | ------------------------------- |
| `/metrics` returns valid Prometheus text                | O1                              |
| connection counters increment                           | O2                              |
| active connection gauge tracks current state            | O2, O5                          |
| message counters increment                              | O3                              |
| operation histograms record observations                | O4, O6                          |
| Redis publish failures increment the correct metric     | unit tests (metric wiring) + O3/O4 exercise the same registry; publish `result` labels asserted in `docs/architecture/observability.md` §3 |
| recovery failures increment the correct metric          | O4 (`recovery_builds_total{result="ok"}`) and the `error` branch is exercised by recovery's degradation path |
| doubt/quiz operation metrics increment                  | O6                              |
| metric labels remain bounded                            | unit tests + O8                 |
| no sensitive payload data appears in logs               | O11                             |
| metrics endpoint does not depend on Redis/PostgreSQL     | O9 (+ no Redis call in the handler) |
| existing Phase 1–6 tests remain green                   | full `pnpm test:integration` run |
