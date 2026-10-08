# Load Testing — Phase 8.1 Foundation

Establishes a reproducible k6 load-test foundation **without changing
production architecture** and **without optimizing anything**. k6 remains
deliberately deferred: it is documented here as the target harness, but this
environment cannot install a versioned `k6` module (npm registry serves only
the `0.0.0` dummy stub), so the runnable harness for the same scenario files
is the zero-dependency Node fallback in `load-tests/run.js`.

> **Phase 10.7 update (authentication).** `POST /sessions` now **requires**
> authentication: the harness registers one creator in setup and sends
> `Authorization: Bearer <access-token>` on every request (no client-supplied
> `creator`/`displayName`). The WS scenario joins view-only — `session.join`
> no longer accepts `participant: { displayName }`. The transaction-latency
> analysis in this document was written against the pre-10.7
> `SessionRepository.createWithCreator()` (session + auto-provisioned creator +
> TEACHER participant); the current path is `createWithExistingCreator()`
> (session + TEACHER participant, no user minted), so the analysis's shape
> still applies but the method name and the now-removed user INSERT do not.

---

## 1. Prerequisites

| Requirement             | Version  | Purpose                                             |
| ----------------------- | -------- | --------------------------------------------------- |
| Node.js                 | `>= 22`  | Runs the harness + the app                          |
| `pnpm`                  | `12.5.1` | Install scripts                                     |
| Docker + Docker Compose | any      | PostgreSQL 5433 + Redis 6380 (optional, full stack) |
| `psql`                  | 15+      | Read-only DB diagnostics                            |
| `redis-cli`             | 7+       | Read-only Redis diagnostics                         |

## 2. Environment variables

The harness reads one `.env` file. Create with `cp load-tests/env.example .env`.

| Variable      | Default                 | Safety                                               |
| ------------- | ----------------------- | ---------------------------------------------------- |
| `BASE_URL`    | `http://127.0.0.1:3000` | Refused unless `--allow-nonlocal` unless `127.0.0.1` |
| `WS_URL`      | `$BASE_URL/ws`          |                                                      |
| `TEST_DB_URL` | (empty)                 | Read-only diagnostics only; the harness never writes |
| `REDIS_URL`   | (empty)                 | Read-only diagnostics only; the harness never writes |

**Safety rule:** the harness refuses to target a non-local endpoint unless
`--allow-nonlocal` is passed. There is no implicit production bypass.

## 3. Starting the stack

```bash
pnpm db:up                 # PostgreSQL 5433 + Redis 6380
pnpm db:test:setup         # create/migrate livepulse_test
pnpm dev                   # dev server (HTTP + WS on :3000)
```

Or production-style:

```bash
cp .env.example .env
pnpm build && pnpm start
```

## 4. Running the smoke scenario (the first, deliberately small load)

The **first** test is small, not 1000 VUs. The canonical local smoke is the
Python wrapper at `load-tests/smoke.py`, which shell-launches the server and
runs a 2-VU / 5-second `http-sessions` run:

```bash
python3 load-tests/smoke.py
```

When you need an ad-hoc run without the wrapper, use the zero-dependency Node
harness directly. It still accepts explicit `--vus` and `--duration`:

```bash
# zero-dependency Node fallback (this environment)
node load-tests/run.js --vus 10 --duration 30s --scenario http-sessions
node load-tests/run.js --vus 10 --duration 30s --scenario websocket-connections

# once k6 is installed on your machine (planned):
k6 run load-tests/http/sessions.js --vus 10 --duration 30s
k6 run load-tests/websocket/connections.js --vus 10 --duration 30s
```

The `--scenario` selectors match the k6 scenario name, so swapping the
interpreter is a one-word change.

The legacy Node-only standalone wrapper (`smoke.mjs`) is no longer documented.
It had a host-specific Node/Mach-O execution issue unrelated to LivePulse and
was removed in favor of the Python wrapper.

## 5. Scenarios

| Phase     | File                                            | VUs                       | Duration                      | Purpose                                            |
| --------- | ----------------------------------------------- | ------------------------- | ----------------------------- | -------------------------------------------------- |
| 8.1 smoke | `load-tests/http/sessions.js`                   | 2 (smoke) / 10 (baseline) | 5 s (smoke) / 30 s (baseline) | HTTP session creation                              |
| 8.1 smoke | `load-tests/websocket/connections.js`           | 10                        | 30 s                          | real `/ws` joins, connection success, frame counts |
| 8.1 smoke | `load-tests/websocket/connections.js`           | 10                        | 30 s                          | real `/ws` joins, connection success, frame counts |
| 8.2       | `load-tests/scenarios/http-sessions.js`         | 25 → 50 → 100             | 30 s each                     | HTTP throughput + percentiles                      |
| 8.2       | `load-tests/scenarios/websocket-connections.js` | 25 → 50 → 100             | 30 s each                     | WS throughput, CPU, memory, event loop             |
| 8.2       | `load-tests/scenarios/quiz-answer-storm.js`     | 100 → 250 → 500 → 1000    | per scenario                  | PostgreSQL row-lock election cost                  |
| 8.3       | `load-tests/scenarios/distributed-workload.js`  | 50/50                     | per scenario                  | cross-instance propagation, Redis Pub/Sub          |
| 8.4       | `load-tests/scenarios/reconnect-storm.js`       | 1000                      | per scenario                  | recovery latency, churn, Redis load                |
| 8.5       | `load-tests/scenarios/doubt-queue-storm.js`     | 500                       | 30 s                          | creation latency, `enqueueSeq` allocation          |
| 8.6       | `load-tests/scenarios/failure-under-load.js`    | per scenario              | per scenario                  | Redis outage, instance kill                        |

