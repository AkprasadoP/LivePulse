# Production deployment — Phase 9.1 (single container)

How LivePulse runs as a reproducible production-style container. No
business logic, schema, pool, or PostgreSQL setting differs from
development — only packaging and wiring.

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

One app container plus Postgres 17 / Redis 7. The dev file
(`docker-compose.yml`) is untouched; `name: livepulse-prod` isolates the
two projects after an observed incident where a same-project `down`
removed the dev containers (volumes — and data — survived).

| Service    | Internal        | Host (127.0.0.1 only) | Purpose                                                                           |
| ---------- | --------------- | --------------------- | --------------------------------------------------------------------------------- |
| `postgres` | `postgres:5432` | `5434`                | durable source of truth, `postgres-prod-data` volume                              |
| `redis`    | `redis:6379`    | `6381`                | notifications/ephemeral presence, no persistence directives (same posture as dev) |
| `app`      | `:3000`         | `3100`                | `node dist/server.js`, `stop_grace_period: 30s`                                   |

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

## Reverse proxy — Phase 9.2 (single upstream, no balancing)

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
nginx-balancing change; killing an instance mid-session stays in
Phase 9.7 failure testing.

## Limits (for later phases)

Single app instance; no Nginx/load balancing; no TLS/auth/rate limiting;
no readiness endpoint (health is liveness-only by contract); metrics
unauthenticated as in development. Host-port operator access is a local
convenience, not a deployment model.

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
