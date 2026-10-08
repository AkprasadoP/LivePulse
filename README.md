# LivePulse

Real-time classroom infrastructure: live quizzes with first-correct-answer-wins
semantics, a doubt queue with defined ordering guarantees, presence, and
reconnection with server-side state recovery.

**Engineering principles, phase plan and honesty rules live in `AGENT.md`.**
Architecture: `docs/architecture/overview.md` · WebSocket:
`docs/architecture/websocket-architecture.md` · API: `docs/api/http-api.md` ·
WS protocol: `docs/api/websocket-protocol.md` · Schema:
`docs/database/schema.md` · Decisions: `docs/decisions/`.

## Current implementation status

**Phase 7 — Presence + Observability** (complete; Phases 1–6 retained beneath
it):

- Everything from Phases 1–2: typed Fastify HTTP server, fail-fast Zod
  config, Pino logging, graceful shutdown, liveness-only `/health`, the
  7-entity PostgreSQL domain schema, the race-safe session state machine,
  the session/quiz REST API, and the raw-`ws` WebSocket layer (shared port,
  envelope protocol, ephemeral registry, heartbeat, `preClose` shutdown)
- A temporary development identity seam: `session.join` binds a real user +
  `session_participants` row by globally-unique `displayName`
  (find-or-create, race-safe); view-only joins still supported. Replaced by
  authentication in a later phase — the seam is one replaceable code path
- Quiz/question lifecycles driven over WebSocket (teacher-only):
  `quiz.start` (DRAFT→ACTIVE), `question.publish` (DRAFT→PUBLISHED),
  `question.close` (PUBLISHED→CLOSED), with broadcasts; at most one
  published question per quiz enforced by a partial unique index
- Answer submission (`quiz.answer`): server-side grading, atomic
  persist + first-correct-wins election — submissions serialize on a
  question row lock, the winning INSERT is the election, and a partial
  unique index makes winner-count-≤-1 a database invariant (ADR-004).
  Duplicates are idempotent verdict replays; the client is never told the
  correct answer
- Per-question leaderboard derived from answer rows, broadcast as
  `leaderboard.updated` (no ranking state cached anywhere)
- Concurrency verified with real-socket race tests: 10, 50 and 100
  simultaneous correct answers (the 100 race repeated 3×) and a mixed
  correct/incorrect run — exactly one winner on every run
  (`docs/testing/concurrency.md`)
- Vitest suites: 72 unit tests + 141 integration tests against real
  PostgreSQL, real Redis and real WebSocket clients
- **Phase 4 — distributed WebSockets (implemented)**: inter-instance event
  distribution over Redis Pub/Sub, strictly as post-commit event notices on a
  single global channel — PostgreSQL stays the sole source of truth, winner
  election stays in the database, the receive path never writes, delivery is
  at-most-once with PostgreSQL reconciliation, and Redis outages degrade
  propagation only (`DISTRIBUTION_ENABLED` switch). Verified with two real
  independent instances: cross-instance question/verdict/leaderboard
  delivery, no echo/duplicates, a 20-student race split across both
  instances still electing exactly one winner, clean shutdown, and
  disabled-distribution degradation (`tests/integration/distributed.test.ts`).
  See `docs/architecture/distributed-websockets.md` and ADR-005
- **Phase 5 — reconnect & recovery (implemented)**: `session.join` now returns
  a `recovery` snapshot read purely from PostgreSQL — session quizzes with
  their states, the current published/closed question, the bound participant's
  stored answer verdict, and current standings. A client that drops and
  reconnects **to any instance** converges to authoritative state and resumes
  live delivery; missed transient events are never replayed, and a lost
  `answer.accepted` is recovered from the snapshot or by an idempotent retry
  (which can never create a second winner — the DB still elects one). Redis is
  not involved in the recovery path at all. Verified over real sockets across
  two independent instances, including the full "participate on WS-A, WS-A
  stops, reconnect to WS-B, recover, continue" criterion
  (`tests/integration/recovery.test.ts`). See
  `docs/architecture/recovery.md`, `docs/testing/recovery.md` and ADR-006
- **Phase 6 — doubt queue with deterministic ordering (implemented)**: students
  `doubt.create` and teachers `doubt.resolve` / `doubt.dismiss`, with a
  `doubt.queue.list` snapshot. The queue **is** PostgreSQL: order is
  `(priority DESC, enqueueSeq ASC)` over OPEN doubts, where `enqueueSeq` is a
  per-session monotonic integer the server assigns inside the accepting
  transaction while holding the session row lock — so sequence order equals
  durable acceptance order, not network/wall-clock/UUID/Redis order. Clients
  can never set ordering fields; create is idempotent on `clientDoubtId`
  (checked inside the same lock); resolve/dismiss are single conditional
  `OPEN → terminal` updates. Mutations broadcast locally and propagate via
  Redis notices; recovery carries the capped OPEN queue. Verified by a 100-way
  concurrent create race split across two real instances (enqueueSeq exactly
  1..100), resolve/dismiss races, idempotent retries and cross-session
  authorization (`tests/integration/doubt-queue.test.ts`). See
  `docs/architecture/doubt-queue.md`, `docs/testing/doubt-queue.md` and ADR-007
