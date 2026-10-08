# Presence — Phase 7

> **Status: implemented (Phase 7).** This document describes only what exists
> and is tested. Per AGENT.md's honesty rule, deferred items are labelled as
> such. Decision record: ADR-008; test evidence: `docs/testing/presence.md`.

## 1. Layering

```
PostgreSQL   = durable business state      (presence is NEVER written here)
Presence     = ephemeral connection state  (in-memory, per instance, derived)
Redis        = cross-instance notification (whole-set notices, never truth)
WebSocket    = ephemeral transport
```

Presence answers exactly one question: **which participants are currently
connected to this session?** It is not identity, not attendance history, and
not a durable roster.

## 2. Definition (exact)

> A participant is **online** for a session iff at least one healthy WebSocket
> connection bound to that participant (`participantId` set) is registered on a
> live instance, where "healthy" means it has not been terminated by the
> existing heartbeat sweep.

Consequences of that wording:

| Case                                                | Presence                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| Authenticated connection joined (participant bound) | online (immediately after the join ack)                                 |
| Connection joined without a participant (view-only) | **not** presence — presence is about participants, not sockets          |
| Connection that has never answered a ping           | online (liveness is decided by the sweep, not by a successful pong yet) |
| Connection terminated by the heartbeat sweep        | offline, as soon as its socket close is processed                       |
| Participant with phone on WS-A and laptop on WS-B   | online, from both instances' contributions                              |
| Participant with two connections, one closed        | **still online** (see §4)                                               |
| Instance process killed                             | its participants expire after `3 × PRESENCE_DIGEST_INTERVAL_MS` (§6)    |

There is **no** application-level heartbeat. `presence.heartbeat` does not
exist: the WS ping/pong sweep that already detects dead connections is the only
liveness mechanism, and presence hooks into its lifecycle rather than
duplicating it (ADR-008).

## 3. Local presence (instance truth)

Each instance derives presence from the `SessionRegistry` it already maintains:

```
SessionRegistry (live connections, per process)
        │  derived on every read — no parallel structure to drift
        ▼
PresenceTracker
  ├─ localParticipants(sessionId)   → deduped participants, sorted
  ├─ localSessions()                → sessions with ≥1 bound participant
  ├─ localParticipantCount()        → distinct participants on this instance
  └─ remote                          → accepted contributions from peers
```

`localParticipants` walks live connections and deduplicates by
`participantId`, so two sockets from one participant produce **one** entry.
Nothing is cached, so there is no window in which the registry and presence can
disagree: a half-completed lifecycle leaves the _next_ read correct rather than
leaving stale presence behind.

Lifecycle points that refresh presence (in this order — registry first,
presence second, client notification last):

```
session.join  → registry.joinSession → presence refresh → presence.snapshot(joiner)
                                                  └──────► presence.update (Redis)
session.leave → registry.leaveSession → presence refresh
socket close  → registry.removeConnection → presence refresh
heartbeat     → terminate → 'close' → registry.removeConnection → presence refresh
digest tick   → republish local set → expire silent peers → refresh affected sessions
```

## 4. Multiple connections (the multi-device rule)

> **A participant is online iff the number of healthy bound connections is
> greater than zero** — across all instances, not per socket.

- Two connections for one participant are both registered; the participant
  appears once in every snapshot.
- Closing one connection does not produce an offline transition and no
  `presence.snapshot` is emitted that omits them, because the derived set is
  unchanged.
- Only the _final_ connection closing emits a changed snapshot.
- This is enforced by construction (sets, not counters of sockets) and
  asserted in tests P5 and P7, including the metric-level assertion that no
  `offline` transition is recorded.

## 5. Cross-instance architecture

```
WS-A: local truth ──► presence.update { sessionId, seq, participants[full set] } ──► Redis
                                                                                     │
WS-B: apply contribution (replace that instance's whole set) ◄───────────────────────┘
         │
         ├─ recompute aggregate = local ∪ every fresh remote contribution
         ├─ push presence.snapshot to local clients IF the aggregate changed
         └─ never render the notice as a client frame
```

- Notices carry the origin instance's **complete** local online set for one
  session, plus a per-instance monotonic `seq`. The receiver replaces that
  instance's contribution wholesale; an older/duplicate `seq` is ignored.
- `presence.update` is internal transport; it is **not** a client event and is
  never rendered as one.
- A notice is applied even when the receiving instance currently has no local
  connections for that session, so a client joining shortly after sees the
  freshest aggregate instead of waiting for the next digest.
- Echo suppression, schema-version gating and payload validation are inherited
  from the Phase 4 receive path (ADR-005) — presence adds no new Redis
  semantics.

