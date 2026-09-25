# Reconnect & Recovery — Phase 5

> **Status: implemented (Phase 5).** This document is the Phase 5 design
> proposal and the description of what is actually built and tested. Per
> AGENT.md's honesty rule, everything below the "Implemented" line reflects
> code that exists and tests that pass; deferred items are labeled as such.

## 1. The problem

A WebSocket connection is ephemeral and Redis Pub/Sub is non-durable:

```
PostgreSQL = truth
Redis      = live notification (at-most-once, fire-and-forget)
WebSocket  = ephemeral transport
```

Any of these can cause a client to miss real-time events:

- network drop, laptop sleep, tab freeze (socket dies)
- WebSocket instance crash / graceful shutdown (all local sockets die)
- Redis outage on another instance (a publish never reaches it — Phase 4)

A disconnected client misses every `question.published`, `answer.accepted`,
`leaderboard.updated` and `question.closed` that fires while it is gone.
Phase 5 must make reconnection _correct_ without making delivery durable.

## 2. Design proposal (written before implementation)

### A. What does "recovery" mean?

**Convergence, not replay.** Recovery means: after reconnecting, the client
holds an accurate view of the _current_ authoritative state and resumes live
event delivery from that point. It does NOT mean the client receives the
events it missed. LivePulse does not guarantee replay of every transient
WebSocket event; it guarantees that reconnecting clients can reconcile
against authoritative PostgreSQL state.

### B. Which state is authoritative after reconnect?

Exactly what PostgreSQL stores:

1. **Session state** (`CREATED` / `LIVE` / `ENDED`) — already authoritative,
   already read by `session.join` since Phase 2.
2. **Quiz state** (`DRAFT` / `ACTIVE` / `COMPLETED`) — authoritative in
   `quizzes.state`.
3. **Question state** (`DRAFT` / `PUBLISHED` / `CLOSED`) — authoritative in
   `questions.state`, including which question is the (at most one)
   published one.
4. **The participant's own answer verdict** — authoritative in `answers`
   (unique `(questionId, participantId, attemptNumber)`, `isCorrect`,
   `isWinner`).
5. **Current standings** — derived from answer rows (the same derivation
   `leaderboard.updated` broadcasts).

Nothing else is client-visible state. In-memory registries, Redis and
sockets hold connection state only.

### C. Which events can safely be missed?

All of them. Every distributed event (ADR-005 list) is a _notification of a
durable state change_, not the state change itself:

| Missed event          | Durable effect it announced                  |
| --------------------- | -------------------------------------------- |
| `quiz.started`        | `quizzes.state = ACTIVE`                     |
| `question.published`  | `questions.state = PUBLISHED` (+ prompt row) |
| `answer.accepted`     | an `answers` row                             |
| `leaderboard.updated` | derivable from `answers`                     |
| `question.closed`     | `questions.state = CLOSED`                   |

Missing a notification costs the push, never the data. The reconnect
snapshot is built from the same tables the events announced.

### D. Which events must NOT be replayed?

**None are replayed** — by design. Replaying historical notifications would
require a durable event log (Redis Streams, Kafka, event sourcing), which
AGENT.md forbids introducing for this problem and which would create a
second ordering of record competing with PostgreSQL. Frames that are _not_
state are also never reconstructed: private error frames, targeted verdicts
with their original `requestId`, and heartbeat/close frames are connection-
scoped and die with the connection.

Two subtleties worth stating explicitly:

- A stale broadcast delivered _after_ reconnect (a Redis notice rendered on
  the new instance can race the snapshot) may momentarily describe an older
  state than the snapshot. This is benign: every frame carries the state it
  describes (`questionId`, `standings`, `state`), and the durable state only
  moves forward through PostgreSQL-guarded transitions.
- The client's **own lost verdict** is special: instead of replaying the
  missed `answer.accepted` frame, the snapshot carries the stored verdict
  (`recovery.ownAnswer`), and a retry resubmission replays it idempotently
  (Phase 3 semantics, unchanged).

