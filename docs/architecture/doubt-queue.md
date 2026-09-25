# Doubt Queue — Phase 6

> **Status: implemented (Phase 6).** This document describes only what exists
> and is tested. Per AGENT.md's honesty rule, deferred items are labeled as
> such. Decision record: ADR-007; test evidence: `docs/testing/doubt-queue.md`.

## 1. The problem

Students raise doubts during a live class; a teacher works the queue. The
system must stay correct when **100 students submit simultaneously across
WS-A and WS-B**. The queue must be durable (PostgreSQL), ordered by an explicit
contract (not network arrival), and updated in real time (Redis notification +
local broadcast).

```
Student(s) ──► WS-A / WS-B ──► validate ──► PostgreSQL tx ──► COMMIT
                                              │
                                   local broadcast + Redis notice ──► all instances
```

## 2. Ordering contract (the core)

**Canonical order:** `(priority DESC, enqueueSeq ASC)` over `status = OPEN`.

> **FIFO means ascending PostgreSQL-assigned `enqueueSeq` within a session,
> among OPEN doubts, after applying priority ordering.** It does not mean
> network arrival order, wall-clock order, UUIDv7 order, or Redis delivery
> order.

`enqueueSeq` is a **per-session monotonic integer** assigned by PostgreSQL
inside the accepting transaction while the session row is locked
(`SELECT ... FOR UPDATE`), so the lock is held until COMMIT and sequence order
equals durable acceptance order:

```
T1: lock session → doubtSeq := 41 → insert enqueueSeq=41 → COMMIT
T2:            (waits) → lock session → doubtSeq := 42 → insert enqueueSeq=42 → COMMIT
⇒ 41 < 42 and 41 committed first. Ordering is real acceptance order.
```

Properties:

- **No ties:** `UNIQUE (sessionId, enqueueSeq)`.
- **No gaps in practice:** allocation and insert share one transaction.
- **Server-owned:** no client schema accepts `enqueueSeq` or `priority`.
- **Instance-agnostic:** the sequence comes from a shared PostgreSQL row, so
  clients on any instance agree on the order.

Alternatives rejected (wall clock, UUIDv7 alone, global `SERIAL`, commit
timestamp, Redis order) are evaluated in ADR-007.

## 3. Data model (PostgreSQL only)

`doubts` (new/changed columns in bold):

| Field                   | Type                                          | Notes                                                    |
| ----------------------- | --------------------------------------------- | -------------------------------------------------------- |
| `id`                    | UUID PK                                       | uuidv7                                                   |
| `sessionId`             | UUID → sessions                               | Cascade                                                  |
| `participantId`         | UUID → session_participants                   | Cascade                                                  |
| `content`               | text                                          | 1..1000 chars (Zod)                                      |
| **`enqueueSeq`**        | int                                           | **ordering authority**; `UNIQUE (sessionId, enqueueSeq)` |
| `priority`              | int default 0                                 | in the order key; bump deferred                          |
| **`doubtRequestId`**    | varchar(64) nullable                          | **client idempotency key** (partial unique, below)       |
| `status`                | `DoubtStatus` (`OPEN`,`RESOLVED`,`DISMISSED`) | default `OPEN`                                           |
| `resolvedAt`            | timestamptz nullable                          | terminal timestamp (both RESOLVED and DISMISSED)         |
| `createdAt`,`updatedAt` | timestamptz                                   | diagnostic only, never ordering                          |

`sessions` gains **`doubtSeq` int default 0** — the per-session counter locked
and incremented at acceptance.

Indexes (justified):

| Index                                                                                                                 | Query it supports                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `doubts_sessionId_status_priority_enqueueSeq_idx` `(sessionId, status, priority DESC, enqueueSeq ASC)`                | the queue read: OPEN doubts of a session in canonical order (teacher view, recovery, list) |
| `doubts_sessionId_enqueueSeq_key` unique                                                                              | ordering-key uniqueness per session                                                        |
| `doubts_client_request_key` **partial** `(sessionId, participantId, doubtRequestId) WHERE doubtRequestId IS NOT NULL` | create idempotency backstop (hand-written; Prisma cannot express partial indexes)          |
| `doubts.participantId`                                                                                                | a participant's doubts (history/moderation)                                                |

`queue position` is **derived** (rank on read) and never stored.

## 4. Lifecycle

```
OPEN ──► RESOLVED   (teacher answers; terminal)
  └───► DISMISSED   (teacher clears noise; terminal)
```

- Terminal states are final; there is no reopen.
- A participant may raise multiple OPEN doubts.
- Rows are never deleted; resolved/dismissed is durable history.
- Every transition is a single conditional UPDATE (`WHERE status = 'OPEN'`), so
  concurrent resolve/dismiss cannot both apply.

## 5. Authorization (server-side)

