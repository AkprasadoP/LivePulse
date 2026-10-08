# Recovery Testing — Phase 5

## Approach

Same rules as every other LivePulse suite (see `websocket-testing.md`):
real PostgreSQL, real Redis, **real sockets**, no mocks of the database or
the WebSocket layer. The recovery suite
(`tests/integration/recovery.test.ts`) additionally uses two **independent
instances** (WS-A / WS-B) from `helpers.startIndependentInstance` so the
reconnect-to-a-different-instance path is exercised literally, not
simulated.

Determinism: tests synchronize on server frames (`WsTestClient.waitFor`)
and database reads (`waitForAsync`), not sleeps. The two deliberate
short settling windows (300 ms) guard "no duplicate frame" assertions —
documented below — because the claim being tested is the _absence_ of
frames after an event, which no positive signal can terminate early.

## Failure experiments covered

| #   | Experiment                                                    | Scenario   |
| --- | ------------------------------------------------------------- | ---------- |
| A   | Client socket destroyed mid-session, reconnects               | R1, R2     |
| B   | Instance WS-A stops entirely (graceful close of all sockets)  | R10        |
| C   | Client reconnects to WS-B (never to the origin instance)      | R2, R10    |
| D   | Several Redis Pub/Sub notifications missed while disconnected | R3, R8     |
| E   | State recovered from PostgreSQL only                          | R3, R8, R9 |

## Scenarios (implemented in `tests/integration/recovery.test.ts`)

- **R1 — basic disconnect/reconnect.** Join on WS-A, destroy the socket,
  reconnect (same instance), re-join: same `participantId`, snapshot
  present.
- **R2 — cross-instance reconnect.** Join on WS-A, destroy, reconnect to
  WS-B: `session.joined.recovery` reflects PostgreSQL; the client then
  answers a live question on WS-B and the teacher (on WS-A) receives the
  verdict + leaderboard — participation continues on the new instance.
- **R3 — state recovery after missed events.** Question published while the
  student is disconnected; on rejoin `recovery.question.state` is
  `PUBLISHED` with prompt and `acceptingAnswers: true`, without the student
  having seen `question.published`.
- **R4 — reconnect during an active quiz.** Quiz started while away →
  `recovery.quizzes[0].state: "ACTIVE"`; the student can answer normally
  after rejoining.
- **R5 — reconnect after question closure.** Question published _and_
  closed while away → `recovery.question.state: "CLOSED"`,
  `acceptingAnswers: false`, final standings in `recovery.standings`, and a
  late answer is rejected with `QUESTION_NOT_ACCEPTING_ANSWERS`.
- **R6 — retry after lost answer response.** The answer commits, the
  verdict frame is lost with the dying socket; on rejoin
  `recovery.ownAnswer` carries the stored verdict (correct/winner), and a
  resubmission replays it (`answer.accepted` with the same verdict) without
  a second broadcast.
- **R7 — duplicate submission after reconnect.** Two connections bound to
  the same authenticated user; the duplicate socket's answer is an
  idempotent replay; `answers` count stays 1 and the winner count stays 1
  (DB-level).
- **R8 — multiple missed events.** Quiz started, question published,
  question closed, leaderboard accumulated — all while disconnected. One
  rejoin returns all of it: quiz `ACTIVE`, question `CLOSED`, standings
  with both participants.
- **R9 — Redis unavailable during reconnect.** Recovery scenario runs
  against a `distributionEnabled: false` instance (Redis untouched by the
  recovery path) — join, snapshot, answer, verdict all work; PostgreSQL is
  the only thing recovery reads.
- **R10 — instance A unavailable → reconnect to B.** The full Phase 5
  completion criterion end-to-end: participate on WS-A, WS-A closes
  (graceful shutdown kills sockets), client reconnects to WS-B, recovers
  the authoritative state, and continues participating on WS-B — with a
  fresh client proving the resumed delivery path.
- **R11 — no duplicate state frames from recovery.** A watching client
  observes exactly one `session.joined` and one `session.state` per join on
  the recovering connection, and broadcast counts for a subsequent event
  match a non-recovering baseline — recovery adds no replay channel.
- **R12 — pre-existing guarantees intact** is covered by _not touching_
  them: the full Phase 1–4 suites (`concurrency`, `distributed`, `quiz-flow`,
  …) run unchanged and green alongside the new suite.

## What is asserted about guarantees

- Convergence to PostgreSQL state at rejoin — every scenario above.
- The exact honest delivery claim: reconnecting clients reconcile against
  authoritative PostgreSQL state; missed transient frames are NOT replayed
  (R11 asserts no replay channel exists).
- Duplicate submissions remain idempotent across reconnects (R6, R7).

## Running

```bash
pnpm db:up                  # PostgreSQL 5433 + Redis 6380
pnpm db:test:setup          # once
pnpm test:integration       # everything incl. recovery
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/recovery.test.ts
```

## Not covered (deliberate)

- Violent `SIGKILL` of an instance process (Phase 11 failure drills; here a
  graceful stop exercises the same recovery path).
- Load-scale reconnect storms (Phase 10, k6).
- **Record continuity is keyed by the authenticated userId** — see
  `docs/architecture/recovery.md` §5.
