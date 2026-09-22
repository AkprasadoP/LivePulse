# LivePulse WebSocket Protocol — Phase 2

> Scope: the protocol actually implemented in this phase. It is **not**
> immutable — later phases add events (quiz, doubts, presence) and possibly
> new envelope fields. Additions must be backward-compatible: clients should
> ignore server event types they do not recognize.

## 1. Endpoint

|         |                                                                               |
| ------- | ----------------------------------------------------------------------------- |
| URL     | `ws://<host>:<port>/ws`                                                       |
| Upgrade | HTTP `GET /ws` with `Upgrade: websocket`                                      |
| Auth    | **None in Phase 2.** Sessions identify themselves via `session.join` in-band. |
| Format  | JSON text frames, UTF-8                                                       |

Notes:

- A plain HTTP `GET /ws` (no upgrade) answers `426 Upgrade Required` so
  misdirected HTTP clients get an explanatory status instead of nothing.
- Upgrade requests to any other path are rejected by closing the TCP socket
  before the WebSocket handshake completes.
- Per-message deflate is **disabled** (ws default): compression trades CPU for
  bandwidth; revisit under load tests (Phase 10), not before there is data.

## 2. Envelope

### Client → server

```json
{
  "type": "session.join",
  "requestId": "req-123",
  "payload": {}
}
```

| Field       | Rules                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| `type`      | string, 1–64 chars, must be a known client event                                              |
| `requestId` | string, 1–128 chars. **Opaque.** Required. Echoed back verbatim. Never used as a database ID. |
| `payload`   | object matching the event's schema. Unknown fields rejected.                                  |

### Server → client

```json
{
  "type": "session.joined",
  "requestId": "req-123",
  "payload": {}
}
```

| Field       | Rules                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| `type`      | string                                                                       |
| `requestId` | echoed `requestId` for **responses**; `null` for **server-initiated events** |
| `payload`   | object                                                                       |

## 3. requestId rules

1. Client-generated; the server treats it as an opaque string (no format
   validation beyond length).
2. Every response to a client request echoes the request's `requestId`
   exactly, so the client can correlate.
3. Server-initiated events (no triggering request) carry `requestId: null`.
4. If a message is too malformed to extract a trustworthy `requestId`
   (unparseable JSON, non-object, missing/invalid `requestId` itself), the
   error response carries `requestId: null`.
5. `requestId` is never used as a database identifier, logged as a session
   ID, or assumed unique across clients.

## 4. Client events (Phase 2)

### `session.join`

```json
{
  "type": "session.join",
  "requestId": "req-123",
  "payload": { "sessionId": "018f3c2e-..." }
}
```

`sessionId` must be a UUID (format checked before any database access).

Server behavior, in order:

1. Validate the envelope and payload (Zod).
2. Load the session from PostgreSQL (single `findUnique` — the database is
   the only source of session state).
3. If missing → `error` `SESSION_NOT_FOUND` (no registry mutation).
4. If the connection is already joined to **this** session → `error`
   `SESSION_ALREADY_JOINED` (idempotent-refused; no state change).
5. If the connection is already joined to a **different** session →
   deterministic switch: silently **leave A, then join B**
   (ADR-003 documents this decision).
6. Register the connection in the in-memory registry and send
   `session.joined` + `session.state`.

**No `session_participants` row is created.** Identity/auth does not exist
yet; joining only associates a _connection_ with a session in memory.

### `session.leave`

```json
{
  "type": "session.leave",
  "requestId": "req-124",
  "payload": {}
}
```

Removes the connection from its session's registry (if any). The WebSocket
itself stays open. Leaving when not joined succeeds (idempotent) and still
acks with `session.state` carrying `sessionId: null`.

## 5. Server events (Phase 2)

### `session.joined` (response to `session.join`)

```json
{
  "type": "session.joined",
  "requestId": "req-123",
  "payload": { "sessionId": "...", "state": "LIVE" }
}
```

### `session.state` (authoritative state snapshot)

