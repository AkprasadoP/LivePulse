# LivePulse — Architecture Overview

> **Status: Phase 3 — Live Quiz Execution + Concurrency (single instance).**
> This document describes ONLY what is actually implemented. Redis Pub/Sub,
> multiple WebSocket instances, presence broadcasting, reconnect/recovery,
> doubt-queue semantics, Prometheus/Grafana and Nginx are _not implemented_
> and are listed as such. Per AGENT.md: never document future-state as
> current-state.

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
   │     session.join (+ optional participant identity seam) / session.leave
   │     quiz.start / question.publish / question.close (TEACHER-guarded, WS-only)
   │     quiz.answer → atomic persist + first-correct-wins election (ADR-004)
   │     server events: quiz.started, question.published, question.closed,
   │     answer.accepted, leaderboard.updated, session.joined/state, error
   │     Zod-validated envelopes, protocol error codes, requestId correlation
   │     heartbeat ping/pong (30s default) → dead-peer sweep
   │     in-memory SessionRegistry (sessionId → connections) — ephemeral, connection-keyed
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

Redis 7 (docker-compose, host 6380): running but NOT used by the application yet.
```

Single Node.js process, single port for HTTP + WS. There is **no Nginx, no
second instance, no Redis usage** — those arrive in Phases 5–6.

## 2. Component inventory

| Component                                              | Status | Notes                                                                            |
| ------------------------------------------------------ | ------ | -------------------------------------------------------------------------------- |
| TypeScript (strict) + Node ESM                         | ✅     |                                                                                  |
| Fastify HTTP server + graceful shutdown                | ✅     | `src/app/app.ts`, `src/server.ts`                                                |
| Health endpoint (liveness only)                        | ✅     | does NOT probe PG/Redis by design                                                |
| Zod env configuration, fail-fast                       | ✅     | `src/config/` incl. `WS_HEARTBEAT_INTERVAL_MS`                                   |
| Pino structured logging                                | ✅     | pretty transport in development                                                  |
| Domain schema (7 entities, 5 enums)                    | ✅     | `prisma/schema.prisma`, ADR-002                                                  |
| Migrations                                             | ✅     | `20260922090904_init_domain` applied to dev + test DBs                           |
| Session state machine                                  | ✅     | `CREATED→LIVE→ENDED` (+`CREATED→ENDED`), atomic conditional UPDATE; race-tested  |
| Data-access layer                                      | ✅     | `SessionRepository`, `QuizRepository` — small, domain-specific                   |
| HTTP API (sessions, quizzes)                           | ✅     | documented in `docs/api/http-api.md`                                             |
| Zod request validation + UUID param guards             | ✅     | malformed IDs never reach the DB                                                 |
| WebSocket server (raw `ws`) on the shared HTTP server  | ✅     | `src/ws/`; upgrade routing, 64 KiB frame cap, 426 for plain HTTP `/ws`           |
| WS protocol (envelope + Zod schemas + error codes)     | ✅     | documented in `docs/api/websocket-protocol.md`                                   |
| `session.join` / `session.leave` / state push          | ✅     | reads session state from PostgreSQL; no participants created                     |
| In-memory SessionRegistry (ephemeral)                  | ✅     | `sessionId → Set<Connection>`; connection-keyed, no dedup (by design)            |
| Heartbeat liveness (ping/pong + sweep)                 | ✅     | one missed pong ⇒ terminate; default 30 s                                        |
| WS integration tests over real sockets                 | ✅     | 45 tests: lifecycle, protocol, session behavior, heartbeat, shutdown             |
| Integration tests vs real PostgreSQL                   | ✅     | 83 total incl. WS (API flows, DB constraints, quiz flow, races)                  |
| Quiz/question lifecycle transitions (WS, teacher)      | ✅     | `quiz.start` / `question.publish` / `question.close`; one-open-question DB index |
| Identity seam (displayName → user + participant)       | ✅     | Phase 3, temporary until auth; unique displayName, race-safe find-or-create      |
| Answer submission + first-correct-wins election        | ✅     | ADR-004: FOR NO KEY UPDATE + partial unique index; duplicates replay verdicts    |
| Leaderboard (per question, derived from answers)       | ✅     | `leaderboard.updated` broadcasts; no ranking state cached                        |
| Concurrency tests (10/50/100 + mixed races)            | ✅     | exactly one winner on every run — `docs/testing/concurrency.md`                  |
| Presence broadcasting, reconnect/recovery              | ❌     | later phases (7)                                                                 |
| Redis client, Pub/Sub, presence, doubt queue semantics | ❌     | Phases 5–8                                                                       |
| Nginx, multi-instance, Prometheus, Grafana, k6         | ❌     | deliberately deferred (§16, §18)                                                 |

## 3. Repository layout (Phase 2 additions highlighted)

```
src/
├── app/
│   ├── app.ts                Fastify factory, error mapping, GET /ws (426), preClose hook
│   └── routes/health.ts
├── config/                   Zod env config + minimal .env loader (+ WS_HEARTBEAT_INTERVAL_MS)
├── infrastructure/
│   └── prisma/plugin.ts      PrismaClient from config; disconnect on close
├── modules/
│   ├── sessions/…            repository, state machine, schemas, routes   (Phase 1)
│   ├── quizzes/…             repository, CAS state transitions, schemas   (Phases 1+3)
│   ├── answers/…             AnswerRepository: atomic election transaction (Phase 3)
│   ├── participants/…        ParticipantRepository: find-or-create seam   (Phase 3)
│   ├── users/…               UserRepository: find-or-create by displayName (Phase 3)
│   └── index.ts
├── ws/                                                            (Phases 2+3)
│   ├── ws.plugin.ts          attach(): upgrade routing, lifecycle, heartbeat, shutdown
│   ├── protocol.ts           envelope + event Zod schemas, message factories
│   ├── handlers.ts           session.join/leave, guards, error mapping, dispatch
│   ├── quiz-handlers.ts      quiz.start/publish/close + quiz.answer + broadcasts (Phase 3)
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
├── architecture/             overview.md, websocket-architecture.md
├── decisions/                ADR-001…004 (foundation, domain, WS foundation, first-correct-answer)
├── api/                      http-api.md, websocket-protocol.md
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
  refused; same-identity sockets are not deduplicated (no auth yet).
