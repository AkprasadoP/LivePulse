# ADR-005: Redis Pub/Sub as Inter-Instance Event Propagation (Design)

- **Status:** Accepted and implemented (Phase 4)
- **Date:** 2026-09-24
- **Supersedes:** none
- **Related:** ADR-003 (WebSocket foundation, ephemeral registry), ADR-004
  (first-correct-answer election), `docs/architecture/distributed-websockets.md`
  (full design), AGENT.md §8 (Horizontal Scaling problem)

## Context

Phases 1–3 deliberately proved everything on one instance: domain
invariants, a correct raw-WebSocket lifecycle, and exactly-one-winner
concurrency — all with PostgreSQL as the only state store and an in-memory
`SessionRegistry` for delivery. The moment a second instance exists behind a
load balancer, that registry becomes the bottleneck of visibility: WS-1
commits a correct answer to PostgreSQL, but WS-2 — where the teacher is
connected — has no process-level path to learn about it. The durable state
is shared; the _observable real-time behavior_ is not.

Phase 4 must answer: how do N WebSocket instances share events while
PostgreSQL remains the single source of truth — without dragging business
state, caching, or election logic into Redis?

## Options

**1. Sticky sessions only (no cross-instance propagation).**
Load-balance by session ID so all clients of a session land on one instance.
Rejected: it caps a session's connections at one process (the scaling limit
we are trying to remove), makes instance crashes session-fatal, and requires
session-affinity machinery at the LB for a property the app should own.

**2. WebSocket servers talk to each other directly (mesh).**
Each instance connects to every other and forwards notices. Rejected: O(N²)
connections, service discovery between app instances, partial-mesh failure
modes, and a bespoke protocol to reinvent what a broker already does.

**3. Redis Pub/Sub fan-out.**
Instances publish compact event notices; instances subscribe and deliver
locally. Redis is already in the stack (compose, AGENT.md §3 sanctions
Pub/Sub for exactly this), operationally simple, and — critically —
**dispensable**: nothing durable depends on it.

**4. Redis Streams (persistent log).**
Durable, replayable — and a different product. Streams would invite reading
state back out of Redis, a replay/recovery model, consumer groups, and ack
semantics. AGENT.md sanctions Streams only "where reliable asynchronous event
processing genuinely benefits the design"; the design here needs the opposite
property: a _lossy hint_ whose loss costs nothing because PostgreSQL holds
the truth.

## Decision

**Option 3 — Redis Pub/Sub, with the boundary drawn as follows.**

- Redis carries **one thing**: post-commit, session-scoped application event
  notices `{eventId, type, sessionId, originInstanceId, schemaVersion,
occurredAt, payload}` on a **single global channel** `livepulse:events`.
- It is **not** a source of truth, **not** a cache, **not** the winner
  election, **not** a queue. The Redis subscriber path is read-only: it
  renders frames to local sockets and never writes PostgreSQL.
- Echo loops are prevented structurally (only handlers publish; the
  subscribe path never publishes) plus an `originInstanceId` check.
- Delivery is at-most-once. Loss of a notice loses only a real-time push;
  clients reconcile against PostgreSQL (join snapshots today, reconnect
  snapshots in Phase 7).
- **One channel to start** (per-session channels deferred with reasoning:
  classroom-scale volumes make global fan-out noise; revisit with Phase 10
  data).

## Why

- **The interesting property is preserved:** Phase 3's exactly-one-winner
  election lives in PostgreSQL (row lock + partial unique index). Two
  students on different instances serialize on the same database row lock.
  Horizontal scaling cannot corrupt what was designed not to live in the
  process. The ADR that chose PostgreSQL for election (ADR-004) explicitly
  anticipated this phase.
- **Failure semantics are simple and honest.** Redis down ⇒ instances
  degrade to serving local clients only (still fully correct for their own
  clients, still committing to PostgreSQL) and reconnect with backoff. No
  split-brain is possible because nobody consults Redis for truth.
- **The envelope is a transport protocol, not a leaked wire format.** It
  carries exactly what receivers need to render frames; `requestId` is
  deliberately absent (correlation is per-connection and stays local to the
  origin instance's targeted response).
- **Simplicity ranking (AGENT.md §4)**: Pub/Sub is the simplest mechanism
  that solves Problem 8 (horizontal scaling) without adding durable-state
  ambiguity.

## Trade-offs

- **Missed pushes are possible** (subscriber down, Redis down, in-flight
  window). Mitigation is reconciliation from PostgreSQL, not delivery
  guarantees. Clients must be hint-based; this becomes a documented protocol
  contract during implementation.
- **Every instance receives every session's notices** (global channel). At
  classroom scale this is cheap filtering; at unmeasured scale it is a known,
  documented revisitable.
- **No dedup infrastructure.** Receive path is idempotent by construction;
  `eventId` suffices for tracing and for an LRU seen-set _if_ observation
  ever demands it. No dedup table (AGENT.md: no structure without a problem).
- **Two protocols now exist** (client-facing WS, inter-instance transport).
  Cost: one more schema set to maintain. Benefit: client-facing stability is
  decoupled from internal evolution; broadcast shaping happens exactly once.

## Consequences

- Easier: multi-instance local development becomes a compose-level concern;
  Phase 6 (Nginx/LB) becomes mostly infrastructure work; Phase 7 (reconnect)
  gets a clean recovery story (PostgreSQL, not Redis history); Phase 11
  failure drills have precisely defined expected behaviors.
- Harder: broadcast delivery is now best-effort across instances — tests must
  assert against PostgreSQL state and treat cross-instance frames as
  eventually-visible; a new class of "hint lost" bugs becomes possible and
  must be documented rather than hand-waved.
- Not done (deliberately): Redis caching, presence in Redis, doubt queue in
  Redis, Streams, Redis-based election, dedup tables. Each is a future ADR
  with its own problem statement, none claimable as existing.
