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

**Phase 6 — Doubt Queue (PostgreSQL-enforced ordering)** (complete; Phases 1–5
retained beneath it):

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
- Vitest suites: 55 unit tests + 117 integration tests against real
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

**Not implemented yet** (by design, in phase order): Dockerized
multi-instance compose (tests spawn independent in-process instances today),
presence, Prometheus/Grafana, k6 load testing. Do not assume any of this
exists.

## Stack (as of Phase 6)

TypeScript (strict, ESM) · Node.js ≥ 22 · Fastify 5 · `ws` 8 · Prisma +
PostgreSQL 17 · Redis 6 (node-redis, Pub/Sub propagation only) · Zod · Pino ·
Vitest · Docker Compose (PostgreSQL + Redis). k6, Nginx and
Prometheus/Grafana arrive with their phases.

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

## Health check

```bash
curl -s http://localhost:3000/health
# → {"status":"ok"}
```

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
- `docs/testing/recovery.md` — how recovery is tested (scenarios R1–R11)
- `docs/testing/doubt-queue.md` — how the doubt queue is tested (scenarios Q1–Q13)
- `docs/decisions/` — architecture decision records (ADR-001–007)
- `AGENT.md` — engineering principles, phase plan, honesty rules