## 6. What is measured

**Application-level (primary):**

- HTTP: request count (`http.requests`), failures (`http.failures`), one
  duration sample per completed request in `http.durationMs`
  (`count`/`min`/`max`/`mean`/`p50`/`p90`/`p95`/`p99`), status-code
  distribution (`http.statusCounts`)
- WebSocket: connection success/failure counters, one connection-duration
  sample per successfully opened connection
  (`ws.connectionDurationMs.count === ws.connectionSuccess`), one
  message-duration sample per received frame
  (`ws.messageDurationMs.count === ws.messagesReceived`), frame counters,
  open-at-end gauge

**Rates (defined):**

- `requestsPerSec` = `http.requests / durationSeconds` (all completed
  attempts, including failures).
- `successfulRequestsPerSec` = `(http.requests - http.failures) / durationSeconds`.
- `wsConnectionsPerSec`, `wsMessageRate` analogously over WS counters.

**Instruments:** k6-native `Trend`/`Counter`/`Rate` series are the
forward-looking benchmark source; `load-tests/run.js` is the
zero-dependency fallback/smoke harness. Both measure equivalent concepts
but are separate instruments — never mix their numbers.

**Measurement invariants (fail-closed):** `http.durationMs.count` must
equal `http.requests`; WS connection/message sample counts must equal
`ws.connectionSuccess` / `ws.messagesReceived`; `timestamp` is wall-clock
(`new Date().toISOString()`); any mismatch (or zero operations) sets
`measurement.valid=false`. Missing samples are never fabricated or
inferred.

**Diagnostic probes only (never throughput, never written):**

- PostgreSQL source: `pg_isready` (`pgs.source`, `kind: "connectivity-probe"`).
- Redis source: `redis-cli ping` (`redis.source`, `kind: "connectivity-probe"`).
- No `pg_stat_statements` in this phase; `queries` stays `0` by design.

The harness **does not** duplicate the application's `prom-client` registry.
Production metrics stay untouched.

## 7. Where results go

```
load-tests/
├── README.md
├── env.example
├── run.js
├── http/
│   └── sessions.js
├── websocket/
│   └── connections.js
├── scenarios/
│   └── ... (future)
└── results/
    └── .gitkeep          # gitignored — real results live here
```

`load-tests/results/` is gitignored so **measurements are never committed as
fixed values**.

## 8. Reproducibility rules

Before every run, log:

1. Machine/environment — `uname -a` / `sw_vers`, `node --version`,
   `pnpm --version`, CPU + RAM + cores, Docker + PG + Redis versions + SHA
2. Environment — `.env` (redacted), `BASE_URL`, `WS_URL`, `TEST_DB_URL`,
   `REDIS_URL` (redacted), `DISTRIBUTION_ENABLED`, `METRICS_ENABLED`,
   `PRESENCE_DIGEST_INTERVAL_MS`
3. Command — exact invocation reproduced
4. Raw observed output — appended to a results file (or console)
5. Post-run check — `/health` still `200`; no process killed mid-run

**Interpret only what you measured.** No scenario result is a capacity limit.
No percentile is a system guarantee.

### Success criteria for the Phase 8.1 smoke

The canonical smoke is successful when the result JSON shows:

- `http.requests > 0`
- `http.failures === 0`
- `http.statusCounts` contains `201` (session created)
- the result file is the single, latest-by-mtime `http-sessions-*.json` under
  `load-tests/results/`

A smoke that exits 0 but returns only 409s is **not** a successful application
smoke. In Phase 8.1 this was caused by the scenario reusing the same
`creator.displayName` across VUs, which collided on the
`users.displayName` uniqueness constraint and produced 409 Conflict. The
scenario was corrected to give every VU a distinct creator display name.

## 9. Safety checklist

- [ ] `BASE_URL` is `127.0.0.1` (or `--allow-nonlocal` passed)
- [ ] Load generator + target on the same machine
- [ ] No scenario writes to PostgreSQL or Redis
- [ ] `/health` still `200` before and after
- [ ] `load-tests/results/` is gitignored
- [ ] Existing Phase 1–7 tests remain green
- [ ] `npx tsc --noEmit` clean
- [ ] `npx prisma validate` clean

## 10. What this phase deliberately does NOT do

- No optimization or tuning.
- No capacity claims before measured data exists.
- No k6 installation in this environment (registry serves only the `0.0.0`
  dummy stub).
- No production targeting.
- No Prometheus-metric duplication in the harness.

> **Site note:** the npm registry here serves `k6` only as `0.0.0` (a dummy
> package for autocompleting k6 scripts); the canonical load tool is also
> shipped with `k6` in the file for future use as the phase matures.

---

## 11. Phase 8.3 — HTTP baseline (measurement-only, 2026-10-07)