- **Liveness is protocol-level ping/pong** with a one-interval grace, then
  terminate (ADR-003).
- **Shutdown ordering:** Fastify `preClose` closes all sockets (1001) before
  `server.close()` — otherwise upgraded sockets deadlock the close (covered
  by a dedicated test).
- **Identity:** global `users` vs session-scoped `session_participants`
  (role on the participant). Phase 3 development seam: `session.join` binds a
  participant by unique displayName (find-or-create, race-safe); explicitly
  temporary until JWT auth — the seam is one replaceable code path.
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
- **Non-conflicting local ports:** PostgreSQL 5433, Redis 6380 (host).

## 5. Deferred-by-design (not "missing")

1. Redis: presence, live doubt queue, Pub/Sub fan-out (Phases 5–8) — the
   election deliberately stays in PostgreSQL so Redis need not own it
2. Multi-instance + Nginx (Phase 6), reconnect/recovery protocol (Phase 7)
3. WS backpressure tuning (measured in Phase 10, not guessed)
4. Prometheus/Grafana `/metrics` (Phase 9), k6 load tests (Phase 10),
   failure drills (Phase 11)
5. Quiz `ACTIVE → COMPLETED` transition (modeled; not exposed — questions
   are the fine-grained surface for now)

## 6. How to run what exists today

See `README.md` → Commands. Integration tests require the Dockerized
PostgreSQL (`pnpm db:up` then `pnpm db:test:setup` once). WebSocket tests
connect to real listening sockets on OS-assigned ephemeral ports.
