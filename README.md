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

**Phase 2 — Single WebSocket Server** (complete; Phase 1 retained beneath it):

- Everything from Phase 1: typed Fastify HTTP server, fail-fast Zod config,
  Pino logging, graceful shutdown, liveness-only `/health`, the 7-entity
  PostgreSQL domain schema with real constraints, the race-safe session
  state machine, and the session/quiz REST API
- A WebSocket server on raw `ws`, sharing Fastify's HTTP server (one port,
  one process): upgrade routing at `/ws`, 426 for plain HTTP, 64 KiB frame
  cap, unknown upgrade paths destroyed before handshake
- An explicit JSON envelope protocol (validated with Zod): `session.join`
  and `session.leave` client events; `session.joined`, `session.state` and
  a uniform `error` envelope from the server, with `requestId` correlation
- An ephemeral in-memory session registry (connection-keyed, at most one
  session per connection, deterministic leave-then-join switching)
- Heartbeat liveness: server ping/pong every 30 s (configurable), one missed
  pong terminates the connection
- Graceful shutdown closes WebSockets with 1001 before the HTTP server
  stops (Fastify `preClose`)
- Vitest suites: 33 unit tests + 67 integration tests against real
  PostgreSQL and real WebSocket clients (lifecycle, protocol validation,
  session behavior, heartbeat sweep, shutdown)

**Not implemented yet** (by design, in phase order): quiz/question
publishing over WS, answer submission and first-correct-wins election, Redis
integration, presence broadcasting, doubt queue semantics, multi-instance
deployment, reconnect recovery, Prometheus/Grafana, k6 load testing. Do not
assume any of this exists.

## Stack (as of Phase 2)

TypeScript (strict, ESM) · Node.js ≥ 22 · Fastify 5 · `ws` 8 · Prisma +
PostgreSQL 17 · Zod · Pino · Vitest · Docker Compose (PostgreSQL + Redis).
Redis is running but unused until Phase 5. k6, Nginx and
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
- `docs/decisions/` — architecture decision records (ADR-001–003)
- `AGENT.md` — engineering principles, phase plan, honesty rules