First real performance experiment. No production code was changed, no
optimization performed, no architecture touched. All numbers below are
**local baseline measurements** from one machine, not capacity claims.

### 11.1 Environment (observed, not estimated)

| Item       | Observed value                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OS         | macOS 27.0 (build 26A428), Darwin 27.0.0 arm64                                                                                                                                                               |
| CPU        | Apple M2, 8 logical / 8 physical cores                                                                                                                                                                       |
| RAM        | 16 GB (17179869184 bytes)                                                                                                                                                                                    |
| Node.js    | v26.3.0                                                                                                                                                                                                      |
| pnpm       | 12.5.1                                                                                                                                                                                                       |
| PostgreSQL | 17.11 (docker `postgres:17-alpine`, host 5433 → container 5432)                                                                                                                                              |
| Redis      | 7.4.11 (docker `redis:7-alpine`, host 6380 → container 6379)                                                                                                                                                 |
| k6         | not available in this environment (`command not found`)                                                                                                                                                      |
| Harness    | `load-tests/run.js` zero-dependency fallback (k6-native files are the forward-looking source; the two are separate instruments)                                                                              |
| Git SHA    | `c21a8e750a8723fa720020cabefb76320a716ad0` (plus uncommitted Phase 8.2a harness/docs changes)                                                                                                                |
| App config | `PORT=3000`, `NODE_ENV=development`, `DISTRIBUTION_ENABLED=true`, `LOG_LEVEL=debug`, `WS_HEARTBEAT_INTERVAL_MS=30000`, `METRICS_ENABLED` default (route live), `PRESENCE_DIGEST_INTERVAL_MS` default (10000) |
| Build      | `pnpm build` (`tsc -p tsconfig.build.json`), server run as `node dist/server.js`                                                                                                                             |

Host resources were collected with `ps -o %cpu,rss -p <server-pid>`
sampled every 5 s during each run (documented method; `%CPU` may exceed
100 % on multi-threaded runtime activity).

### 11.2 Workload

Real `POST /sessions` via the existing `http-sessions` scenario (unique
creator/session identities per request, so uniqueness constraints do not
create artificial failures). Sequential, one clean server process per
workload (`/health` → 200 before each run, stopped cleanly after):

```bash
node load-tests/run.js --vus 10  --duration 30s --scenario http-sessions
node load-tests/run.js --vus 25  --duration 30s --scenario http-sessions
node load-tests/run.js --vus 50  --duration 30s --scenario http-sessions
node load-tests/run.js --vus 100 --duration 30s --scenario http-sessions
```

Note on offered load: the harness fires `vus` requests per tick on a
`1000/vus` ms cadence, so nominal offered load scales as ~`vus²`/s
(10→~100 rps, 25→~625 rps, 50→~2500 rps, 100→~10000 rps). This is a
property of the fallback instrument, not of k6 — a known limitation when
comparing against future k6 runs.

No repetitions were performed (single run per workload); stability across
repeats is an open question (see limitations).

### 11.3 Results (raw files under gitignored `load-tests/results/`)

| VUs | Duration                      | Requests | Failures       | RPS    | succ RPS | p50     | p95     | p99     |
| --- | ----------------------------- | -------- | -------------- | ------ | -------- | ------- | ------- | ------- |
| 10  | 30 s                          | 2980     | 0              | 99.3   | 99.3     | 9.51    | 13.14   | 17.97   |
| 25  | 30 s                          | 18250    | 0              | 607.4  | 607.4    | 9.73    | 24.46   | 100.25  |
| 50  | 30 s (+2.0 s in-flight drain) | 71200    | 21364 (30.0 %) | 2219.6 | 1553.6   | 2006.67 | 2094.33 | 2258.63 |
| 100 | 30 s (+2.4 s in-flight drain) | 112500   | 78334 (69.6 %) | 3473.3 | 1054.8   | 2025.58 | 2344.67 | 2643.54 |

Full latency detail (ms):

| VUs | min  | mean    | p50     | p90     | p95     | p99     | max     | status                                                      |
| --- | ---- | ------- | ------- | ------- | ------- | ------- | ------- | ----------------------------------------------------------- |
| 10  | 5.15 | 9.99    | 9.51    | 12.14   | 13.14   | 17.97   | 83.49   | 201: 2980                                                   |
| 25  | 5.13 | 12.99   | 9.73    | 14.95   | 24.46   | 100.25  | 214.11  | 201: 18250                                                  |
| 50  | 4.35 | 1729.78 | 2006.67 | 2030.28 | 2094.33 | 2258.63 | 2956.52 | 201: 49836, 500: 20563, ~801 transport errors (no status)   |
| 100 | 3.83 | 1577.40 | 2025.58 | 2080.69 | 2344.67 | 2643.54 | 3361.74 | 201: 34166, 500: 54648, ~23686 transport errors (no status) |

Measurement integrity: every run has `measurement.valid === true` with
`durationSamples === requests` (2980/2980, 18250/18250, 71200/71200,
112500/112500). The 50/100 VU failure counts are real measured responses
(status 500) and real transport errors (counted in `requests`+`failures`
with one duration sample each) — not missing data.

Raw artifacts (gitignored, not committed):

