# LivePulse — Architecture Overview

> **Status: Phase 6 — Doubt Queue (PostgreSQL-enforced ordering).**
> This document describes ONLY what is actually implemented. Presence
> broadcasting, Prometheus/Grafana and Nginx are _not implemented_ and are
> listed as such. Per AGENT.md: never document future-state as current-state.
>
> **Phases 4–6 are implemented:** inter-instance distribution via Redis
> Pub/Sub (post-commit notices only; ADR-005), reconnect recovery via a
> PostgreSQL snapshot in `session.joined` (ADR-006), and the doubt queue with
> server-assigned per-session ordering (ADR-007). Dockerized multi-instance
> compose and failure drills remain deferred.

## 1. Current architecture (as implemented)

```
            Client (HTTP and/or WebSocket)
                    │
             same TCP port, one Node.js process
                    ▼
Fastify server (TypeScript, ESM)
   ├── GET  /health                        → liveness only: { "status": "ok" }
   ├── POST /sessions                      → session + auto-provisioned TEACHER creator
   ├── GET  /sessions/:sessionId           → session + participants
   ├── POST /sessions/:sessionId/state     → explicit lifecycle transitions
   ├── POST /sessions/:sessionId/quizzes   → quiz + inline ordered questions
   ├── GET  /quizzes/:quizId               → quiz + questions (answers hidden)
   ├── GET  /ws (plain HTTP)               → 426 Upgrade Required
   ├── WebSocket upgrade /ws               → raw `ws`, upgrade-routed on the SAME HTTP server
   │     auth.authenticate + session.join (identity from the token) / session.leave
   │       → session.joined carries the Phase 5 recovery snapshot (ADR-006):
   │         quizzes/question/ownAnswer/standings read from PostgreSQL —
   │         convergence on reconnect, NOT event replay
   │     quiz.start / question.publish / question.close (TEACHER-guarded, WS-only)
   │     quiz.answer → atomic persist + first-correct-wins election (ADR-004)
   │     server events: quiz.started, question.published, question.closed,
   │     answer.accepted, leaderboard.updated, session.joined/state, error
   │     Zod-validated envelopes, protocol error codes, requestId correlation
   │     heartbeat ping/pong (30s default) → dead-peer sweep
   │     in-memory SessionRegistry (sessionId → connections) — ephemeral, connection-keyed
   ├── Redis Pub/Sub distribution (Phase 4, ADR-005)
   │     publisher + subscriber connections (node-redis), global channel `livepulse:events`
   │     post-commit event notices {eventId, type, sessionId, originInstanceId, schemaVersion, occurredAt, payload}
   │     receive path read-only: validate → schema-version gate → echo drop → local-interest filter → render frames
   │     at-most-once delivery; Redis failure degrades propagation, never commits (DISTRIBUTION_ENABLED switch)
   ├── Zod-validated env config (fail-fast) + Zod request validation
   ├── Centralized error mapping (400/404/409/500, consistent body shape)
   ├── Pino structured logging (connection/protocol/heartbeat events)
   ├── Graceful shutdown: preClose closes WS (1001) BEFORE server.close()
   └── Modules (domain-specific repositories, no generic abstractions)
                    │
                    ▼
PostgreSQL 17 (docker-compose, host 5433)  ← durable source of truth
  users · sessions · session_participants · quizzes · questions · answers · doubts
  (migrations: 20260922090904_init_domain + 20260922191225_phase3_quiz_and_winner;
  constraints verified by integration tests; two partial unique indexes enforce
  one-winner-per-question and one-published-question-per-quiz)
  The WS layer reads all state and writes exactly one thing: the atomic answer
  election transaction. Session/quiz/question state machines are never duplicated.

Redis 7 (docker-compose, host 6380): Pub/Sub propagation channel only. Never a
source of truth, never a cache; nothing durable depends on it (ADR-005).
```

