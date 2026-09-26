# Load Testing — Phase 8.1 Foundation

Establishes a reproducible k6 load-test foundation **without changing
production architecture** and **without optimizing anything**. k6 remains
deliberately deferred: it is documented here as the target harness, but this
environment cannot install a versioned `k6` module (npm registry serves only
the `0.0.0` dummy stub), so the runnable harness for the same scenario files
is the zero-dependency Node fallback in `load-tests/run.js`.

---

## 1. Prerequisites

| Requirement | Version | Purpose |
| --- | --- | --- |
| Node.js | `>= 22` | Runs the harness + the app |
| `pnpm` | `12.5.1` | Install scripts |
| Docker + Docker Compose | any | PostgreSQL 5433 + Redis 6380 (optional, full stack) |
| `psql` | 15+ | Read-only DB diagnostics |
| `redis-cli` | 7+ | Read-only Redis diagnostics |

## 2. Environment variables

The harness reads one `.env` file. Create with `cp load-tests/env.example .env`.

| Variable | Default | Safety |
| --- | --- | --- |
| `BASE_URL` | `http://127.0.0.1:3000` | Refused unless `--allow-nonlocal` unless `127.0.0.1` |
| `WS_URL` | `$BASE_URL/ws` |  |
| `TEST_DB_URL` | (empty) | Read-only diagnostics only; the harness never writes |
| `REDIS_URL` | (empty) | Read-only diagnostics only; the harness never writes |

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

| Phase | File | VUs | Duration | Purpose |
| --- | --- | --- | --- | --- |
| 8.1 smoke | `load-tests/http/sessions.js` | 2 (smoke) / 10 (baseline) | 5 s (smoke) / 30 s (baseline) | HTTP session creation |
| 8.1 smoke | `load-tests/websocket/connections.js` | 10 | 30 s | real `/ws` joins, connection success, frame counts |
| 8.1 smoke | `load-tests/websocket/connections.js` | 10 | 30 s | real `/ws` joins, connection success, frame counts |
| 8.2 | `load-tests/scenarios/http-sessions.js` | 25 → 50 → 100 | 30 s each | HTTP throughput + percentiles |
| 8.2 | `load-tests/scenarios/websocket-connections.js` | 25 → 50 → 100 | 30 s each | WS throughput, CPU, memory, event loop |
| 8.2 | `load-tests/scenarios/quiz-answer-storm.js` | 100 → 250 → 500 → 1000 | per scenario | PostgreSQL row-lock election cost |
| 8.3 | `load-tests/scenarios/distributed-workload.js` | 50/50 | per scenario | cross-instance propagation, Redis Pub/Sub |
| 8.4 | `load-tests/scenarios/reconnect-storm.js` | 1000 | per scenario | recovery latency, churn, Redis load |
| 8.5 | `load-tests/scenarios/doubt-queue-storm.js` | 500 | 30 s | creation latency, `enqueueSeq` allocation |
| 8.6 | `load-tests/scenarios/failure-under-load.js` | per scenario | per scenario | Redis outage, instance kill |

## 6. What is measured

**Application-level (primary):**

- HTTP: request count, request failures, request duration (ms), status-code
  distribution
- WebSocket: connection success/failure, connection duration (ms), `session.joined`
  latency, frame counts

**Diagnostic reads only (never written):**

- PostgreSQL: query count, slow-query count, errors (via `psql` read-only
  checks)
- Redis: connection state, Pub/Sub notice counts (via `redis-cli` read-only
  checks)

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
