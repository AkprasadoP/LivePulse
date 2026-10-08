# Production deployment — Phase 9 (containers, proxy, instances, recovery)

How LivePulse runs as a reproducible production-style deployment: container
image (9.1), Nginx reverse proxy (9.2), two app instances (9.3), instance
failure + recovery (9.4), readiness (9.5), graceful draining (9.6), failure
matrix (9.7). No business logic, schema, pool, or PostgreSQL setting
differs from development — only packaging, wiring, and the explicitly
noted readiness/drain additions.

## Image (`Dockerfile`, multi-stage)

- **Build stage** (`node:22-alpine` + pinned `pnpm@12.5.1` via corepack):
  frozen-lockfile install of all dependencies, `prisma generate`,
  `tsc -p tsconfig.build.json` → `dist/`.
- **Runtime stage** (`node:22-alpine` + `libc6-compat`/`openssl` for the
  Prisma engines): production-only install (`--prod --frozen-lockfile`),
  then a transient pinned `prisma@6.19.3` (`pnpm dlx`, never a runtime
  dependency, lockfile untouched) generates the client into this stage's
  own pnpm store layout. Copying the artifact from the build stage is
  deliberately avoided: pnpm isolates it in a version-and-peer-hashed
  store path that differs between full and prod installs.
- Runtime contents: `dist/` (compiled JS only — no TypeScript, `tsx`,
  `vitest`, or `tests/`), prod `node_modules`, `prisma/` (schema +
  migrations for operator reference), `package.json`/lockfiles. No `.env`,
  no credentials, no source.
- Runs as `USER node` (uid 1000). `HEALTHCHECK` uses Node 22's built-in
  `fetch` against `/health` (honors `$PORT`) — no curl/wget bloat.
- Image ≈ 609 MB (dominated by prod `node_modules` ≈ 292 MB, incl. Prisma
  engines). Verified: `whoami` → `node`, no `tsc`/`tsx`/`vitest`, Prisma
  client imports, missing env fails fast with an explicit config error.

## Compose (`docker-compose.prod.yml`, project `livepulse-prod`)

One app container plus Postgres 17 / Redis 7 at 9.1; a second identical
app container since 9.3. The dev file (`docker-compose.yml`) is untouched; `name: livepulse-prod` isolates the
two projects after an observed incident where a same-project `down`
removed the dev containers (volumes — and data — survived).

| Service    | Internal        | Host (127.0.0.1 only) | Purpose                                                                           |
| ---------- | --------------- | --------------------- | --------------------------------------------------------------------------------- |
| `postgres` | `postgres:5432` | `5434`                | durable source of truth, `postgres-prod-data` volume                              |
| `redis`    | `redis:6379`    | `6381`                | notifications/ephemeral presence, no persistence directives (same posture as dev) |
| `app-1`    | `:3000`         | `3100`                | `node dist/server.js` (`INSTANCE_ID=ws-a`), `stop_grace_period: 30s`              |
| `app-2`    | `:3000`         | `3101`                | identical image (`INSTANCE_ID=ws-b`), added in 9.3                                |

Host ports exist for operator access only (psql, redis-cli, curl,
host-side `migrate deploy`); container-to-container traffic uses service
names, never `localhost`. The app starts only after both dependencies
are `service_healthy`.

## Configuration and secrets

- `POSTGRES_PASSWORD` is required with **no default** (Compose fails fast
  without it) and is never committed — see `.env.prod.example`. It must be
  URL-safe (URL-encode `: @ / ? #`) as it is interpolated into
  `DATABASE_URL`. Non-secret identifiers (`POSTGRES_USER/DB`, `LOG_LEVEL`,
  feature toggles) have documented defaults.
- `/health` semantics unchanged: liveness only, no PG/Redis dependency —
  safe as a container healthcheck as-is.

## Migrations (operator workflow, never on boot)

The app container never migrates. Against a fresh volume, apply once from
the repo root (devDependency CLI, repo schema):

```bash
export POSTGRES_PASSWORD="<same password as the stack>"
DATABASE_URL="postgresql://livepulse:<password>@127.0.0.1:5434/livepulse" \
  pnpm exec prisma migrate deploy
```

