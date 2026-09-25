# ADR-007: Doubt Queue — PostgreSQL-Enforced Ordering via a Per-Session Enqueue Sequence

- **Status:** Accepted and implemented (Phase 6)
- **Date:** 2026-09-25
- **Supersedes:** ADR-002's deferral of doubt ordering ("no sequence column
  yet"; "Redis will hold the live queue"). The queue lives in PostgreSQL —
  Redis is notification only.
- **Related:** ADR-003 (ephemeral, connection-keyed registry), ADR-004
  (first-correct-answer election), ADR-005 (Redis Pub/Sub boundary),
  ADR-006 (reconnect recovery), `docs/architecture/doubt-queue.md` (full
  design + guarantee), `docs/testing/doubt-queue.md` (evidence)

## Context

Students must raise doubts during a live session and teachers must work the
queue. The hard part is not CRUD: it is defining what "FIFO" means when two
students submit at the same time on **different WebSocket instances**.

Network arrival order is not global. Wall-clock timestamps are not monotonic
and can tie. UUIDv7 ids carry an app-side clock, not a server acceptance
point. Redis Pub/Sub ordering is per-publisher and at-most-once. The project's
own rules (AGENT.md §7, §17) require a **server-side, atomic ordering point**
and forbid claiming FIFO merely because requests "usually arrive in order".

## Options

1. **`createdAt` timestamptz only.** Rejected: wall clock; equal values under
   concurrency; not monotonic across instances.
2. **UUIDv7 id as the order.** Rejected as the ordering point: generated
   app-side from a local clock + random tail, not a server acceptance event,
   and not comparable across instances under skew. (Kept as the PK
   convention.)
3. **Global `BIGSERIAL`/identity sequence column.** Viable, but the value is
   allocated at INSERT and becomes visible at COMMIT: two concurrent inserts
   can become visible in the opposite order to their sequence values, so a
   reader can momentarily see a higher sequence before a lower one that
   commits a moment later. It also leaks global cross-session volume if the
   value is exposed.
4. **Per-session counter allocated under the session row lock (chosen).**
   `sessions.doubtSeq` is incremented in the same transaction that inserts the
   doubt, while holding `SELECT ... FOR UPDATE` on the session row. The lock is
   held until COMMIT, so sequence order equals durable acceptance order.
5. **Commit-derived (`pg_xact_commit_timestamp`, `xmin`).** Rejected: requires
   non-default configuration, opaque, not a clean monotonic API.
6. **Redis ordering.** Rejected by the ADR-005 boundary: Redis is a lossy
   hint channel, never truth.

## Decision

Order doubts by **`(priority DESC, enqueueSeq ASC)` over `status = OPEN`**,
where `enqueueSeq` is a per-session monotonically increasing integer assigned
by PostgreSQL inside the accepting transaction under the session row lock.

```
T1                                     T2
│ lock session                         │ (waits)
│ doubtSeq := 41                       │
│ insert enqueueSeq = 41               │
│ COMMIT ───────────────────────────►  │ lock acquired
                                       │ doubtSeq := 42
                                       │ insert enqueueSeq = 42
                                       │ COMMIT
```

Hence `enqueueSeq` 41 < 42 **and** 41 committed before 42 — the ordering is
real acceptance order, not an allocation artifact.

### Precise guarantee

> **"FIFO" means ascending PostgreSQL-assigned `enqueueSeq` within a session,
> among OPEN doubts, after applying priority ordering.** It does **not** mean
> network arrival order, wall-clock order, UUIDv7 order, or Redis delivery
> order. Ordering is a total order with no ties and no gaps within a session,
> established by the database at durable acceptance.

Supporting choices:

- **`enqueueSeq` is server-owned.** No client schema accepts `enqueueSeq` or
  `priority`; a client can never set its own position.
- **Priority is in the order key from day one** but there is no bump operation
  yet (deferred): a later `doubt.bump` is a single-row `priority + 1` UPDATE —
  never positional arithmetic (`queuePosition - 1`), which would race.
- **Transitions are conditional on `status = OPEN`**, so concurrent resolve
  and dismiss cannot both apply; exactly one terminal state wins.
- **Idempotency is checked inside the lock.** A retried `doubt.create` carrying
  the same `clientDoubtId` resolves to the existing row; the check happens
  after the session row is locked and before the sequence is incremented, so
  two concurrent retries cannot both insert.
- **Redis only notifies.** `doubt.created` / `doubt.resolved` /
  `doubt.dismissed` cross Redis as post-commit notices; receivers render
  frames. The queue is never read from or written to Redis.

## Why

- The ordering point is the database transaction that durably accepts the
  doubt, so the guarantee survives concurrent execution across instances — the
  same property that made the Phase 3 winner election correct.
- It is PostgreSQL-native: no extra service, no wall clock, no application
  mutex, no Redis dependency, no event log.
- Per-session numbering keeps the token meaningful in the client's context and
  avoids leaking other sessions' volume.

## Trade-offs

- **Creates for one session serialize on the session row lock.** At classroom
  scale (tens to a few hundred) each step is a row-lock + two statements; a
  100-way burst serializes in well under a second (measured in the test suite).
  The alternative (global sequence) is faster but loses the strict
  commit-order/visibility property, so this is a deliberate
  throughput-for-strictness trade.
- **The session row is shared** with session state transitions, which briefly
  contend with doubt creates. Negligible at this scale; documented.
- **`enqueueSeq` gaps are not expected within a session** (allocation happens
  only on insert, under the lock), but a rolled-back transaction that already
  incremented would leave a gap — acceptable because only relative order
  matters, not density. (The current path increments and inserts in the same
  transaction, so it does not produce gaps in practice.)
- **Snapshot payload grows** on join; bounded by a cap (below), not by queue
  capacity.

## Consequences

- Clients become simple: order by the key they are handed; never infer order
  from arrival.
- Recovery (ADR-006) extends naturally: `recovery.doubts.open` is the OPEN
  queue in canonical order, capped at 100 as a **payload bound** — the
  database keeps every row, and `truncated` reports the cap.
- `doubt.queue.updated` is an explicit, private convenience read; it is not a
  source of truth and not required for correctness (a lost response is
  corrected by recovery).
- Deferred by design: `doubt.bump`, `doubt.cancel`, resolver audit fields,
  per-session Redis channels, pagination beyond the recovery cap.
