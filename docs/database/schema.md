# LivePulse — Domain Schema (Phase 1 + Phase 3)

> Scope: the durable state model implemented through Phase 3. This document
> describes what is actually in `prisma/schema.prisma` and applied by
> migrations `20260922090904_init_domain` and
> `20260922191225_phase3_quiz_and_winner`. It is **not** immutable — later
> phases may evolve it through new migrations. Redis-specific structures are
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
| `doubts`               | A raised question from a participant     | session + participant  | `OPEN → RESOLVED` / `OPEN → DISMISSED`           |

Phase 3 additions: quiz/question state machines are now **driven** (see
§3), `users.displayName` is unique (identity seam), `answers.isWinner`
exists with a partial unique index enforcing the one-winner invariant, and
at most one question per quiz may be `PUBLISHED` at a time (partial unique
index). See `docs/decisions/004` for the election design.

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

### Quiz — `QuizState` (driven since Phase 3)

`DRAFT → ACTIVE → COMPLETED`. `quiz.start` (WebSocket, teacher) performs
`DRAFT → ACTIVE` atomically (conditional update, zero rows ⇒
`InvalidStateTransitionError`). `ACTIVE → COMPLETED` is **not exposed yet**
— questions are the fine-grained control surface for now. Restarting an
`ACTIVE` quiz is refused.

### Question — `QuestionState` (driven since Phase 3)

`DRAFT → PUBLISHED → CLOSED`. `question.publish` (WebSocket, teacher, quiz
must be `ACTIVE`) performs `DRAFT → PUBLISHED`; `question.close` performs
`PUBLISHED → CLOSED`. While a question is `PUBLISHED` it accepts answers.
**At most one question per quiz may be `PUBLISHED`** — enforced by the
partial unique index `questions_one_published_per_quiz_key`
(`(quizId) WHERE state = 'PUBLISHED'`), not by application checks. Closing
twice or publishing a non-`DRAFT` question is
`InvalidStateTransitionError`.

## 4. Fields and nullability

### users

