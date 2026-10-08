# LivePulse — HTTP API (Phase 1 + Phase 2/3 additions)

Only the endpoints actually implemented are documented here. Authentication
has its own reference: `docs/api/authentication.md` (register / login /
refresh / logout / me, token lifetimes, revocation semantics). Quiz/question
lifecycle transitions and answer submission are **WebSocket-only** (Phase 3)
— see `docs/api/websocket-protocol.md`.

All responses are JSON. Errors use one consistent envelope:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "human-readable reason",
  "details": { "optional": "extra info, e.g. validation issues" }
}
```

| Status | When                                                                          |
| ------ | ----------------------------------------------------------------------------- |
| 400    | request body/query fails Zod validation, malformed JSON, malformed UUID param |
| 404    | referenced resource does not exist                                            |
| 409    | invalid state transition, or a uniqueness constraint would be violated        |
| 500    | unexpected server error (details are logged, never leaked)                    |

---

## GET /ws (plain HTTP)

Added in Phase 2. A plain HTTP `GET /ws` — without an `Upgrade: websocket`
header — is answered with:

```json
{
  "statusCode": 426,
  "error": "Upgrade Required",
  "message": "WebSocket connections must use the ws:// protocol at /ws"
}
```

WebSocket upgrades at `/ws` are not part of the HTTP API; see
`docs/api/websocket-protocol.md`. Upgrades on any other path are rejected by
closing the TCP connection before the handshake.

---

## POST /sessions

Creates a session. **Requires authentication** (`Authorization: Bearer
<access-token>`): the creator is the token subject, and that user is added as
the first `TEACHER` participant. There is no client-supplied creator identity
(the Phase 3 `creator.displayName` auto-provisioning seam is retired).

**Request**

```json
{
  "name": "Physics — Current Electricity"
}
```

- `name`: string, 1–200 chars, required
- no `creator` field — identity comes from the access token, never the body

**Response — 201**

```json
{
  "session": {
    "id": "0198b62f-...-uuidv7",
    "name": "Physics — Current Electricity",
    "state": "CREATED",
    "startedAt": null,
    "endedAt": null,
    "createdAt": "2026-09-22T09:09:04.123Z",
    "updatedAt": "2026-09-22T09:09:04.123Z",
    "creator": { "id": "user-uuid", "displayName": "Dr. Ohm" }
  },
  "teacherParticipant": {
    "id": "participant-uuid",
    "role": "TEACHER",
    "userId": "user-uuid",
    "joinedAt": "2026-09-22T09:09:04.123Z"
  }
}
```

**Errors:** 400 (missing/empty/too-long `name`, malformed JSON); 401 (missing
or invalid access token).

---

## GET /sessions/:sessionId

Returns the session and its participants.

**Response — 200**

```json
{
  "session": {
    "id": "...",
    "name": "...",
    "state": "CREATED",
    "startedAt": null,
    "endedAt": null,
    "createdAt": "...",
    "updatedAt": "...",
    "creator": { "id": "user-uuid", "displayName": "Dr. Ohm" }
  },
  "participants": [
    {
      "id": "participant-uuid",
      "role": "TEACHER",
      "userId": "user-uuid",
      "displayName": "Dr. Ohm",
      "joinedAt": "..."
    }
  ]
}
```

**Errors:** 404 (unknown id), 400 (malformed id — rejected by Zod before any
database access).

---

## POST /sessions/:sessionId/state

Explicit lifecycle transition. The approved state machine:

```
CREATED ──▶ LIVE ──▶ ENDED
   │                  ▲
   └───── (cancel) ───┘        ENDED is terminal
```

Valid: `CREATED → LIVE`, `LIVE → ENDED`, `CREATED → ENDED`.
Everything else is rejected. Transitions are atomic conditional updates —
concurrent transitions are race-safe (exactly one wins).

**Request**

```json
{ "state": "LIVE" }
```

- `state`: one of `"LIVE" | "ENDED"` (only transition targets are accepted)

**Response — 200**

```json
{
  "session": {
    "id": "...",
    "name": "...",
    "state": "LIVE",
    "startedAt": "2026-09-22T09:10:00.000Z",
    "endedAt": null,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

Side effects: entering `LIVE` sets `startedAt`; entering `ENDED` sets
`endedAt` and preserves `startedAt`.

**Errors:** 400 (unknown target state), 404 (unknown session), 409
(invalid transition, e.g. `ENDED → LIVE`).

---

## POST /sessions/:sessionId/quizzes

Creates a quiz for an existing session, with optional inline questions
(approved Phase 1 intake decision). Quiz and questions are written in one
transaction; positions are assigned by array order starting at 1. Questions
are created in `DRAFT` state — lifecycle transitions are WebSocket
teacher events since Phase 3 (`quiz.start`, `question.publish`,
`question.close`).

**Request**

```json
{
  "title": "Electricity basics",
  "questions": [
    { "prompt": "Unit of current?", "correctAnswer": "Ampere" },
    { "prompt": "Open question without a key" },
    { "prompt": "Custom rule", "firstCorrectWins": false }
  ]
}
```

- `title`: string, 1–200 chars, required
- `questions`: optional array (max 100); each item:
  - `prompt`: string, 1–2000 chars, required
  - `correctAnswer`: string, 1–2000 chars, optional (absent ⇒ ungraded)
  - `firstCorrectWins`: boolean, optional, default `true` (Phase 3 semantics —
    drives winner election on `quiz.answer`)

**Response — 201**

```json
{
  "quiz": {
    "id": "...",
    "sessionId": "...",
    "title": "Electricity basics",
    "state": "DRAFT",
    "startedAt": null,
    "endedAt": null,
    "createdAt": "...",
    "updatedAt": "...",
    "questions": [
      {
        "id": "...",
        "position": 1,
        "prompt": "Unit of current?",
        "hasCorrectAnswer": true,
        "firstCorrectWins": true,
        "state": "DRAFT"
      }
    ]
  }
}
```

`correctAnswer` is **never** included in any response — teacher-only data.

**Errors:** 400 (missing title, empty prompt, malformed id), 404 (session
does not exist — nothing is created).

---

## GET /quizzes/:quizId

Returns the quiz with its questions ordered by `position`.

**Response — 200:** same `quiz` shape as above.
**Errors:** 404 (unknown quiz), 400 (malformed id).

---

## Not implemented (by design)

Joining via HTTP (participants bind over the WebSocket after
`auth.authenticate`), doubt endpoints, presence. Quiz/question state
transitions and answers are WS-only by design — real-time classroom events
belong on the real-time channel; HTTP remains the control plane for
durable/curatorial operations (create session/quiz, move session state).
See `docs/architecture/overview.md` §5.
