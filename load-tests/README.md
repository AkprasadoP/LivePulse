# LivePulse — Load Testing (Phase 8.1)

Establishes the load-testing foundation. Nothing here optimizes or changes
production architecture. Phase 8 exists to **measure** first, then to reason
about bottlenecks — never the other way around.

> This directory is the *successor* of AGENT.md's deferred `k6` tooling.
> k6 is the intended production-grade harness. This project currently runs on
> Node 26 with `pnpm@12`; the npm registry in this environment does not serve a
> versioned `k6` module (only the `0.0.0` dummy stub), so the Phase 8.1
> foundation uses a zero-dependency, pure-Node harness that reuses the real
> `ws` and `fastify`/`http` surface the app already owns. The k6 directory and
> its `.gitkeep` are retained so the planned k6 migration maps cleanly onto
> the same scenario layout.

## 1. Prerequisites

Run these on the **same machine** that will run `pnpm dev` (or the
dockerized stack), so that "local" means what it says.

| Requirement | Version | Purpose |
| --- | --- | --- |
| Node.js | `>= 22` | Runs the load harness + the app |
| `pnpm` | `12.5.1` (repo default) | Install scripts |
| Docker + Docker Compose | any | PostgreSQL 5433 + Redis 6380 (optional, for full stack) |
| `psql` | 15+ | Inspect the test DB during results review |
| `redis-cli` | 7+ | Inspect Redis during results review |

Do **not** point the load harness at any host other than the local dev
stack. Production targets are refused by a hardcoded default and an explicit
environment guard.

## 2. Environment variables

The harness reads a **single** environment configuration file. Create it with
`cp env.example .env` and edit only what you need.

```bash
# .env — MUST NOT be committed. Copied from env.example.
# Base URL of the LivePulse instance the harness talks to.
# Default is deliberately local-only; override via --env for other targets.
BASE_URL=http://127.0.0.1:3000

# Optional, used by the WebSocket scenario.
# Defaults to $BASE_URL/ws
WS_URL=ws://127.0.0.1:3000/ws

# PostgreSQL connection (read-only diagnostics only; the harness never writes)
# Ex: postgresql://livepulse:livepulse@localhost:5433/livepulse_test
TEST_DB_URL=postgresql://livepulse:livepulse@localhost:5433/livepulse_test

# Redis connection (read-only diagnostics only; the harness never writes)
# Ex: redis://localhost:6380
REDIS_URL=redis://localhost:6380
```

**Hard-safety rule:** the harness refuses to run when `BASE_URL` is not on
`127.0.0.1` unless `--allow-nonlocal` is passed on the command line. There is
no implicit production bypass.

## 3. How to start PostgreSQL / Redis / LivePulse

```bash
# 1. Start the dockerized dependencies (PostgreSQL 5433, Redis 6380)
pnpm db:up

# 2. Create the test database + apply migrations
pnpm db:test:setup

# 3. Start the dev server (HTTP + WebSocket on one port, default 3000)
pnpm dev
```

Or, for a production-style run:

```bash
cp .env.example .env
# edit if needed
pnpm build && pnpm start
```

## 4. Canonical smoke (Phase 8.1)

The canonical local smoke for Phase 8.1 is the Python wrapper at
`load-tests/smoke.py`. It shell-launches the server, verifies the socket and
`GET /` return `200`, runs the chosen scenario with explicit `--vus` and
`--duration`, retries once if the server vanishes on this host, cleans stale
result files before each run, and writes one clearly identified result JSON
under `load-tests/results/`.

```bash
python3 load-tests/smoke.py
```

The smoke is intentionally small: 2 VUs for 5 seconds against
`http-sessions`. The wrapper hardcodes those values for the canonical smoke;
the underlying Node harness still accepts arbitrary parameters for ad-hoc runs.

The same scenario files are executed directly by the zero-dependency Node
harness (`load-tests/run.js`) when you want an ad-hoc run without the wrapper:

```bash
node load-tests/run.js --vus 10 --duration 30s --scenario http-sessions
node load-tests/run.js --vus 10 --duration 30s --scenario websocket-connections
```

The `--scenario` selector matches the k6 scenario name, so swapping the
interpreter is a **one-word change** when k6 becomes available.

> The legacy Node-only standalone wrapper (`smoke.mjs`, if any) is no longer
> the documented entry point. It had a host-specific Node/Mach-O execution
> issue unrelated to LivePulse and was removed in favor of the Python wrapper.

## 5. Test scenarios (start small)

Load tests are added **incrementally**. Never jump straight to production
size.