### E. How does a reconnecting client obtain current session state?

It sends the same `session.join` it always sent — no new event, no new
envelope field. The **smallest contract change** that makes join sufficient
for recovery: the `session.joined` response now carries an optional
`recovery` snapshot object (see §4). A client that wants recovery
participation re-joins with its `participant.displayName` and reads
`session.joined.recovery`.

### F. Can the client reconnect to a different WS instance?

Yes — and this is the normal case, not the special case. The snapshot is
assembled by the instance handling the join, purely from PostgreSQL (which
every instance shares). No session affinity, no instance identity check, no
state migration between instances. Tested: connect to WS-A, disconnect,
reconnect to WS-B, recover, continue participating (see
`docs/testing/recovery.md`).

### G. Reconnect-time scenarios

| Reconnect while…                   | What the snapshot says                                                |
| ---------------------------------- | --------------------------------------------------------------------- |
| quiz active, no question published | `recovery.quizzes[0].state: "ACTIVE"`, `question: null`               |
| question published                 | `recovery.question { state: "PUBLISHED", acceptingAnswers: true, … }` |
| question closed                    | `recovery.question { state: "CLOSED" }`, current standings            |
| leaderboard changed                | `recovery.standings` = current derived standings                      |
| answer submitted just before drop  | `recovery.ownAnswer` = stored verdict; a retry replays it             |
| session ended                      | `session.state: "ENDED"`, no quiz/question section                    |
| nothing has happened yet           | `recovery` fields stay `null` (quiz never started)                    |

The participant's role/identity binding is re-established by the same
displayName seam (§5), so answering after reconnect works as before.

### H. How are duplicate client submissions handled?

Unchanged from Phase 3 — recovery deliberately touches none of it:

- `answers` has `UNIQUE (questionId, participantId, attemptNumber)`.
- The election transaction locks the question row (`FOR NO KEY UPDATE`),
  re-checks `PUBLISHED`, finds the prior attempt and **replays the stored
  verdict** (`duplicate` outcome, winner or not) without re-broadcasting.
- A retry that races the reconnect is adjudicated by PostgreSQL under the
  lock; a second winner is a database-level impossibility (partial unique
  index `answers_one_winner_per_question_key`).
- Duplicates re-send the private verdict only — never a re-broadcast, never
  re-ranking.

New for Phase 5: this retry-across-reconnect behavior is now _tested_
(see `docs/testing/recovery.md`, scenarios R6/R7).

### I. What happens if a reconnect happens during an in-flight server operation?

The in-flight operation completes against PostgreSQL regardless of the
socket: server-side success and client-side acknowledgement are different
things (protocol doc §7). Specifically:

- **Answer mid-election when the socket dies:** the transaction commits or
  rolls back on its own. If it committed, the reconnecting client finds its
  verdict in `recovery.ownAnswer`. If it did not, the client never had a
  verdict and may resubmit.
- **Publish/close mid-flight:** state transitions are single conditional
  UPDATEs; the snapshot read may land either side of the commit. Because
  the join reads each table in one consistent PostgreSQL database (READ
  COMMITTED, statement-level snapshots), the snapshot can never mix a
  question row with a quiz row from an impossible timeline; a snapshot that
  is a few milliseconds behind the newest commit simply reflects the state
  at read time, and the _live_ events resume from there.

The only client-initiated write (`quiz.answer`) is fully adjudicated under
the row lock, so reconnect-time staleness can never corrupt durable state —
worst case the client gets `QUESTION_NOT_ACCEPTING_ANSWERS` for a question
that closed while it was away, which is the correct answer.

### J. Do we need event sequence numbers / versioning?

**No.** Sequence numbers are only meaningful if the consumer can use them to
detect a gap and request the missing range — i.e. if replay exists. Redis
Pub/Sub is at-most-once, there is no log to read from, and the snapshot
model closes every gap wholesale. Adding per-event or per-session sequence
numbers now would imply a delivery guarantee we do not have (worse than no
field at all in a protocol documented this precisely) and would be dead
weight. The snapshot itself does not need a version: it is a point-in-time
read of PostgreSQL, and state enums already describe recency. If a later
phase (client-side diffing, resumable streams) genuinely needs ordering,
that phase will introduce it with its own replay machinery — not this one.

