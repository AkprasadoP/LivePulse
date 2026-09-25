# Presence Testing — Phase 7

## Approach

Same rules as every LivePulse suite (`websocket-testing.md`): real PostgreSQL,
real Redis, **real sockets**, no mocks of the database, Redis or the WebSocket
layer. The presence suite (`tests/integration/presence.test.ts`) runs two
**independent instances** (WS-A / WS-B) plus per-scenario instances where the
scenario needs its own shutdown, heartbeat cadence or digest interval.

Determinism:

- Tests synchronize on **server frames** (`WsTestClient.waitFor`, and the
  `waitForPresence` helper that requires a specific participant set) and on
  **registry/database state** (`waitFor`, `waitForAsync`), not on sleeps.
- Digest intervals are injected (`PRESENCE_DIGEST_INTERVAL_MS = 150`) so the
  staleness window is `3 × 150 ms` and convergence is observable in
  milliseconds.
- Two documented settles exist, both for **absence** assertions ("no snapshot
  frame may appear that omits the participant", "no offline transition may be
  recorded"). No positive signal can terminate those early, so a bounded wait
  is the only correct synchronization — the same pattern as Phase 5's
  no-replay assertions.
- A dead peer is simulated by **freezing a real client** (stop reading, so
  server pings are never answered) rather than by faking a socket close, and a
  crashed instance is simulated by publishing one notice from an instance id
  that never speaks again.

Run it:

```bash
pnpm test:integration                       # everything (14 files, 141 tests)
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/presence.test.ts
```

## Unit tests (`tests/unit/presence.test.ts`, 9)

Cover the semantics that must hold independently of transport:

- a participant is counted once regardless of how many connections they hold;
- a participant stays online while ANY bound connection remains, and goes
  offline only when the last one is removed;
- view-only connections (no participant binding) are never presence;
- local presence is scoped per session and only bound sessions are listed;
- whole-set remote contributions replace the previous set, and a duplicate or
  older `seq` is ignored wholesale (including an empty set withdrawing an
  instance);
- a peer silent for `3 × digest` expires and reports the sessions it touched,
  while a peer that keeps sending updates for any session stays fresh;
- `snapshotIfChanged` emits only on change (no redundant frames) and
  `forgetSession` re-arms it;
- local sequence numbers are monotonically increasing.

## Integration scenarios (13)

| #   | Scenario                                | What it proves                                                                                             |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| P1  | join announces the participant to itself | the joining connection receives `presence.snapshot` after `session.joined`, exactly once (ordering + no duplicate) |
| P2  | new participant joins                   | existing clients receive an updated aggregate (both participants)                                          |
| P3  | participant on WS-A, observer on WS-B    | cross-instance presence via Redis notice, in both directions                                                |
| P4  | graceful leave                          | the departed participant disappears from the other instance's view                                          |
| P5  | one of two connections closes (multi-device) | registry still holds the participant; **no** snapshot omitting them over 3 digest cycles; **no** `offline` transition; the final close does announce and does count |
| P6  | view-only join                          | an empty snapshot, and a later participant sees only themselves                                             |
| P7  | same participant bound on WS-A and WS-B  | losing one instance's connection leaves them online (only if BOTH close do they disappear)                  |
| P8  | reconnect                               | a fresh connection reconciles to the CURRENT aggregate (local + remote), not a stale one                    |
| P9  | distribution degraded                    | local presence and durable work are unaffected when the instance takes no part in distribution              |
| P10 | crashed instance (ghost notice)          | a peer that announces once and never speaks again is visible briefly, then expires at `3 × digest`          |
| P11 | graceful instance shutdown               | the departing instance withdraws its local set immediately — well before the staleness window                |
| P12 | heartbeat termination                    | a frozen client is swept, its presence is removed, and the close is counted as `reason="heartbeat"`         |
| P13 | persistence check                        | presence writes no rows (`users`, `session_participants` unchanged across digest cycles and departures) and no presence/connection table exists |

Stability: the 13 scenario tests plus the 11 observability tests were run **3
consecutive times** with 24/24 passing each run.

## What is proven, and what is not

**Proven by these tests:**

- Local presence is exact: it follows the live connection set, including the
  multi-connection case.
- Cross-instance presence converges, and a silent/crashed peer is dropped by
  the documented `3 × digest` rule (not merely documented — P10 fails if the
  expiry rule is broken).
- Heartbeat termination is integrated with presence (P12), and graceful
  shutdown is prompt (P11).
- Presence is ephemeral and write-free in PostgreSQL (P13), and unaffected by
  degraded distribution (P9).
- Snapshots are whole-set and idempotent, so they cannot corrupt client state
  by duplication or reordering (P1–P8 assert on sets, and the unit tests assert
  the replace semantics).

**Not proven here:**

- **Redis process restart.** `node-redis` retries an unreachable server forever
  by design (Phase 4 documented behavior), so a hard outage cannot be simulated
  in-process without controlling the container lifecycle, which the suite
  deliberately does not do. What is covered instead: (a) the degraded shape
  used since Phase 4 (`DISTRIBUTION_ENABLED=false`, P9), (b) the self-healing
  rule that a missed notice is repaired by the next whole-set notice or digest
  (unit tests + digest assertions), and (c) dead-peer expiry (P10). A
  container-level Redis restart belongs to the Phase 9 failure campaign.
- **True network partitions / half-open TCP** at scale: P12 covers one frozen
  client; a partition between instances is covered only by the staleness path.
- **Presence under sustained load** (hundreds of sockets, many sessions):
  Phase 8 measures it; no number is claimed here.
- **Identity:** presence reports the displayName-bound participant. The Phase 3
  seam limitation (a name is not a credential) is inherited and unchanged.

## Coverage against the Phase 7 requirements

| Required presence test                                  | Covered by          |
| ------------------------------------------------------- | ------------------- |
| participant joins → presence announced                  | P1, P2              |
| participant leaves → presence removed                   | P4                  |
| two connections, one closes → still online              | P5                  |
| only after the final connection → offline               | P5                  |
| same participant on WS-A and WS-B                       | P7                  |
| cross-instance propagation                              | P3, P4, P5, P7      |
| local presence works without distribution/Redis         | P9 + unit tests     |
| propagation resumes (missed notice repaired)            | unit tests + P10    |
| heartbeat termination removes presence                  | P12                 |
| instance shutdown removes local presence                | P11                 |
| duplicate presence notifications do not corrupt clients | unit `snapshotIfChanged` + P1–P8 (set assertions) |
| reconnect gets current presence                         | P8                  |
| presence does not write PostgreSQL                      | P13                 |
