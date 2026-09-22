# ADR-001: Project Foundation — TypeScript, Node.js, Fastify, PostgreSQL, Redis, raw ws, Modular Monolith

- **Status:** Accepted
- **Date:** 2026-09-22
- **Phase:** 0 (bootstrap) — ADR covers foundation choices made at project start

## Context

LivePulse is a real-time classroom infrastructure project: live quizzes with
"first correct answer wins" semantics, a doubt queue with defined ordering,
presence, reconnection with state recovery, and horizontal scaling across
multiple WebSocket instances. The system must demonstrate genuine engineering
depth (concurrency, ordering, failure recovery, observability, measurement) in
a deliberately small scope. The foundation had to be chosen once, up front,
because nearly every later decision (state storage, event propagation,
testing strategy) builds on it.

Constraints from AGENT.md:

- correctness > data consistency > explicit failure handling > simplicity >
  measurable performance > feature velocity (in that priority order)
- no technology accumulation; every tool must justify itself (§18)
- the system must survive and demonstrate multi-instance operation later, but
  must start correct and simple (§16: single instance first)

## Options

**Language/runtime:** TypeScript+Node.js vs Go vs Java/Spring vs Python/FastAPI.
**HTTP framework:** Fastify vs Express vs NestJS vs raw `node:http`.
**Primary datastore:** PostgreSQL vs MongoDB vs MySQL.
**Ephemeral/coordination layer:** Redis vs in-process memory only vs Kafka.
**WebSocket layer:** raw `ws` vs Socket.IO vs uWebSockets.js.
**Process topology:** modular monolith (single deployable) vs microservices from day one.

## Decision

1. **TypeScript on Node.js** (strict mode, ESM), **Fastify**, **PostgreSQL via
   Prisma**, **Redis**, **raw `ws`** (not Socket.IO), starting as a **modular
   monolith**.
2. Configuration is validated with **Zod** at process start and is **fail-fast**.
3. Logging is **Pino** (structured JSON; pretty transport in development).
4. Tests use **Vitest**; load tests (later phases) will use **k6**.
5. Local infrastructure via **Docker Compose** (PostgreSQL + Redis only, for now).

## Why

- **Why TypeScript:** real-time state machines (quiz state, presence, queue
  ordering) accumulate subtle state-shape bugs; the compile-time type system
  catches whole classes of them before runtime. The same language on client
  and server keeps the future WS event protocol contract (§13) defined once.
  Shared Zod schemas give runtime validation and static types from one source.
- **Why Node.js:** the workload is overwhelmingly I/O-bound — thousands of
  mostly-idle WebSocket connections, small JSON messages, occasional DB/Redis
  round-trips. Node's event loop is well suited to this; CPU-bound work is not
  part of the core problem. The WebSocket ecosystem (`ws`) is first-class.
- **Why Fastify:** schema-friendly routing with low overhead, first-class
  lifecycle hooks (`onClose` drives graceful shutdown of Prisma today), plugin
  encapsulation that maps cleanly to the modular-monolith structure, native
  logger integration with Pino. Express lacks built-in schema validation and
  its lifecycle story is weaker; NestJS adds a framework layer this project
  does not need; raw `node:http` would mean rebuilding routing, validation and
  shutdown semantics by hand.
- **Why PostgreSQL:** the system needs durable, consistent business data —
  answers, winners, session state, doubts. "First correct answer wins" (§5)
  must be atomic under concurrent writes; PostgreSQL gives both a uniqueness
  constraint path and transactional isolation to solve it correctly, and
  remains the **source of truth** while Redis stays ephemeral (§3, §15).
  MongoDB's weaker consistency guarantees are the wrong trade for winner
  election and ordering guarantees the project must demonstrate.
- **Why Redis:** three distinct jobs, none of which PostgreSQL serves well:
  (a) atomic operations with TTL (`SET NX` winner election), (b) ephemeral
  session/presence state, (c) Pub/Sub for instance-to-instance event
  propagation once there is more than one WS server (§8). All of these are
  reconstructible or transient by design — Redis is explicitly _not_ a second
  source of truth.
- **Why raw `ws`:** the point of the project is to understand the WebSocket
  layer — handshakes, heartbeats, backpressure, close codes, reconnect
  semantics. Socket.IO would hide exactly the problems this project exists to
  solve (it also imposes its own framing protocol, which would make the
  explicit protocol design in §13 harder to defend in an interview). The cost
  (building reconnect/heartbeat/rooms ourselves) is the curriculum, not an
  overhead.
- **Why a modular monolith first:** §16's phase order requires correct
  single-instance behavior before any distribution. A modular monolith keeps
  deployment, testing and debugging trivial while module boundaries
  (`src/modules/*`) preserve the option to extract services later _if_ a
  concrete requirement appears. Microservices from day one would add network
  failures, distributed transactions and operational burden to a system that
  has not yet proven its core state transitions are right. The multi-instance
  requirement (§8) is satisfied by running _multiple instances of the same
  monolith_ behind Nginx later — no service split needed.

## Trade-offs

- **Node.js single-threaded event loop:** one CPU-bound task (e.g., JSON
  parsing storms at extreme scale) can starve all connections. Mitigation for
  later phases: measurement first (Phase 10), clustering/worker threads only
  if numbers demand it. Accepted because the workload is I/O-bound.
- **raw `ws`:** no automatic reconnection, heartbeats, rooms or fallbacks —
  we build and therefore own all of it. This is deliberate (see Why).
- **Prisma:** adds a query-engine layer with its own connection pooling
  behavior; some advanced SQL is harder to express. Accepted for type-safe
  data access and migrations; raw SQL remains available via `$queryRaw` if a
  specific access pattern demands it.
- **Redis Pub/Sub (later phase):** fire-and-forget delivery — no persistence,
  no delivery guarantee to a briefly-disconnected subscriber. Known limitation
  to be documented when implemented (§8 explicitly requires this honesty).
- **Modular monolith:** module boundaries require discipline; nothing forces
  `modules/quiz` from reaching into `modules/doubts` internals. Mitigation:
  enforce boundaries via import rules if violations appear.
- **Zod parse-once config:** misconfiguration kills the process at boot. This
  is the intended behavior (explicit failure handling beats silent defaults).

## Consequences

**Easier:**

- One deployable, one process model, one test strategy for now; the phase
  order (§16) can proceed without distributed-systems debugging noise.
- Atomic winner election has two clean implementation paths (PostgreSQL
  constraint + transaction, or Redis `SET NX`) to be compared in a dedicated
  ADR when Phase 4 arrives.
- Event protocol (§13) can be defined once with Zod schemas shared between
  HTTP and WS layers.
- Type-safe DB access and reproducible migrations via Prisma.

**Harder:**

- Multi-instance event propagation is _our_ responsibility (Redis Pub/Sub)
  with no framework safety net.
- Reconnect/recovery state reconstruction must be designed explicitly —
  connection state (ephemeral, per-socket) vs session state (per-connection
  lifetime) vs durable state (PostgreSQL) are distinct layers we maintain.
- Any future CPU-bound feature will need an explicit offloading strategy.

**Deferred decisions recorded here:** Nginx, Prometheus/Grafana, multiple
backend instances, k6 — intentionally **not** adopted yet; each arrives with
its phase (§16) and its own ADR when justified.