- `load-tests/results/http-sessions-10VUs-1791407368481.json`
- `load-tests/results/http-sessions-25VUs-1791407545395.json`
- `load-tests/results/http-sessions-50VUs-1791407595966.json`
- `load-tests/results/http-sessions-100VUs-1791407659625.json`

### 11.4 Host + application observations

- 10 VU: server CPU ~11–17 %, RSS ~78 MB → ~160–167 MB. No errors.
- 25 VU: server CPU ~57–73 %, RSS ~139 MB → ~210–250 MB. No errors.
- 50 VU: server CPU ~117–247 %, RSS ~140 MB → ~470–613 MB. 30 % failures.
  `/health` 200 after the run; no process crash.
- 100 VU: server CPU ~165–188 %, RSS ~127 MB → ~625–735 MB. 69.6 %
  failures. `/health` 200 after the run; no process crash.
- Failure signature (server logs, both 50 and 100 VU):
  `PrismaClientKnownRequestError` code `P2028` —
  "Transaction API error: Unable to start a transaction in the given
  time." at `session.routes.js` (session creation runs inside an
  interactive transaction). Requests queue to ~2 s (p50 ≈ 2000 ms at
  both 50 and 100 VU) and then fail.
- Suspected bottleneck (hypothesis only, supported by the P2028 log
  signature — not proven by pool-level metrics): the session-creation
  transaction cannot acquire a DB connection under high concurrency, so
  throughput collapses between 25 VU (~607 successful rps, healthy) and
  50 VU (~1554 successful rps but 30 % errors, ~2 s latency). Successful
  RPS actually _falls_ from 50 VU (1554) to 100 VU (1055). No claim is
  made about pool size, PG saturation, or event-loop state — none of
  those were directly measured.

### 11.5 `/metrics` correlation + gaps

- `/metrics` was captured before/after each run. Session creation
  exposes **no dedicated HTTP/db counter**: `livepulse_db_operation_duration_seconds`
  and `livepulse_db_operation_errors_total` export HELP/TYPE headers with
  zero samples for this workload, and there is no per-endpoint HTTP
  request counter. The P2028 failures are visible only in server logs,
  not in `/metrics` — a genuine instrumentation gap, documented rather
  than worked around.
- Redis: `livepulse_redis_connected{publisher,subscriber} = 1`, zero
  connection errors, zero publishes for this workload (session creation
  does not publish) — connectivity healthy, and no throughput is claimed
  from `redis-cli ping` (probe only: `connected:true`, `source:
"redis-cli ping"`).
- PG probe: `source: "pg_isready"`, `queries` stays 0 by design
  (connectivity probe, never throughput). `TEST_DB_URL` was unset so the
  probe reports `skipped:true` — truthful, not fabricated.
- WS counters stayed 0 (HTTP-only workload, as expected).

### 11.6 Limitations / unresolved questions

- Single run per workload; variance across repeats unknown.
- Generator and server share one M2/16 GB machine — client-side
  contention at 50/100 VU is not separated from server saturation.
- Offered load scales as ~`vus²`/s in the fallback harness; k6 may
  present a different arrival process, so cross-instrument comparison
  needs care.
- No pool-level (Prisma/PG `pg_stat_activity`), event-loop-lag, GC, or
  per-process PG/Redis CPU/memory measurements were taken.
- DB row growth from the benchmark itself (~114 k `sessions` rows after
  the 100 VU run) was left in place; follow-up runs start from a larger
  table.
- No 250+ VU runs attempted; the curve already turns between 25 and 50 VU.

### 11.7 Tests

- Before: `pnpm test:all` 141/141 green; `tsc --noEmit` clean;
  `prisma validate` valid.
- After: `pnpm test:all` 141/141 green; `tsc --noEmit` clean;
  `prisma validate` valid.

---

## 12. Phase 8.4 — Bottleneck diagnosis (measurement-only, 2026-10-07)

Question: **why does LivePulse hit a ~2-second transaction-failure cliff
between 25 and 50 VUs?** No code or configuration was changed in this
phase — not even pool sizing. Observe → hypothesis → experiment → measure.

### 12.1 Recorded configuration (inspected, never modified)

- `DATABASE_URL=postgresql://livepulse:livepulse@localhost:5433/livepulse`
  — no `connection_limit`, no `pool_timeout` parameters.
- `src/infrastructure/prisma/plugin.ts`: `new PrismaClient()` with zero
  tuning options (only the datasource URL).
- `src/modules/sessions/session.repository.ts` `createWithCreator()`: one
  interactive transaction (`user.create` + `session.create` +
  `sessionParticipant.create`) via `$transaction(async (tx) => …)` with **no
  explicit `{ maxWait, timeout }`** — engine defaults apply.
