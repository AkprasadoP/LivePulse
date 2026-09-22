# LivePulse — Domain Schema (Phase 1)

> Scope: the durable state model implemented in this phase. This document
> describes what is actually in `prisma/schema.prisma` and applied by
> migration `20260922090904_init_domain`. It is **not** immutable — later phases may
> evolve it through new migrations. Redis-specific structures are
> deliberately absent here; PostgreSQL is the durable source of truth only.

## 1. Identity model — User vs Participant

These are two different concepts and two different tables:

- **User** — a global identity across the platform. One row per human.
  Currently has no credentials (authentication is a later phase), so the
  unique identity is the surrogate `id` (UUID) only.
- **SessionParticipant** — the join of _user × session_, carrying
  session-scoped state. A user may participate in many sessions; each
  participation is its own row with its own `role` and `joinedAt`.

All session-scoped data (answers, doubts) references the **participant**,
never the bare user: an answer is "participant P answered question Q",
which is only meaningful inside one session.

Roles are stored on the participant row, not the user: the same human can
hold different roles in different sessions. The session creator becomes the
session's first `TEACHER` participant (created in the same transaction as
the session).

## 2. Entity inventory

| Entity                 | Purpose                                  | Owned by               | Lifecycle                                        |
| ---------------------- | ---------------------------------------- | ---------------------- | ------------------------------------------------ |
| `users`                | Global identity                          | itself                 | created once; no soft-delete                     |
| `sessions`             | A live classroom                         | teacher (creator)      | `CREATED → LIVE → ENDED`                         |
| `session_participants` | User-in-session + role                   | session                | created on join; no state machine                |
| `quizzes`              | A quiz run inside a session              | session                | `DRAFT → ACTIVE → COMPLETED`                     |
| `questions`            | One quiz item                            | quiz                   | `DRAFT → PUBLISHED → CLOSED`                     |
| `answers`              | A participant's submission to a question | question + participant | immutable once written (append rows per attempt) |
| `doubts`               | A raised question from a participant     | session + participant  | `OPEN → RESOLVED`                                |

## 3. Lifecycle state machines

### Session — `SessionState`

```
CREATED ──start──▶ LIVE ──end──▶ ENDED
   │                               ▲
   └──────────end (cancel)─────────┘
```

- Valid transitions: `CREATED → LIVE`, `LIVE → ENDED`, `CREATED → ENDED`
  (decided: cancel-before-live is allowed; there is no separate
  `CANCELLED` state).
- Invalid: `ENDED → anything`, `LIVE → CREATED`.
- Enforcement: the repository performs an atomic conditional update
  (`UPDATE sessions SET state = :to WHERE id = :id AND state = :from`);
  zero rows updated ⇒ invalid transition ⇒ `InvalidStateTransitionError`.
  This is race-safe for concurrent transitions (check-and-set in one
  statement). A PostgreSQL-level trigger guard is documented as deferred
  defense-in-depth (ADR-002) — the DB currently trusts the single writer.
- Timestamps: `startedAt` set when entering `LIVE`; `endedAt` when entering
  `ENDED`.

### Quiz — `QuizState` (modeled, transitions not yet exposed in HTTP)

`DRAFT → ACTIVE → COMPLETED`. Authored in `DRAFT`, running in `ACTIVE`,
finished in `COMPLETED`. Teacher actions that drive these transitions are
Phase 3.

### Question — `QuestionState` (modeled, transitions not yet exposed)

`DRAFT → PUBLISHED → CLOSED`. "Publish a question" (WebSocket push) is
Phase 3; "close a question" stops answer acceptance. Rows are created in
`DRAFT` (inline at quiz creation in this phase).

## 4. Fields and nullability

### users

| Field         | Type         | Notes                                                       |
| ------------- | ------------ | ----------------------------------------------------------- |
| `id`          | UUID PK      | `uuidv7()` generated client-side (sortable IDs)             |
| `displayName` | varchar(100) | non-null; no uniqueness (no auth yet — documented decision) |
| `createdAt`   | timestamptz  | default now                                                 |

### sessions

| Field                    | Type                | Notes                                                                            |
| ------------------------ | ------------------- | -------------------------------------------------------------------------------- |
| `id`                     | UUID PK             | uuidv7                                                                           |
| `name`                   | varchar(200)        | non-null                                                                         |
| `state`                  | `SessionState` enum | default `CREATED`                                                                |
| `creatorId`              | UUID → users        | NOT NULL. **OnDelete: Restrict** — a user who created sessions cannot be deleted |
| `startedAt`              | timestamptz         | null until `LIVE`                                                                |
| `endedAt`                | timestamptz         | null until `ENDED`                                                               |
| `createdAt`, `updatedAt` | timestamptz         | maintained by Prisma                                                             |

### session_participants

| Field       | Type                                         | Notes                                                                     |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `id`        | UUID PK                                      | uuidv7                                                                    |
| `sessionId` | UUID → sessions                              | NOT NULL, **Cascade** (participants die with the session)                 |
| `userId`    | UUID → users                                 | NOT NULL, **Restrict** (never silently delete a user with participations) |
| `role`      | `ParticipantRole` enum (`TEACHER`,`STUDENT`) | default `STUDENT`                                                         |
| `joinedAt`  | timestamptz                                  | default now                                                               |
| —           | —                                            | **UNIQUE (sessionId, userId)** — one membership per user per session      |

### quizzes

