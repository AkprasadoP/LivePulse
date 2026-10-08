# Authentication (Phase 10)

Identity in LivePulse is **authenticated**, not declared. PostgreSQL is the
identity/authorization source of truth; Redis is never auth state. This
document is the single reference for the HTTP auth surface, the WebSocket
identity flow, and the accepted revocation tradeoffs.

- Implementation: `src/modules/auth/` (schemas, password hashing, token
  service, credential/auth-session repositories, routes, HTTP middleware).
- Schema: `User`, `Credential` (one per user, `UNIQUE(userId)` and
  `UNIQUE(email)`), `AuthSession` (opaque refresh tokens, hashed).
- WS identity: `docs/api/websocket-protocol.md` §4–§5.

## 1. Identity flow (WebSocket)

```
WS connect
   ↓
auth.authenticate { token }         access token verified server-side (jose)
   ↓
connection.userId                   only server-derived; never client-supplied
   ↓
session.join { sessionId }          no identity field accepted
   ↓
(sessionId, userId)                 find-or-create SessionParticipant
   ↓
participant                         role + displayName read from the database
```

- A connection with no valid `auth.authenticate` is **view-only**: it joins
  the registry (broadcasts, `doubt.queue.list`) but binds **no** participant
  and gets `NOT_A_PARTICIPANT` for participant-bound events.
- `session.join` is a strict object: `participant`, `userId`, `participantId`
  and `role` are rejected with `INVALID_REQUEST`.
- `displayName` is **presentation data only** — a unique label, never a
  credential and never an authority.
- A failed `auth.authenticate` leaves any previously bound user untouched
  (a failed attempt is not a logout).

## 2. HTTP endpoints

All request/response bodies are JSON. Errors use the global shape
`{ statusCode, error, message, details? }`.

### `POST /auth/register` → 201

```json
{ "email": "teacher@example.com", "password": "at-least-8-chars", "displayName": "Ms. Ray" }
```

| Field         | Rules                                                         |
| ------------- | ------------------------------------------------------------- |
| `email`       | trimmed; 3–320 chars; valid email; canonicalized to lowercase |
| `password`    | 8–128 chars                                                   |
| `displayName` | 1–100 chars                                                   |

Response: `{ user: { id, email, displayName }, accessToken, refreshToken, expiresIn }`
(`expiresIn` is the access token's lifetime in seconds).

- One atomic nested write: user + credential, or neither.
- Duplicate **email** or **displayName** → `409` (existing global conflict).

### `POST /auth/login` → 200

```json
{ "email": "teacher@example.com", "password": "at-least-8-chars" }
```

Response shape is identical to register. Failures are fully **generic**:
unknown email and wrong password both return `401 { message: "Invalid email or
password" }`, and the unknown-email path performs a dummy password verify so
response timing does not reveal account existence.

### `POST /auth/refresh` → 200

```json
{ "refreshToken": "<opaque>" }
```

Response: `{ accessToken, refreshToken, expiresIn }`. The presented refresh
token is **rotated**: the old session is revoked and linked to the new one
(`rotatedFromId`). Presenting an already-revoked token signals reuse and
**revokes the whole user's session set** (`logout-everywhere`), then returns
`401 { message: "Invalid refresh token" }`.

### `POST /auth/logout` → 204

```json
{ "refreshToken": "<opaque>" }
```

Revokes the refresh session. **Idempotent and Oracle-free**: an unknown token
still returns `204` (no validity oracle).

### `GET /me` → 200

Requires `Authorization: Bearer <access-token>`. Returns
`{ user: { id, email, displayName } }`. Missing/malformed/expired/tampered
tokens all return `401`.

## 3. Tokens

| Token   | Form                            | Lifetime   | Stored                                                     |
| ------- | ------------------------------- | ---------- | ---------------------------------------------------------- |
| Access  | HS256 JWT `{ sub: userId }`     | 15 minutes | not stored (stateless, verified with `AUTH_ACCESS_SECRET`) |
| Refresh | 32 random bytes (base64url, 43) | 30 days    | SHA-256 hash only (`AuthSession.refreshTokenHash`)         |

- The raw refresh token is shown to the client once and **never persisted**; a
  database read yields only hashes.
- Access tokens carry no `jti`/session reference — they are self-contained.
- `AUTH_ACCESS_SECRET` (HS256, ≥ 32 chars) **must** be set in production
  (startup fails without it); development/test get a random per-boot secret
  (tokens invalidate on restart).

## 4. Revocation semantics (accepted tradeoff)

Revocation is **not** instantaneous. This is a deliberate design decision, not
a defect:

```
Refresh session revoked (logout, rotation, or reuse detection)
      ↓
future refresh/login prevented (refresh chain exhausted)
      ↓
existing WebSocket connections remain alive (no proactive socket kill)
      ↓
the live access token remains valid until it expires (≤ 15 minutes)
      ↓
future reconnects with that access token are rejected after expiry
```

- There is **no** distributed access-token revocation list and no push that
  severs live sockets. Adding one would introduce auth state outside
  PostgreSQL/Redis boundaries and a revocation fan-out — deliberately out of
  scope.
- A connection is never killed server-side because its refresh session was
  revoked; it ends when its socket closes or its token can no longer refresh.

## 5. Historical data

- Credential-less `User` rows created before authentication existed **remain**
  and are never deleted or rewritten.
- Historical `SessionParticipant` rows remain valid; identity is
  `(sessionId, userId)` and `displayName` is presentation only.
- There is **no destructive backfill**. A credential-less user simply cannot
  authenticate (there is no credential-less login path); it gains access only
  once a credential is attached (a claiming flow is a later phase).

## 6. Secret hygiene

Passwords are hashed with Argon2id (production: m=64 MiB, t=3, p=1). Passwords,
password hashes, access tokens, refresh tokens, refresh-token hashes and
`AUTH_ACCESS_SECRET` never appear in logs, error payloads, or responses — auth
views expose only `{ id, email, displayName }`.
