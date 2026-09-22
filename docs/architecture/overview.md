# LivePulse — Architecture Overview

> **Status: Phase 1 — Domain Model + PostgreSQL Persistence.** This document
> describes ONLY what is actually implemented. WebSockets, Redis integration,
> doubt-queue semantics, presence, horizontal scaling, Prometheus/Grafana and
> Nginx are _not implemented_ and are listed as such. Per AGENT.md: never
> document future-state as current-state.

## 1. Current architecture (as implemented)

```
HTTP client (curl / tests)
        │
        ▼
Fastify HTTP server (single Node.js process, TypeScript, ESM)
   ├── GET  /health                        → liveness only: { "status": "ok" }
   ├── POST /sessions                      → session + auto-provisioned TEACHER creator
   ├── GET  /sessions/:sessionId           → session + participants
   ├── POST /sessions/:sessionId/state     → explicit lifecycle transitions
   ├── POST /sessions/:sessionId/quizzes   → quiz + inline ordered questions
   ├── GET  /quizzes/:quizId               → quiz + questions (answers hidden)
   ├── Zod-validated env config (fail-fast) + Zod request validation
   ├── Centralized error mapping (400/404/409/500, consistent body shape)
   ├── Pino structured logging
   └── Modules (domain-specific repositories, no generic abstractions)
        │
        ▼
PostgreSQL 17 (docker-compose, host 5433)  ← durable source of truth
  users · sessions · session_participants · quizzes · questions · answers · doubts
  (migration 20260922090904_init_domain; constraints verified by integration tests)

Redis 7 (docker-compose, host 6380): running but NOT used by the application yet.
```

Single Node.js process. There is **no Nginx, no WebSocket server, no second
instance** — those arrive in Phases 2 and 6.

## 2. Component inventory

| Component                                              | Status             | Notes                                                                           |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------- |
| TypeScript (strict) + Node ESM                         | ✅                 |                                                                                 |
| Fastify HTTP server + graceful shutdown                | ✅                 | `src/app/app.ts`, `src/server.ts`                                               |
| Health endpoint (liveness only)                        | ✅                 | does NOT probe PG/Redis by design                                               |
| Zod env configuration, fail-fast                       | ✅                 | `src/config/`                                                                   |
| Pino structured logging                                | ✅                 | pretty transport in development                                                 |
| Domain schema (7 entities, 5 enums)                    | ✅                 | `prisma/schema.prisma`, ADR-002                                                 |
| Migrations                                             | ✅                 | `20260922090904_init_domain` applied to dev + test DBs                          |
| Session state machine                                  | ✅                 | `CREATED→LIVE→ENDED` (+`CREATED→ENDED`), atomic conditional UPDATE; race-tested |
| Data-access layer                                      | ✅                 | `SessionRepository`, `QuizRepository` — small, domain-specific                  |
| HTTP API (sessions, quizzes)                           | ✅                 | documented in `docs/api/http-api.md`                                            |
| Zod request validation + UUID param guards             | ✅                 | malformed IDs never reach the DB                                                |
| Integration tests vs real PostgreSQL                   | ✅                 | 42 tests incl. DB constraints + concurrency                                     |
| WebSockets (`ws`)                                      | ❌ not implemented | Phase 2                                                                         |
| Quiz/question lifecycle transitions via API            | ❌                 | modeled in schema, driven in Phase 3                                            |
| Answer submission / first-correct-wins                 | ❌                 | Phase 4 (winner election ADR pending)                                           |
| Redis client, Pub/Sub, presence, doubt queue semantics | ❌                 | Phases 5–8                                                                      |
| Nginx, multi-instance, Prometheus, Grafana, k6         | ❌                 | deliberately deferred (§16, §18)                                                |

## 3. Repository layout (Phase 1 additions highlighted)

```
src/
├── app/
│   ├── app.ts                Fastify factory + centralized error mapping
│   └── routes/health.ts
├── config/                   Zod env config + minimal .env loader
├── infrastructure/
│   └── prisma/plugin.ts      PrismaClient from config; disconnect on close
├── modules/
│   ├── sessions/
│   │   ├── session.repository.ts   transactional creator+session; CAS transitions
│   │   ├── session.state.ts        approved transition table
│   │   ├── session.schemas.ts      Zod request schemas
│   │   └── session.routes.ts
│   ├── quizzes/
│   │   ├── quiz.repository.ts      transactional quiz+questions
│   │   ├── quiz.schemas.ts
│   │   ├── quiz.serializer.ts      hides correctAnswer from responses
│   │   └── quiz.routes.ts
│   └── index.ts
├── shared/                   errors.ts (domain errors), types.ts
└── server.ts                 entrypoint: .env → config → listen → signals
prisma/                       schema + migrations (init_domain)
scripts/test-db-setup.mjs     creates livepulse_test + applies migrations
tests/
├── unit/                     config, env loader, app boot (no DB)
└── integration/              real PostgreSQL (livepulse_test), sequential
docs/
├── architecture/overview.md  this file
├── decisions/                ADR-001 (foundation), ADR-002 (domain schema)
├── api/http-api.md           actual implemented endpoints
└── database/schema.md        entities, states, constraints, indexes
load-tests/                   (empty until Phase 10)
```

## 4. Key decisions in force

- **PostgreSQL is the only state store in use.** All durable domain data
  lives there with real constraints (unique memberships, unique question
  positions, unique answer attempts, FK cascades/restricts, enum states) —
  see `docs/database/schema.md`.
- **Identity:** global `users` vs session-scoped `session_participants`
  (role on the participant). Creator auto-provisioned per approved decision;
  replaced by JWT identity in the auth phase.
- **Session lifecycle is enforced, not implied:** transitions are atomic
  conditional updates; concurrent transitions are tested (exactly one
  winner). A DB trigger guard is documented as deferred defense-in-depth.
- **API never leaks answers:** `correctAnswer` is stored but excluded from
  all serialized responses.
- **Error shape is uniform:** `{ statusCode, error, message, details? }`
  from one setErrorHandler; Zod → 400, unknown ID → 404, invalid transition
  or constraint conflict → 409.
- **Fail-fast configuration** and **real-env-wins `.env` loading**
  (unchanged from Phase 0).
- **Non-conflicting local ports:** PostgreSQL 5433, Redis 6380 (host).

## 5. Deferred-by-design (not "missing")

1. WebSocket layer (raw `ws`, Phase 2) — `ws` is installed but unused
2. Quiz/question transitions + question publishing (Phase 3)
3. Answer submission + first-correct-wins election (Phase 4 ADR)
4. Redis: presence, live doubt queue, Pub/Sub (Phases 5–8)
5. Multi-instance + Nginx (Phase 6), reconnect/recovery (Phase 7)
6. Prometheus/Grafana `/metrics` (Phase 9), k6 load tests (Phase 10),
   failure drills (Phase 11)

## 6. How to run what exists today

See `README.md` → Commands. Integration tests require the Dockerized
PostgreSQL (`pnpm db:up` then `pnpm db:test:setup` once).