Verified: all 3 migrations applied to the fresh prod volume; session
create + GET roundtrip; `livepulse_redis_connected{publisher,subscriber}
= 1`; full `down`/`up` preserves data (named volume); `docker stop`
shows `SIGTERM → Graceful shutdown complete`; restart returns `/health` 200. Development data was never touched (dev volume `4 users / 3 sessions
/ 1 quiz` intact; dev stack recreated with `docker compose up -d`).

## Reverse proxy — Phase 9.2 (single upstream, then dual in 9.3)

`nginx/nginx.conf` fronts the app; `nginx` service (`nginx:1.28-alpine`,
127.0.0.1:3200 → 80, config mounted read-only) starts after the app is
healthy. Exactly one `server` in the upstream — no `ip_hash`, no sticky
logic: stickiness would hide the cross-instance behavior Phase 9.3 exists
to demonstrate (client on App-1 and client on App-2 seeing the same
session events via Redis propagation + PG recovery).

- HTTP passes through with `Host`/`X-Real-IP`/`X-Forwarded-For`/
  `X-Forwarded-Proto` preserved; `proxy_http_version 1.1` + keepalive 32
  upstream.
- WebSocket uses the standard `map $http_upgrade` → `Upgrade`/`close`
  switch: plain requests are unaffected, real upgrades handshake through.
  No path-based WS special-casing, so the app's own 426 for non-upgrade
  `GET /ws` passes through byte-identical (verified: 426 direct and via
  proxy).
