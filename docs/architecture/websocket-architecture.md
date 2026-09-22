# WebSocket Architecture — Phase 2 (Single Instance)

> Scope: what is actually implemented in this phase. Redis Pub/Sub, multiple
> WebSocket instances, presence broadcasting, and reconnect/recovery are
> **future architecture** (AGENT.md Phases 5–7) and are marked as such.

## 1. Topology

There is exactly ONE application instance.

```
                Client(s)
                   |
            HTTP / WebSocket     (same TCP port)
                   |
          ┌────────▼────────┐
          │     Fastify     │
          │                 │
          │  HTTP routes    │  /health, /sessions, /quizzes, GET /ws (426)
          │       +         │
          │   WS server     │  upgrade routing on the SAME HTTP server
          └────────┬────────┘
                   │
             PostgreSQL     (authoritative session state)
```

Key property: HTTP and WebSocket share Fastify's HTTP server. There is no
second port and no second process. Node's HTTP server emits an `'upgrade'`
event for `Upgrade: websocket` requests; Fastify ignores those events, and
our layer listens for them.

## 2. Upgrade routing

`src/ws/ws.plugin.ts` registers an `'upgrade'` listener on Fastify's server:

- Path `/ws` → `wss.handleUpgrade(...)` completes the 101 handshake and emits
  a `connection` event on our `WebSocketServer` (`noServer: true` — we own
  upgrade routing).
- Any other path → `socket.destroy()` **before** any handshake bytes are sent.
  The client sees a transport-level failure, never a half-open WebSocket.
- Plain HTTP `GET /ws` (no upgrade header) never reaches the upgrade listener;
  a normal Fastify route answers `426 Upgrade Required` (registered in
  `app.ts`, because Fastify rejects routes added after listen).

The `WebSocketServer` is created with `noServer: true` and `maxPayload:
64 KiB`. Frames larger than the limit make `ws` close the socket with code
1009 (message too big).

## 3. Connection lifecycle

```
TCP accept
  ↓
HTTP Upgrade request (GET /ws)
  ↓
upgrade listener: path check
  ├─ wrong path → socket.destroy()            (never a WebSocket)
  └─ /ws → ws handshake (101 Switching Protocols)
             ↓
        'connection' event
             ↓
        Connection state created in the registry
        { socket, joinedSessionId: null, isAlive: true, connectedAt }
             ↓
        message loop: JSON.parse → envelope Zod → event dispatch
             ↓        (per-message errors → protocol `error` frames)
        heartbeat: ping every WS_HEARTBEAT_INTERVAL_MS, sweep dead peers
             ↓
        close (client- or server-initiated)
             ↓
        'close' event → registry.removeConnection() → cleanup done
```

Failure handling rules:

- A malformed message never closes the socket (except the 64 KiB limit) and
  never crashes the process — the pipeline catches everything and answers
  with the `error` envelope.
- Socket errors are logged (Pino); `close` always performs cleanup, whether
  the close was clean (1000/1001) or abrupt (1006).
- A `preClose` Fastify hook runs the WS teardown **before** Fastify closes
  the HTTP server — required, because `server.close()` waits for open
  upgraded TCP sockets and would otherwise deadlock (documented in ADR-003).

## 4. Connection state vs session state vs durable state

| Kind                   | Lives in                           | Survives restart? | Examples                                                   |
| ---------------------- | ---------------------------------- | ----------------- | ---------------------------------------------------------- |
| Connection state       | process memory (`SessionRegistry`) | **no**            | socket handle, `joinedSessionId`, `isAlive`, `connectedAt` |
| Session state          | PostgreSQL (`sessions.state`)      | **yes**           | `CREATED / LIVE / ENDED`, timestamps                       |
| Durable business state | PostgreSQL                         | **yes**           | participants, quizzes, questions, answers, doubts          |

The registry is deliberately ephemeral: it maps `sessionId → Set<Connection>`
so the server can deliver frames to everyone watching a session. It holds **no
business data**, is keyed by connection (no identity exists yet), and a
restart simply means every client re-joins. PostgreSQL is never written by
the WebSocket layer in this phase — it only reads sessions.

## 5. Heartbeat design

- One `setInterval` per process (default 30 s, `WS_HEARTBEAT_INTERVAL_MS`),
  `unref()`ed so it cannot keep the process alive on its own.
- Each tick: connections already marked `isAlive: false` are dead (they
  missed a full interval's pong) → `socket.terminate()`; everyone else is
  set `isAlive: false` and pinged.
- Each socket's `'pong'` handler sets its connection's `isAlive: true`.
- A dead socket therefore survives at most one full interval after missing
  its pong. Terminated sockets emit `'close'` → standard registry cleanup.
- Termination (not graceful close) is intentional: there is nothing to
  negotiate with a peer that is not answering.

This detects OS-level/half-open dead peers (crashed laptops, dropped NAT
entries) that clean TCP closes never report. It does **not** solve
application-level reconnect/recovery — that is Phase 7.

## 6. Session association rules

- A connection joins at most one session (`joinedSessionId`).
- `session.join(B)` while joined to A: deterministic **leave A, join B**
  (chosen over rejecting, so a client landing on the wrong session can
  recover without closing the socket — ADR-003).
- `session.join(A)` while already joined to A: `error`
  `SESSION_ALREADY_JOINED` (refused, no state change) so a buggy client loop
  cannot churn the registry.
- `session.leave` detaches from the registry but keeps the socket open.
- Connections are NOT deduplicated: two sockets from the same client are two
  registry entries. Identity does not exist yet; deduplication without it
  would be guesswork (deliberate, documented behavior).

## 7. Observability

Structured Pino events, all at the connection/registry level — never payload
contents, never connection strings or future credentials:

| Event                       | Level | Fields                                            |
| --------------------------- | ----- | ------------------------------------------------- |
| connection opened           | info  | `remoteAddress`                                   |
| session joined              | info  | `sessionId` (+ `previousSessionId` on switch)     |
| session left                | info  | `sessionId`                                       |
| connection closed           | info  | `code`, `reason`                                  |
| protocol error              | warn  | event type / issue count / code (no raw payloads) |
| heartbeat cleanup           | info  | `connectedAt` of the terminated connection        |
| send failure / socket error | warn  | error message only                                |
| unexpected handler fault    | error | full error object server-side                     |

## 8. What is deliberately NOT here (future architecture)

- **Redis Pub/Sub / multi-instance fan-out** — Phase 5–6. This registry is
  process-local; a second instance would not see its sessions.
- **Presence broadcasting** — Phase 3+. The registry already knows who is
  connected; announcing it to everyone is a later, deliberate step.
- **Reconnect/recovery** — Phase 7. A dropped socket loses nothing durable
  (nothing was written), but there is no resume/session-replay protocol yet.
- **Backpressure strategy** — `ws` buffers sends; at Phase 10 (load testing)
  we will measure and decide between per-socket bufferedAmount limits,
  draining, or disconnect policies. No premature tuning.