- **Phase 7 — presence (implemented)**: a participant is online for a session
  iff at least one healthy bound connection is registered on a live instance;
  presence is **ephemeral** (never a PostgreSQL row, never a Redis key) and
  derived from the registry each instance already keeps, so it cannot drift.
  Multi-connection participants (phone + laptop, on different instances) stay
  online until their **last** connection closes. Each instance publishes its
  complete local set as a `presence.update` Redis notice (whole sets, not
  deltas — a missed notice is repaired by the next one or by the periodic
  digest) and re-publishes it every `PRESENCE_DIGEST_INTERVAL_MS`; a peer
  silent for 3 × that interval is dropped. Clients receive one idempotent,
  order-insensitive `presence.snapshot` after joining and whenever the
  aggregate changes — never as part of the durable recovery snapshot. Verified
  over real sockets with two instances: cross-instance propagation, leave
  removal, multi-connection semantics, reconnect, degraded distribution,
  crashed-peer expiry, graceful-shutdown withdrawal, heartbeat removal and
  "presence writes nothing to PostgreSQL"
  (`tests/integration/presence.test.ts`). See `docs/architecture/presence.md`,
  `docs/testing/presence.md` and ADR-008
- **Phase 7 — observability (implemented)**: one process-local Prometheus
  registry per instance (`prom-client`) exposed at `GET /metrics`
  (unauthenticated, same port, `METRICS_ENABLED` toggle; 404 when disabled).
  31 metric families cover WebSocket transport, sessions, presence, Redis,
  durable operations, quiz, doubt queue and recovery. Labels are restricted to
  fixed enums (`operation`, `event`, `result`, `reason`, `status`, `role`,
  `connection`, `code`, `state`) — ids such as `sessionId` / `participantId` /
  `questionId` / `doubtId` / `requestId` are **forbidden** and enforced by
  tests — so cardinality is bounded by construction. The endpoint renders
  memory only and never queries PostgreSQL or Redis; `/health` stays
  liveness-only. Pino logs are standardized on an `instanceId` base field plus
  operation/session/participant fields, and never carry answers, payloads,
  tokens or connection strings. No performance number is claimed: buckets are
  provisional and Phase 8 revises them from measured traffic. See
  `docs/architecture/observability.md`, `docs/testing/observability.md` and
  ADR-009

**Not implemented yet** (by design, in phase order): Dockerized
multi-instance compose (tests spawn independent in-process instances today),
Grafana dashboards/alerting, OpenTelemetry tracing, k6 load testing,
authentication, attendance history. Do not assume any of this exists.

## Stack (as of Phase 7)

TypeScript (strict, ESM) · Node.js ≥ 22 · Fastify 5 · `ws` 8 · Prisma +
PostgreSQL 17 · Redis 6 (node-redis, Pub/Sub propagation only) · Zod · Pino ·
`prom-client` · Vitest · Docker Compose (PostgreSQL + Redis). k6, Nginx and
Grafana arrive with their phases.

## Commands

```bash
pnpm install                # install dependencies
pnpm db:up                  # start PostgreSQL (host 5433) + Redis (host 6380)
cp .env.example .env        # then edit if needed
pnpm db:test:setup          # one-time: create livepulse_test + apply migrations
pnpm dev                    # run the server in watch mode (HTTP + WS on one port)
pnpm build && pnpm start    # production-style run (compiles to dist/)
pnpm typecheck              # strict TypeScript check
pnpm test:unit              # unit tests (no database required)
pnpm test:integration       # integration tests vs real PostgreSQL + real WS clients
pnpm test:all               # both suites
pnpm format                 # Prettier
pnpm prisma:validate        # validate prisma/schema.prisma
pnpm prisma:generate        # generate the Prisma client
pnpm prisma:migrate         # create/apply a dev migration (needs db:up)
```

## Production container (Phase 9.1)

The backend ships as a minimal non-root image (`node dist/server.js`,
`Dockerfile` multi-stage: toolchain + compile in build, prod-deps +
`dist/` only at runtime). One app container plus Postgres/Redis via
`docker-compose.prod.yml` (isolated `livepulse-prod` project; host ports
3100/5434/6381 on 127.0.0.1 so the dev stack on 3000/5433/6380 is
untouched; services talk over `postgres`/`redis` hostnames).

