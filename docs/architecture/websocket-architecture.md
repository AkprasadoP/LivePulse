# WebSocket Architecture — Single Instance (Phases 2–3 mechanics)

> Scope: the connection/transport mechanics of the WebSocket layer as built
> in Phases 2–3. Redis Pub/Sub distribution (Phase 4) and reconnect/recovery
> (Phase 5) are **implemented** and documented separately
> (`distributed-websockets.md`, `recovery.md`); this document focuses on the
> per-instance layer they build on. Presence broadcasting remains future work.

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
          │                 │  auth.authenticate + session.join (Phase 10.7), quiz.start,
          │                 │  question.publish/close, quiz.answer + broadcasts
          └────────┬────────┘
                   │
             PostgreSQL     (authoritative state: sessions AND answers)
                   ▲
                   └── one new write path since Phase 3: answer submission
                       (atomic election, ADR-004). Everything else is read-only.
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
        { socket, joinedSessionId: null, isAlive: true, connectedAt,
          participantId: null, participantRole: null, displayName: null }
             ↓
        message loop: JSON.parse → envelope Zod → event dispatch
             ↓        (per-message errors → protocol `error` frames)
        Phase 3 dispatch: session.join may bind a participant; quiz.start /
        question.publish / question.close (TEACHER-guarded) mutate quiz
        state and broadcast; quiz.answer persists + elects (ADR-004) and
        broadcasts verdict + leaderboard to the session registry
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

| Kind                   | Lives in                           | Survives restart? | Examples                                                                                                               |
| ---------------------- | ---------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Connection state       | process memory (`SessionRegistry`) | **no**            | socket handle, `joinedSessionId`, `isAlive`, `connectedAt`, participant binding (`participantId`/`role`/`displayName`) |
| Session state          | PostgreSQL (`sessions.state`)      | **yes**           | `CREATED / LIVE / ENDED`, timestamps                                                                                   |
| Durable business state | PostgreSQL                         | **yes**           | participants, quizzes, questions, answers (incl. winner), doubts                                                       |

The registry is deliberately ephemeral: it maps `sessionId → Set<Connection>`
so the server can deliver frames to everyone watching a session. It holds **no
business data**, is keyed by connection, and a restart simply means every
client re-joins (a re-join re-binds the participant for the authenticated
user by `(sessionId, userId)`).
PostgreSQL is written by the WebSocket layer in exactly one place — the
answer submission transaction (ADR-004) — and read everywhere else; session,
quiz and question state machines are never duplicated in memory.

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
application-level reconnect/recovery — that is handled at the join layer
(`session.joined.recovery`, Phase 5 / ADR-006; see `recovery.md`).

## 6. Session association rules

- A connection joins at most one session (`joinedSessionId`).
- `session.join(B)` while joined to A: deterministic **leave A, join B**
  (chosen over rejecting, so a client landing on the wrong session can
  recover without closing the socket — ADR-003).
- `session.join(A)` while already joined to A: `error`
  `SESSION_ALREADY_JOINED` (refused, no state change) so a buggy client loop
  cannot churn the registry.
- `session.leave` detaches from the registry **and the participant binding**
  (it is session-scoped) but keeps the socket open.
- Connections are NOT deduplicated: two sockets bound to the same
  authenticated user resolve to the SAME participant row but remain two
  independent registry entries (deliberate, documented behavior).

## 6a. Participant binding and broadcasts (Phase 3)

**Identity (Phase 10.7).** The connection first binds an authenticated user
via `auth.authenticate` (access-token verified server-side). `session.join`
then resolves (find-or-create, race-safe via the `(sessionId, userId)` unique
constraint) a `session_participants` row for that user; the connection stores
`{participantId, role, displayName}` read from the database. The role is
`TEACHER` for the session creator, else `STUDENT`. Joining without
authentication stays view-only and binds no participant. `session.join`
rejects any client-supplied `participant`/`userId`/`participantId`/`role`
field — there is no displayName identity path.

**Teacher + answer events.** `quiz.start`, `question.publish` and
`question.close` are TEACHER-guarded, validate against PostgreSQL (session
`LIVE`, quiz `ACTIVE`, legal transitions), mutate through the same
repository conditional-update pattern as the session machine, and broadcast
`quiz.started` / `question.published` / `question.closed` (+ leaderboard
frames) to every connection in the session via the registry.
`question.published` never contains `correctAnswer`.

**Answer path.** `quiz.answer` is the one DB write: it runs the atomic
election transaction (ADR-004) and then sends a targeted `answer.accepted`
to the submitter plus `answer.accepted` + `leaderboard.updated`
broadcasts. Duplicate submissions replay the stored verdict without
re-broadcasting. Leaderboards are derived from answer rows at read time —
no ranking state is cached anywhere.

## 7. Observability

Structured Pino events, all at the connection/registry level — never payload
contents, never connection strings or future credentials:

| Event                                               | Level | Fields                                            |
| --------------------------------------------------- | ----- | ------------------------------------------------- |
| connection opened                                   | info  | `remoteAddress`                                   |
| session joined                                      | info  | `sessionId` (+ `previousSessionId` on switch)     |
| session joined (participant)                        | info  | `sessionId`, `participantId`                      |
| session left                                        | info  | `sessionId`                                       |
| quiz started / question published / question closed | info  | `sessionId`, `quizId`, `questionId`               |
| answer accepted (fresh)                             | info  | `sessionId`, `questionId`, `participantId`        |
| duplicate answer replay                             | info  | `sessionId`, `questionId`, `participantId`        |
| connection closed                                   | info  | `code`, `reason`                                  |
| protocol error                                      | warn  | event type / issue count / code (no raw payloads) |
| heartbeat cleanup                                   | info  | `connectedAt` of the terminated connection        |
| send failure / socket error                         | warn  | error message only                                |
| unexpected handler fault                            | error | full error object server-side                     |

## 8. What is deliberately NOT here (future architecture)

- **Redis Pub/Sub / multi-instance fan-out** — implemented in Phase 4
  (ADR-005, `distributed-websockets.md`). This registry stays process-local;
  cross-instance delivery goes through Redis notices, not registry sharing.
  (The answer election was deliberately placed in PostgreSQL so it did not
  need to move — ADR-004.)
- **Presence broadcasting** — later phase. The registry knows who is
  connected (and now who the participants are); announcing it to everyone is
  a later, deliberate step.
- **Reconnect/recovery** — implemented in Phase 5 (ADR-006) via a PostgreSQL
  snapshot in `session.joined`; see `docs/architecture/recovery.md`. A
  dropped socket loses nothing durable, and reconnecting clients converge to
  authoritative state (missed event frames are not replayed).
- **Backpressure strategy** — `ws` buffers sends; at Phase 10 (load testing)
  we will measure and decide between per-socket bufferedAmount limits,
  draining, or disconnect policies. No premature tuning.
