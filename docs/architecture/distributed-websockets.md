# Distributed WebSockets — Design & Implementation (Phase 4)

> **Status: implemented (Phase 4).** Redis Pub/Sub distribution is live: the
> `redis` client is in `package.json`, `src/infrastructure/redis/` owns the
> two connections (publisher + subscriber), `src/ws/distribution.ts` is the
> boundary module, and the handlers publish post-commit notices. Two
> independent instances sharing the compose PostgreSQL + Redis pass the
> cross-instance integration suite (`tests/integration/distributed.test.ts`).
> §2–§14 below retain the design reasoning; where implementation chose a
> different shape, the divergence is stated in place.
>
> Still future-work (unchanged): Dockerized multi-instance compose (Phase 6
> per the plan — tests spawn independent in-process instances today),
> reconnect/recovery snapshots (Phase 7), and the failure drills (Phase 11;
> §13 defines them, none executed yet).

## 0. The three kinds of state (the distinction everything else rests on)

| Kind                           | Owner                        | Survives restart?          | Examples                                                                                           | May enter Redis?                                |
| ------------------------------ | ---------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Durable business state**     | PostgreSQL                   | yes                        | users, sessions, participants, quizzes, questions, answers (+ winner), doubts; every state machine | **No.** Never copied, never cached (this phase) |
| **Ephemeral connection state** | each WS process, in memory   | no (dies with the process) | TCP/WS sockets, `isAlive`, local `joinedSessionId`, participant binding on the connection          | **No.** It is per-process by definition         |
| **Propagation events**         | Redis Pub/Sub (transit only) | no (fire-and-forget)       | "question X was published in session Y" notices                                                    | **Yes — this is Redis's entire job in Phase 4** |

Rules that follow:

- PostgreSQL remains the **only** source of truth. A Redis message is a
  _notification_, never a record.
- Redis caching (read-through, session snapshots, presence) is **out of
  scope** for Phase 4. Nothing reads from Redis except the subscription.
- Redis Streams are out of scope. Redis-based winner election is **forbidden
  here** — Phase 3's PostgreSQL mechanism (ADR-004) stays authoritative.

## 1. The distribution problem (why single-instance breaks)

Today (Phase 3, `ead4314`) the `SessionRegistry` is one `Map` inside one
Node process. With two instances behind a load balancer:

```
Student A ──► WS-1 ──┐
                     │   X  (no path between WS-1 and WS-2)
Teacher   ──► WS-2 ──┘
```

Student A answers through WS-1. WS-1's registry holds only WS-1's
connections, so `broadcast(deps, sessionId, ...)` delivers to A's peers on
WS-1 — and reaches nothing else. The teacher on WS-2 never sees
`answer.accepted` or `leaderboard.updated`. Worse: the _state change itself
happened correctly_ — WS-1's handler already committed the answer and the
winner election to PostgreSQL. The bug is purely in propagation: durable
truth is shared, observable real-time behavior is not. Each instance would
also validate/broadcast independently, so clients connected to different
instances see different "live" sessions while the database holds one truth.

An in-memory registry cannot fix this — a process cannot iterate a Set that
lives in another process's heap. The registry stays (it is still exactly the
right structure for _local_ delivery); it needs a cross-instance fan-out
layer behind it.

## 2. Proposed target architecture

```
                       Load balancer          (Phase 6: Nginx; Phase 4 uses
                      /             \          two direct ports locally)
                     /               \
              WS Server A          WS Server B
             (Fastify + ws +       (Fastify + ws +
              local registry)       local registry)
                     \               /
                      \             /
                  Redis Pub/Sub  ←  propagation ONLY
                           |
                      PostgreSQL  ←  durable truth (unchanged)
```

Per instance, the runtime flow becomes:

1. A client frame arrives (e.g. `quiz.answer`).
2. The handler runs exactly as in Phase 3 — PostgreSQL transaction, ADR-004
   election, durable commit. **The commit is the event of record.**