## 3. Recovery model (implemented)

```
WebSocket disconnect (crash, network, instance shutdown)
        ↓
client reconnects (any instance)
        ↓
session.join (same protocol as always, participant.displayName seam)
        ↓
server reads PostgreSQL: session + quiz + question + own answer + standings
        ↓
session.joined { …, recovery }          ← authoritative snapshot
        ↓
normal live events resume (local broadcast + Redis Pub/Sub fan-out)
```

- The reconnect path does not touch Redis at all. Redis being down changes
  nothing about recovery correctness (tested).
- Nothing is buffered per-client while disconnected. There is no per-client
  outbox, no replay buffer, no presence tracking of "who saw what".

## 4. Session recovery contract (implemented)

`session.join` → `session.joined` payload, after Phase 5:

```jsonc
{
  "sessionId": "018f…",
  "state": "LIVE",
  "participantId": "018a…", // unchanged
  "role": "STUDENT", // unchanged
  "displayName": "Student-1", // unchanged
  "recovery": {
    // NEW — never absent, fields nullable
    "quizzes": [
      // every quiz of the session
      { "quizId": "018e…", "state": "ACTIVE", "startedAt": "…" },
    ],
    "question": {
      // CURRENT published/closed question, else null
      "quizId": "018e…",
      "questionId": "018d…",
      "position": 1,
      "prompt": "Capital of Germany?",
      "firstCorrectWins": true,
      "state": "PUBLISHED", // "PUBLISHED" | "CLOSED" (never DRAFT)
      "acceptingAnswers": true, // mirrors question.published semantics
    },
    "ownAnswer": {
      // bound participant's stored attempt-1 verdict, else null
      "questionId": "018d…",
      "content": "Berlin",
      "isCorrect": true,
      "isWinner": true,
      "attemptNumber": 1,
      "submittedAt": "…",
    },
    "standings": [
      // current derived standings for recovery.question
      { "participantId": "018a…", "displayName": "Student-1", "correctCount": 1, "isWinner": true },
    ],
    "doubts": {
      // Phase 6: the OPEN queue in canonical order (see doubt-queue.md)
      "open": [
        {
          "doubtId": "018c…",
          "participantId": "018a…",
          "displayName": "Student-1",
          "content": "Why is the sky blue?",
          "priority": 0,
          "enqueueSeq": 1,
          "status": "OPEN",
          "createdAt": "…",
        },
      ],
      "truncated": false, // true when OPEN doubts exceed the 100-doubt payload cap
    },
  },
}
```

Guarantees of the snapshot (each enforced by a test):

1. **Authoritative:** every field is read from PostgreSQL at join time. No
   Redis, no in-memory state contributes to it.
2. **Question section:** the question in `PUBLISHED` or `CLOSED` state most
   recently transitioned (`updatedAt DESC`, tie-break `position ASC`). At
   most one is ever `PUBLISHED` (DB index). `DRAFT` questions never appear.
   `correctAnswer` never crosses the wire.
3. **ownAnswer:** present iff the bound participant has an attempt-1 answer
   row for that question. It is the stored verdict, including the
   lost-`answer.accepted` case.
4. **standings:** the same derivation the close broadcast uses, computed
   fresh; `[]` when no question section exists or nothing is scored.
5. **`recovery: null`** when the session has neither quizzes nor open doubts
   — the field is always present on the payload so clients can rely on its
   shape. (A doubt-only session still gets a snapshot.)
6. **Doubts (Phase 6):** `recovery.doubts.open` is the session's OPEN doubt
   queue in canonical order `(priority DESC, enqueueSeq ASC)`, capped at 100
   as a payload bound (never capacity — PostgreSQL keeps every row).
7. **Idempotent:** joining twice on separate connections yields the same
   snapshot (it is a pure read).