Two app instances can run concurrently (distinct `INSTANCE_ID`, shared
PostgreSQL + Redis): events commit on one instance and are pushed to the
other's clients via Pub/Sub. There is **no Nginx and no Dockerized
multi-instance compose** — that arrives in Phase 6.

## 2. Component inventory

| Component                                             | Status | Notes                                                                                   |
| ----------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| TypeScript (strict) + Node ESM                        | ✅     |                                                                                         |
| Fastify HTTP server + graceful shutdown               | ✅     | `src/app/app.ts`, `src/server.ts`                                                       |
| Health endpoint (liveness only)                       | ✅     | does NOT probe PG/Redis by design                                                       |     | Zod env configuration, fail-fast                        | ✅  | `src/config/` incl. `WS_HEARTBEAT_INTERVAL_MS`, `INSTANCE_ID`, `DISTRIBUTION_ENABLED`                                      |
| Pino structured logging                               | ✅     | pretty transport in development                                                         |
| Domain schema (7 entities, 5 enums)                   | ✅     | `prisma/schema.prisma`, ADR-002                                                         |
| Migrations                                            | ✅     | `20260922090904_init_domain` applied to dev + test DBs                                  |
| Session state machine                                 | ✅     | `CREATED→LIVE→ENDED` (+`CREATED→ENDED`), atomic conditional UPDATE; race-tested         |
| Data-access layer                                     | ✅     | `SessionRepository`, `QuizRepository` — small, domain-specific                          |
| HTTP API (sessions, quizzes)                          | ✅     | documented in `docs/api/http-api.md`                                                    |
| Zod request validation + UUID param guards            | ✅     | malformed IDs never reach the DB                                                        |
| WebSocket server (raw `ws`) on the shared HTTP server | ✅     | `src/ws/`; upgrade routing, 64 KiB frame cap, 426 for plain HTTP `/ws`                  |
| WS protocol (envelope + Zod schemas + error codes)    | ✅     | documented in `docs/api/websocket-protocol.md`                                          |
| `session.join` / `session.leave` / state push         | ✅     | reads session state from PostgreSQL; participant binding + recovery snapshot            |
| In-memory SessionRegistry (ephemeral)                 | ✅     | `sessionId → Set<Connection>`; connection-keyed, no dedup (by design)                   |
| Heartbeat liveness (ping/pong + sweep)                | ✅     | one missed pong ⇒ terminate; default 30 s                                               |
| WS integration tests over real sockets                | ✅     | 45 tests: lifecycle, protocol, session behavior, heartbeat, shutdown                    |
| Integration tests vs real PostgreSQL                  | ✅     | 91 total incl. WS + distribution (API flows, DB constraints, quiz flow, races)          |
| Quiz/question lifecycle transitions (WS, teacher)     | ✅     | `quiz.start` / `question.publish` / `question.close`; one-open-question DB index        |     | Authenticated identity (token → user → participant)     | ✅  | Phase 10.7/10.9: participant resolved by `(sessionId, userId)`; displayName is presentation (`docs/api/authentication.md`) |
| Answer submission + first-correct-wins election       | ✅     | ADR-004: FOR NO KEY UPDATE + partial unique index; duplicates replay verdicts           |
| Leaderboard (per question, derived from answers)      | ✅     | `leaderboard.updated` broadcasts; no ranking state cached                               |
| Concurrency tests (10/50/100 + mixed races)           | ✅     | exactly one winner on every run — `docs/testing/concurrency.md`                         |
| Redis Pub/Sub distribution (post-commit notices)      | ✅     | ADR-005: global channel, echo-suppressed, at-most-once; degraded mode w/o Redis         |
| Cross-instance integration tests (2 real instances)   | ✅     | `distributed.test.ts`: A–E + cross-instance 20-way race + shutdown regression           |
| Reconnect recovery (`session.joined.recovery`)        | ✅     | ADR-006: PostgreSQL snapshot at join; instance-agnostic; no replay (`recovery.test.ts`) |
| Dockerized multi-instance compose (2 app containers)  | ❌     | later phase (tests spawn independent in-process instances today)                        |
| Presence broadcasting                                 | ❌     | later phase                                                                             |     | Doubt queue (`doubt.create/resolve/dismiss/queue.list`) | ✅  | ADR-007: `enqueueSeq` ordering in PostgreSQL; Redis notification-only                                                      |
| Presence (Redis structures)                           | ❌     | later phase                                                                             |
| Nginx, Prometheus, Grafana, k6                        | ❌     | deliberately deferred (§16, §18)                                                        |

