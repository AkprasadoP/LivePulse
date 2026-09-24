# Concurrency Testing — First-Correct-Answer Race (Phase 3)

> Scope: how the "exactly one winner" guarantee is demonstrated empirically.
> This is a **correctness demonstration, not a benchmark** — no latency or
> throughput claims are made, and none of the numbers below should be read
> as performance targets.

## 1. The race condition

Multiple students submit (correct) answers to the same published question at
the same time:

```
Student A ── correct answer ──┐
                              │
Student B ── correct answer ──┼──> server ──> PostgreSQL
                              │
Student C ── correct answer ──┘
```

Even in a single Node process, answer handlers run _concurrently_: each one
`await`s database I/O, so the steps of two handlers interleave. A
check-then-act election ("count winners; if 0, mark me winner") has a window
between the check and the write in which two handlers both see zero winners.
The required invariants:

- `winner count ≤ 1` for every question — always;
- `winner count = 1` whenever at least one valid correct submission exists;
- every valid answer is persisted exactly once (with its own verdict);
- a question close concurrent with submissions must never produce an answer
  persisted after the close, or a lost close.

The mechanism under test is documented in `docs/decisions/004` — the
transaction serializes on `FOR NO KEY UPDATE` of the question row and the
partial unique index `answers_one_winner_per_question_key` backstops the
invariant at the schema level.

## 2. Test setup

`tests/integration/concurrency.test.ts` runs against the real Dockerized
PostgreSQL and a **real WebSocket server** (no mocks, no `app.inject` for the
race itself):

- `startListeningServer()` boots the actual Fastify + `ws` stack on an
  ephemeral port; clients are real `ws` connections.
- Each race run creates a fresh session/quiz through the real HTTP API
  (`createLiveQuizScenario`), starts the quiz and publishes one question
  **with strict serialization** — the test awaits `quiz.started` before
  sending `question.publish`, because publish validates quiz state at
  processing time (a lesson recorded here deliberately: back-to-back teacher
  operations race their own state transitions).
- `N` student connections join with unique display names; each then sends
  `quiz.answer` **in the same event-loop tick** (back-to-back `send()` calls
  across N sockets), so frames arrive interleaved on the server — genuine
  single-process concurrency, as close to simultaneous as one client machine
  allows.

**Synchronization method:** the release tick is the synchronization point
(all sends are issued without awaiting anything between them). On the server
side, correctness is provided by the database row lock, not by the test.
Completion is awaited with `waitForAsync` polling the DB until **all N
answers** have persisted — not merely until the winner exists, which would
race the queue of submissions still serialized behind the row lock.

**Client counts:** 10, 50, 100 (the 100 race is repeated three times within
one test to shake out ordering luck), plus a mixed run of 20 (10 correct /
10 incorrect interleaved).

## 3. Assertions per run

1. Total answers for the question == N (every submission persisted exactly
   once — counts are scoped to the run's `questionId`, since repeated runs
   accumulate rows across questions).
2. Winners == 1; the winner row has `isCorrect = true`.
3. Losers == N − 1, all `isWinner = false`.
4. Mixed run: correct == 10, incorrect == 10, winners == 1.
5. No broadcast frame ever shows two winners in one `leaderboard.updated`.

## 4. Actual results

Environment: macOS dev machine, Dockerized PostgreSQL 17, all suites local.
Final green run of `tests/integration/concurrency.test.ts` (4 tests):

| Test                                                                | Result  | Wall time |
| ------------------------------------------------------------------- | ------- | --------- |
| 10 simultaneous correct answers → exactly one winner                | ✅ pass | ~0.24 s   |
| 50 simultaneous correct answers → exactly one winner                | ✅ pass | ~0.48 s   |
| 100 simultaneous correct answers → exactly one winner (repeated 3×) | ✅ pass | ~3.3 s    |
| Mixed 20 (10 correct / 10 incorrect) → single winner                | ✅ pass | ~0.1 s    |

The 3×100 test includes **300 WebSocket connections, 300 joins and 3 full
scenario setups** — that whole pipeline completing in ~3.3 s bounds the
per-submission serialization cost empirically: the row lock is held for the
duration of one small transaction, and even 100 submitters drain in well
under a second per race. Durations vary run to run (all observed values
fell in the ranges above ±20%); **the winner invariants held on every run**,
which is the point of the suite.

Full-suite status at documentation time: unit **49/49**, integration
**83/83** (9 files, including this suite), typecheck and build clean.

## 5. Why this demonstrates correctness

The database — not the test — enforces the invariant, so the test can only
_fail to detect_ a violation, not create one. Specifically:

- The partial unique index makes `winner ≥ 2` physically impossible; any
  bug reaching the index aborts a transaction (visible as an error/missing
  answer) rather than corrupting state.
- The row lock makes the _empirical_ assertions meaningful: since
  submissions serialize, "exactly one winner and N − 1 persisted losers"
  after all N complete is exactly the expected post-state; a broken
  election (e.g. `FOR SHARE` variant, or unlocked check-then-act) would show
  either aborted transactions (lost answers → assertion 1 fails) or a lost
  winner (assertion 2 fails).
- Repeating the 100-race three times and running the suite many times during
  development covers different interleavings; the failure mode of the naive
  implementation is timing-dependent, which is precisely why the suite
  exists.

## 6. Known test-infrastructure lessons (recorded honestly)

Two test bugs were found and fixed while building this suite; they are
documented because they are exactly the mistakes future suites will make:

1. **Waiting for the winner instead of all answers** — the winner commits
   first (it wins the lock), so a wait predicate of "1 winner exists"
   resumed the test while submissions 5..N were still queued; the "all N
   persisted" assertion then failed spuriously. Wait for the _full_ expected
   post-state.
2. **Unscoped counts across repeated runs** — the 3×100 test runs three
   races without resetting; a global `answer.count()` can never equal 100.
   All counts are scoped to the run's question.

`resetDatabase()` also retries `TRUNCATE` on PostgreSQL deadlock (40P01) a
few times: a teardown racing a still-draining server transaction is an
infrastructural race, never a correctness signal.

## 7. What this does not claim

- Nothing here measures throughput or latency at scale (Phase 10 load tests,
  with k6 and multiple instances, will).
- Nothing here covers multi-instance behavior — Redis Pub/Sub does not exist
  yet; the election is explicitly designed (ADR-004) so that later phases do
  not need to move it.
