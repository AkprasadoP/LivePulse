# LivePulse — Architecture Overview

> **Status: Phase 2 — Single WebSocket Server.** This document describes ONLY
> what is actually implemented. Redis Pub/Sub, multiple WebSocket instances,
> presence broadcasting, reconnect/recovery, doubt-queue semantics,
> Prometheus/Grafana and Nginx are _not implemented_ and are listed as such.
> Per AGENT.md: never document future-state as current-state.

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
   │     session.join / session.leave      → session.joined / session.state / error
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
  (migration 20260922090904_init_domain; constraints verified by integration tests)
  The WebSocket layer READS session state; it never writes or duplicates it.

Redis 7 (docker-compose, host 6380): running but NOT used by the application yet.
```

Single Node.js process, single port for HTTP + WS. There is **no Nginx, no
second instance, no Redis usage** — those arrive in Phases 5–6.

## 2. Component inventory

| Component                                              | Status | Notes                                                                           |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------- |
| TypeScript (strict) + Node ESM                         | ✅     |                                                                                 |
| Fastify HTTP server + graceful shutdown                | ✅     | `src/app/app.ts`, `src/server.ts`                                               |
| Health endpoint (liveness only)                        | ✅     | does NOT probe PG/Redis by design                                               |
| Zod env configuration, fail-fast                       | ✅     | `src/config/` incl. `WS_HEARTBEAT_INTERVAL_MS`                                  |
| Pino structured logging                                | ✅     | pretty transport in development                                                 |
| Domain schema (7 entities, 5 enums)                    | ✅     | `prisma/schema.prisma`, ADR-002                                                 |
| Migrations                                             | ✅     | `20260922090904_init_domain` applied to dev + test DBs                          |
| Session state machine                                  | ✅     | `CREATED→LIVE→ENDED` (+`CREATED→ENDED`), atomic conditional UPDATE; race-tested |
| Data-access layer                                      | ✅     | `SessionRepository`, `QuizRepository` — small, domain-specific                  |
| HTTP API (sessions, quizzes)                           | ✅     | documented in `docs/api/http-api.md`                                            |
| Zod request validation + UUID param guards             | ✅     | malformed IDs never reach the DB                                                |
| WebSocket server (raw `ws`) on the shared HTTP server  | ✅     | `src/ws/`; upgrade routing, 64 KiB frame cap, 426 for plain HTTP `/ws`          |
| WS protocol (envelope + Zod schemas + error codes)     | ✅     | documented in `docs/api/websocket-protocol.md`                                  |
| `session.join` / `session.leave` / state push          | ✅     | reads session state from PostgreSQL; no participants created                    |
| In-memory SessionRegistry (ephemeral)                  | ✅     | `sessionId → Set<Connection>`; connection-keyed, no dedup (by design)           |
| Heartbeat liveness (ping/pong + sweep)                 | ✅     | one missed pong ⇒ terminate; default 30 s                                       |
| WS integration tests over real sockets                 | ✅     | 25 tests: lifecycle, protocol, session behavior, heartbeat, shutdown            |
| Integration tests vs real PostgreSQL                   | ✅     | 42 Phase 1 tests (API flows, DB constraints, concurrency)                       |
| Quiz/question lifecycle transitions via API            | ❌     | modeled in schema, driven in Phase 3                                            |
| Answer submission / first-correct-wins                 | ❌     | Phase 4 (winner election ADR pending)                                           |
| WS: quiz events, presence, reconnect/recovery          | ❌     | Phases 3, 7                                                                     |
| Redis client, Pub/Sub, presence, doubt queue semantics | ❌     | Phases 5–8                                                                      |
| Nginx, multi-instance, Prometheus, Grafana, k6         | ❌     | deliberately deferred (§16, §18)                                                |

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
│   ├── quizzes/…             repository, schemas, serializer, routes     (Phase 1)
│   └── index.ts
├── ws/                                                            (Phase 2)
│   ├── ws.plugin.ts          attach(): upgrade routing, lifecycle, heartbeat, shutdown
│   ├── protocol.ts           envelope + event Zod schemas, message factories
│   ├── handlers.ts           session.join / session.leave handlers, error mapping
│   ├── session-registry.ts   sessionId → Set<Connection> (ephemeral)
│   ├── connection.ts         per-socket state record
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
├── decisions/                ADR-001 (foundation), ADR-002 (domain), ADR-003 (WS foundation)
├── api/                      http-api.md, websocket-protocol.md
├── database/schema.md        entities, states, constraints, indexes
└── testing/websocket-testing.md
load-tests/                   (empty until Phase 10)
```

## 4. Key decisions in force

- **PostgreSQL is the only state store in use.** All durable domain data
  lives there with real constraints (unique memberships, unique question
  positions, unique answer attempts, FK cascades/restricts, enum states) —
  see `docs/database/schema.md`.
- **WebSocket layer is read-only against PostgreSQL** (Phase 2 constraint):
  it reads session state, never mutates it, never duplicates the state
  machine, and stores nothing about connections in the database.
- **Connection state is ephemeral and connection-keyed** (ADR-003): at most
  one session per connection; join-switch = leave-then-join; duplicate joins
  refused; no client dedup (no identity exists).
- **Liveness is protocol-level ping/pong** with a one-interval grace, then
  terminate (ADR-003).
- **Shutdown ordering:** Fastify `preClose` closes all sockets (1001) before
  `server.close()` — otherwise upgraded sockets deadlock the close (covered
  by a dedicated test).
- **Identity:** global `users` vs session-scoped `session_participants`
  (role on the participant). Creator auto-provisioned per approved decision;
  replaced by JWT identity in the auth phase.
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

1. Quiz/question transitions + question publishing (Phase 3) — WS stays
   join/state-only until then
2. Answer submission + first-correct-wins election (Phase 4 ADR)
3. Redis: presence, live doubt queue, Pub/Sub fan-out (Phases 5–8)
4. Multi-instance + Nginx (Phase 6), reconnect/recovery protocol (Phase 7)
5. WS backpressure tuning (measured in Phase 10, not guessed)
6. Prometheus/Grafana `/metrics` (Phase 9), k6 load tests (Phase 10),
   failure drills (Phase 11)

## 6. How to run what exists today

See `README.md` → Commands. Integration tests require the Dockerized
PostgreSQL (`pnpm db:up` then `pnpm db:test:setup` once). WebSocket tests
connect to real listening sockets on OS-assigned ephemeral ports.