## 6. Staleness, digest and dead instances

`PRESENCE_DIGEST_INTERVAL_MS` (default **10 000 ms**) is both the reconcile
cadence and the basis of the staleness rule:

```
every digest interval:
  1. republish this instance's full local set for each locally active session
  2. drop every remote contribution not heard from for 3 × the interval
  3. push a snapshot for each session whose aggregate changed
```

- Because notices are whole sets, a **missed notice needs no repair protocol**:
  the next notice or digest overwrites the contribution.
- A **crashed or partitioned instance** is indistinguishable from a silent one:
  its participants disappear after the staleness window (30 s at default).
- A peer that keeps sending digests for _any_ session stays fresh; freshness is
  per instance, not per session.

## 7. Client contract

`presence.snapshot` is the only client-visible presence event:

```jsonc
{
  "type": "presence.snapshot",
  "requestId": null,
  "payload": {
    "sessionId": "018f…",
    "participants": [{ "participantId": "018f…", "displayName": "Ada", "role": "TEACHER" }],
  },
}
```

- Sent to the joining connection right after `session.joined` / `session.state`.
- Sent to the session's local clients only when the aggregate changes (never on
  every digest, never per participant event).
- The payload is the **whole** set: clients replace their view. It is
  idempotent and order-insensitive, so duplicate or reordered snapshots cannot
  corrupt client state.
- No connection ids, instance ids, socket counts, IPs or infrastructure detail
  ever appear in it.
- There is **no** client → server presence event and **no**
  `presence.joined` / `presence.left` **and no** explicit online/offline flag:
  membership in `participants` is the presence signal.

### Reconnect

Presence is deliberately **not** part of `session.joined.recovery`. Recovery
restores durable state from PostgreSQL (ADR-006); presence is ephemeral and is
delivered as its own snapshot immediately after the join ack. A reconnecting
client therefore ends up with:

1. `session.joined` → durable state (quizzes, question, own answer, standings,
   doubt queue),
2. `session.state`,
3. `presence.snapshot` → current connectivity as observed right now.

## 8. Guarantees — stated honestly

**Guaranteed (tested):**

- Within one instance, presence is **exact** at the moment it is read: it is
  derived from the live connection set, not from cached state.
- Multi-connection participants stay online while any bound connection remains,
  and go offline only when the last one closes.
- A participant's local presence transitions are counted 0→1 (`online`) and
  1→0 (`offline`) — a second connection never produces a spurious transition.
- Cross-instance presence **converges** within the digest interval; a silent
  peer's participants disappear after `3 × digest`.
- Graceful shutdown withdraws the instance's local set immediately (best
  effort, before Redis closes).
- Presence never writes to PostgreSQL and never creates a Redis key.
- Presence failure never breaks a join, a leave, or a durable operation.

**Not guaranteed (by design):**

- **Not strongly consistent.** Two instances can briefly disagree about who is
  online; presence is eventually consistent, with a bounded staleness window.
- **Not durable.** A process restart loses all presence; nothing is replayed.
- **Not a roster.** Presence ≠ registered participants ≠ attendance.
- **Not identity.** Presence reports the participant bound by the
  authenticated `(sessionId, userId)` membership. `displayName` is a
  presentation label, never proof of a person.
- **No per-participant join/leave events** and no presence history.
- **No delivery guarantee** for `presence.snapshot` — consistent with Phase 5,
  a missed snapshot is corrected by the next change or digest.

## 9. Redis failure behavior

| Situation                            | Local presence      | Cross-instance presence                               | Durable work |
| ------------------------------------ | ------------------- | ----------------------------------------------------- | ------------ |
| Redis unreachable / distribution off | exact and immediate | degraded: nothing propagates; peers rely on staleness | unaffected   |
| Redis recovers                       | unaffected          | resumes at the next local change or digest            | unaffected   |
| Redis drops a notice                 | unaffected          | stale until the next notice/digest (self-healing)     | unaffected   |
| Redis unavailable at shutdown        | unaffected          | peers expire the instance after `3 × digest`          | unaffected   |

Redis is never consulted to answer "who is online", so a Redis outage cannot
make presence incorrect on the instance that owns the connection — only
incomplete elsewhere, and only until the next digest.

## 10. Deferred (not implemented)

- Full authentication / real identity for participants.
- Attendance or presence history in PostgreSQL.
- Redis-backed presence leases or a distributed presence registry.
- Per-participant presence events (`presence.joined` / `presence.left`).
- Typing indicators, "teacher is looking at your doubt", or any presence-derived
  feature.
- Grafana dashboards, alerting on presence metrics.