3. After a successful commit, the instance publishes a compact event notice
   to Redis _and_ delivers locally through the registry.
4. Every other instance receives the notice and fans it out to _its_ local
   connections for that session.
5. A client that misses a notice (or joins late) reconciles against
   PostgreSQL — the same path it already uses on join.

## 3. Inter-instance transport protocol vs the WebSocket protocol

Two different protocols with two different jobs:

- **WebSocket protocol** (`docs/api/websocket-protocol.md`): client ⇄ server
  contract. Envelope `{type, requestId, payload}`, Zod-validated, error
  envelopes, requestId correlation. Stable, versioned, documented for client
  authors.
- **Inter-instance transport protocol** (this document): instance ⇄ broker ⇄
  instance. It exists only to say "a durable fact was committed; tell your
  local sockets". It is never exposed to clients, never accepts client
  input, and may evolve with the server internals.

Deliberately **not** the design: serializing the outgoing WebSocket frame
and shoving it through Redis. That would (a) couple the broker payload to a
client-facing wire format, (b) smuggle `requestId`-correlation semantics
across instances where they are meaningless, and (c) blur who owns broadcast
shaping (e.g. `correctAnswer`-stripping must happen exactly once, on the
origin instance, not again on every receiver). Instead the transport carries
an **application event notice**, and each receiver renders its own frames
from the notice.

## 4. Event envelope (inter-instance)

```json
{
  "eventId": "0199f3a0-7c1a-7de0-a11c-9f2b4c5d6e7f",
  "type": "question.published",
  "sessionId": "0198b62f-...",
  "originInstanceId": "ws-a1b2c3",
  "schemaVersion": 1,
  "occurredAt": "2026-09-24T12:00:00.000Z",
  "payload": {}
}
```