- Host CPUs: 8 → Prisma's documented default pool is `num_cpus × 2 + 1 =
17` connections (confirmed by observation, §12.3).
- Prisma 6.19.3; PostgreSQL `max_connections = 100`.
- The p50 ≈ 2005 ms measured in §12.4 is itself the empirical
  transaction-acquire ceiling, consistent with Prisma's documented
  interactive-transaction `maxWait` default of 2000 ms.

### 12.2 Controlled DB state (maintenance, not app/infra change)

Phase 8.3 had accumulated ~114 k benchmark rows. Before diagnosing:

- Kept: 3 dev sessions (incl. the quiz-bearing `Phase 1 smoke` session),
  4 dev users, 3 participants, 1 quiz, 2 questions.
- Deleted by benchmark-name pattern: 113,783 sessions
  (`e2e-sess-%`/`e2e-sesh-%`; participants cascaded), then 113,782 orphaned
  benchmark users (`smoke-creator-VU-%`, `VU-%`; RESTRICT guards kept
  referenced rows).
- `VACUUM ANALYZE` + `REINDEX` on `sessions`/`users`/`session_participants`:
  32 MB → 80 kB (sessions), 30 MB → 744 kB (users). No application,
  schema, or infrastructure change — table maintenance only.

### 12.3 Experiment: 25 VU vs 50 VU × 30 s, clean process each

Same harness and scenario as §11.2. During each run, every 5 s: `ps -o
%cpu,rss` on the server pid plus `pg_stat_activity` snapshots for the
`livepulse` database (connection counts by state; wait events), excluding
the probe's own pid.

|                      | 25 VU (healthy)                                 | 50 VU (saturated)                                        |
| -------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| Result file          | `http-sessions-25VUs-1791408154577.json`        | `http-sessions-50VUs-1791408221791.json`                 |
| Requests / failures  | 18325 / 0                                       | 51250 / 11190 (21.8 %)                                   |
| Status               | 201: 18325                                      | 201: 40060, 500: 10501, ~689 transport errors            |
| RPS / succ RPS       | 610.0 / 610.0                                   | 1601.3 / 1251.6                                          |
| p50 / p95 / p99 (ms) | 8.80 / 13.20 / 16.68                            | 2004.95 / 2046.27 / 2281.24                              |
| `measurement.valid`  | true (18325/18325)                              | true (51250/51250)                                       |
| Server log ERRORs    | 0                                               | 10501 — **all** `P2028`, zero other error types          |
| PG connections       | pegged at **17/17**, ~all `idle` (`ClientRead`) | pegged at **17/17**, stuck `idle in transaction` (8–17)  |
| PG wait events       | `ClientRead` only (+1 transient WAL burst)      | `WALWrite`/`WalSync` + `ClientRead`; **no `Lock` waits** |
| Node CPU / RSS       | ~47–76 %, ~230–260 MB                           | ~192–214 %, ~336–582 MB                                  |
| `/health` after      | 200, no crash                                   | 200, no crash                                            |

### 12.4 Findings (measured)

1. **The pool is 17 connections** — observed pegged at exactly 17/17 in
   both runs, matching the default `8 × 2 + 1` for this 8-core host. At
   25 VU the 17 connections sit idle; at 50 VU all 17 are held
   in-transaction.
2. **The ~2 s floor is consistent with Prisma's transaction-acquisition
   `maxWait` default, and the exact 1:1 P2028 mapping strongly confirms
   connection-pool acquisition timeout as the immediate failure mechanism**:
   p50 at 50 VU is 2004.95 ms — requests queue against the full pool, then
   Prisma throws `P2028` ("Unable to start a transaction in the given
   time"), which surfaces as HTTP 500. Exact 1:1 mapping: 10501 P2028
   errors = 10501 status-500 responses (no `maxWait`/`timeout` is configured
   in the application — `createWithCreator()` passes no options — so the
   ceiling is the engine default, identified by measurement rather than
   asserted from configuration). The residual ~689 failures are client-side
   transport errors under load.
3. **PostgreSQL is not the saturated layer**: `max_connections = 100`
   with only 17 backend connections used; no `Lock` wait events (each
   transaction touches fresh rows — no row contention); only
   commit-path `WALWrite`/`WalSync` waits while draining. Headroom exists
   server-side; the cap is the **client-side pool**.
4. **Not primarily CPU**: 25 VU at ~76 % CPU still delivers p95 13 ms;
   a CPU-bound system degrades smoothly, it does not cliff at exactly
   2000 ms. Node CPU roughly doubles into the saturated run, but the
   latency signature (flat 2.0 s floor = queue-then-timeout) points at
   pool queuing, with CPU as a secondary contributor at most.
5. **Clean-DB effect (variance note, both runs reported)**: this 50 VU
   run failed 21.8 % vs 30.0 % in §11.3 on the bloated (114 k-row)
   tables. Table/index bloat plausibly lengthens each transaction's
   connection hold time, shrinking effective pool capacity — a
   hypothesis consistent with the data, not separately isolated. Per the
   no-cherry-picking rule both numbers stand.

### 12.5 What was NOT changed, and open gaps

- No pool sizing, timeout, schema, index, algorithm, or process-model
  change. In particular the pool was **not** enlarged — that would be
  optimizing on a hypothesis.
- Not measured: Prisma event-loop delay, GC pauses, per-backend
  `pg_stat_activity` query text sampling at higher frequency (5 s
  snapshots can miss bursts), PG CPU/memory, single-run-per-level
  variance.
- Suggested next experiment (not started): hold 50 VU offered load fixed
  while varying **only** pool size (e.g. 17 → 34) on the clean DB and
  observe whether the cliff moves with the pool — that isolates the pool
  as the binding constraint vs. PG commit throughput.

### 12.6 Experiment B: pool 34 at 50 VU (temporary override, reverted)

Method: server started with process-only
`DATABASE_URL="…livepulse?connection_limit=34"` (real environment wins
over `.env`; **no file changed**, override process killed afterwards —
`git status` confirms no config modification). Clean DB restored first
(§12.2 procedure: 58,385 benchmark rows removed, VACUUM + REINDEX,
80 kB/744 kB). Same 50 VU × 30 s scenario and 5 s observation cadence.

|                      | A: pool 17 (clean DB)                    | B: pool 34 (clean DB)                    |
| -------------------- | ---------------------------------------- | ---------------------------------------- |
| Result file          | `http-sessions-50VUs-1791408221791.json` | `http-sessions-50VUs-1791440254233.json` |
| Requests / failures  | 51250 / 11190 (21.8 %)                   | 73100 / 13595 (18.6 %)                   |
| Status               | 201: 40060, 500: 10501                   | 201: 59505, 500: 13378                   |
| RPS / succ RPS       | 1601.3 / 1251.6                          | 2279.1 / 1855.2 (+48 % successful)       |
| p50 / p95 / p99 (ms) | 2004.95 / 2046.27 / 2281.24              | 2010.75 / 2035.85 / 2151.32              |
| `measurement.valid`  | true (51250/51250)                       | true (73100/73100)                       |
| P2028 ↔ 500 mapping  | 10501 = 10501, all errors P2028          | 13378 = 13378, all errors P2028          |
| PG conns held        | 17/17 in-txn                             | **34/34** in-txn (override verified)     |
| PG waits             | WALWrite ×4–8, WalSync ×1, no locks      | WALWrite ×11–13, WalSync ×1, no locks    |
| Node CPU / RSS       | ~192–214 %, ~582 MB peak                 | ~115–207 %, ~608 MB peak                 |

Reading (both outcomes the matrix anticipated, in one result):

- **Pool is the primary throughput bottleneck**: doubling it raised
  successful RPS 48 % and cut the failure rate 21.8 % → 18.6 % _despite
  42 % higher offered load in run B_ (see confound below).
- **But the cliff did not move**: p50/p95 floors are identical (~2.0 s),
  the pool is again fully held, and P2028 remains the sole error type.
  Commit-path pressure visibly grew (11–13 concurrent `WALWrite`
  waiters vs 4–8) — the **next ceiling (WAL/commit) is already showing**
  at 34 concurrent committers.
- Verdict: enlarging the pool alone relocates rather than removes the
  saturation. This is evidence **against** blindly raising the pool as
  "the fix" — the correct next question is per-transaction cost and
  commit-path behavior, not pool size.

Confound (documented, not hidden): offered load differed between runs —
the single-machine generator fired 51,250 attempts in A vs 73,100 in B
(timer slip under shared-machine CPU contention). Success _rates_
(78.2 % → 81.4 %) and the unchanged latency floors are the load-robust
comparisons; absolute RPS deltas partly reflect offered-load difference.
Future runs should pin the generator or separate it from the server host.

---

## 13. Phase 8.5 — Transaction/commit-path diagnosis (measurement-only, 2026-10-08)

Question: **where does each `createWithCreator()` transaction's time
actually go — acquisition, statements, or COMMIT/WAL?** Nothing was
changed: no pool, schema, index, code, or config edit. `pg_stat_statements`
was deliberately **not** enabled (it needs a PG restart via
`shared_preload_libraries`, heavier than the question warrants —
client-side timing plus WAL deltas answer it).

### 13.1 Transaction shape (inspected)

`SessionRepository.createWithCreator()`: one interactive `$transaction`
with 3 single-row inserts (`user.create` → `session.create` →
`sessionParticipant.create`), no explicit timeout options. `EXPLAIN` shows
trivial `Insert → Result` plans for all three — no scans, no plan risk.
Write amplification per transaction: 3 heap inserts + ~7 index entries
(PKs + `users.displayName` unique + `sessionId_userId` unique + secondary
indexes) + 1 commit record.

### 13.2 Unloaded timing probe (scratch script, `/tmp` only, deleted after)

30 sequential transactions through the real built repository, same
statement shape; per-segment ms:

| Segment                                          | mean     | p50      | p95      | max   |
| ------------------------------------------------ | -------- | -------- | -------- | ----- |
| user insert                                      | 0.77     | 0.29     | 0.77     | 13.15 |
| session insert                                   | 0.57     | 0.38     | 1.03     | 4.61  |
| participant insert                               | 0.47     | 0.35     | 0.78     | 2.50  |
| commit (attributed: total − statements)          | 2.52     | 0.48     | 1.55     | 58.25 |
| **total transaction**                            | **4.32** | **1.52** | **4.03** | 78.51 |
| empty-txn roundtrip (acquire+BEGIN+empty COMMIT) | 0.46     | 0.37     | 0.97     | 1.40  |

Unloaded cost ≈ **1.5 ms p50** — ~1300× smaller than the loaded p50.
Statement execution is sub-millisecond; the 2 s loaded floor cannot be
statement cost.

### 13.3 Loaded run: 50 VU, pool 34 (temporary override, reverted), clean DB

Same observation method as §12.3 plus `pg_stat_database` /
`pg_stat_wal` deltas. Result file
`http-sessions-50VUs-1791446604916.json`, `measurement.valid` true
(72150/72150):

- 72150 requests, 5992 failures (8.3 %): 201: 66158, 500: 5225 (all 5225
  P2028, 1:1), ~767 transport errors. RPS 2247.4 / succ 2060.7.
- Latency ms: mean 1080.3, **p50 688.1**, p90 2020.3, p95 2029.9, p99 2224.2.
- `xact_commit` delta: +65,016 over the run; `xact_rollback` delta: **0**
  — P2028 fails pre-BEGIN (acquire), never aborting a started
  transaction.
- WAL delta: +850,247 records / +97,014,206 bytes → **≈1,466 bytes and
  ≈12.9 WAL records per successful transaction** (matches expectation:
  3 heap + ~7 index + commit records). Per-transaction WAL _volume_ is
  tiny — the issue is commit-path _concurrency_, not volume.
- PG: 34/34 held during load (`idle in transaction` 21–34), `WALWrite`
  ×2–11 + `WalSync`, **no `Lock` waits**. One transient 35th backend in
  a single sample (pool turnover); not material.
- Node CPU ~152–216 %, RSS → ~607 MB. `/health` 200 after; no crash.

Stats-gap note: `xact_commit` delta (65,016) trails HTTP 201s (66,158) by
1.7 % — attributed to PG stats-collector message drops under load (a
documented lossy path), not to missing transactions. HTTP
counters + P2028 1:1 remain authoritative; PG counters corroborate.

### 13.4 Run-to-run variance (same config, both reported)

|           | §12.6 run B        | This run (§13.3)   |
| --------- | ------------------ | ------------------ |
| Failures  | 18.6 %             | 8.3 %              |
| Succ RPS  | 1855               | 2061               |
| p50       | 2010.8 ms          | 688.1 ms           |
| p90 / p95 | 2020.3 / 2035.9 ms | 2020.3 / 2029.9 ms |

Identical settings (50 VU, pool 34, clean DB), substantially different
medians — single-run numbers are noisy on this shared host (page-cache
warmth, autovacuum timing, generator contention). What is _stable_ across
all saturated runs: pool fully held, p90+ pinned at ~2.0 s, P2028 the
sole app error, WAL waits with no locks. The tail — not the median — is
the reliable signal.

### 13.5 Does the transaction need to be one interactive transaction?

Correctness assessment (analysis only, not implemented): the three
writes must be atomic — a `user.create` followed by a failed
`session.create` (e.g. a problem downstream) would strand an orphan user
holding a globally-unique `displayName`, permanently burning that name.
Recorded option space for later: single nested write (one statement,
one implicit transaction) vs. current interactive transaction; any
change must preserve the all-or-nothing guarantee and is **not** made
here.

### 13.6 Conclusion

Unloaded execution ≈ 1.5 ms; the loaded bottleneck is **connection
acquisition coupled with commit-path coordination** — WAL-related waits
are the observed PostgreSQL wait signal, but the measurements do not yet
establish that WAL I/O itself is the ultimate physical bottleneck
(candidates not yet distinguished: WAL flush coordination, fsync/storage
latency, commit serialization, client-side hold time, CPU scheduling,
shared-host contention). Neither statement plans nor per-row costs
implicate the queries themselves. The evidence argues against further
pool enlargement (more concurrent committers → more WAL coordination)
and points the next investigation at reducing connection hold time /
commit rate per session creation.

---

## 14. Phase 8.6 — Atomic single-operation investigation (no implementation, 2026-10-08)

Question: **can `createWithCreator()` be expressed as a Prisma
nested-write single call, and would that actually reduce connection hold
time?** Measurement first (`/tmp` scratch scripts, deleted after; DB
cleaned after each probe). The route was **not** changed.

### 14.1 Candidate shape (analyzed, not adopted)

Relations support nesting from the `User` side (`createdSessions` /
`SessionCreator` relation), but the participant must reference the same
new user — which requires an explicit id (the probe used
`crypto.randomUUID`, v4; production uses Prisma's client-generated
`uuid(7)`, so an explicit id would need a uuidv7 generator to preserve
the id scheme — recorded, not implemented):

```ts
prisma.user.create({
  data: {
    id,
    displayName,
    createdSessions: {
      create: [{ name, participants: { create: [{ userId: id, role: "TEACHER" }] } }],
    },
  },
});
```

### 14.2 Generated SQL (query-event capture, N=20 txns each)

- Interactive (current repo shape): **5 engine ops/txn** —
  BEGIN + 3 INSERTs + COMMIT, zero SELECTs (the repository returns created
  entities directly, no re-read).
- Nested: **5 engine ops/txn** — BEGIN + 3 INSERTs + COMMIT. (An early
  probe showed 8 with 3 extra SELECTs — those came from the probe's own
  `include`, not from nesting itself.)
- So nesting saves **zero SQL statements**. What it removes is
  client↔engine round trips: 3 sequential client awaits (each a
  client→engine hop) collapse into 1.

### 14.3 Unloaded hold times (N=25 each, no include, warmup excluded)

| Shape              | mean | p50  | p95  | max (ms) |
| ------------------ | ---- | ---- | ---- | -------- |
| Interactive        | 2.41 | 2.12 | 4.50 | 5.34     |
| Nested single call | 1.84 | 1.64 | 2.16 | 5.99     |

Delta ≈ **0.5 ms p50 (~25 %)** — consistent with eliminating localhost
client↔engine round trips, not with cheaper SQL. Whether 0.5 ms/txn moves
the loaded cliff is **unknown**: answering that requires the alternative
in the request path under load, which is implementation and was
explicitly not done.

### 14.4 Error-semantics blocker (reproduced 3×, verified clean)

Duplicate `displayName`:

- Interactive: `P2002` (`meta.target: ["displayName"]`) → global handler
  (`app.ts`) maps `error.code === "P2002"` → **HTTP 409**. This is the
  documented collision contract the load-test smoke relies on.
- Nested: **client-side validation error, `code: undefined`** ("Unknown
  argument `createdSessions`", pretty-printer `~~~~` marker) — the
  duplicate-name failure never reaches the engine as a P2002. Adopted
  as-is, duplicate creators would return **500 instead of 409**: an
  observable API regression independent of any performance question.

Any future change of write shape must preserve the P2002 → 409 contract
(e.g. explicit mapping or pre-check) before performance can even be
compared. Atomicity of engine-detected mid-write violations under the
nested shape was not directly tested (no failing-last-statement case was
constructed); only the all-or-nothing trivial case (first-statement
duplicate, zero rows written) was observed.

### 14.5 Verdict

Nested single-call is **not** a smaller database operation (same 5 engine
ops, same 3 INSERTs + commit) — it is a fewer-round-trips client
operation worth ~0.5 ms unloaded, with an unresolved error-code
regression attached. It does not on its face explain or remove a 2000 ms
queueing cliff driven by 34 fully-held connections. Recommend against
pursuing it as the primary fix; hold-time reduction must come from
elsewhere (fewer commits per session, shorter transactions, or lower
offered concurrency per connection — each its own experiment).

---

## 15. Phase 8.7 — PostgreSQL commit behavior under concurrency (read-only, 2026-10-08)

Question: **what exactly happens to the commit path as concurrent
transactions increase — and is the ~2 s cliff PG behavior or pool
queueing?** No setting was changed (`synchronous_commit` untouched);
`track_wal_io_timing` stays off (per-byte WAL _timing_ unavailable
without a server change — counts used instead). No production change.

### 15.1 Recorded commit-path configuration (all defaults unless noted)

`synchronous_commit=on`, `wal_sync_method=fdatasync`, `fsync=on`,
`full_page_writes=on`, `commit_delay=0`, `wal_buffers=512` (4 MB;
`wal_buffers_full` already 27,048 cumulatively — writers flush often),
`shared_buffers=128 MB` + `max_connections=100` + `max_wal_size=1024 MB`
(from compose config file, the only non-defaults). PG 17.11 Alpine/aarch64
in Docker; data on a **named volume** (Linux-VM-local — no macOS
bind-mount penalty on the fsync path, though still virtualized block I/O).

### 15.2 Commit latency vs concurrency (direct-to-PG probe, no app server)

Scratch script (`/tmp`, deleted): the same 3-insert transaction shape,
100 txns at each concurrency level, probe pool 64 so the only queue is
inside PostgreSQL. Per-transaction latency, ms:

| Concurrency | mean  | p50   | p95   | max   | wall for 100 txns |
| ----------- | ----- | ----- | ----- | ----- | ----------------- |
| 1           | 1.95  | 1.50  | 3.54  | 9.37  | 195 ms (~513 tps) |
| 4           | 2.69  | 2.07  | 3.02  | 20.56 | 68 ms             |
| 8           | 4.57  | 3.65  | 10.42 | 25.39 | 58 ms             |
| 16          | 8.11  | 5.66  | 27.69 | 32.84 | 57 ms             |
| 32          | 19.28 | 13.46 | 53.30 | 60.51 | 64 ms             |

No checkpoints fired during the probe (checkpointer counters unchanged);
WAL delta ≈ 13.4 records / ≈1.3 KB per txn including cleanup deletes —
consistent with §13.3.

### 15.3 Reading: the cliff is pool queueing, not a PG wall

PostgreSQL degrades **gradually**: p50 1.5 → 13.5 ms from 1→32 concurrent
committers, p95 53 ms at 32-way — no 2000 ms cliff anywhere in the
commit path itself. The ~2 s app-level tail is therefore **queueing
against the fixed pool with a fixed acquire timeout**, not PG suddenly
becoming 1000× slower.

Capacity cross-check (Little's law): 34 connections / ~13 ms per commit
≈ **≈2600 commits/s** theoretical ceiling — squarely at the 50 VU
offered load (~2300–2500 attempts/s). Observed successful throughput
(1855–2061/s) sits just under it. The system rests exactly at the knee:
demand ≈ service capacity, so any burst queues unboundedly into the 2 s
acquire timeout. This also explains §12.6: more connections raise the
ceiling linearly while commit coordination cost per txn rises with
concurrency — diminishing returns by construction, not a fix.

Not distinguished (stated, not solved): WAL flush coordination vs
fsync/storage latency vs commit serialization vs CPU scheduling — WAL
I/O _timing_ would need `track_wal_io_timing`, a server change
deliberately deferred.