| Field         | Type         | Notes                                                                                                                                                                  |
| ------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | UUID PK      | `uuidv7()` generated client-side (sortable IDs)                                                                                                                        |
| `displayName` | varchar(100) | non-null; **UNIQUE since Phase 3** (identity seam: stable find-or-create by name until authentication lands — documented in ADR-004's context and the WS protocol doc) |
| `createdAt`   | timestamptz  | default now                                                                                                                                                            |

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

| Field           | Type                        | Notes                                                                                                                            |
| --------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | UUID PK                     | uuidv7                                                                                                                           |
| `questionId`    | UUID → questions            | NOT NULL, **Cascade**                                                                                                            |
| `participantId` | UUID → session_participants | NOT NULL, **Cascade**                                                                                                            |
| `content`       | text                        | the submitted answer                                                                                                             |
| `attemptNumber` | int                         | default 1 — supports multiple attempts if enabled later                                                                          |
| `isCorrect`     | boolean                     | **nullable** — null means ungraded (question has no key)                                                                         |
| `isWinner`      | boolean                     | default `false` (Phase 3). The winning INSERT **is** the election (ADR-004)                                                      |
| `submittedAt`   | timestamptz                 | default now                                                                                                                      |
| —               | —                           | **UNIQUE (questionId, participantId, attemptNumber)** — no duplicate attempts                                                    |
| —               | —                           | **UNIQUE (questionId) WHERE isWinner** — partial index `answers_one_winner_per_question_key`: winner count ≤ 1 is a DB invariant |

Election semantics (ADR-004): every valid answer is persisted (correct,
incorrect, ungraded); the first correct submission whose transaction commits
under the question row lock inserts `isWinner = true`; duplicates replay the
stored verdict idempotently; nothing about the election lives outside
PostgreSQL.

### doubts

| Field                    | Type                                          | Notes                                                            |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------------- |
| `id`                     | UUID PK                                       | uuidv7                                                           |
| `sessionId`              | UUID → sessions                               | NOT NULL, **Cascade**                                            |
| `participantId`          | UUID → session_participants                   | NOT NULL, **Cascade**                                            |
| `content`                | text                                          | non-null                                                         |
| `enqueueSeq`             | int NOT NULL                                  | **ordering authority** (Phase 6): per-session, server-assigned   |
| `priority`               | int                                           | default 0; higher = more urgent (first key of the order)         |
| `doubtRequestId`         | varchar(64) nullable                          | client idempotency key for create retries                        |
| `status`                 | `DoubtStatus` (`OPEN`,`RESOLVED`,`DISMISSED`) | default `OPEN`                                                   |
| `resolvedAt`             | timestamptz                                   | null while `OPEN`; terminal timestamp for RESOLVED and DISMISSED |
| `createdAt`, `updatedAt` | timestamptz                                   | diagnostic only — never used for ordering                        |

`sessions` gains `doubtSeq int default 0`: the per-session counter that is
locked (`SELECT … FOR UPDATE`) and incremented in the same transaction that
inserts a doubt, so `enqueueSeq` order equals durable acceptance order. Both
`enqueueSeq` and `priority` are **server-owned** — no client can set them.

The queue **is** this table: PostgreSQL holds the live ordering (ADR-007);
Redis is notification only. Not modeled: persisted queue positions (derived
on read), resolver identity (deferred), reopen (terminal states are final).

## 5. Indexes (beyond PKs/uniques) — with query justification

| Index                                             | Query it supports                                                 | Access pattern                                       |
| ------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| `quizzes.sessionId`                               | fetch all quizzes of a session                                    | session detail page / quiz list (frequent, Phase 3+) |
| `questions.quizId`                                | fetch ordered questions of a quiz                                 | quiz delivery + reconnection state rebuild           |
| `answers.questionId_submittedAt_idx`              | submissions of a question in time order                           | leaderboard/timing queries (Phase 3 leaderboard)     |
| `answers_one_winner_per_question_key` (partial)   | schema-level winner invariant                                     | defense-in-depth for the ADR-004 election            |
| `questions_one_published_per_quiz_key` (partial)  | schema-level single-open-question invariant                       | teacher publish flow (Phase 3)                       |
| `answers.participantId`                           | a participant's answer history                                    | reconnect recovery: "what did I already answer?"     |
| `doubts_sessionId_status_priority_enqueueSeq_idx` | open doubts of a session ordered by priority DESC, enqueueSeq ASC | teacher's queue view + recovery (Phase 6 contract)   |
| `doubts_sessionId_enqueueSeq_key` (unique)        | one doubt per (session, enqueueSeq)                               | ordering-key uniqueness                              |
| `doubts_client_request_key` (partial)             | retried create with the same clientDoubtId                        | create idempotency backstop (hand-written SQL)       |
| `doubts.participantId`                            | a participant's doubts                                            | moderation/history                                   |
| `session_participants.userId`                     | all sessions a user participates in                               | user-centric listing                                 |

Uniques also create implicit indexes: `(sessionId,userId)` on
`session_participants`, `(quizId,position)` on `questions`,
`(questionId,participantId,attemptNumber)` on `answers`, and
`users.displayName` (Phase 3 identity seam).

> Note: partial unique indexes are hand-completed in migration SQL because
> Prisma cannot express them in its DSL: the Phase 3 winner / one-published-
> question indexes (`20260922191225_phase3_quiz_and_winner`) and the Phase 6
> doubt idempotency index (`20260925120000_phase6_doubt_queue`).
> `prisma migrate diff` reports the drift harmlessly. Reason documented per
> the AGENT.md migration rule.

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
- Redis: only ephemeral/reconstructible state — cross-instance pub/sub
  notices (Phase 4) and connection-local frame rendering. It is **not** queue
  storage: the doubt queue's ordering lives in `doubts.enqueueSeq` (Phase 6,
  ADR-007). Nothing durable depends on Redis.