| Field              | Meaning                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventId`          | UUIDv7, generated by the origin instance **per durable commit**. Identity for dedup, logging, and tracing. Not used for ordering.                                                                                 |
| `type`             | Same event-type vocabulary as the WebSocket server events (single taxonomy, two protocols).                                                                                                                       |
| `sessionId`        | Routing key / subscription filter. Every notice is session-scoped.                                                                                                                                                |
| `originInstanceId` | Random per-process ID (generated at boot). Enables echo suppression and ops debugging.                                                                                                                            |
| `schemaVersion`    | 1. Receivers reject versions they don't understand (log + ignore), so instances can be upgraded independently.                                                                                                    |
| `occurredAt`       | When the commit happened. Diagnostic only — **not** an ordering primitive.                                                                                                                                        |
| `payload`          | Exactly the fields the receiving instances need to render frames — the same (already client-safe) broadcast payloads from Phase 3. No DB handles, no SQL rows, no internals beyond what clients legitimately see. |

Notice a deliberate asymmetry: the envelope has **no `requestId`**.
`requestId` correlates a client's request with its response _on one
connection_; a remote instance cannot honor it. Origin-local delivery keeps
request correlation (the submitting client gets its verdict locally, from
the instance that handled the request); remote instances render broadcast
frames with `requestId: null` — which is already the protocol's
server-initiated convention.

## 5. Echo-loop prevention (explicit rule)

**Rule: an instance never re-publishes a notice received from Redis.**
Publication is exclusively a side effect of a _local handler committing a
durable change_. A Redis-delivered notice triggers local delivery only.

Two independent mechanisms back the rule:

1. **Structural** (primary): the Redis subscriber code path and the handler
   code path are different code paths; only handlers call `publish()`. There
   is no "forward unknown events" fallback anywhere. A loop therefore cannot
   form even if `originInstanceId` were removed.
2. **`originInstanceId` comparison** (belt-and-braces): on receipt, if
   `originInstanceId === myId`, drop silently. This also lets the origin
   instance subscribe to its own channel and, for debugging, _see_ its own
   publications without re-delivering them.

## 6. Delivery semantics (honest)

Redis Pub/Sub is **at-most-once, fire-and-forget, no persistence, no
acks, no replay**. The design accepts this and compensates with PostgreSQL:

| Scenario                                                   | What happens                                                                                                                                                                    | Recovery                                                                                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WS-2 subscribed and healthy                                | Notice delivered; local broadcast                                                                                                                                               | —                                                                                                                                                                                                      |
| WS-2 momentarily slow/disconnected (reconnecting to Redis) | Notice lost. Pub/Sub holds nothing.                                                                                                                                             | Clients on WS-2 reconcile from PostgreSQL (on next relevant interaction, on reconnect — Phase 7, or on any state read). **No durable data is lost — only a real-time push.**                           |
| Redis down at publish time                                 | Origin instance logs a warning and **continues serving its own clients** (local broadcast already happened; the commit already happened). Cross-instance clients miss the push. | Degraded mode: every instance still serves its local clients fully; state convergence is via PostgreSQL. Publishing is best-effort; we do NOT buffer/retry Pub/Sub notices (they are hints, not data). |
| Redis down at subscribe time / dies between                | Instance keeps running, keeps serving local clients, keeps committing to PostgreSQL. Periodic reconnect with capped backoff.                                                    | When Redis returns, subscription resumes. Missed pushes are unrecoverable _as pushes_ — clients reconcile from PostgreSQL.                                                                             |
| Whole instance crashes                                     | Its sockets die. Pub/Sub unaffected for others.                                                                                                                                 | Reconnect flow (Phase 7) rebuilds client state from PostgreSQL.                                                                                                                                        |

**Can a quiz answer be lost?** No. Answers (and winners) live in PostgreSQL,
committed by the instance that received them, before any publication exists.
The worst case in every failure mode above is a _missed real-time
notification_ — a client that doesn't instantly see someone else's
leaderboard update — never lost application data. This is the
server-side-success vs client-acknowledgement distinction from the protocol
doc, extended across instances.

**Safe to miss:** any `*.updated` broadcast (`leaderboard.updated`,
`answer.accepted` broadcast copies) — each is a rendering of committed state
that can be re-derived. The client-side rule that makes this safe: treat
event frames as _hints_ and re-read authoritative state when something looks
stale or after any gap.

## 7. State recovery model (instance restart)

A restarting instance **reconstructs nothing from Redis**. Pub/Sub has no
history; designing around replaying it would mean inventing a log — which is
what PostgreSQL already is. The recovery model is:

```
WS-2 crashes → restarts → (empty registry, no subscriptions)
  → PostgreSQL is authoritative
  → each reconnecting client: session.join → handler reads PostgreSQL →
    session.joined + session.state (current quiz/question state snapshot)
  → subscription re-established → new events flow
