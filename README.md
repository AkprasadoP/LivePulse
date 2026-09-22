# LivePulse

Real-time classroom infrastructure: live quizzes with first-correct-answer-wins
semantics, a doubt queue with defined ordering guarantees, presence, and
reconnection with server-side state recovery.

**Engineering principles, phase plan and honesty rules live in `AGENT.md`.**
Architecture: `docs/architecture/overview.md` · API: `docs/api/http-api.md` ·
Schema: `docs/database/schema.md` · Decisions: `docs/decisions/`.

## Current implementation status

**Phase 1 — Domain Model + PostgreSQL Persistence** (complete):

- Typed Fastify HTTP server with fail-fast Zod configuration, Pino logging,
  graceful shutdown and liveness-only `/health`
- Domain schema in PostgreSQL: `users`, `sessions`, `session_participants`,
  `quizzes`, `questions`, `answers`, `doubts` — with real constraints
  (unique memberships, unique question positions, unique answer attempts,
  FK cascades/restricts, enum states)
- Explicit session lifecycle `CREATED → LIVE → ENDED` (+ cancel before
  live), enforced by race-safe atomic conditional updates
- HTTP API: create/get sessions, session state transitions, create quizzes
  with inline ordered questions, get quiz — Zod-validated, uniform errors
- Vitest suites: unit tests + integration tests against real PostgreSQL
  (API flows, database constraints, concurrent state transitions)

**Not implemented yet** (by design, in phase order): WebSockets, answer
submission and first-correct-wins election, Redis integration, presence,
doubt queue semantics, multi-instance deployment, reconnect recovery,
Prometheus/Grafana, k6 load testing. Do not assume any of this exists.

## Stack (as of Phase 1)

TypeScript (strict, ESM) · Node.js ≥ 22 · Fastify 5 · Prisma + PostgreSQL 17 ·
Zod · Pino · Vitest · Docker Compose (PostgreSQL + Redis).
`ws` is installed but unused until Phase 2. k6, Nginx and
Prometheus/Grafana arrive with their phases.

## Commands

```bash
pnpm install                # install dependencies
pnpm db:up                  # start PostgreSQL (host 5433) + Redis (host 6380)
cp .env.example .env        # then edit if needed
pnpm db:test:setup          # one-time: create livepulse_test + apply migrations
pnpm dev                    # run the server in watch mode
pnpm build && pnpm start    # production-style run (compiles to dist/)
pnpm typecheck              # strict TypeScript check
pnpm test:unit              # unit tests (no database required)
pnpm test:integration       # integration tests vs real PostgreSQL
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

## Documentation

- `docs/architecture/overview.md` — what is actually implemented, per component
- `docs/api/http-api.md` — implemented endpoints, validation, error cases
- `docs/database/schema.md` — entities, lifecycles, constraints, indexes
- `docs/decisions/` — architecture decision records (ADR-001, ADR-002)
- `AGENT.md` — engineering principles, phase plan, honesty rules