```json
{
  "type": "session.state",
  "requestId": "req-123 | null",
  "payload": {
    "sessionId": "... | null",
    "state": "CREATED | LIVE | ENDED",
    "startedAt": "2026-09-22T10:00:00.000Z | null",
    "endedAt": "... | null",
    "updatedAt": "2026-09-22T10:00:00.000Z"
  }
}
```

Sent after `session.joined`, after `session.leave` (with
`sessionId: null` — the connection no longer tracks a session), and available
for server-initiated pushes in later phases (hence `requestId: null` support).

### `error` (uniform error envelope)

```json
{
  "type": "error",
  "requestId": "req-123 | null",
  "payload": {
    "code": "SESSION_NOT_FOUND",
    "message": "Session does not exist",
    "details": null | { "issues": [ { "path": "payload.sessionId", "message": "..." } ] }
  }
}
```

## 6. Error codes

| Code                     | Meaning                                                                                                                            | Typical trigger                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `INVALID_MESSAGE`        | The frame is not a JSON object (unparseable JSON, arrays, strings, numbers, `null`).                                               | `"{ not json"`, `"42"`                     |
| `INVALID_REQUEST`        | JSON object recognized but envelope/payload invalid: missing `type`, bad `requestId`, unknown payload fields, wrong payload shape. | `{"type":"session.join","requestId":1}`    |
| `INVALID_SESSION_ID`     | `payload.sessionId` is not a UUID.                                                                                                 | Rejected before any DB access.             |
| `SESSION_NOT_FOUND`      | UUID well-formed but no such session in PostgreSQL.                                                                                | Joining a deleted/unknown session.         |
| `SESSION_ALREADY_JOINED` | Connection re-joined the session it is already in.                                                                                 | Duplicate `session.join` for same session. |
| `UNSUPPORTED_EVENT`      | `type` is a valid string but not a known client event.                                                                             | `{"type":"quiz.answer"}` in Phase 2        |

Rules:

- Errors are protocol-level only. They never include stack traces, Prisma
  errors, SQL text, or other internals. Unexpected server faults are logged
  server-side (Pino) and surfaced to the client as `INTERNAL_ERROR`.
- `details.issues` is populated only for `INVALID_REQUEST` (Zod issue paths)
  to help client developers; never for other codes.

## 7. Limits and lifecycle rules

| Rule                       | Value / behavior                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Max inbound frame size     | 64 KiB. Larger frames are closed by `ws` with code 1009 (`message too big`).                                                       |
| Message processing         | Sequential per connection (async handler ordering); no per-message concurrency.                                                    |
| Heartbeat                  | Server pings every `WS_HEARTBEAT_INTERVAL_MS` (default 30 s, env-configurable). See `docs/architecture/websocket-architecture.md`. |
| One session per connection | A connection joins at most one session at a time; a join to another session performs leave-then-join.                              |
| Leave vs close             | `session.leave` detaches from the registry but keeps the socket open; closing the socket detaches and tears the connection down.   |
| Unknown server events      | Clients must ignore server `type`s they do not know (forward compatibility).                                                       |
| No durable state           | The registry is process memory only. Nothing about connections is stored in PostgreSQL.                                            |

## 8. Worked example

```
C → S: {"type":"session.join","requestId":"r1","payload":{"sessionId":"018f..."}}
S → C: {"type":"session.joined","requestId":"r1","payload":{"sessionId":"018f...","state":"LIVE"}}
S → C: {"type":"session.state","requestId":"r1","payload":{"sessionId":"018f...","state":"LIVE","startedAt":"...","endedAt":null,"updatedAt":"..."}}

C → S: (30+ connections later) {"type":"session.leave","requestId":"r2","payload":{}}
S → C: {"type":"session.state","requestId":"r2","payload":{"sessionId":null,"state":"ENDED",...}}

C → S: "this is not json"
S → C: {"type":"error","requestId":null,"payload":{"code":"INVALID_MESSAGE","message":"Message is not valid JSON"}}

C → S: {"type":"session.join","requestId":"r3","payload":{"sessionId":"nope"}}
S → C: {"type":"error","requestId":"r3","payload":{"code":"INVALID_SESSION_ID","message":"sessionId must be a UUID","details":{"issues":[{"path":"payload.sessionId","message":"..."}]}}}
```
