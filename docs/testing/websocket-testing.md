# WebSocket Testing — Phase 2

## Approach

Every WebSocket test drives a **real socket** against a really listening
server: `buildApp({ config, listen: true })` on an OS-assigned ephemeral
port (`PORT=0`), real `ws` clients from the `ws` package, and — for
liveness — a raw TCP peer that completes the WebSocket handshake and then
refuses to pong. No socket or Prisma mocks exist anywhere in the suite.

Why not `fastify.inject()`? It never touches TCP, so it cannot exercise
upgrades, framing, heartbeats, or close codes. Session-state assertions use
the real PostgreSQL test database (`livepulse_test`) as in Phase 1.

The shared listening server lives in `tests/integration/helpers.ts`
(`startListeningServer`, `connectWsClient`, `WsTestClient`). Suites run
sequentially in one fork (`vitest.integration.config.ts`).

## Coverage

### `tests/unit/protocol.test.ts` (11 tests)

Envelope schema (type/requestId/payload limits), event dispatch table,
case sensitivity, UUID payload schema, message factories, `requestId: null`
for server-initiated events, `payload.`-prefixed issue paths.

### `tests/unit/session-registry.test.ts` (7 tests)

Join/leave/switch, empty-bucket pruning, idempotent removal, independent
per-session counting, snapshot semantics for the heartbeat sweeper.

### `tests/integration/ws-connection.test.ts` (6 tests)

- Real upgrade at `/ws` succeeds.
- Plain HTTP `GET /ws` → 426 with the standard error body.
- Unknown upgrade path → TCP destroyed pre-handshake (client sees a
  transport error, never a 101).
- Three connections to one session tracked independently; leave removes
  exactly one member; close removes the socket from all registries.
- Graceful shutdown with open sockets: every client observes close code
  1001 and the registry ends empty (this test guards the `preClose`
  ordering that prevents the `server.close()` upgrade-socket deadlock).

### `tests/integration/ws-protocol.test.ts` (11 tests)

Malformed JSON → `INVALID_MESSAGE` (requestId null, socket stays usable);
non-object frames; missing `type` → `INVALID_REQUEST` with echoed
requestId; invalid `requestId` variants → requestId null; non-UUID
`payload.sessionId` → `INVALID_SESSION_ID` with `payload.sessionId` issue
path; unknown payload fields rejected (strict payloads); unknown event →
`UNSUPPORTED_EVENT`; opaque/Unicode requestIds echoed verbatim; garbage on
one connection leaves others healthy; 80 KiB frame → close 1009;
request/response correlation across sequential messages.

### `tests/integration/ws-session.test.ts` (8 tests)

Join → `session.joined` + authoritative `session.state` (CREATED and LIVE
variants read from real PostgreSQL rows); nonexistent session →
`SESSION_NOT_FOUND` and no registry mutation; duplicate join →
`SESSION_ALREADY_JOINED` with unchanged counts; deterministic A→B switch;
leave detaches but keeps the socket open; five connections counted
independently (connection-keyed, no dedup); heartbeat: server pings arrive,
a non-ponging raw TCP peer is terminated by the sweep while a healthy
client survives, registry drains to the healthy set.

## Running

```bash
pnpm db:up          # Dockerized PostgreSQL + Redis
pnpm db:test:setup  # one-time: create/migrate livepulse_test
pnpm test:integration
```

## Not covered yet (deliberate)

- Reconnect/recovery semantics (Phase 7).
- Dockerized multi-instance behavior (Phase 6) — cross-instance distribution
  is already covered by `distributed.test.ts` with two independent
  in-process instances; containerized instances + Nginx arrive in Phase 6.
- Load/backpressure behavior (Phase 10, k6).
- Authentication on the upgrade path (auth phase).
