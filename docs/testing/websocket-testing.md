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

### `tests/integration/ws-measurement.test.ts` (Phase 8.2a measurement correctness)

Focused tests validating the load-test harness measurement invariants:
- Response correlation: only `session.joined` with matching `requestId` counts as a response to `session.join`
- Ignored unrelated frames: `session.state`, `presence.snapshot`, and other broadcasts do not contribute to round-trip latency
- Timeout handling: join requests without a response within the timeout window are counted as timeouts, not fabricated samples
- Incomplete measurements: harness refuses to emit results when sample counts don't match completed operations

## Running

```bash
pnpm db:up          # Dockerized PostgreSQL + Redis
pnpm db:test:setup  # one-time: create/migrate livepulse_test
pnpm test:integration
```

Manual smoke against a running dev server (`pnpm dev` on :3000):

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

## Not covered here (covered elsewhere)

- Reconnect/recovery semantics — covered by `docs/testing/recovery.md`
  (`tests/integration/recovery.test.ts`).
- Dockerized multi-instance behavior — covered by
  `docs/architecture/production.md` (two app containers behind Nginx);
  `distributed.test.ts` covers the same propagation with two independent
  in-process instances.
- Load/backpressure behavior — `load-tests/README.md` (standalone
  harness) and `tests/integration/ws-backpressure.test.ts` (paced
  slow-consumer stages with safety tripwires).
- Upgrade-path authentication — `auth.authenticate` before `session.join`
  (`docs/api/authentication.md`, `tests/integration/ws-auth.test.ts`).

---

## Load-Test Measurement Specification (Phase 8.2a)

### What IS measured

1. **Connection establishment latency** (`ws_connection_duration_ms` / `wsConnectionDurationMs`)
   - Monotonic timestamp at TCP connect → WebSocket `open` event
   - One sample per successfully opened connection
   - Reported separately from message latency

2. **Message round-trip latency** (`ws_message_roundtrip_duration_ms` / `wsMessageRoundtripDurationMs`)
   - Unique `requestId` generated per `session.join` request
   - Start timestamp recorded immediately before `send()`
   - Latency recorded ONLY when matching `session.joined` response arrives with same `requestId`
   - Error responses (`type: "error"`) to the join request also complete the measurement
   - One sample per completed measured operation (join request with response)

3. **Counters tracked separately**
   - `ws_connection_success`: successful WebSocket handshakes
   - `ws_connection_fail`: transport-level failures (pre-open)
   - `ws_connection_timeouts`: join requests that never received a response
   - `ws_protocol_errors`: invalid JSON, invalid envelope, error responses
   - `ws_unexpected_closes`: connections closed with codes other than 1000/1001
   - `ws_messages_received`: all frames received (including broadcasts)
   - `ws_messages_sent`: all frames sent
   - `ws_join_responses_received`: completed measured operations

### What is NOT measured (and why)

- **Open-to-first-frame duration**: This conflates connection establishment with server processing time and is not a request-response latency. Reported separately as connection latency.
- **Unrelated broadcasts**: `session.state`, `presence.snapshot`, `doubt.created`, etc. are counted in `messagesReceived` but do NOT generate latency samples. They are server-initiated events with `requestId: null` and no client request to correlate with.
- **Fabricated samples**: If a join request times out or the connection drops before a response, no latency sample is invented. The measurement is marked invalid if `joinResponsesReceived !== messageRoundtripSamples`.
- **Authentication handshake**: `auth.authenticate` → `auth.authenticated` is a separate measured operation (not included in this scenario).

### Measurement validity

A result is marked `measurement.valid: false` when:
- `connectionDurationSamples !== connectionSuccess` (missing/extra connection samples)
- `messageRoundtripSamples !== joinResponsesReceived` (missing/extra latency samples)
- Any connection/timeouts/protocol errors occurred without corresponding samples

This ensures the reported percentiles (p50, p95, p99) are computed only from valid, complete measurements.