8. **Not a diff:** the snapshot says nothing about _what changed_ while the
   client was away. Clients that need change history do not get it here.

View-only joins (no `participant`) get the same `recovery` object minus
`ownAnswer` (always `null` — there is no bound participant to read answers
for).

## 5. Identity / participation (limitations, documented honestly)

Phase 3's development identity seam is preserved: `participant.displayName`
is the only credential. Reconnect with the same displayName binds to the
same `users` row and the same `session_participants` row
(`UNIQUE(sessionId, userId)`, race-safe find-or-create) — which is what
makes `recovery.ownAnswer` resolve to the reconnecting participant.

The server therefore classifies an incoming join as:

- **same participant reconnecting** — displayName resolves to an existing
  participant row → identity continuity _of the participant record_,
  including stored answers;
- **new participant** — unknown displayName → new user + participant row;
- **duplicate connection** — a second simultaneous socket joining with the
  same displayName binds to the _same_ participant row. Allowed (unchanged
  since Phase 3: sockets are connection-keyed, not deduplicated). Both
  connections share verdicts and receive broadcasts; duplicate
  _submissions_ remain idempotent at the database.

**This is NOT identity continuity of a person.** displayName is not a
credential; anyone can claim any name and thereby inherit a participant's
record — including `recovery.ownAnswer`. The system provides _record
continuity keyed by a self-declared label_, deliberately. True identity
requires the JWT/auth phase; inventing a token scheme here would be
authentication theater. The limitation is documented rather than solved.

There is also no session-resume token and no `session.reconnect` event:
AGENT.md's protocol sketch lists one, but with a find-or-create name seam a
separate event would add surface without adding guarantees. It is deferred
to the auth phase, where a real credential makes a distinct reconnect path
meaningful.

## 6. What is and is not guaranteed

**Guaranteed (tested):**

- Reconnect to any instance recovers session/quiz/question state from
  PostgreSQL (cross-instance tested).
- A client that missed any subset of Phase 4 events converges to the
  current state at rejoin.
- A lost answer verdict is recoverable from the snapshot or by an
  idempotent retry; a retry can never create a second winner (DB-enforced).
- Redis unavailability during reconnect does not affect recovery.
- Duplicate frames are not introduced by recovery: the snapshot is one
  response, and no replay channel exists.
- Phase 1–4 concurrency guarantees are unchanged (full existing suites
  stay green).

**Not guaranteed (by design):**

- **No replay of missed events.** LivePulse does not guarantee replay of
  every transient WebSocket event. It guarantees that reconnecting clients
  can reconcile against authoritative PostgreSQL state.
- No delivery of events that happen _between_ the snapshot read and the
  join response (a sub-millisecond window; subsequent live events close it).
- No person-level identity (displayName seam; see §5).
- No presence: the server does not track who is "currently connected" as
  durable state (later phase).
- No outbox/durable queue for undelivered frames, ever, in this phase.

## 7. During the gap (what actually happens server-side)

When the socket drops, the server's only action is registry cleanup on
`close` (unchanged from Phase 2). The participant row, answers, quiz and
question state all persist — they were never in the socket. While the
client is away the session continues normally for everyone else; the absent
client is simply not in the broadcast target set (and, cross-instance,
other instances' clients still get Redis-rendered frames). On rejoin the
client is re-added to the target set. Nothing else changes: no ghost
sessions, no stale participant state, no cleanup debt.

## 8. Observability (minimum, per Phase 5 scope)

- `WebSocket session joined` — already existed; now includes
  `recovered: boolean` (true when a snapshot carrying a published/closed
  question or own answer was sent) for grep-able reconnect visibility.
- `Recovery snapshot failed` — `warn` when snapshot assembly throws; the
  join still succeeds with `recovery: null` so a broken recovery path can
  never break joining itself.
- `WebSocket duplicate answer replay` — already existed (Phase 3); doubles
  as the retry signal across reconnects.

No counters, no metrics, no new log levels; the full observability phase
comes later.
