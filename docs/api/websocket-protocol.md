# LivePulse WebSocket Protocol — Phase 2 + Phase 3

> Scope: the protocol actually implemented through Phase 3 (live quiz
> execution). It is **not** immutable — later phases add events (doubts,
> presence) and possibly new envelope fields. Additions must be
> backward-compatible: clients should ignore server event types they do not
> recognize.

## 1. Endpoint

|         |                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------------------- |
| URL     | `ws://<host>:<port>/ws`                                                                              |
| Upgrade | HTTP `GET /ws` with `Upgrade: websocket`                                                             |
| Auth    | **None.** Identity is the Phase 3 development seam (see `session.join`); real auth is a later phase. |
| Format  | JSON text frames, UTF-8                                                                              |

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

Broadcasts triggered by a request (e.g. `question.published` caused by a
teacher's `question.publish`) echo that request's `requestId` so senders can
correlate their own action; pure server-initiated frames carry `null`.

## 3. requestId rules

1. Client-generated; the server treats it as an opaque string (no format
   validation beyond length).
2. Every response to a client request echoes the request's `requestId`
   exactly, so the client can correlate.
3. Server-initiated events carry `requestId: null`.
4. If a message is too malformed to extract a trustworthy `requestId`
   (unparseable JSON, non-object, missing/invalid `requestId` itself), the
   error response carries `requestId: null`.
5. `requestId` is never used as a database identifier, logged as a session
   ID, or assumed unique across clients.

## 4. Identity seam (Phase 3, temporary)

There is no authentication yet. `session.join` accepts an optional
`participant: { displayName }`:

- **With `participant`** — the server resolves a _stable global user_ by
  `displayName` (unique on `users.displayName`, find-or-create, race-safe)
  and binds a _session participant_ (`session_participants`, unique per
  `(sessionId, userId)`). The role is `TEACHER` when the displayName matches
  the session creator, otherwise `STUDENT`. The binding is stored on the
  in-memory connection and answers/teacher actions are attributed to it.
- **Without `participant`** — view-only join (Phase 2 behavior): the
  connection joins the registry but cannot answer or run the quiz
  (`NOT_A_PARTICIPANT`).

This is an explicitly temporary seam: displayName is a convenient, unique
label, not a credential. Anyone can claim any name. When JWT/auth lands,
`session.join` will carry a token and the binding code is the only thing that
changes; the schema (`users`, `session_participants`) is already auth-shaped.

## 5. Client events

### 5.1 `session.join`

```json
{
  "type": "session.join",
  "requestId": "req-123",
  "payload": {
    "sessionId": "018f3c2e-...",
    "participant": { "displayName": "Student-1" }
  }
}
```

| Field         | Rules                                            |
| ------------- | ------------------------------------------------ |
| `sessionId`   | UUID (format checked before any database access) |
| `participant` | optional; `displayName` 1–50 chars               |

Server behavior, in order:

1. Validate the envelope and payload (Zod).
2. Load the session from PostgreSQL (the database is the only source of
   session state). Missing → `error` `SESSION_NOT_FOUND`.
3. Already joined to **this** session → `error` `SESSION_ALREADY_JOINED`
   (idempotent-refused; no state change).
4. Joined to a **different** session → deterministic switch: **leave A, then
   join B** (ADR-003).
5. If `participant` is present, resolve/create user + participant rows
   (race-safe find-or-create) and bind them to the connection.
6. Register the connection in the in-memory registry; send `session.joined`
   (now including the participant triple, `null` for view-only) and
   `session.state`.

### 5.2 `session.leave`

```json
{ "type": "session.leave", "requestId": "req-124", "payload": {} }
```

Removes the connection from its session's registry (if any) **and detaches
the participant binding** (it is session-scoped). The WebSocket itself stays
open. Idempotent: leaving while not joined still acks with `session.state`
carrying `sessionId: null`.

### 5.3 `quiz.start` (teacher)

```json
{
  "type": "quiz.start",
  "requestId": "q1",
  "payload": { "quizId": "018f..." }
}
```

Requires: joined + bound participant + role `TEACHER` (else `NOT_A_PARTICIPANT` /
`TEACHER_REQUIRED`). The quiz must belong to the joined session (otherwise
`QUIZ_NOT_FOUND` — cross-session resources look "unknown", leaking nothing)
and the session must be `LIVE` (`SESSION_NOT_LIVE`).

State transition: quiz `DRAFT → ACTIVE`. Idempotency: starting an already
`ACTIVE` quiz is refused with `INVALID_STATE_TRANSITION`.

Ack: `quiz.started` (echoing `requestId`) **broadcast to every connection in
the session**.

### 5.4 `question.publish` (teacher)

```json
{
  "type": "question.publish",
  "requestId": "q2",
  "payload": { "questionId": "018f..." }
}
```

Requires teacher + session + quiz `ACTIVE` (`QUIZ_NOT_ACTIVE` otherwise) and
the question must belong to that quiz (`QUESTION_NOT_FOUND` otherwise).

State transition: question `DRAFT → PUBLISHED`. **At most one question may be
in `PUBLISHED` state at a time** — enforced by a partial unique index in
PostgreSQL (`questions_one_published_per_quiz_key`), not by application
checks. A second publish while one is open fails with
`INVALID_STATE_TRANSITION`.

Ack/broadcasts: `question.published` to the session — the payload contains
`prompt`, `firstCorrectWins`, `acceptingAnswers: true`, positions and IDs;
**`correctAnswer` never crosses the wire** — followed by an empty
`leaderboard.updated` so clients can reset standings for the new question.

### 5.5 `question.close` (teacher)

```json
{
  "type": "question.close",
  "requestId": "q3",
  "payload": { "questionId": "018f..." }
}
```

Requires teacher + session; question must belong to the session's quiz.
State transition: `PUBLISHED → CLOSED` (closing a `DRAFT` or already-`CLOSED`
question is `INVALID_STATE_TRANSITION`).

Ack/broadcasts: `question.closed` + a final `leaderboard.updated` with the
question's standings.

### 5.6 `quiz.answer` (participant)

```json
{
  "type": "quiz.answer",
  "requestId": "a1",
  "payload": {
    "questionId": "018f...",
    "content": "Berlin"
  }
}
```

| Field        | Rules                                     |
| ------------ | ----------------------------------------- |
| `questionId` | UUID                                      |
| `content`    | string, 1–200 chars (the selected option) |

Requires joined + bound participant (`NOT_A_PARTICIPANT` / `NOT_JOINED`).

Server pipeline:

1. Load the question; it must belong to the joined session's quiz, else
   `QUESTION_NOT_FOUND` (unknown and cross-session questions are
   indistinguishable by design).
2. Persist + elect **atomically** (ADR-004): inside one transaction the
   question row is locked (`FOR NO KEY UPDATE`), the `PUBLISHED` state is
   re-checked under the lock, correctness is computed **server-side** against
   the stored `correctAnswer` (never trusted from the client), and the answer
   row is inserted. The first correct submission commits `isWinner = true`;
   the partial unique index `answers_one_winner_per_question_key` is the
   backstop that makes winner count ≤ 1 a database invariant.
3. Respond to the submitter with `answer.accepted` (request-correlated):
   `participantId`, `displayName`, `isCorrect`, `isWinner`,
   `attemptNumber`. For unkeyed questions (`correctAnswer` null) `isCorrect`
   is `null` (ungraded) and no winner is ever elected.
4. For **fresh** submissions, broadcast `answer.accepted` (`requestId: null`)
   - `leaderboard.updated` to the session. Duplicate replays re-send the
     private verdict only — no re-broadcast, no re-ranking.

Rejections: question not `PUBLISHED` (checked twice: pre-transaction and
under the lock) → `QUESTION_NOT_ACCEPTING_ANSWERS`; nothing is persisted.

The client is never told the correct answer — only whether _its_ submission
was correct.

## 6. Server events

| Event                 | Trigger / direction                        | requestId           |
| --------------------- | ------------------------------------------ | ------------------- |
| `session.joined`      | response to `session.join`                 | echoed              |
| `session.state`       | after join / leave; authoritative snapshot | echoed              |
| `quiz.started`        | broadcast on `quiz.start`                  | echoed (triggering) |
| `question.published`  | broadcast on `question.publish`            | echoed (triggering) |
| `question.closed`     | broadcast on `question.close`              | echoed (triggering) |
| `answer.accepted`     | targeted verdict + session broadcast       | echoed / `null`     |
| `leaderboard.updated` | on publish (empty), fresh answers, close   | echoed / `null`     |
| `error`               | any failure                                | echoed / `null`     |

`leaderboard.updated` payload:

```json
{
  "type": "leaderboard.updated",
  "requestId": null,
  "payload": {
    "sessionId": "018f...",
    "questionId": "018f...",
    "standings": [
      {
        "participantId": "018f...",
        "displayName": "Student-1",
        "correctCount": 1,
        "isWinner": true
      }
    ]
  }
}
```

Standings are derived from authoritative answer rows (correct answers per
participant for that question, winner flagged first) — no ranking state is
kept anywhere else.

## 7. Acknowledgement, delivery and ordering semantics

**Server-side success and client-side acknowledgement are different things.**

- If the answer transaction commits, the answer is durable **even if the
  submitting socket dies before the response arrives** (the client may
  disconnect mid-flight; PostgreSQL decides the outcome, not the wire).
- A client that never receives its `answer.accepted` (disconnect, network
  drop) can simply resubmit: duplicate handling is idempotent (below), so a
  retry is safe. At-least-once frames + idempotent server = exactly-once
  _effect_.
- WebSocket delivery is at-least-once at best, and frames from one client are
  processed sequentially per connection; there is no cross-connection
  ordering guarantee.

**Duplicate / idempotency behavior.** The unique constraint
`(questionId, participantId, attemptNumber)` (attemptNumber is always 1 in
this phase — one submission per participant per question) means a repeat
submission can never create a second row. The server detects the existing
attempt inside the election transaction and **replays the stored verdict**
(original `isCorrect` / `isWinner`) under the new `requestId`. Duplicates are
therefore: persisted once, acknowledged repeatedly, broadcast once.

**Ordering / what "first" means.** "First correct answer" is _not_ defined by
client send time, network arrival order, or Node's read order. It is defined
by the atomic operation the system uses: the first submission whose
transaction **acquires the question row lock and commits the winning
INSERT** is the winner. Everything else is, by definition, not first —
including submissions that were _sent_ earlier but serialized after the lock
holder. The database clock (lock order + commit), not the wall clock, decides.

## 8. Error codes

| Code                             | Meaning                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_MESSAGE`                | The frame is not a JSON object (unparseable JSON, arrays, strings, numbers, `null`).                                               |
| `INVALID_REQUEST`                | JSON object recognized but envelope/payload invalid: missing `type`, bad `requestId`, unknown payload fields, wrong payload shape. |
| `INVALID_SESSION_ID`             | `payload.sessionId` of `session.join` is not a UUID (rejected before any DB access).                                               |
| `SESSION_NOT_FOUND`              | UUID well-formed but no such session in PostgreSQL.                                                                                |
| `SESSION_ALREADY_JOINED`         | Connection re-joined the session it is already in.                                                                                 |
| `UNSUPPORTED_EVENT`              | `type` is a valid string but not a known client event (e.g. `doubt.create` before Phase 5).                                        |
| `NOT_JOINED`                     | Participant-bound event sent before joining a session.                                                                             |
| `NOT_A_PARTICIPANT`              | Event requires a bound participant but the join was view-only (or the binding was detached by leave).                              |
| `TEACHER_REQUIRED`               | Teacher-only event sent by a `STUDENT` participant.                                                                                |
| `SESSION_NOT_LIVE`               | `quiz.start` attempted while the session is not `LIVE`.                                                                            |
| `QUIZ_NOT_FOUND`                 | Quiz unknown or not part of the joined session.                                                                                    |
| `QUIZ_NOT_ACTIVE`                | `question.publish` attempted before `quiz.start`.                                                                                  |
| `QUESTION_NOT_FOUND`             | Question unknown or not part of the joined session's quiz.                                                                         |
| `QUESTION_NOT_ACCEPTING_ANSWERS` | Answer attempted while the question is not `PUBLISHED` (draft, closed, or closed mid-flight).                                      |
| `INVALID_STATE_TRANSITION`       | Illegal lifecycle transition (double publish, re-start, close of a closed question, …).                                            |
| `INTERNAL_ERROR`                 | Unexpected server fault. Details are logged server-side only — never stack traces, Prisma or SQL errors.                           |

Rules:

- Errors are protocol-level only. They never include internals.
- `details.issues` is populated only for `INVALID_REQUEST` (Zod issue paths)
  to help client developers; never for other codes.

## 9. Limits and lifecycle rules

| Rule                       | Value / behavior                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Max inbound frame size     | 64 KiB. Larger frames are closed by `ws` with code 1009 (`message too big`).                                                       |
| Message processing         | Sequential per connection (async handler ordering); no per-message concurrency.                                                    |
| Heartbeat                  | Server pings every `WS_HEARTBEAT_INTERVAL_MS` (default 30 s, env-configurable). See `docs/architecture/websocket-architecture.md`. |
| One session per connection | A connection joins at most one session at a time; a join to another session performs leave-then-join.                              |
| Leave vs close             | `session.leave` detaches (registry + participant binding) but keeps the socket open; closing the socket tears the connection down. |
| Unknown server events      | Clients must ignore server `type`s they do not know (forward compatibility).                                                       |
| No durable state           | The registry is process memory only. Connections are never stored in PostgreSQL; answers/participants are.                         |

## 10. Worked example (full live quiz)

```
C → S: {"type":"session.join","requestId":"r1","payload":{"sessionId":"018f...","participant":{"displayName":"Ms. Ray"}}}
S → C: {"type":"session.joined","requestId":"r1","payload":{"sessionId":"018f...","state":"LIVE","participantId":"0189...","role":"TEACHER","displayName":"Ms. Ray"}}
S → C: {"type":"session.state","requestId":"r1","payload":{"sessionId":"018f...","state":"LIVE",...}}

C → S: {"type":"quiz.start","requestId":"q1","payload":{"quizId":"018e..."}}
S → C: {"type":"quiz.started","requestId":"q1","payload":{"sessionId":"018f...","quizId":"018e...","state":"ACTIVE"}}   (broadcast)

C → S: {"type":"question.publish","requestId":"q2","payload":{"questionId":"018d..."}}
S → C: {"type":"question.published","requestId":"q2","payload":{"sessionId":"018f...","quizId":"018e...","questionId":"018d...","position":1,"prompt":"Capital of Germany?","firstCorrectWins":true,"acceptingAnswers":true}}
S → C: {"type":"leaderboard.updated","requestId":"q2","payload":{"sessionId":"018f...","questionId":"018d...","standings":[]}}

C → S: {"type":"quiz.answer","requestId":"a1","payload":{"questionId":"018d...","content":"Berlin"}}
S → C: {"type":"answer.accepted","requestId":"a1","payload":{"sessionId":"018f...","questionId":"018d...","participantId":"0189...","displayName":"Student-1","isCorrect":true,"isWinner":true,"attemptNumber":1}}
S → C: {"type":"answer.accepted","requestId":null,"payload":{...same verdict...}}                                        (broadcast)
S → C: {"type":"leaderboard.updated","requestId":null,"payload":{"sessionId":"018f...","questionId":"018d...","standings":[{"participantId":"0189...","displayName":"Student-1","correctCount":1,"isWinner":true}]}}

C → S: {"type":"quiz.answer","requestId":"a1-retry","payload":{"questionId":"018d...","content":"Berlin"}}   (client retry)
S → C: {"type":"answer.accepted","requestId":"a1-retry","payload":{...stored verdict replayed...}}            (no re-broadcast)

C → S: {"type":"question.close","requestId":"q3","payload":{"questionId":"018d..."}}
S → C: {"type":"question.closed","requestId":"q3","payload":{"sessionId":"018f...","quizId":"018e...","questionId":"018d..."}}
S → C: {"type":"leaderboard.updated","requestId":"q3","payload":{...final standings...}}

C → S: {"type":"quiz.answer","requestId":"late","payload":{"questionId":"018d...","content":"Berlin"}}
S → C: {"type":"error","requestId":"late","payload":{"code":"QUESTION_NOT_ACCEPTING_ANSWERS","message":"This question is not accepting answers","details":null}}
```
