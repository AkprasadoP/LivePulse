# LivePulse — HTTP API (Phase 1)

Only the endpoints implemented in Phase 1 are documented here. Authentication,
WebSockets, answer submission and the doubt queue do not exist yet.

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

## POST /sessions

Creates a session and auto-provisions its creator as the first `TEACHER`
participant (no authentication exists yet — approved Phase 1 decision).

**Request**

```json
{
  "name": "Physics — Current Electricity",
  "creator": { "displayName": "Dr. Ohm" }
}
```

- `name`: string, 1–200 chars, required
- `creator.displayName`: string, 1–100 chars, optional (defaults to `"Teacher"`)

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

**Errors:** 400 (missing/empty/too-long `name`, malformed JSON).

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
are created in `DRAFT` state (lifecycle transitions arrive in Phase 3).

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
  - `firstCorrectWins`: boolean, optional, default `true` (Phase 4 semantics)

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

## Not implemented in this phase (by design)

Authentication/auth headers, joining (participants beyond the creator),
answer submission, doubt endpoints, question publish/close transitions,
leaderboards, presence. See `docs/architecture/overview.md` §5.
