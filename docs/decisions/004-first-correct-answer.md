# ADR-004: First-Correct-Answer Election — PostgreSQL Row Lock + Partial Unique Index

- **Status:** Accepted (Phase 3)
- **Date:** 2026-09-24
- **Supersedes:** none
- **Related:** ADR-002 (domain schema), `docs/api/websocket-protocol.md`
  (ordering + idempotency sections), `docs/testing/concurrency.md`

## Context

Phase 3 makes the quiz live: many students can submit answers concurrently,
and the product promise is "first correct answer wins". Concretely:

```
Student A ── correct answer ──┐
                              │
Student B ── correct answer ──┼──> server
                              │
Student C ── correct answer ──┘
```

The system must guarantee **winner count ≤ 1** per question, and when at
least one valid correct submission exists, **winner count = 1**. Node.js runs
one event loop, but the danger is real: multiple handler invocations await
database I/O _concurrently_, so any check-then-act sequence split across
`await` points interleaves. A naive implementation —

```ts
const winnerCount = await countWinners(questionId);
if (winnerCount === 0) {
  await insertAnswer({ ..., isWinner: true }); // ← race window
}
```

— lets two concurrent submitters both observe `winnerCount === 0` before
either INSERT commits, electing two winners. The bug would appear rarely,
under load, and never in a debugger.

Phase 2 deliberately kept the WS layer read-only. This phase relaxes that
for exactly one write path — answer submission — and the mechanism must be
demonstrably correct, not merely convenient.

## Options

**Option A — PostgreSQL: the winning INSERT is the election.**
An answer row carries `isWinner`; a _partial unique index_
`answers_one_winner_per_question_key ON answers (questionId) WHERE isWinner`
makes "two winners for one question" a constraint violation the database
itself refuses. Correctness does not depend on any sequence of reads.

**Option B — Redis `SET NX` per question.**
`SET quiz:winner:<questionId> <participantId> NX` grants winner status to
exactly one caller. Fast, atomic — but it is a _second_ state store: the
election then lives in Redis while the answer lives in PostgreSQL, and crash
windows between the two stores become real. Redis arrives in Phase 4 for
pub/sub; electing winners there before the durable path is proven would put
the hardest invariant in the newest layer.

**Option C — In-process mutex / single-flight queue.**
Node is single-threaded, so a lock around the election would "work" — inside
one process. It converts a distributed-correctness problem into a
process-local assumption that Phase 5 (multi-instance) would silently break.
Also does nothing for the close-during-submit race, which is a _database_
ordering question.

**Option D — Optimistic: unique index only, no lock.**
Just INSERT with `isWinner = true` for the first correct submission and
retry on constraint violation. This alone is actually correct for the winner
invariant — but it elects the winner and _persists_ only one participant
atomically; the losers' persistence then happens in separate transactions
that must re-derive "already lost" correctly, and the close-during-submit
window still needs explicit handling. We keep the index as backstop but
serialize explicitly (below) so both invariants share one mechanism.

## Decision

**Option A, concretely:** every submission runs in a single PostgreSQL
transaction that:

1. `SELECT ... FOR NO KEY UPDATE` the question row — submitters serialize
   against each other **and** against the close transition, which is a
   writer on the same row. `FOR SHARE` was evaluated and rejected: shared
   locks are _compatible with each other_, so two submitters would both
   proceed to the winner index and the loser would abort with its answer
   unpersisted — exactly the failure we must not have.
2. Re-checks the question state under the lock. Not `PUBLISHED` → the
   submission is rejected and nothing is persisted. This closes the
   close-during-submit window atomically: either close-then-submit (rejected)
   or submit-then-close (answer persisted first) — never both, never neither.
3. Detects duplicates: an existing `(questionId, participantId,
attemptNumber = 1)` row means a retry arrived after a committed first
   submission → replay the stored verdict (idempotency; see protocol doc).
4. Computes correctness server-side against the stored `correctAnswer`
   (client-trusted correctness is never a thing).
5. Persists **every valid answer** (correct, incorrect, ungraded), electing
   at most one winner: for a correct answer, count existing winners (0 under
   the lock, by construction) and set `isWinner` accordingly. The partial
   unique index stays as defense-in-depth — the invariant survives even a
   future code path that skips the lock.

`attemptNumber` exists in the schema for future multi-attempt modes; this
phase always writes 1 and treats any second attempt as a duplicate replay.

### Why this is atomic

The election is not a check-then-act pattern across awaits; it is the
_commit order of mutually serialized transactions_. The question row lock
orders all submitters; the winner INSERT of the first committer is the
election event; every later transaction reads committed state (the winner
already exists) and persists itself as a loser. "First correct answer" is
thereby defined by lock acquisition + commit — a database-defined total
order, not by client send time or Node arrival order. The protocol doc's
"Ordering" section documents this definition explicitly.

### Failure behavior

- **Crash mid-transaction:** the transaction aborts atomically — no answer,
  no winner. The client may retry; duplicate handling makes that safe.
- **Response lost after commit:** the answer is durable; the verdict was
  elected; a resubmission replays the stored verdict. Server-side success
  and client-side acknowledgement are deliberately different things
  (protocol doc, §7).
- **Close during submission:** resolved by the row lock, per (2).
- **Database unavailable:** submissions fail; no degraded "memory election"
  fallback exists — we prefer refusing to electing wrongly.

## Trade-offs

- **Throughput per question is serialized** by design: one row lock means
  one write transaction at a time per open question. For a classroom (tens
  of concurrent submitters, sub-millisecond lock hold times — measured in
  `docs/testing/concurrency.md`) this is irrelevant; a global leaderboard
  hotspot would not be, and Redis-based ranking arrives only if/when data
  says so.
- **Raw SQL inside Prisma** for the row lock (Prisma cannot express `FOR NO
KEY UPDATE`); the query is four lines and commented.
- **Read-then-insert under lock** rather than an `INSERT ... WHERE NOT
EXISTS` trick: the lock is also what makes close-vs-submit atomic; one
  mechanism, one explanation.
- **`INTERNAL_ERROR` risk on any bug** is contained: the partial unique
  index turns "two winners" into a failed transaction instead of a corrupted
  state.

## Why appropriate at this stage

It proves the concurrency model on the single instance _without_ adding a
second state store, uses the invariant-bearing tool we already trust
(PostgreSQL constraints, per ADR-002), and yields a clean seam for Phase 4:
Redis Pub/Sub can fan out events across instances later without owning the
election at all — each instance keeps submitting through PostgreSQL, and the
database remains the single arbiter.

## Consequences

- `winner count ≤ 1` is enforced by the schema, not by discipline.
- Answer submission is the WS layer's first (and only) DB write; the "WS is
  read-only" note in ADR-003 is amended by this ADR for this path.
- Concurrency tests (10/50/100 simultaneous submissions, repeated runs)
  demonstrate exactly-one-winner empirically on every run.