- Timeouts: `proxy_read/send_timeout 120s` against the app's 30 s WS
  heartbeat (each frame resets Nginx's timer) — 4× headroom without
  masking a dead upstream.
- Nginx healthcheck uses the image's `wget` against `/health` through the
  proxy itself, so a healthy nginx implies a working proxy path.

Verified: `POST /sessions` + `GET /sessions/:id` via :3200; WS
`session.join` → `session.joined` (matching `requestId`) via
`ws://127.0.0.1:3200/ws`; direct `:3100` kept during 9.2 for
proxied-vs-direct comparison. No app, schema, pool, or PG change.

## Two instances — Phase 9.3 (round-robin, no stickiness)

`app-1` (`INSTANCE_ID=ws-a`, :3100) + `app-2` (`ws-b`, :3101) behind the
same Nginx, plain round-robin, deliberately no `ip_hash` or sticky
logic: placement must not matter, and the test verifies placement
instead of assuming it — an `X-Upstream-App` response header echoes the
serving upstream (`$upstream_addr`) so WS clients read it off the 101
response. Direct ports stay for debugging, never for the test path.

Critical test (scratch script, all traffic via :3200, since deleted):
teacher creates session + quiz (HTTP), activates session (HTTP state →
LIVE), starts quiz and publishes the question (WS) from instance A while
the student sits on instance B. Every step passed with A≠B verified:

- `question.published` received cross-instance; `quiz.answer` →
  `answer.accepted` (`correct=true`) received cross-instance.
- `doubt.create` → `doubt.created` and `doubt.resolve` → `doubt.resolved`
  across instances (Redis propagation, PG persistence).
- `presence.snapshot` observed on both sides (client frame name —
  `presence.update` is the internal Redis notice type, never sent).
- Student disconnect + re-`session.join` → `session.state` recovery
  snapshot served (PG-backed, Phase 5 path through the proxy).
- Lifecycle note: publish requires session LIVE then quiz ACTIVE
  (`SESSION_NOT_LIVE` / `QUIZ_NOT_ACTIVE` otherwise) — enforced state
  machine, not proxy behavior.

Two test-harness lessons recorded: round-robin placement must be sampled
(new connections until upstreams diverge, bounded retries — healthcheck
traffic interleaves, so strict alternation can't be assumed), and the
doubt wire shape uses `doubtId`, not `id`. No app, schema, pool, PG, or
nginx-balancing change.

## Readiness semantics — Phase 9.5 (`/health` vs `/ready`)

`/health` is unchanged liveness (process alive → 200, no dependency
checks). New `GET /ready` (`src/app/routes/ready.ts`, registered in
`app.ts` alongside health) is traffic readiness:

| State      | Code | Body                                                                |
| ---------- | ---- | ------------------------------------------------------------------- |
| Healthy    | 200  | `{"ready":true,"postgres":"ok","redis":"ok"}`                       |
| Redis down | 200  | `{"ready":true,"postgres":"ok","redis":"degraded"}`                 |
| PG down    | 503  | `{"ready":false,"postgres":"unavailable","redis":"ok"\|"degraded"}` |

PostgreSQL gates readiness (sole durable truth; an instance that cannot
reach it can serve nothing durable). Redis never flips the code —
degraded-but-serving is the architecture Phase 7 built (local serving
continues, propagation degraded). Bodies carry fixed enums only: no
connection strings, errors, hostnames, or traces.

Implementation notes: PG probe is one read-only `SELECT 1` via the
existing client with a hard **1 s timeout** (≪ 10 s nginx interval — no
indefinite hang, no pool amplification, no business repo/transaction/
migration, no second pool). Redis state reuses the layer-owned
connections (`publisherReady` + new `subscriberReady` accessor on the
existing interface; `wsLayer` exposes the infra it already owns — no new
truth mechanism, no duplicate state). Absent layer (non-listening/test)
or never-connected reads as degraded. No new metric: `redisConnected`
gauges and `dbOperationErrors` already export per-dependency state with
bounded labels. Contract tests: `tests/integration/readiness.test.ts`
(R1 healthy 200/ok, R2 PG-refused 503 + `/health` still 200, R3 Redis-dead
200 degraded + local `POST /sessions` 201, R4 distribution-disabled
degraded-never-unready).

### Live topology results (prod stack, then cleaned)

- Redis stopped: both instances `/ready` 200 degraded, `/health` 200,
  session creation works; on restart clients auto-reconnect
  (gauges back 1/1, `/ready` ok/ok).
- PostgreSQL stopped: both `/ready` **503** unavailable with `/health`
  still 200 (liveness/readiness split demonstrated, not just asserted);
  on restart all `/ready` 200 again, via nginx too.
- Kill/reconnect re-measured (fresh session, teacher killed): socket dead
  191 ms / 1006; reconnect **2 attempts / 10,511 ms**; recovery complete.
  Identical to the 9.4 baseline — **no failover improvement, as
  predicted**: stock Nginx OSS has no active upstream health checking
  (`health_check` verified unknown directive in `nginx:1.28-alpine`), so
  it cannot poll `/ready`. Failover stays passive (`max_fails=1
fail_timeout=10s`, now explicit in `nginx.conf` with zero behavior
  change): first dead-hit costs `proxy_connect_timeout`, then the peer is
  skipped. `/ready`'s value is orchestrator/operator/Compose-level and
  future use — documented as such, not as an nginx behavior change. App
  container healthchecks stay on `/health` (liveness); startup ordering
  unchanged.

### Measurement-hygiene incident (recorded, resolved)

Mid-phase, placement assertions keyed on hardcoded container IPs (`.4` =
app-1) produced impossible readings (101s "from" a dead peer) — Docker
had reassigned `.4` to app-2 across container recreations. Resolution:
the header mechanism was correct; the literal-IP map was stale (verified
via `docker network inspect`). Rule going forward: refresh the IP→service
map immediately before each run; combined `a, b` header values mean an
internal nginx retry happened. No product behavior involved.

## Graceful draining — Phase 9.6 (planned SIGTERM, not SIGKILL)

Existing connections don't "finish" like HTTP requests, so draining is
defined explicitly: **no new admissions, existing sockets live until a
deadline, then a polite close clients reconnect from.** New `DRAIN_TIMEOUT_MS`
(default 10 s, fits the 30 s compose grace):

```text
SIGTERM → beginDraining() → /ready 503 draining:true (≤300 ms measured)
        → upgrade attempts destroyed pre-handshake (no registry/presence churn)
        → existing WS untouched until the deadline
        → pre-existing close(): presence withdrawal, 1001 closes, distributor close
```

`/ready` gains an always-present `draining` boolean (explicit field, not
overloaded onto postgres/redis). Refusal is `socket.destroy()`, not a 1012:
there is no Connection yet, and a handshake-then-close would churn
registry/presence for a socket about to die — clients see a transport
error and reconnect elsewhere.

Measured live (`docker stop -t 30`, teacher draining, student survivor):
ready flip 264–265 ms; new WS refused immediately; existing WS open at
+267 ms; **polite 1001 at +10,050 ms** (server/client timestamps
ms-identical); `docker stop` returns ~10.2 s; reconnect 2 attempts /
~10.5 s to survivor; standings recovered from PG. Contrast SIGKILL (9.4):
1006 in ~200 ms with no warning window. Drain does NOT shorten
post-stop reconnect (~10.5 s both) — it moves disruption earlier and
politely: reconnects can happen _during_ the window instead of all at
once after abrupt death.

Contract tests: `readiness.test.ts` D1 (ready flip, health stays 200),
D2 (refuse-new / keep-existing / close-still-1001), D3 (default
10 s, rejects negatives). A probe-harness lesson is recorded here too:
my first script's connect helper never resolved transport errors, only
timeouts — making a millisecond refusal look like a 10 s hang. Resolve
errors explicitly.

> **This is not zero-downtime WebSocket deployment.** At the deadline,
> existing sockets still break (1001 → reconnect → PG recovery). What
> draining buys is intention and observability: a ready-signal,
> immediate refusal of new admissions, and a known polite close — instead
> of abrupt death. Fast _state recovery_ (not socket preservation) is the
> architectural tradeoff LivePulse deliberately makes.

## Instance failure + recovery — Phase 9.4 (`docker kill`, no new mechanisms)

Topology above with `app-1` (ws-a, .4) + `app-2` (ws-b, .5). Failure =
`docker kill` (SIGKILL, abrupt — never graceful stop for the primary
tests). Redis and PostgreSQL untouched throughout. Scratch scripts (all
traffic via :3200, placement via `X-Upstream-App`) since deleted; all
`f94*`/`x-*` test rows removed from the prod volume afterward.

What this is: connection-level interruption with state recovery — NOT
zero downtime, NOT nginx-side WebSocket reconnection (an established WS
dies with its upstream; the client reconnects and nginx routes the new
connection).

### A — kill teacher's instance (app-1, teacher on .4, student on .5)

- Teacher socket dead **~200 ms** post-kill, close code **1006**. Student
  on app-2 unaffected (5 s+); `GET /health` via nginx 200 throughout.
- Reconnect: **2 attempts / ~10.5 s** — the first attempt hit the dead
  peer and hung until `proxy_connect_timeout`; a killed container's IP
  blackholes (no RST), so failover costs the connect timeout, not zero.
  (A repeat with nginx already aware reconnected in 4 ms / 1 attempt.)
- Rejoin recovery from PG: quizzes + published question + student-answer
  standings + open doubt all present (`recovery` keys:
  quizzes,question,ownAnswer,standings,doubts).
- Presence: teacher gone from student's snapshots in **≤20 s**
  (consistent with 30 s staleness given ~10 s digest cadence staleness at
  kill time); teacher re-appears via survivor after rejoin.

### B — mirror (kill app-2, student on .5, teacher on .4)

Symmetric: student socket dead ~174 ms / 1006; teacher unaffected and
fully functional during the outage (created a doubt alone on app-1);
reconnect 2 attempts / ~10.5 s to app-1; recovery `ownAnswer` = the "4"
(`isCorrect/isWinner true, attemptNumber 1`); presence converged ≤25 s.
Answer retry post-rejoin returned `answer.accepted` with **zero new
durable rows** — the `submitWithElection` duplicate path (existing
attempt-1 → replay verdict, no re-broadcast, Phase 3 contract).

### C — kill mid-traffic + true idempotency

Answer accepted and doubt committed (both observed cross-instance), then
immediate kill of the student's instance. After rejoin: `ownAnswer`
restored; same-participant retries (same answer content; same
`clientDoubtId`) → exactly **1 answer row and 1 doubt row** in
PostgreSQL. Idempotency scope note, verified in PG: the doubt unique key
is `(sessionId, participantId, doubtRequestId)` — same key from a
_different_ participant legitimately creates a second row (observed,
by design, not a duplicate bug).

### D — restart rejoins the system

`docker start` on the killed container → healthy; pinned `INSTANCE_ID`
(`ws-a`/`ws-b`) back in logs; new connections land on it via nginx; events
published on app-1 render on the restarted app-2 (Redis subscription
re-established through normal startup — no replay, nothing special).
Survivor metrics during outages: `redis_events_received_total` keeps
flowing; a dead instance's own counters die with it (expected — the
victim records nothing). One transient nginx `/health` 499 appeared once
mid-kill-window among sustained 200s (not reproduced, not pursued).

### Failure classification (observed)

Expected: WS termination (1006, ~200 ms), nginx serving via survivor,
client reconnect with ~10 s worst-case first-failover, PG recovery
snapshots, cross-instance propagation after recovery, presence
convergence in ~20–25 s. No durable loss, no reconnect-created
duplicates, no stale recovery, no indefinite dead-routing. Not tested:
kill during the ~ms commit window itself (C kills after ack), Redis or
PG failure, both instances simultaneously.

## Failure matrix — Phase 9.7 (no new infrastructure)

Each row names its evidence (live topology run or suite). Scratch scripts
deleted; all `f94*`/`f95*`/`f97*`/`x-*` rows cleaned from the prod volume
afterward (verified 0/0).

| Failure                  | Expected                                           | Evidence                                                                                                              |
| ------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| App SIGKILL              | WS 1006 → reconnect → PG recovery                  | §9.4 A/B/C live                                                                                                       |
| App SIGTERM              | drain → 1001 at deadline → reconnect               | §9.6 live (1001 at +10,050 ms)                                                                                        |
| PG unavailable           | `/ready` 503, `/health` 200                        | §9.5 live + R2                                                                                                        |
| PG outage mid-session    | no verdict, sockets survive, resume + dedupe after | 9.7 live: answer attempt unanswered during outage; post-restore retry → duplicate path; PG holds exactly 1 answer row |
| Redis unavailable        | 200 degraded, local serving                        | §9.5 live + R3/R4                                                                                                     |
| Redis outage mid-traffic | local commits both sides, NO cross-instance leak   | 9.7 live: 6 s partition window with zero propagation                                                                  |
| Redis restore            | propagation resumes (event-level)                  | 9.7 live: post-restore doubt received cross-instance; gauges 1/1                                                      |
| App restart              | healthy, rejoins, renders peer events              | §9.4 D + §9.7 (restarted instance serving)                                                                            |
| Duplicate answer retry   | existing verdict, no new row                       | §9.4 B/C + §9.7 (PG count 1 across outage)                                                                            |
| Duplicate doubt retry    | existing doubt, still 1 row                        | §9.4 A/C + PG unique-scope verification                                                                               |
| Heartbeat timeout        | dead peer terminated                               | suite (`ws-session` heartbeat test)                                                                                   |
| Cross-instance traffic   | Redis propagation                                  | §9.3 + every live run since                                                                                           |
| Presence loss            | eventual convergence ~20–25 s                      | §9.4 A/B measured                                                                                                     |

Deliberately not tested: kill inside the millisecond commit window,
Redis+PG simultaneous loss, dual-instance loss, network partition
(split-brain), client-behavior under 1012 (no 1012 is ever sent —
refusal is pre-handshake destroy).

Not claimed: zero-downtime deployment (existing sockets still break at
the deadline by design); nginx awareness of draining (OSS passive only —
new connections may still be offered to the draining peer and refused,
which is correct but chatty).

## Limits (residual — what production still lacks)

No TLS/auth/rate limiting; metrics unauthenticated as in development;
no autoscaling/orchestration beyond Compose (health/readiness are
container-local signals); host-port operator access is a local
convenience, not a deployment model; the failure matrix's explicitly
untested rows (simultaneous loss, split-brain, mid-commit kill) remain
untested. Authentication + authorization is the planned Phase 10.

## Design property: Redis data loss on restart is acceptable

Redis runs with **no persistence directives** — a restart (or full
`down`) wipes it, by decision, not omission:

```text
PostgreSQL = durable truth (sessions, participants, quizzes, answers,
             doubts, recovery snapshots)
Redis      = ephemeral coordination (cross-instance event notifications,
             presence contributions)
```

This holds because recovery never reads business state from Redis: a
disconnected WebSocket client reconnects (possibly to a different
instance in later phases) and reconstructs session state from PostgreSQL
(Phase 5 reconnect/recovery), while presence re-converges from fresh
heartbeats and digest reconciliation (Phase 7). Losing Redis therefore
costs transient notification/presence freshness — never durable data. Any
future proposal to persist Redis must justify which invariant requires
durability, or it stays ephemeral.