| Phase | Scenario | VUs | Duration | What it measures |
| --- | --- | --- | --- | --- |
| 8.1 (this phase) | `http-sessions` | **2** (smoke) / **10** (baseline) | **5 s** (smoke) / **30 s** (baseline) | session creation — HTTP baseline |
| 8.1 (this phase) | `websocket-connections` | **10** | **30 s** | real `/ws` joins — connection success, frame throughput, churn |
| 8.2 | `http-sessions` (25 / 50 / 100) | 25 → 50 → 100 | 30 s each | HTTP throughput + latency percentiles |
| 8.2 | `websocket-connections` (25 / 50 / 100) | 25 → 50 → 100 | 30 s each | WS throughput, CPU, memory, event loop |
| 8.2 | `quiz-answer-storm` | 100 → 250 → 500 → 1000 | 30 s each | PostgreSQL row-lock election cost, winner invariant |
| 8.3 | two-instance distribution | 50/50 | per scenario | cross-instance propagation, Redis Pub/Sub throughput |
| 8.4 | reconnect storm | 1000 | per scenario | recovery latency, churn, Redis load |
| 8.5 | doubt queue storm | 500 | 30 s | creation latency, enqueueSeq allocation, lock contention |
| 8.6 | failure under load | per scenario | per scenario | Redis outage, instance kill, convergence |

**Rules:**

- Every scenario starts at the smallest credible size and only grows while
  the machine and the services stay within sane bounds.
- If a scenario fails to converge, the result is **invalid** — stop. Do not
  raise the load to "make it pass."
- No scenario ever writes to the database. Read-only dashboards and
  read-checks only.
- Every result file is named with the exact env + machine + timestamp that
  produced it, e.g. `results/http-sessions-10VUs-20260925T120000Z.json`.

## 6. What metrics are collected

The harness captures **application-level** metrics only:

- HTTP: request count, request failures, request duration (ms), status codes
- WebSocket: connection success/failure, connection duration (ms), message
  count, `session.joined` latency
- PostgreSQL (diagnostic reads only): query count, slow-query count, errors
- Redis (diagnostic reads only): connection state, Pub/Sub notice count

The harness **does not** duplicate the application's Prometheus metrics. The
`prom-client` registry that already exists in production stays untouched by
the load harness.

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

## 7. Where results go

```
load-tests/
├── README.md
├── env.example
├── run.js
├── http/
│   └── sessions.js          # scenario: HTTP session baseline
├── websocket/
│   └── connections.js       # scenario: real WS connection baseline
├── scenarios/
│   └── ...                  # future: quiz-answer-storm.js, doubt-queue-storm.js, ...
└── results/
    └── .gitkeep             # empty; *real results* live here (gitignored)
```

`load-tests/results/` is gitignored so **measurements are never committed** as
fixed values.

## 8. Reproducibility — record before you run

Before every run, log to a results file (or the console):

1. **Machine / environment**
   - `uname -a` (or macOS `sw_vers`)
   - Node version: `node --version`
   - `pnpm --version`
   - CPU model + cores, RAM
   - Docker version (if used), PostgreSQL image + version, Redis image + version
   - Load harness version + commit SHA of the repo that produced it
2. **Environment**
   - `.env` contents (redacted)
   - `BASE_URL`, `WS_URL`, `TEST_DB_URL`, `REDIS_URL` (redacted)
   - `DISTRIBUTION_ENABLED`, `METRICS_ENABLED`, `PRESENCE_DIGEST_INTERVAL_MS`
3. **Command**
   - Exact `node load-tests/run.js --vus ... --duration ... --scenario ...`
4. **Raw observed output**
   - The harness prints everything; it also appends a JSON summary to
     `results/`.
5. **Post-run check**
   - `/health` returned `200` before and after.
   - No process was killed or restarted during the run.

**Interpret only what you measured.** No scenario result is a capacity limit.
No percentile is a system guarantee. Phase 8.2+ explains bottlenecks; it does
not set them.

## 9. Safety checklist

- [ ] `BASE_URL` must be `127.0.0.1` or `--allow-nonlocal` passed
- [ ] Load server and load generator on the same machine
- [ ] No scenario writes to PostgreSQL or Redis
- [ ] `/health` still `200` before and after
- [ ] Results directory is gitignored
- [ ] `pnpm test:all` still green after this phase
- [ ] `npx tsc --noEmit` clean
- [ ] `npx prisma validate` clean

## 10. Files

- `load-tests/smoke.py` — canonical Phase 8.1 smoke entry point (Python)
- `load-tests/run.js` — zero-dependency Node harness (ad-hoc runs, k6-shaped
  scenario input)
- `load-tests/http/sessions.js` — HTTP session baseline scenario (k6-shaped)
- `load-tests/websocket/connections.js` — WebSocket baseline scenario
  (k6-shaped)

Generated with Codebuff 🤖
