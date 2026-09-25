# Doubt Queue Testing — Phase 6

## Approach

Same rules as every LivePulse suite (`websocket-testing.md`): real PostgreSQL,
real Redis, **real sockets**, no mocks of the database or the WebSocket layer.
The suite (`tests/integration/doubt-queue.test.ts`) uses two **independent
instances** (WS-A / WS-B) so cross-instance ordering and propagation are
executed literally.

Determinism: tests synchronize on server frames (`WsTestClient.waitFor`) and
database reads (`waitForAsync`), not sleeps. The only settles (300 ms) guard
"exactly one broadcast" assertions, whose claim is the _absence of extra_
frames — nothing positive can terminate them early.

## The decisive test: Q3 (100-way cross-instance create race)

```
100 students half on WS-A, half on WS-B
        ↓  all send doubt.create with no interleaved awaits
   PostgreSQL (session row lock serializes)
        ↓
enqueueSeq must be exactly {1, 2, …, 100}  — no duplicates, no gaps
```

This is where the design is not merely conceptually correct but proven under
concurrent execution: the session row lock makes the sequence a real
acceptance order, and the dense 1..N result shows every create was accepted
exactly once. It completes in ~0.5 s.

## Scenarios

- **Q1 — create broadcast + durable row.** `doubt.created` reaches the session
  with `enqueueSeq: 1`, content, author; PostgreSQL has exactly one OPEN row.
- **Q2 — cross-instance create.** Created on WS-A, observed on WS-B with
  `requestId: null` (server-initiated remote frame).
- **Q3 — 100 concurrent creates across both instances.** See above; asserts the
  dense 1..N sequence and that the canonical read is a strict total order.
- **Q4 — idempotent retry.** Same `clientDoubtId` twice → one row, same
  `doubtId`, one broadcast only (the retry is a private replay).
- **Q5 — concurrent identical retries.** Two sockets on the same participant,
  same `clientDoubtId`, fired simultaneously → exactly one row (the in-lock
  check serializes them).
- **Q6 — resolve race.** Two teachers resolve the same doubt → exactly one
  succeeds (`RESOLVED`, `resolvedAt` set), the other gets `DOUBT_NOT_OPEN`; a
  watcher sees exactly one `doubt.resolved`.
- **Q7 — resolve vs dismiss race.** Concurrent resolve + dismiss → exactly one
  terminal state on the single row.
- **Q8 — authorization.** A student resolving a doubt gets `TEACHER_REQUIRED`
  and the doubt stays `OPEN`.
- **Q9 — cross-session ownership.** A teacher of session B resolving a doubt of
  session A gets `DOUBT_NOT_FOUND`; the doubt is unchanged.
- **Q10 — non-LIVE session.** `doubt.create` before the session is LIVE →
  `SESSION_NOT_LIVE`, nothing persisted.
- **Q11 — recovery cap.** 101 OPEN doubts; recovery returns 100 in canonical
  order with `truncated: true`, while PostgreSQL still holds all 101 (the cap
  is a payload bound, not capacity).
- **Q12 — private queue listing.** `doubt.queue.list` returns the ordered OPEN
  queue to the requester only; no broadcast.
- **Q13 — cross-instance resolve.** Resolve on WS-A propagates to WS-B with the
  terminal status.

## Running

```bash
pnpm db:up                  # PostgreSQL 5433 + Redis 6380
pnpm db:test:setup          # once
pnpm test:integration       # everything incl. doubt queue
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/doubt-queue.test.ts
```

## Not covered (deliberate)

- `doubt.bump` and `doubt.cancel` (not implemented; see ADR-007).
- Load-scale queue storms (k6, a later phase).
- Pagination beyond the recovery cap.
- Person-level identity (displayName seam; ADR-006 §5).