## 3. Repository layout (Phase 2 additions highlighted)

```
src/
├── app/
│   ├── app.ts                Fastify factory, error mapping, GET /ws (426), preClose hook
│   └── routes/health.ts
├── config/                   Zod env config + minimal .env loader (+ WS_HEARTBEAT_INTERVAL_MS)
├── infrastructure/
│   ├── prisma/plugin.ts      PrismaClient from config; disconnect on close
│   └── redis/index.ts        Phase 4: publisher + subscriber connections, capped
│                             backoff reconnect, best-effort publish, safe close
├── modules/
│   ├── sessions/…            repository, state machine, schemas, routes   (Phase 1)
│   ├── quizzes/…             repository, CAS state transitions, schemas   (Phases 1+3)
│   ├── answers/…             AnswerRepository: atomic election transaction (Phase 3)
│   ├── participants/…        ParticipantRepository: find-or-create by (sessionId,userId) (Phase 10.7)
│   ├── doubts/…              DoubtRepository: transactional queue accept + transitions (Phase 6)
│   ├── users/…               UserRepository: user rows (created at auth registration)
│   └── index.ts
├── ws/                                                            (Phases 2+3)
│   ├── ws.plugin.ts          attach(): upgrade routing, lifecycle, heartbeat, shutdown
│   ├── protocol.ts           envelope + event Zod schemas, message factories
│   ├── handlers.ts           session.join/leave, guards, error mapping, dispatch
│   ├── quiz-handlers.ts      quiz.start/publish/close + quiz.answer + broadcasts (Phase 3)
│   ├── recovery.ts           Phase 5: PostgreSQL recovery snapshot for session.join (ADR-006)
│   ├── doubt-handlers.ts     Phase 6: doubt.create/resolve/dismiss/queue.list + broadcasts
│   ├── distribution.ts       Phase 4: event envelope, uuidv7 ids, publisher, receive path
│   ├── session-registry.ts   sessionId → Set<Connection> (ephemeral)
│   ├── connection.ts         per-socket state record (+ participant binding, Phase 3)
│   └── index.ts
├── shared/                   errors.ts (domain errors), types.ts
└── server.ts                 entrypoint: .env → config → buildApp(listen) → signals
prisma/                       schema + migrations (init_domain)
scripts/test-db-setup.mjs     creates livepulse_test + applies migrations
tests/
├── unit/                     config, env loader, app boot, WS protocol, WS registry
└── integration/              real PostgreSQL + REAL WebSocket clients (ephemeral ports)
                              helpers: startListeningServer, WsTestClient, waitFor
docs/
├── architecture/             overview.md, websocket-architecture.md,
│                             distributed-websockets.md (Phase 4 design + implementation),
│                             recovery.md (Phase 5 design + contract)
├── decisions/                ADR-001…006 (foundation, domain, WS foundation,
│                             first-correct-answer, Redis Pub/Sub boundary,
│                             reconnect recovery)
├── api/                      http-api.md, authentication.md, websocket-protocol.md
├── database/schema.md        entities, states, constraints, indexes
└── testing/websocket-testing.md
load-tests/                   (empty until Phase 10)
```

## 4. Key decisions in force

- **PostgreSQL is the only state store in use.** All durable domain data
  lives there with real constraints (unique memberships, unique question
  positions, unique answer attempts, unique winner per question, unique
  displayName, FK cascades/restricts, enum states) — see
  `docs/database/schema.md`.