```

Nothing else is needed because Phase 3 already made every client-visible
fact derivable from PostgreSQL: session state, quiz/question states, the
winner, the leaderboard. (If a richer join-time snapshot is needed during
implementation — e.g. "current published question" — it is a PostgreSQL
read, not a Redis read.)

## 8. Event categories — what crosses Redis

| Category                                                      | Events                                                                                                                     | Crosses Redis?                                                              | Why                                                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| State-changing session-scoped facts (committed in PostgreSQL) | `quiz.started`, `question.published`, `question.closed`, `answer.accepted` (broadcast copy), `leaderboard.updated`         | **Yes** — these are exactly the facts every instance's clients must observe | Their effect _is_ multi-client visibility                                          |
| Future: doubt queue updates, presence, session state changes  | same treatment                                                                                                             | Yes (later phases)                                                          | Same reasoning                                                                     |
| Connection-local events                                       | `session.joined` / `session.state` (join ack), `answer.accepted` (submitter's private verdict), protocol errors, heartbeat | **No** — never leave the instance that owns the connection                  | They are responses on one socket; remote instances have no stake and no route back |
| Anything derivable per-client                                 | standings recomputation, snapshots                                                                                         | No                                                                          | Each instance renders from committed state itself                                  |

Minimum-publication rule: one logical durable change ⇒ **one** notice (with
its follow-on frames rendered locally per instance — e.g. an answer commit
publishes one `answer.accepted`-notice; receivers render the leaderboard
frame themselves; the origin additionally does its existing Phase 3 local
broadcast). We do not publish N notices for N rendered frames.

## 9. Ordering semantics

**What Pub/Sub gives:** messages published by one connection to one channel
are delivered to subscribers in publish order. Nothing more. There is no
global order across publishers, channels, or instances, and `occurredAt`
timestamps are wall-clock noise.

**What LivePulse actually requires:** for one session, clients must not
observe an _impossible_ sequence — e.g. `question.published` for Q2 before
`question.closed` for Q1, or `answer.accepted` for a question the client
believes is still unpublished. Analysis:

- The dangerous sequences are per-session. **Per-session publish order is
  preserved** by design: all notices for a session originate from whichever
  instance committed the change (only one instance can hold the PostgreSQL
  row lock for that change — the same lock that already serializes Phase 3
  state transitions), and one Redis connection ⇒ one publish order.
- Consequence worth stating precisely: cross-_event-type_ ordering on the
  same session is real but _incidental_ (it falls out of "same channel, one
  origin per commit"), not a distributed-consensus property. We claim
  exactly: **for a single session, subscribers observe notices in commit
  order.** We do not claim global ordering, cross-session ordering, or
  ordering vs client-observed sends.

**Client contract — trust events, reconcile against truth:** clients treat
event frames as hints and the protocol's authoritative snapshots
(`session.state`, join-time state, future reconnect snapshot) as truth. The
protocol doc already forbids clients from assuming delivery ordering;
implementation should add: after a gap (reconnect, missed frames), clients
re-read state rather than extrapolate. Servers keep the invariant side:
`answer.accepted` is only rendered/emitted for questions whose committed
state says `PUBLISHED` — receivers re-check nothing (the origin already
did), so an impossible state cannot be _created_ by ordering; the worst case
remains a missed hint.

## 10. Duplicate events

**Duplicates are possible.** Pub/Sub is at-most-once, but _reconnections_
are a real duplicate source: if WS-2's Redis connection drops and
re-establishes, it may receive ... actually no — Pub/Sub delivers nothing
from before the subscription. The honest sources of duplicates in this
design are: (a) the same _logical_ event rendered by multiple paths (origin
local broadcast + remote delivery must not double-deliver to a client on
the origin instance — handled by echo suppression §5), and (b) future
topology changes (sharded pub/sub, reconnect storms). So:

- Handlers of received notices must be **idempotent** by construction: their
  only action is "render a frame to local sockets" — rendering twice is
  wasteful but harmless; there are **no writes** on the receive path (a
  hard rule: the Redis subscriber never touches PostgreSQL for writes).
- `eventId` is logged on both ends (tracing) and is _sufficient_ to add a
  small in-memory LRU seen-set per instance **if** observation ever shows
  duplicate rendering matters. **No dedup table, no Redis SETNX dedup** in
  Phase 4 — there is no demonstrated requirement, and AGENT.md forbids
  structure without a problem. Decision: ship without a dedup cache; the
  receive path is read-only and idempotent, so duplicates degrade to
  duplicate frames, never to state corruption.
- Safe to replay: all broadcast-class events (see §6). Unsafe to
  "replay" into anything durable: nothing — no received event is ever
  durable input.

## 11. Channel topology

Options considered:

| Option                                               | Subscription count                | Filtering                                                           | Volume                                          | Cleanup                                                      | Complexity                                                                          | Verdict                  |
| ---------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------ |
| **A. One global channel** `livepulse:events`         | 1 per instance                    | Receiver-side (drop notices for sessions with no local subscribers) | Every instance receives every session's notices | None needed (channel always exists)                          | Lowest                                                                              | ✅ chosen for Phase 4    |
| **B. Per-session channels** `livepulse:session:{id}` | 1 per joined session per instance | Native (subscribe only what you host)                               | Only relevant notices delivered                 | Must unsubscribe on last local leave; leaks channels on bugs | Higher: subscribe/unsubscribe churn, per-join Redis round-trips, more failure modes | Revisit when measured    |
| **C. Sharded/hashed channels**                       | —                                 | —                                                                   | —                                               | —                                                            | —                                                                                   | Overkill; no requirement |

Analysis for expected scale: LivePulse sessions are classrooms (tens–hundreds
of sessions, not millions). A global channel's cost is that every instance
parses and filters every notice — at classroom scale this is noise. Option A
has no lifecycle to get wrong (no channel leaks, no subscription storms on
join bursts), and its receiver-side filter (`registry.getConnectionsForSession(sessionId)` — the check already exists in Phase 3's broadcast) makes irrelevant notices ~free. Per-session channels win when
session count × instance count makes global fan-out measurable — that's a
Phase 10 measurement, not a Phase 4 guess.

**Decision: single global channel `livepulse:events`.** Trade-off accepted:
every instance sees every notice; documented as revisitable with data.

## 12. Multi-instance local development (design)

Two application instances on different host ports sharing one PostgreSQL and
one Redis. Compose will grow (in the implementation step) to something like:

```
postgres (5433)   redis (6380)   ws-a (3001)   ws-b (3002)
```

- Each app instance gets a distinct `INSTANCE_ID` (env; random suffix default)
  and its own port; both share `DATABASE_URL` and `REDIS_URL`.
- Demo flow to be supported: create session via HTTP on :3001 → teacher WS
  on :3002 → student WS on :3001 → student answers → teacher sees
  `answer.accepted`/`leaderboard.updated` through Redis. That one flow
  proves the boundary end-to-end.
- Integration-test analogue (no Docker changes needed for tests): spawn two
  `buildApp(listen: true)` instances in-process on ephemeral ports sharing
  the Dockerized Redis — the same guarantee, runnable in CI.
- **Nginx stays out** until Phase 6 (AGENT.md: no premature infra).

## 13. Failure experiments (defined now, executed in Phase 11)

1. **Instance kill:** A publishes; kill A (SIGKILL) mid-run; B and its
   clients continue serving; measure client reconnect time, state recovery
   from PostgreSQL, lost pushes (expected: only in-flight Pub/Sub notices).
2. **Redis kill:** stop Redis; verify both instances keep serving local
   clients and committing to PostgreSQL; verify warnings; restart Redis;
   verify subscriptions resume; enumerate which pushes were missed and show
   clients reconcile.
3. **Subscribe-then-publish race:** publish immediately after a new
   instance's subscribe resolves to characterize the subscription window.
4. **Partition drill:** instance subscribed but network blackholed → verify
   the missed-push + PostgreSQL-reconcile story empirically.

Success criteria are written into the experiment docs at execution time —
no numbers claimed now.

## 14. Phase 3 concurrency preservation (non-negotiable)

Horizontal scaling changes _nothing_ about winner election:

- `quiz.answer` handling is identical on every instance: same handler, same
  `submitWithElection` transaction, same `FOR NO KEY UPDATE` row lock, same
  partial unique index. Two students on **different instances** submitting
  concurrently serialize on the **PostgreSQL question row lock** — the
  property that made Phase 3 correct was chosen precisely because it lives
  in the database, not in the process (ADR-004 §"Why appropriate at this
  stage" explicitly anticipated this).
- Winner election never touches Redis. No in-memory winner state exists
  anywhere. The invariant `winner count ≤ 1` remains a PostgreSQL schema
  invariant; the concurrency test suite (10/50/100) gains a cross-instance
  variant during implementation (two instances' clients racing the same
  question must still yield exactly one winner — same assertions, two
  origins).
- Pub/Sub notices are emitted **after** commit; they can never elect,
  mutate, or veto anything.
