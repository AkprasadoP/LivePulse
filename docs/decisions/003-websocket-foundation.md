# ADR-003: WebSocket Foundation — Raw ws, Shared HTTP Server, Ephemeral Registry

- **Status:** Accepted (Phase 2)
- **Date:** 2026-09-22
- **Supersedes:** none
- **Related:** ADR-001 (foundation), ADR-002 (domain schema),
  `docs/architecture/websocket-architecture.md`, `docs/api/websocket-protocol.md`

## Context

Phase 2 must add a real WebSocket layer to the Phase 1 Fastify application
without any distributed machinery: single instance, single process, no Redis,
no identity. The layer must establish a correct connection lifecycle,
protocol validation, heartbeat liveness, and cleanup — the substrate that
Phases 3–8 (live quiz, concurrency, Redis, multi-instance, recovery) will
build on. Wrong lifecycle decisions here become outages later.

## Options

**Integration approach**

1. Separate HTTP server on a second port for WebSockets.
2. Share Fastify's HTTP server and route upgrades ourselves.

**Liveness**

1. Application-level ping/pong protocol messages.
2. WebSocket protocol-level ping/pong (`ws` built-ins).

**Join semantics when a connection joins another session**

1. Reject the second join.
2. Deterministic leave-then-join.

**Where connection→session association lives**

1. PostgreSQL (a `ws_connections`-style table).
2. In-memory registry.

## Decision

1. **Share Fastify's HTTP server** (`noServer: true` + our own `'upgrade'`
   listener). One port, one process. The WebSocket layer attaches before
   `listen` and tears down in a Fastify `preClose` hook.
2. **Protocol-level ping/pong** (server pings on `WS_HEARTBEAT_INTERVAL_MS`,
   one missed pong ⇒ terminate). No application bandwidth wasted on liveness
   frames.
3. **leave-then-join** for session switching; re-joining the same session is
   refused with `SESSION_ALREADY_JOINED`.
4. **In-memory, ephemeral registry** (`sessionId → Set<Connection>`). The
   WebSocket layer only _reads_ session state from PostgreSQL and writes
   nothing to it.

## Why

- (1) Clients get one origin/port; lifecycle is unified — Fastify's
  `preClose` runs our teardown before `server.close()`, which would otherwise
  deadlock on open upgraded sockets (verified by a test that reproduces
  exactly this).
- (2) The WebSocket protocol already defines ping/pong; inventing an
  application-level heartbeat would duplicate it and consume protocol
  bandwidth. A missed pong is the only reliable signal that a half-open peer
  is gone.
- (3) Rejecting a switch forces clients to close/reopen to move on — pure
  friction. Silent refusal of duplicate same-session joins, on the other
  hand, catches buggy client loops instead of silently churning state.
- (4) Connection association is per-socket ephemeral state with a process
  lifetime; storing it in PostgreSQL would write a row on every connection,
  need TTL/GC logic for crashed sockets, and imply durability the data does
  not have. PostgreSQL remains the source of truth for _sessions_; the
  registry only accelerates delivery.

## Trade-offs

- Single instance: every connection lives in one process's memory. Restart
  drops all sockets (clients must reconnect); no horizontal scale yet — that
  is the explicit, staged goal of Phases 5–6.
- The ephemeral registry cannot answer "who was connected yesterday". It is
  not an audit log and must never grow business meaning.
- Upgrades we refuse destroy raw TCP sockets; clients see abrupt failures,
  not tidy HTTP errors (there is no HTTP response in the upgrade path —
  this is inherent to the protocol).
- `preClose` closes sockets with code 1001 before HTTP draining finishes;
  in-flight HTTP requests still complete, but WS peers get no per-socket
  "finish your business" grace period. Acceptable: there is no client work
  to protect yet.

## Consequences

- Phase 3 (live quiz) can broadcast by iterating
  `registry.getConnectionsForSession(sessionId)`.
- Phase 5/6 (Redis, multi-instance) will replace local iteration with
  Pub/Sub fan-out; the registry's shape (`sessionId → connections`) is
  exactly what a per-instance Pub/Sub subscriber needs.
- Phase 7 (reconnect) will need client identity (auth phase) and a resume
  contract; nothing here blocks it.
- Testing relies on real sockets over real ports (`PORT=0`); `inject()`
  cannot exercise upgrades.

## Explicitly deferred

Redis Pub/Sub, multi-instance deployment, presence broadcasting, dedup of
logical clients, reconnect/recovery protocol, backpressure tuning,
authentication on the upgrade request. Each is a later phase with its own
ADR where warranted.
