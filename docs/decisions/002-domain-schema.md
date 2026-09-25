# ADR-002: Domain Schema — Users, Participants, Session Lifecycle, Quizzes, Questions, Answers, Doubts

- **Status:** Accepted (Phase 1); partially **superseded** on doubt ordering by
  ADR-007 (Phase 6)
- **Date:** 2026-09-22
- **Related:** ADR-001 (foundation), ADR-007 (doubt queue ordering),
  `docs/database/schema.md`

## Context

Phase 1 must establish the durable state model before any WebSocket or
real-time behavior exists. Every later hard problem (live quiz delivery,
concurrent first-correct-answer election, doubt queue ordering, reconnect
recovery) reads and writes this model, so the invariants that PostgreSQL
can enforce should be established now. There is no authentication yet, and
the product will eventually require: explicit session lifecycle, ordered
questions, multiple-attempt answers, first-correct-wins semantics, and a
doubt queue. (This ADR originally assumed the live ordering would live in
Redis; ADR-007 supersedes that — the ordering is PostgreSQL's
`doubts.enqueueSeq`, and Redis is notification only.)

Decisions supplied by the project owner for this phase:

1. `POST /sessions` **auto-provisions the creator** (no auth yet): the
   request may carry `creator { displayName }`; the server creates user +
   session + TEACHER participant in one transaction.
2. Session state machine **allows `CREATED → ENDED`** (cancel before going
   live); `ENDED` is the single terminal state, no separate `CANCELLED`.
3. Questions enter via the **quiz-creation payload** (ordered array,
   created atomically with the quiz) in this phase.

## Options

**Identity:** (a) single `users` table with a session_id column;
(b) separate `users` and `session_participants` with role on the user;
(c) separate tables with role on the participant row.

**Session state enforcement:** (a) application checks only;
(b) PostgreSQL enum + conditional-update check-and-set in the repository;
(c) enum + database trigger guarding transitions.

**Answers:** (a) one mutable row per (question, participant);
(b) append-only rows with `attemptNumber` and a composite unique;
(c) separate `submissions` + `results` tables.

**Winners:** (a) `isWinner` column now; (b) nothing now, decide mechanism
in Phase 4; (c) dedicated `winners` table now.

**Doubts:** (a) sequence column now; (b) durable record only, ordering
contract deferred to Phase 8.

## Decision

- **(c) separate `users` / `session_participants`, role on the
  participant.** User = global identity; participant = user-in-session
  with session-scoped state. All answers/doubts reference the participant.
- **(b) enum states + atomic conditional updates** for session lifecycle
  (`CREATED → LIVE → ENDED`, plus `CREATED → ENDED`); quiz
  (`DRAFT → ACTIVE → COMPLETED`) and question (`DRAFT → PUBLISHED →
CLOSED`) states are modeled but not yet driven by any endpoint.
- **(b) append-style answers** with `attemptNumber` and
  `UNIQUE (questionId, participantId, attemptNumber)`.
- **(b) no winner storage yet.**
- **(b) doubts as a durable record** with an ordering-shaped index
  (`(sessionId, status, priority DESC, createdAt ASC)`), no sequence numbers
  yet. **(Superseded by ADR-007: Phase 6 added `doubts.enqueueSeq` and the
  final index `(sessionId, status, priority DESC, enqueueSeq ASC)`.)**
- UUID primary keys generated client-side as **UUIDv7**
  (`uuidv7()` from the `uuid` package): sortable by creation time, which
  later makes time-ordered queries and cursor pagination natural without
  exposing serial numbers.

## Why

- **Participant split:** the same human in two sessions has two independent
  lifecycles (role, join time, answers, doubts). Conflating them into one
  table would either duplicate user data or force session-scoped columns
  onto a global row. The split also mirrors exactly how the WebSocket
  layer will address state later ("participant X in session Y").
- **Role on the participant:** role is a property of the membership, not
  the person — the same human may teach one session and join another.
- **Conditional-update lifecycle:** a single
  `UPDATE … WHERE state = <from>` statement is atomic in PostgreSQL, so
  two concurrent `start` calls cannot both "win" — one updates one row,
  the other updates zero and fails. Application-level `if` checks alone
  would be a read-then-write race. A trigger (option c) adds
  defense-in-depth but also operational opacity; deferred until there is
  a second writer path that bypasses the repository.
- **Attempt-based answers:** keeps the door open for retry policies
  without a migration to a different shape, while the composite unique
  makes duplicate _attempts_ impossible at the database level. The first
  attempt (`attemptNumber = 1`) is the one that matters for
  first-correct-wins; correctness of that rule stays a Phase 4 concern.
- **No winner columns:** electing a winner is the core concurrency
  problem this project exists to demonstrate; hard-coding `isWinner` now
  would prematurely pick the mechanism (and invite read-then-write bugs).
  Any of the Phase 4 candidates (Redis `SET NX`, partial unique index on
  a correct first attempt) can be adopted without breaking this schema.
- **Doubts without sequence:** the live ordering contract (priority vs
  FIFO vs tie-break) was left to the doubt-queue phase; PostgreSQL only needed
  to durably record doubts and their resolution. The index anticipated the
  likely query without committing to the queue semantics.
  **(Resolved by ADR-007: `enqueueSeq` is assigned by PostgreSQL under the
  session row lock; FIFO = ascending `enqueueSeq` among OPEN doubts within a
  session.)**

## Trade-offs

- **No `displayName` uniqueness (no auth yet):** two users may share a
  name until the auth phase introduces real identity. Accepted and
  documented rather than inventing a fake uniqueness rule now.
- **Repository-enforced state machine:** someone bypassing the repository
  (raw SQL, future code path) could perform an invalid transition. A
  trigger would close this; consciously deferred (simplicity, single
  writer path today).
- **Cascade deletes:** deleting a session wipes its quizzes, questions,
  answers, doubts, participants. Correct for this product's lifecycle
  (nothing survives outside a session), but destructive by design.
- **UUIDv7 client-side generation:** UUIDs are wider than bigserials
  (16 bytes vs 8); chosen for time-sortability and collision-free
  distributed generation, which matters once multiple instances write
  concurrently.
- **No unique "one ACTIVE quiz per session" yet:** could be a partial
  unique index later if the product demands it; not justified by any
  current flow.

## Consequences

**Easier:** reconnect recovery can rebuild full session state from
PostgreSQL; leaderboard queries have their indexes pre-shaped; the
WebSocket join flow can be a pure participant lookup; concurrent
transitions are already safe.

**Harder:** every new write path must go through repositories to keep
lifecycle guarantees; the auth phase will need a migration adding
credentials to `users`; deleting users is restricted (needs explicit
product policy later).

**Intentionally deferred:** database triggers for state transitions;
`correctAnswer` secrecy enforcement at the API layer (Phase 3+);
one-ACTIVE-quiz partial index; winner election mechanism; answer-content
grading logic. (Delivered since: winner election — ADR-004; doubt sequence
numbers — ADR-007.)

**Not immutable:** this schema will evolve through migrations as real
requirements appear; the shape above is the smallest correct model for
Phases 1–2.