```bash
export POSTGRES_PASSWORD="<local-only, URL-safe, never committed>"
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
# fresh volume only, once (container never migrates on boot):
DATABASE_URL="postgresql://livepulse:<password>@127.0.0.1:5434/livepulse" \
  pnpm exec prisma migrate deploy
curl -s http://127.0.0.1:3100/health   # → {"status":"ok"}
```

Full design, migration workflow, verification log and limits:
`docs/architecture/production.md`. Single instance only — Nginx, replicas,
TLS and auth arrive in later phases.

Phase 9.2 adds Nginx (`nginx/nginx.conf`, single upstream, no balancing)
as the operator entrypoint on 127.0.0.1:3200; it proxies both HTTP and
the raw WebSocket upgrade (verified: session create/GET plus
`session.join` → `session.joined` through the proxy; plain `GET /ws`
still 426). Direct app access on :3100 stays for comparison.

Phase 9.3 runs two instances (`app-1`/`app-2`, pinned `ws-a`/`ws-b`,
round-robin, no stickiness): teacher on one instance and student on the
other exchange question/answer/doubt/presence events across instances via
Redis, with PG recovery on rejoin (placement verified per-connection via
an `X-Upstream-App` header, never assumed).

Phase 9.5 adds `GET /ready` (200 iff PostgreSQL answers; Redis reports
`ok`/`degraded` without flipping the code; PG down → 503 while
`/health` stays 200). Phase 9.6 drains planned stops: SIGTERM flips
`/ready` to 503 `draining:true`, refuses new WebSockets, keeps existing
ones until `DRAIN_TIMEOUT_MS` (10 s), then closes politely (1001) —
SIGKILL stays abrupt (1006, ~200 ms) for catastrophic loss.

## Health check

```bash
curl -s http://localhost:3000/health
# → {"status":"ok"}
```

Liveness only — it deliberately does not check PostgreSQL or Redis.

## Metrics

```bash
curl -s http://localhost:3000/metrics | head
# → # HELP livepulse_ws_connections_active Current live WebSocket connections on this instance
#   # TYPE livepulse_ws_connections_active gauge
#   livepulse_ws_connections_active 2
```

Prometheus text exposition, per instance, no authentication (Phase 7), and no
PostgreSQL/Redis dependency in the scrape path. Set `METRICS_ENABLED=false` to
disable the endpoint (it then answers 404).

## WebSocket smoke test

```bash
node -e '
const WebSocket = require("ws"); // pnpm exec node, or use an .mjs script
const ws = new WebSocket("ws://localhost:3000/ws");
ws.on("open", () => ws.send(JSON.stringify({ type: "session.join", requestId: "r1", payload: { sessionId: "<uuid>" } })));
ws.on("message", (m) => console.log(m.toString()));
'
```

A plain HTTP request gets the documented response:

```bash
curl -s http://localhost:3000/ws
# → {"statusCode":426,"error":"Upgrade Required",...}
```

## Documentation

- `docs/architecture/overview.md` — what is actually implemented, per component
- `docs/architecture/websocket-architecture.md` — WS topology, lifecycle, heartbeat, registry
- `docs/api/http-api.md` — implemented endpoints, validation, error cases
- `docs/api/websocket-protocol.md` — envelope, events, error codes, limits
- `docs/database/schema.md` — entities, lifecycles, constraints, indexes
- `docs/testing/websocket-testing.md` — how the WS layer is tested
- `docs/testing/concurrency.md` — how the one-winner race is demonstrated
- `docs/architecture/distributed-websockets.md` — Phase 4 horizontal scaling
  (design + implemented boundary)
- `docs/architecture/recovery.md` — Phase 5 reconnect & recovery (design +
  snapshot contract + guarantees/limitations)
- `docs/architecture/doubt-queue.md` — Phase 6 doubt queue (ordering contract,
  events, concurrency, recovery integration)
- `docs/architecture/presence.md` — Phase 7 presence (exact definition,
  multi-connection rule, digest/staleness, guarantees, Redis failure behavior)
- `docs/architecture/observability.md` — Phase 7 metrics catalogue (types,
  buckets, label-cardinality rules, `/metrics` contract, logging policy)
- `docs/testing/recovery.md` — how recovery is tested (scenarios R1–R11)
- `docs/testing/doubt-queue.md` — how the doubt queue is tested (scenarios Q1–Q13)
- `docs/testing/presence.md` — how presence is tested (unit + P1–P13)
- `docs/testing/observability.md` — how observability is tested (unit + O1–O11)
- `docs/decisions/` — architecture decision records (ADR-001–009)
- `AGENT.md` — engineering principles, phase plan, honesty rules