| Event                             | Requires                                                               |
| --------------------------------- | ---------------------------------------------------------------------- |
| `doubt.create`                    | joined + bound participant (any role) + session `LIVE`                 |
| `doubt.resolve` / `doubt.dismiss` | joined + participant + `TEACHER` + doubt belongs to the joined session |
| `doubt.queue.list`                | joined (view-only allowed)                                             |

Session ownership comes from `connection.joinedSessionId`, never the payload.
A doubt from another session is indistinguishable from an unknown id
(`DOUBT_NOT_FOUND`), leaking nothing.

## 6. WebSocket events

Client → server: `doubt.create { content, clientDoubtId? }`,
`doubt.resolve { doubtId }`, `doubt.dismiss { doubtId }`,
`doubt.queue.list {}`.

Server → client:

| Event                 | Direction                                  | Payload                                                                                                          |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `doubt.created`       | session broadcast (requestId echoed)       | `{ sessionId, doubt { doubtId, participantId, displayName, content, priority, enqueueSeq, status, createdAt } }` |
| `doubt.resolved`      | session broadcast                          | `{ sessionId, doubtId, status:"RESOLVED", resolvedAt }`                                                          |
| `doubt.dismissed`     | session broadcast                          | `{ sessionId, doubtId, status:"DISMISSED", resolvedAt }`                                                         |
| `doubt.queue.updated` | **private** response to `doubt.queue.list` | `{ sessionId, doubts[], truncated }`                                                                             |

Design notes:

- **Granular events, not full-queue-on-every-update.** Because a default-
  priority create appends (and no reordering exists while bump is deferred),
  clients keep order locally from `doubt.created` + terminal events.
- `enqueueSeq` is the ordering token; full ordered arrays appear only in
  snapshots (recovery / list).
- `doubt.created` is idempotent on retry: a duplicate `clientDoubtId` re-sends
  the stored doubt **privately** and never re-broadcasts.
- New error codes: `DOUBT_NOT_FOUND`, `DOUBT_NOT_OPEN`.

## 7. Concurrency

| Situation                            | Mechanism                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| N concurrent creates (any instances) | session row lock serializes; each gets a distinct `enqueueSeq`                             |
| Duplicate/retried create             | in-lock `doubtRequestId` lookup; partial unique index backstop                             |
| Two teachers resolve the same doubt  | `UPDATE ... WHERE status='OPEN'`; exactly one row updated, the other gets `DOUBT_NOT_OPEN` |
| Resolve racing dismiss               | same conditional UPDATE; exactly one terminal state                                        |
| Cross-session attempt                | `WHERE sessionId = <connection's session>`                                                 |

No application mutex, no Node event-loop assumption, no Redis ordering.

## 8. Redis distribution

`doubt.created`, `doubt.resolved`, `doubt.dismissed` are added to the Phase 4
notice set (`DISTRIBUTED_EVENT_TYPES`). Flow is unchanged: commit → local
broadcast → publish; the receive path is read-only, echo-suppressed,
at-most-once. `doubt.queue.updated` and the recovery snapshot are
connection-local and never distributed. Redis delivery order is irrelevant:
receivers order by `payload.doubt.enqueueSeq`.

## 9. Recovery integration (ADR-006)

`session.joined.recovery` gains a `doubts` section:

```jsonc
"doubts": {
  "open": [ { "doubtId", "participantId", "displayName", "content", "priority", "enqueueSeq", "status":"OPEN", "createdAt" } ],
  "truncated": false
}
```

- Read from PostgreSQL in canonical order; only OPEN doubts (terminal history
  is not current state).
- Capped at `DOUBT_SNAPSHOT_LIMIT = 100` — a **payload bound, never a capacity
  limit**: the database keeps every row and `truncated` reports the overflow.
- `recovery` is `null` only when the session has neither quizzes nor open
  doubts (a doubt-only session still gets a snapshot).

## 10. What is and is not guaranteed

**Guaranteed (tested):**

- Every accepted doubt gets a unique per-session `enqueueSeq`; concurrent
  creates across instances yield a dense 1..N ordering (100-way test).
- Canonical reads return the strict total order `(priority DESC, enqueueSeq ASC)`.
- A retried create (same `clientDoubtId`) creates no second row and does not
  re-broadcast; concurrent identical retries create exactly one row.
- Concurrent resolve/resolve and resolve/dismiss leave exactly one terminal
  state and one broadcast.
- Mutations propagate cross-instance; authorization is server-enforced.
- Recovery converges the client to the authoritative OPEN queue.

**Not guaranteed (by design):**

- No durable delivery/replay of queue events (Phase 5 contract applies: clients
  reconcile against PostgreSQL).
- No strict global cross-session order (ordering is per session).
- No `doubt.bump` / `doubt.cancel` / resolver audit (deferred).

## 11. Observability (minimum)

- `WebSocket doubt created` (with `enqueueSeq`), `WebSocket doubt transitioned`,
  `WebSocket duplicate doubt replay` — enough to trace ordering and retries.
- No metrics/counters yet (a later phase).