- **The WebSocket layer writes exactly one thing to PostgreSQL**: the atomic
  answer submission + election transaction (ADR-004). Everything else is
  read-only; state machines are never duplicated in memory.
- **First-correct-answer is elected by the database**, not by application
  sequencing: submissions serialize on the question row lock
  (`FOR NO KEY UPDATE`); the winning INSERT is the election; the partial
  unique index is defense-in-depth. "First" = lock order + commit, not send
  time (ADR-004, protocol doc §7).
- **Connection state is ephemeral and connection-keyed** (ADR-003): at most
  one session per connection; join-switch = leave-then-join; duplicate joins
  refused; two sockets bound to the same authenticated user are not
  deduplicated (deliberate behavior).
- **Liveness is protocol-level ping/pong** with a one-interval grace, then
  terminate (ADR-003).
- **Shutdown ordering:** Fastify `preClose` closes all sockets (1001) before
  `server.close()` — otherwise upgraded sockets deadlock the close (covered
  by a dedicated test).
- **Identity:** global `users` vs session-scoped `session_participants`
  (role on the participant). Phase 10.7: `session.join` binds the participant
  for the connection's authenticated `userId` (find-or-create on
  `(sessionId, userId)`); role and displayName come from the database. No
  client-supplied identity; `displayName` is presentation only.
- **REST vs WS split:** HTTP owns durable/curatorial control-plane operations
  (create session/quiz, move session state); WS owns real-time classroom
  events (quiz start, publish/close, answers, broadcasts) because their
  effect _is_ propagation to every connected client.
- **Session lifecycle is enforced, not implied:** transitions are atomic
  conditional updates; concurrent transitions are tested (exactly one
  winner). A DB trigger guard is documented as deferred defense-in-depth.
- **API never leaks answers:** `correctAnswer` is stored but excluded from
  all serialized responses.
- **Error shapes are uniform:** HTTP `{ statusCode, error, message, details? }`
  and WS `{ type: "error", requestId, payload: { code, message, details } }`,
  each from one central mapper. WS errors never expose internals.
- **Fail-fast configuration** and **real-env-wins `.env` loading**.
- **The doubt queue is PostgreSQL ordering, not a Redis structure** (ADR-007):
  order is `(priority DESC, enqueueSeq ASC)` over OPEN doubts; `enqueueSeq` is
  a per-session sequence assigned inside the accepting transaction under the
  session row lock, so sequence order equals durable acceptance order. Clients
  never set ordering fields; Redis only carries post-commit notices.
- **Reconnect is reconciliation, not replay** (ADR-006): every `session.join`
  returns a `recovery` snapshot read from PostgreSQL (session quizzes, the
  current published/closed question, the bound participant's stored verdict,
  current standings). Missed transient events are never replayed. The
  snapshot is instance-agnostic (any instance serves the same one), never
  touches Redis, and never becomes a second source of truth.
- **Non-conflicting local ports:** PostgreSQL 5433, Redis 6380 (host).

## 5. Deferred-by-design (not "missing")

1. Redis beyond Pub/Sub notices: presence (later phase) — the election and the
   doubt queue deliberately live in PostgreSQL so Redis never owns truth
2. Dockerized multi-instance + Nginx — cross-instance delivery and
   reconnect-to-another-instance recovery are proven with independent
   in-process instances until compose grows app services
3. WS backpressure tuning (measured, not guessed)
4. Prometheus/Grafana `/metrics`, k6 load tests, failure drills
5. Quiz `ACTIVE → COMPLETED` transition (modeled; not exposed — questions
   are the fine-grained surface for now)

## 6. How to run what exists today

See `README.md` → Commands. Integration tests require the Dockerized
PostgreSQL (`pnpm db:up` then `pnpm db:test:setup` once). WebSocket tests
connect to real listening sockets on OS-assigned ephemeral ports.
