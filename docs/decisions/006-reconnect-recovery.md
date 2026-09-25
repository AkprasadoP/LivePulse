# ADR-006: Reconnect Recovery via PostgreSQL Snapshot-on-Rejoin

- **Status:** Accepted and implemented (Phase 5)
- **Date:** 2026-09-25
- **Supersedes:** none
- **Related:** ADR-003 (ephemeral registry, connection-keyed), ADR-004
  (first-correct-answer election), ADR-005 (Redis Pub/Sub boundary),
  `docs/architecture/recovery.md` (full design + contract),
  `docs/testing/recovery.md` (test evidence)

## Context

Phases 1–4 produced a system where durable state lives only in PostgreSQL
and real-time delivery is: local broadcast on the origin instance + Redis
Pub/Sub notices rendered by other instances (at-most-once). A client that
loses its socket — network drop, instance crash, graceful shutdown — misses
every subsequent `question.published` / `answer.accepted` /
`leaderboard.updated` / `question.closed`. Nothing buffers frames for it;
Redis Pub/Sub forgets instantly. Reconnecting must let the client resume
participation correctly, without inventing durable delivery infrastructure
(AGENT.md §16/§18: no Kafka, Redis Streams, event sourcing, NATS, presence,
or full auth in this phase).

## Options

**1. Durable event log + replay (Redis Streams / Kafka / outbox).**
Give every event a sequence number, buffer them, let the client send
"resume from N". Rejected: it converts at-most-once hints into a delivery
system, adds a second ordering-of-record competing with PostgreSQL, adds
consumer/ack/GC machinery, and solves a problem the recovery model does not
have — the client does not need the _events_, it needs the _state they
produced_, and that state is already durable in PostgreSQL. AGENT.md
sanctions Streams only where async processing genuinely benefits; replay
here would be complexity theater.

**2. Sticky sessions + per-instance replay buffers.**
Route a participant back to the instance it left and replay from memory.
Rejected: session affinity reintroduces the scaling limit Phase 4 removed,
memory buffers die with the process anyway (an instance crash is exactly
the case recovery must handle), and per-instance buffers would silently
become a second state store.

**3. Snapshot-on-rejoin (PostgreSQL reconciliation).**
On any `session.join`, read the authoritative state and return it in the
ack; live delivery resumes as normal. No new infrastructure; the
reconnecting client converges regardless of which instance it lands on.

## Decision

**Option 3.** `session.join` → `session.joined` now carries a `recovery`
snapshot: session state (already there), session quizzes with states, the
current published/closed question, the bound participant's stored attempt-1
verdict, and current derived standings. Everything is read from PostgreSQL
at join time; nothing is replayed, buffered, or tracked per client.

Deliberately NOT added:

- **No sequence numbers.** They are only meaningful with a replay range to
  request; there is no log to replay from. Adding them would imply a
  delivery guarantee the system does not have.
- **No `session.reconnect` event.** With the displayName find-or-create
  seam, a distinct reconnect event adds surface without adding guarantees;
  it becomes meaningful only when real credentials exist (auth phase).
- **No presence, no outbox, no per-client buffers.**

## Why

- The durable effect of every missable event is a PostgreSQL row/column;
  the snapshot reads exactly those. Convergence needs no history.
- Redis stays notification-only (ADR-005 boundary untouched); recovery
  works with Redis fully down.
- The reconnect path is instance-agnostic — the snapshot is assembled from
  the shared database, so reconnect-to-WS-B is the same code as
  reconnect-to-WS-A.
- Phase 3 election semantics are untouched: a lost verdict is either in
  `recovery.ownAnswer` or recoverable by an idempotent retry; the database
  still makes a second winner impossible.

## Trade-offs

- **Snapshot is state, not history:** a client cannot learn _what_ changed
  while away, only _what is_. (Accepted: no client requirement for history
  exists; the alternative is a durable log, rejected above.)
- **Join response grows:** `session.joined` payload carries quiz/question/
  standings data. Bounded by one published/closed question section and the
  standings of one question — not a "snapshot everything" API.
- **Read amplification on join:** a few more indexed reads per join
  (quizzes, question, optional answer, optional standings aggregation).
  Unmeasured (no load phase yet); labeled an assumption, not a claim.
- **Sub-millisecond staleness window** between snapshot read and live-event
  resumption; subsequent live events close it. Documented in recovery.md §6.
- **Identity remains a self-declared label:** `recovery.ownAnswer` is
  inheritable by anyone who claims the displayName. Documented limitation,
  resolved only by the auth phase.

## Consequences

- Easier: clients become trivially stateless — reconnect = reconnect +
  re-join; instance crashes stop being client-visible data loss.
- Easier: Phase 11 failure drills (kill an instance, clients recover) now
  have a correctness path to verify.
- Harder: any future feature whose client state is _not_ representable as
  current PostgreSQL state (e.g. consumed-itself history) will need its own
  design — the snapshot will not cover it.
- The honest claim, test-backed: LivePulse does not guarantee replay of
  every transient WebSocket event; it guarantees that reconnecting clients
  can reconcile against authoritative PostgreSQL state.