| Field                    | Type            | Notes                         |
| ------------------------ | --------------- | ----------------------------- |
| `id`                     | UUID PK         | uuidv7                        |
| `sessionId`              | UUID → sessions | NOT NULL, **Cascade**         |
| `title`                  | varchar(200)    | non-null                      |
| `state`                  | `QuizState`     | default `DRAFT`               |
| `startedAt`, `endedAt`   | timestamptz     | null until ACTIVE / COMPLETED |
| `createdAt`, `updatedAt` | timestamptz     |                               |

### questions

| Field                    | Type            | Notes                                                                           |
| ------------------------ | --------------- | ------------------------------------------------------------------------------- |
| `id`                     | UUID PK         | uuidv7                                                                          |
| `quizId`                 | UUID → quizzes  | NOT NULL, **Cascade**                                                           |
| `position`               | int             | ordering for delivery; **UNIQUE (quizId, position)**                            |
| `prompt`                 | text            | non-null                                                                        |
| `correctAnswer`          | text            | **nullable** — a question may have no key (`isCorrect` will be null ⇒ ungraded) |
| `firstCorrectWins`       | boolean         | default `true`; Phase 4 semantics flag                                          |
| `state`                  | `QuestionState` | default `DRAFT`                                                                 |
| `createdAt`, `updatedAt` | timestamptz     |                                                                                 |

### answers

| Field           | Type                        | Notes                                                                         |
| --------------- | --------------------------- | ----------------------------------------------------------------------------- |
| `id`            | UUID PK                     | uuidv7                                                                        |
| `questionId`    | UUID → questions            | NOT NULL, **Cascade**                                                         |
| `participantId` | UUID → session_participants | NOT NULL, **Cascade**                                                         |
| `content`       | text                        | the submitted answer                                                          |
| `attemptNumber` | int                         | default 1 — supports multiple attempts if enabled later                       |
| `isCorrect`     | boolean                     | **nullable** — null means ungraded (question has no key, or not yet graded)   |
| `submittedAt`   | timestamptz                 | default now                                                                   |
| —               | —                           | **UNIQUE (questionId, participantId, attemptNumber)** — no duplicate attempts |

Deliberately **not** modeled: winner columns / `isWinner` flags. The
"first correct answer wins" election is a concurrency problem for Phase 4
(ADR to come: Redis `SET NX` vs PostgreSQL partial unique index). The
current unique constraint on attempts is sufficient to persist every
submission durably and unambiguously.

### doubts

| Field                    | Type                              | Notes                                                                     |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------- |
| `id`                     | UUID PK                           | uuidv7                                                                    |
| `sessionId`              | UUID → sessions                   | NOT NULL, **Cascade**                                                     |
| `participantId`          | UUID → session_participants       | NOT NULL, **Cascade**                                                     |
| `content`                | text                              | non-null                                                                  |
| `priority`               | int                               | default 0; higher = more urgent (ordering contract documented in Phase 8) |
| `status`                 | `DoubtStatus` (`OPEN`,`RESOLVED`) | default `OPEN`                                                            |
| `resolvedAt`             | timestamptz                       | null while `OPEN`                                                         |
| `createdAt`, `updatedAt` | timestamptz                       |                                                                           |

Deliberately **not** modeled here: per-session queue sequence numbers.
Redis will hold the live queue later; PostgreSQL is the durable record of
doubts and their resolution state.

## 5. Indexes (beyond PKs/uniques) — with query justification

| Index                                            | Query it supports                                                | Access pattern                                       |
| ------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `quizzes.sessionId`                              | fetch all quizzes of a session                                   | session detail page / quiz list (frequent, Phase 3+) |
| `questions.quizId`                               | fetch ordered questions of a quiz                                | quiz delivery + reconnection state rebuild           |
| `answers.questionId_submittedAt_idx`             | submissions of a question in time order                          | leaderboard/timing queries (Phase 4)                 |
| `answers.participantId`                          | a participant's answer history                                   | reconnect recovery: "what did I already answer?"     |
| `doubts.sessionId_status_priority_createdAt_idx` | open doubts of a session ordered by priority DESC, createdAt ASC | teacher's queue view (Phase 8 ordering contract)     |
| `doubts.participantId`                           | a participant's doubts                                           | moderation/history                                   |
| `session_participants.userId`                    | all sessions a user participates in                              | user-centric listing                                 |

Uniques also create implicit indexes: `(sessionId,userId)` on
`session_participants`, `(quizId,position)` on `questions`,
`(questionId,participantId,attemptNumber)` on `answers`.

## 6. Referential actions summary

| Relation                         | On delete | Rationale                                        |
| -------------------------------- | --------- | ------------------------------------------------ |
| session.creator → user           | Restrict  | creator is historical ownership; refuse deletion |
| participant.user → user          | Restrict  | participation history belongs to the user        |
| participants → session           | Cascade   | session-scoped state dies with the session       |
| quizzes → session                | Cascade   | quiz is owned by its session                     |
| questions → quiz                 | Cascade   |                                                  |
| answers → question / participant | Cascade   |                                                  |
| doubts → session / participant   | Cascade   |                                                  |

## 7. Ownership of state

- PostgreSQL (this schema): **all durable state** — identities, sessions,
  memberships, quizzes, questions, answers, doubts.
- Redis (future): only ephemeral/reconstructible state — presence, live
  queue ordering, cross-instance pub/sub. Nothing in this schema encodes
  Redis structures.
