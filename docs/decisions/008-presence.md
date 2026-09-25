# ADR-008: Ephemeral Presence via Instance-Local Truth + Redis Whole-Set Notices

- **Status:** Accepted and implemented (Phase 7)
- **Date:** 2026-09-25
- **Supersedes:** none
- **Related:** ADR-003 (ephemeral, connection-keyed registry), ADR-005 (Redis
  Pub/Sub boundary), ADR-006 (recovery reads durable state only),
  `docs/architecture/presence.md` (full design + contract),
  `docs/testing/presence.md` (test evidence)

## Context

Phase 7 must answer "who is currently connected to this session?" — across
WebSocket instances. The constraints already established by earlier ADRs point
in one direction:

- PostgreSQL is durable **business** state. A connection is not business state
  and must not create rows (ADR-003: connection-keyed, ephemeral registry).
- Redis is a **notification** layer, never a store (ADR-005).
- Recovery reads PostgreSQL and must stay free of ephemeral data (ADR-006):
  a snapshot that included presence would blend two different consistency
  models in one payload.
- A participant may hold several connections at once (phone + laptop, on
  different instances). Presence must not flip offline when one of them closes.
- Presence must survive a Redis outage locally and converge after one.

## Options

**1. PostgreSQL-backed presence** (a `connections` / `presence` table, upserted
on connect/disconnect). Rejected: connection liveness is not durable state;
writing a row per socket turns a transient network fact into durable data,
adds write amplification on the hottest path, and requires TTL reaping plus
crash-time reconciliation to avoid permanently "online" ghosts. It also
directly contradicts ADR-003 and the Phase 7 instruction not to persist
connection state.

**2. Redis-backed presence as truth** (a Redis hash/set per session with
`online:<participantId>` keys and TTLs). Rejected: it moves a correctness
dependency into the layer that this architecture deliberately made
non-durable. A Redis restart erases presence; a partition makes two instances
disagree in a way nothing reconciles; and it makes the "Redis is only
notification" invariant false the moment someone reads from the set.

**3. Process-local truth + Redis notices** (chosen). Each instance derives its
own online set from the registry it already maintains, and publishes it as a
**whole-set** notice. Receivers keep a contribution per origin instance and
recompute the union.

**4. Process-local truth + a distributed Redis registry** with leases/heartbeat
keys. Rejected as a needless second consistency mechanism: it introduces its
own TTL semantics, key naming, and reconciliation logic, for the same eventual
answer option 3 already gives — and it puts presence *state* (not just
notices) back into Redis.

## Decision

**Option 3.** Presence is ephemeral, instance-local, and DERIVED:

- **Definition.** A participant is ONLINE for a session iff at least one
  healthy bound connection exists on some live instance. "Healthy" = registered
  in the local registry and not terminated by the existing heartbeat sweep.
  View-only connections (joined with no participant) are not presence. Presence
  is never gated on a pong having arrived.
- **Local truth.** `PresenceTracker.localParticipants(sessionId)` computes the
  set from the live `SessionRegistry` on every read. There is no parallel
  structure to drift from, so a mid-lifecycle exception cannot desynchronize
  registry and presence — the next read is still correct by construction.
- **Cross-instance.** On local 0→1 / 1→0 transitions (and on a periodic
  digest) the instance publishes its COMPLETE local online set for the session
  as a `presence.update` notice carrying a per-instance `seq`. Receivers
  replace that instance's contribution wholesale.
- **Client-visible.** A single server → client event: `presence.snapshot`
  `{ sessionId, participants[] }` — the whole aggregated set, pushed after
  `session.joined` and whenever the aggregate changes. Idempotent and
  order-insensitive by construction.
- **Staleness.** An instance not heard from for `3 × PRESENCE_DIGEST_INTERVAL_MS`
  is dropped, and its participants disappear from every aggregate.
- **Recovery separation.** Presence is NOT part of `session.joined.recovery`.

Deliberately NOT added: `presence.joined` / `presence.left` client events, any
client → server presence event, `presence.heartbeat` (the WS ping/pong is the
only liveness mechanism), presence in PostgreSQL, presence in Redis keys, and
connection counts in the durable model.

## Why

- **Whole sets, not deltas.** Redis Pub/Sub is at-most-once (ADR-005). A
  missed delta would need its own repair protocol; a missed whole set is
  repaired by the next notice or digest automatically. Duplicate and
  late-arriving notices are harmless — the aggregate is recomputed from sets.
- **No new failure mode.** With Redis down, local presence is exact and
  cross-instance presence degrades to "stale until it expires". No durable
  operation is affected.
- **Multi-connection falls out of the model.** Presence is a set of
  participants derived from a set of connections: closing one of two sockets
  cannot produce an offline transition, because the participant is still in
  the derived set.
- **Instance crash is handled by the same rule as a missed notice** — silence
  for 3 × the digest interval — so there is no separate crash-detection path.
- **Recovery stays pure.** Durable convergence (ADR-006) and ephemeral
  connectivity stay in separate payloads with separate guarantees.

## Trade-offs

- **Eventually consistent, not linearizable.** Two instances can briefly
  disagree about who is online. Documented as the guarantee; not called
  "strong consistency".
- **Digest traffic is O(sessions × instances) per interval**, independent of
  the number of participants. Bounded and small at the default 10 s, but it is
  real background traffic; the interval is configurable for tests.
- **A crashed instance's participants linger up to `3 × digest`** (30 s at
  default). Chosen over aggressive expiry to avoid flapping on a slow digest.
- **No cross-instance ordering guarantee** between `presence.update` notices
  from different instances; only per-instance `seq` monotonicity, which is all
  the "replace this instance's set" model needs.
- **Graceful shutdown is best-effort.** It publishes an empty set before Redis
  closes; if Redis is already gone, peers fall back to the staleness window.
- **Identity is still the displayName seam.** Presence reports the participant
  the connection bound to, inheriting the Phase 3 limitation that a name is not
  a credential.

## Consequences

- Easier: clients render presence by replacing a list; no delta bookkeeping,
  no ordering requirements, no missed-event repair on the client.
- Easier: Phase 8 load tests can watch `livepulse_presence_local_participants`
  / `..._remote_instances` to see fan-out without instrumenting connections
  again.
- Harder: genuinely consistent presence (e.g. "exactly one seat per
  participant") would need a different mechanism; this ADR does not provide it.
- The honest claim, test-backed: presence reflects currently healthy
  connections as observed by each instance, converges across instances within
  the digest window, is never durable, and never blocks durable work.
