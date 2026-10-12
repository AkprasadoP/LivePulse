# LivePulse Frontend — Local Developer Guide

The LivePulse web app is a Next.js 16.4.0 frontend with App Router, TypeScript,
Tailwind CSS v4, and native WebSocket. It sits in `web/` at the repo root and
talks to the LivePulse backend via a same-origin `/api` proxy. There is no
Socket.IO, no Kafka client, and no mock live data in the core flows.

This file is the local setup + architecture reference. Backend contracts are
documented upstream at `docs/api/{authentication,http-api,websocket-protocol}.md`
and in `src/ws/protocol.ts`; treat those as the source of truth. This doc only
describes the frontend side.

## 0. Before you start

- Node >= 26, pnpm, and the backend running on its dev port (this workspace uses
  `PORT=3300`; adjust the `.env` values below to your backend). The backend needs
  Postgres (dev host `5433`) and Redis (dev host `6380`) both reachable and
  healthy.
- Run **from source** against the backend when verifying. The production Docker
  image that nginx fronts can be stale for auth routes; see the "Stale prod image"
  note in the final report. Do not use `:3100`/`:3200` as the backend URL for
  browser verification of auth flows.
- The browser verification was done with the **production build** (`pnpm start`)
  because Next dev HMR WebSocket (`_next/hmr`) occasionally fails in this
  environment and can desync React. For day-to-day dev, `pnpm dev` is fine; just
  be aware that a failed HMR frame can make the page look unresponsive even when
  the app is healthy — reload once before concluding the app is broken.

## 1. Repository layout (frontend)

```
web/
  next.config.ts              # /api/:path* → LIVEPULSE_BACKEND_URL/:path*
  src/
    app/                      # App Router pages + root layout
    components/
      layout/                 # site-header, logo, auth-shell
      ui/                     # button, form, card, badge, toast, modal, avatar, feedback
      features/
        auth/                 # auth-provider, login-form, register-form, require-auth
        live/                 # live-store, use-live-session, teacher-room, student-room,
                                # question-panel, presence-panel, leaderboard-panel,
                                # answer-activity, doubt-queue, create-quiz-dialog,
                                # session-controls, session-header, student-answer
    lib/
      config.ts               # API_BASE_URL (/api), WS_URL, token lifetime, WS timers
      utils/                  # cn(), format helpers
      auth/                   # JWT helpers
      storage/                # token-store (memory + localStorage refresh token,
                                # cross-tab sync), session-index (localStorage bookmark)
      api/                    # client, errors, types, auth, sessions, quizzes
      ws/                     # protocol constants + LiveSocket
    providers.tsx
  vitest.config.ts
  vitest.setup.ts
  pnpm-workspace.yaml
```

## 2. Environment variables

| Variable                  | Purpose                                           | Typical dev value                                  |
| -------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| `LIVEPULSE_BACKEND_URL`   | Upstream for the `/api` rewrite                   | `http://127.0.0.1:3300`                          |
| `NEXT_PUBLIC_API_BASE_URL`| HTTP base used by the app client                  | **leave unset** → defaults to `/api`              |
| `NEXT_PUBLIC_WS_URL`      | WebSocket connect target (direct to backend)      | `ws://127.0.0.1:3300/ws`                         |

- The app client goes through the same-origin `/api` proxy; do **not** set
  `NEXT_PUBLIC_API_BASE_URL` to a cross-origin backend (no CORS on the backend,
  bearer tokens).
- WebSocket connects directly to the backend; the token travels in an
  `auth.authenticate` frame, never in the connection URL.

A minimal dev invocation (backend on 3300):

```sh
cd LivePulse/web
LIVEPULSE_BACKEND_URL=http://127.0.0.1:3300 \
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:3300/ws \
pnpm dev --port 3000
```

A minimal production serve invocation (after `pnpm build`):

```sh
cd LivePulse/web
LIVEPULSE_BACKEND_URL=http://127.0.0.1:3300 \
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:3300/ws \
pnpm start --port 3000
```

## 3. The /api proxy — why it exists

`next.config.ts` rewrites `/api/:path*` to `${LIVEPULSE_BACKEND_URL}/:path*`. The
browser never makes a cross-origin request: the backend deliberately does not enable
CORS, access tokens are bearer tokens (never cookies), and proxying keeps every HTTP
call first-party. The WebSocket connects **directly** to the backend
(`NEXT_PUBLIC_WS_URL`); WS handshakes are not subject to CORS, and the token travels
inside an `auth.authenticate` frame, never in the connection URL.

`cacheComponents` is intentionally off: nearly every surface here is authenticated,
live, and client-driven, so the cache-component/Suspense model would add friction
without benefit. All routes are either static landing/auth pages or the dynamic
`sessions/[sessionId]` page.

## 4. Auth flow

### 4.1 Tokens

The backend returns a short-lived **access token** (900s) and a longer-lived
**refresh token**. The access token is what the app carries for API calls and the WS
authenticate frame; the refresh token is stored long-term and used only to get new
access tokens.

Frontend responsibilities:

- Store the access token in memory (the auth provider's internal state).
- Store the refresh token in `localStorage` under the key `livepulse.refresh_token`.
- Rotate the refresh token on every refresh (single-flight: concurrent 401s share
  one in-flight refresh via the auth provider, not the client).
- On cold start (SSR hydration), hydrate the access token from the in-memory store
  the auth provider built during the initial render if a token is present.
- On a 401, attempt one refresh-and-retry, then fall back to treating the session
  as gone (sign out).

### 4.2 How the app actually authenticates a call

- `src/lib/api/client.ts` owns one `ApiClient` for the whole app. UI components
  never call `fetch`.
- `src/lib/api/auth.ts` defines the auth endpoints (`register`, `login`, `refresh`,
  `logout`, `me`) with `auth: false` so they never 401-retry.
- `src/features/auth/auth-provider.tsx` owns the auth state machine: initial
  hydrate, token refresh, single-flight refresh dedup, cross-tab sync, and the HTTP
  refresh-and-retry hooks it wires into the client on mount.
- `src/features/auth/require-auth.tsx` is the route guard that forces sign-in.

### 4.3 Token refresh detail (correctness requirement)

The backend rotates the refresh token on every use and invalidates the previous one.
That means:

- Refresh must be **single-flight**: if two components both get 401 at the same
  time, only one refresh happens and both retries use the same new token.
- The client's 401 retry must send the **freshly-returned** token, not re-read the
  auth store after refresh (the store update and the retry can race). The client
  does this by passing the new token explicitly to the retry `send()` call.
- A failed refresh means the session is truly gone; the app signs out rather than
  retrying forever.

### 4.4 Cross-tab behavior

The auth provider listens for `storage` events to keep multiple tabs of the same
origin in sync. Practical consequence: **do not test two different user identities in
two tabs of the same browser partition** — the second registration/log-in will
overwrite the first tab's refresh token and trigger cross-tab sync, dropping the first
user. Use a separate browser partition (for example an incognito window) for the
second identity during multi-user verification.

### 4.5 XSS caveat (documented limitation)

The refresh token is stored in `localStorage`. Any script running in the page can read
it. This is a known trade-off: the app does not use HttpOnly cookies, and the refresh
token is long-lived relative to the access token. In the app's threat model the page
itself is trusted to run only first-party code; a stored XSS would be able to mint
access tokens until the refresh token is revoked or rotated by the backend's own
single-use rotation. Treat `localStorage` as a bearer secret and do not inject any
untrusted third-party script into the page.

## 5. Architecture: HTTP vs real-time

The frontend has two orthogonal data paths to the same session:

### 5.1 HTTP (authoritative reads + mutations)

- `src/lib/api/client.ts` — one `ApiClient`, bearer injection, one-shot 401 refresh
  retry, typed error mapping, network-failure → `ApiError` with `isNetwork`.
- `src/lib/api/errors.ts` — `ApiError` with a stable `describeApiError()` for UI
  sentences, plus `fieldIssues` that parses the backend's **flat-array** `details`
  shape (and defensively handles a nested `{issues:[]}` shape without crashing).
- `src/lib/api/sessions.ts`, `quizzes.ts` — typed endpoint wrappers.
- `src/lib/api/types.ts` — the exact shapes the backend returns (incl. the fact that
  `correctAnswer` never appears; the serializer only returns `hasCorrectAnswer`).

HTTP is used for: registration/login/refresh/logout, `/me`, session create/read,
session state transitions, quiz create/read, and the initial session detail read that
seeds the live state.

### 5.2 WebSocket (live updates)

- `src/lib/ws/protocol.ts` — the 15 server event types, the 15 request types, the 19
  protocol error codes, payload schemas.
- `src/lib/ws/client.ts` — `LiveSocket`: a small state machine (idle →
  connecting → authenticating → joining → connected → reconnecting → recovering →
  disconnected), exponential backoff with jitter, a `verifyAlive` probe that sends
  `doubt.queue.list`, and the invariant that **only one `LiveSocket` exists per
  session at a time**. `use-live-session` is the only consumer.
- `src/features/live/live-store.ts` — reducer; pure, testable, no React.
- `src/features/live/use-live-session.ts` — the controller: one socket per session,
  subscribes to every `SERVER_EVENT_TYPE`, folds frames into React state via the
  reducer, and provides the action helpers (`startQuiz`, `publishQuestion`,
  `closeQuestion`, `submitAnswer`, `createDoubt`, `resolveDoubt`, `dismissDoubt`,
  `refreshDoubts`).

### 5.3 How the two paths combine for a session page

1. The page mounts `use-live-session(sessionId)`.
2. It immediately does an HTTP `GET /sessions/:id` and folds the result into local
   state as a `session.state` event (name, roster, session state, start/stop times).
3. The WebSocket connects, authenticates, and joins. `session.joined` carries a
   **recovery snapshot** (quizzes, current question, own answer, standings, open
   doubts) that overwrites transient fields with the server's authoritative state.
4. From then on, both paths run: HTTP reads re-sync session state, and WS frames
   drive the live panels (question, presence, leaderboard, answer activity, doubts).

Important: **HTTP session-state transitions (CREATE → LIVE → ENDED) are NOT broadcast
over the WebSocket**. When a session is in `CREATED` state, the frontend polls
`GET /sessions/:id` every 6s until the state is no longer `CREATED`. This is a
documented backend limitation, not a frontend bug. Conversely, the live events
(`quiz.started`, `question.published`, `answer.accepted`, `leaderboard.updated`, …)
do arrive over WS.

### 5.4 No "list my sessions" endpoint

The backend has no "list the sessions I've been in/own" endpoint. The frontend keeps a
small client-side bookmark of recently-touched session ids in `localStorage`
(`session-index.ts`), so reopening a recent session works even without a server-side
listing. This is a workaround for a backend limitation and is documented as such.

### 5.5 `correctAnswer` never crosses the wire

Both the HTTP quiz serializer and the WS protocol deliberately omit the answer key.
The frontend only ever sees `hasCorrectAnswer` on the question object and a verdict
(`isCorrect`/`isWinner`) on accepted answers. The frontend stores and renders answers
as free text; it never displays, searches, or carries the answer key. This is enforced
server-side and reflected in the frontend DTOs and the question-panel/teacher-quiz-panel
code (which shows "scored"/"unscored" badges derived from `hasCorrectAnswer`, never any
answer text).

## 6. Role model + room routing

- One account works for both teaching and attending; the role is per-session, set by
  how you joined.
- `sessions/[sessionId]` is a single dynamic page. `require-auth` guards it. Inside,
  `use-live-session` determines the role from the `session.joined` event (`TEACHER` vs
  `STUDENT`), and the page renders the matching room component:
  - **Teacher room**: session header, question panel, teacher quiz panel (create/start/
    publish/close), presence, leaderboard, answer activity, doubt queue, session
    controls (go live / end session).
  - **Student room**: current question + answer input, leaderboard, doubt queue
    (raise/resolve), presence.
- There is no separate "teacher listing" or "student listing" page; the role is read
  from the live state at join time.

## 7. Real-time architecture, deep dive

### 7.1 One socket, one reducer, one controller

`use-live-session` is a singleton controller per session. It creates exactly one
`LiveSocket` in a `useEffect` and destroys it on unmount. All other components read
from the state that controller projects. Components never create their own sockets and
never call the WS layer directly — they call the action helpers.

### 7.2 Event subscription

The controller registers a listener for **every** `SERVER_EVENT_TYPES` entry
(`auth.authenticated`, `session.joined`, `session.state`, `quiz.started`,
`question.published`, `question.closed`, `answer.accepted`, `answer.rejected`,
`leaderboard.updated`, `doubt.created`, `doubt.resolved`, `doubt.dismissed`,
`doubt.queue.updated`, `presence.snapshot`, `error`). Each frame is folded into React
state by `reduceLiveEvent` from `live-store`. Because the subscription is a single
`SERVER_EVENT_TYPES.map(...)`, adding a new server event is a reducer change plus a
protocol constant — no component wiring change.

### 7.3 The reducer is the authority on shape

`live-store.ts` is pure and tested in isolation (18 tests). It owns:

- Recovery snapshot application (`session.joined`): sets the authoritative transient
  state (quizzes, current question, own answer, standings, open doubts).
- Question lifecycle (`question.published`, `question.closed`).
- Answer handling (`answer.accepted` / `answer.rejected`), including the dedupe key
  `${questionId}:${participantId}:${attemptNumber}` so the submitter's correlated
  private verdict and the session broadcast don't double up in the activity feed.
- Leaderboard (`leaderboard.updated`).
- Doubt queue (`doubt.created/resolved/dismissed/queue.updated`).
- Presence (`presence.snapshot`).

### 7.4 Answer submission

`submitAnswer` sends `quiz.answer{questionId, content}` (free text, content 1–2000
chars, **not** multiple choice). The backend replies on the same connection with an
`answer.accepted` (or `answer.rejected` on validation) correlated by `requestId` —
that private verdict drives the student's `ownAnswer`/`answerResult`. The same server
event is also broadcast to the session; the reducer dedups by attempt key so the
activity feed shows each answer once.

### 7.5 Presence

`presence.snapshot` frames carry the current room roster. The teacher and student
panels both render from this. Presence is ephemeral and reconciled on every join and
on every `presence.snapshot` frame.

### 7.6 Doubt queue

`doubt.queue.list` is the probe the controller sends to `verifyAlive` (a frame the
backend always replies to when connected). `doubt.queue.updated` refreshes the visible
queue. Raise/resolve/dismiss go through `doubt.create/resolve/dismiss`.

## 8. Reconnect + recovery

### 8.1 When a reconnect happens

The `LiveSocket` state machine treats brief silences as recoverable (backoff with
jitter, capped) and long silences as dead (force reconnect). On reconnect it
re-authenticates with the current access token, re-joins the session, and the
backend's `session.joined` response includes a **recovery snapshot** that
re-establishes authoritative transient state:

- quizzes (their states),
- current question (or null),
- own answer (the submitter's own verdict record),
- standings (leaderboard),
- open doubts,
- `recoveryReceived` flag.

This is what makes the live page survive a network drop, a tab backgrounding, or a
backend restart on the same session: reconnect, get the snapshot, continue.

### 8.2 What survives and what resets

**Survives reconnect:** session identity, role, participant id, display name; roster
from the session read; quiz catalog from HTTP reads (re-derived from the recovery
snapshot's quiz states on join); current question and its prompt/state **from the
recovery snapshot**; leaderboard **from the recovery snapshot**; open doubts.

**Resets on rejoin** (transient, re-filled by live events after reconnect): the answer
activity feed (the feed is ephemeral; a fresh join starts empty; the leaderboard and the
recovery `ownAnswer` are the authoritative records, not the feed).

### 8.3 Verification performed

Two rounds of reconnect/recovery verification were run against the real backend:

1. Teacher-kill-WS → student observes RECONNECTING (connection status banner) →
   rechecks → **RECOVERING** → recovery snapshot applied → leaderboard and `ownAnswer`
   preserved, feed starts fresh → `question.published` caught live → feed populates
   again.
2. Five consecutive page reloads of the teacher **and** five of the student (running
   server still up during all five) — each reload re-joined and recovered without losing
   leaderboard or own answer.

The live `ownAnswer` row is the authoritative record for "what did I answer and how was
it judged" — that record is recovered from the snapshot. The ephemeral activity feed is
not; that is by design.

### 8.4 Feed slot collision (documented limitation)

The activity feed dedups by the key `${questionId}:${participantId}:${attemptNumber}`.
If the same submitter answers two different questions and the second verdict lands in the
same feed slot as the first (when the feed is short and the key collides across
questions), the feed can briefly show a stale prompt next to a fresh "first correct"
badge. The leaderboard and the recovered `ownAnswer` are authoritative; the feed is a
pulse-reader. The frontend render for the feed uses the prompt currently attached to that
feed entry, so a collision can show the old prompt with the new verdict for one cycle.
Mitigations: the leaderboard is the source of truth for "who got first correct", and a
user can reload the quiz (or the page) to refresh badges.

## 9. Design system

### 9.1 Tokens (in `src/app/globals.css`)

- Warm canvas `#f6f6f3`, ink `#15171c`, single cobalt accent `#2f4bd8`.
- Status tokens: live / warn / danger / neutral, each with a soft variant.
- Dark mode is driven by `prefers-color-scheme` with a `@theme inline` block (no manual
  toggle class; the theme follows the OS).
- Radii: 5 / 7 / 10 / 14. Container: 76rem.
- One pop shadow (`--lp-shadow-pop`) and one card shadow (`--lp-shadow-card`).
- Documented z-layer scale in the globals.css comment: z-10 sticky bars (site header /
  session header), z-20 modal overlay, z-30 toasts, z-40 skip link. Applied in code:
  header and session header are `sticky top-0 z-10`, modal is portaled to `document.body`
  at `fixed inset-0 z-20`, toasts anchor `bottom-0 z-30`, and the skip link is `sr-only`
  until focused where it becomes `fixed z-40`.

### 9.2 Fonts

- Inter for UI text.
- Instrument Serif as the display face (`lp-display`) for the landing page, auth pages,
  and product sketch only — editorial contrast, not used in the live room.
- Geist Mono for monospace/tabular-nums contexts (`lp-tnum`).

### 9.3 Accessibility

- Status is never color-only (dot + text label).
- Visible `:focus-visible` outlines. `prefers-reduced-motion` respected.
- Skip-to-content link (sr-only until focused, then fixed z-40).
- Toasts anchor bottom-left on desktop (the right rail holds actions); modals are
  vertically centered (not bottom sheets) to avoid colliding with the toast band.
- Live/dashboard pages carry `pb-28` bottom clearance so the toast band does not cover
  content.

### 9.4 Modal portal fix

The "End session" dialog was originally rendered inside the sticky header's
`backdrop-blur` stacking context, which trapped it. The modal portaled the overlay to
`document.body` as `fixed inset-0 z-20`. A regression test (`components/ui/modal.test.tsx`,
5 tests) asserts the overlay wrapper is `fixed inset-0` and its parent is `document.body`.

## 10. Submitting an answer — what actually happens

1. Student types free text (1–2000 chars) and submits.
2. `use-live-session.submitAnswer` sends `quiz.answer{questionId, content}` over WS.
3. Backend replies with `answer.accepted` (or `answer.rejected`) correlated by
   `requestId`.
4. Reducer applies the private verdict: sets the student's `ownAnswer` and
   `answerResult`.
5. Same `answer.accepted` is broadcast; leaderboard re-ranks; the activity feed appends
   the answer (deduped by attempt key).

The answer input is **free text**, not multiple choice. The question prompt and the
student's submitted text are what the student sees; the answer key is never shown.

## 11. Quizzes — what the teacher sees vs the backend

- The teacher quiz panel shows quiz state from the **live session state** (frames +
  recovery snapshot) and quiz content (title, questions, prompts) from the HTTP quiz
  read (`GET /quizzes/:id`).
- Question badges (Draft/Published/Closed, scored/unscored) come from the HTTP quiz
  read. A known UX gap existed: after publish/close/start the catalog row could stay
  stale (e.g., a closed question still showing "Draft" until the teacher pressed
  "Reload"). The fix re-loads the affected quiz catalog row after a successful
  publish/close/start mutation, so the badge, the "on screen" label, and the
  publish/close enable match what actually happened.
- The backend never returns the answer key — only `hasCorrectAnswer` — so neither panel
  can leak it.

## 12. Running the tests

```sh
cd LivePulse/web
pnpm test          # vitest, jsdom + Testing Library, 94 tests across 11 files
pnpm test:watch    # watch mode
```

Notes on the test harness:

- `vitest.config.ts` sets up the `@/*` alias to `src/` so tests import the real modules
  (not mocks of the modules under test).
- `vitest.setup.ts` shims `window.localStorage` (jsdom 30 delegates to Node's disabled
  webstorage, which is undefined) and loads jest-dom + cleanup.
- There is **no** React/Vite plugin in the config. Vitest transpiles JSX through esbuild
  using `jsx: react-jsx` from tsconfig; that is sufficient for these tests, and adding a
  React plugin would drag in an incompatible Vite major. The `turbopack` loader rule in
  `next.config.ts` is only relevant for the Next/Turbopack path and is not part of the
  vitest/esbuild test path.

## 13. Running against production nginx (documented caveat)

The nginx entrypoint (`:3200`) fronts a Docker image. In this workspace that image is
known to be **stale for auth routes** (`dist/modules` has no `auth` module, so `/me` and
`/auth/*` 404). Because of that:

- Do **not** verify auth flows (`/register`, `/login`, `/me`, token refresh) against
  `:3100`/`:3200`. The proxy will 404 before the app can even register.
- Verify against the backend **running from source** (this workspace uses `PORT=3300`).
- When you do point the frontend at the nginx entrypoint in production, set
  `LIVEPULSE_BACKEND_URL` to the nginx origin (for example `https://lp.example.com`) and
  keep `NEXT_PUBLIC_WS_URL` pointing at the WS path nginx forwards (for example
  `wss://lp.example.com/ws`).

## 14. Final verification report (2026-10-09; re-verified 2026-10-11)

**Re-verified 2026-10-11** with explicit exit-status capture and the real Node
entrypoints (the package scripts are shell shims, so `node node_modules/.bin/tsc` fails
with `SyntaxError: Invalid or unexpected token`):

| Gate | Command (cwd `LivePulse/web`) | Exit | Output |
| --- | --- | --- | --- |
| Typecheck | `node node_modules/typescript/bin/tsc --noEmit` | **0** | no diagnostics |
| Lint | `node node_modules/eslint/bin/eslint.js .` | **0** | 0 errors, 2 warnings (both intentional `_url`/`_init` stubs) |
| Tests | `node node_modules/vitest/vitest.mjs run` | **0** | 11 files, 94 tests passed |
| Build | `LIVEPULSE_BACKEND_URL=… NEXT_PUBLIC_WS_URL=… node node_modules/next/dist/bin/next build` | **0** | compiled, 6 routes |

Serve the built app on a port that is genuinely free: `:3000` may still hold an older
`next-server`, and `:3200` is bound by a Docker nginx container (`127.0.0.1:3200->80`) in
front of a **stale image** — `next start -p 3200` reports "Ready" but loopback requests
reach the container first and 404 under `/api`. Check the port with
`lsof -nP -iTCP:<port> -sTCP:LISTEN`, then confirm `/` → `200` and `/api/me` → a Fastify
`401` before driving the browser. The 2026-10-11 pass served the build on `:3210`.

Gates (2026-10-09 pass):

- `pnpm exec tsc --noEmit` — exit 0, no errors.
- `pnpm lint` — exit 0.
- `pnpm test` — 94 tests passing across 11 files (client.test.ts: 13 incl. one
  fetch-receiver regression; auth-provider.test: 8; live-store.test.ts: 18; modal.test.tsx:
  5 incl. one portal regression; plus role-rooms, doubt-queue, student-answer,
  session-index, require-auth, and ws/client).
- `pnpm build` (with `LIVEPULSE_BACKEND_URL` and `NEXT_PUBLIC_WS_URL` set) — exit 0, all
  routes generated (`/`, `/dashboard`, `/login`, `/register`, `/sessions/[sessionId]`).

Browser verification (production build on :3000, backend from source on :3300):

- Register a teacher account via the proxy → dashboard.
- Create a session, go live, create a quiz, start it, publish a question.
- Register a student in a **separate browser partition** and join the session.
- Observe live presence ("2 online", both users listed) on both sides.
- Publish the question live: student instantly gets the free-text question; no
  `correctAnswer` anywhere.
- Student submits an answer → `answer.accepted` → "Correct. FIRST CORRECT" on the
  student side, leaderboard updates live, teacher's answer activity feed populates.
- Raise a doubt (student) → teacher sees it live → teacher resolves → student sees "No
  open doubts".
- Kill the teacher's WebSocket (force-reconnect) → student observes RECONNECTING →
  RECOVERING → recovery snapshot applied → leaderboard + own answer preserved, feed
  starts fresh → `question.published` caught live → feed populates again.
- Five consecutive reloads of both teacher and student — each re-joined and recovered
  without losing leaderboard or own answer.

Second pass (2026-10-11, teacher "Ms. Ray" / student "Ana", session "Physics — Period 3",
production build on `:3210`) re-ran the whole flow and added wire-level checks:

- Start quiz → both Publish buttons enable and "Start quiz" disables with **no manual
  reload**, and Close Q1 → publish Q2 behaves the same (the catalog re-load fix).
- Real socket drop on both sides: `Connected → Reconnecting → Recovering → Connecting →
  Connected`, snapshot applied; the student's `ownAnswer` and the leaderboard survive.
- Answer-key secrecy checked on the wire, not just in the DOM: no captured WS frame
  (including the `session.joined` recovery snapshot) contains a `correctAnswer` field or
  the key value, and `GET /quizzes/:id` returns only `hasCorrectAnswer`.
- Found (documented, not patched — see `report-phase12.md` §12.7 and §12.13): an unscored
  question is labelled "Scored" in the live question panel because the published payload
  omits `hasCorrectAnswer`; and the backend still **accepts** `quiz.answer` after the
  session has `ENDED` while correctly rejecting `doubt.create` with `SESSION_NOT_LIVE`.

Issues found and fixed during verification (2026-10-09 pass):

1. **`fetch` brand-check illegal invocation** — the app client called
   `this.fetchImpl(url, …)`, passing the `ApiClient` instance as `this`. Browsers
   brand-check `fetch` and throw "Illegal invocation" for any non-global receiver, which
   the client's network-failure catch misreports as "Can't reach LivePulse.". Tests never
   caught it because they inject `vi.fn` mocks (no brand check). Root cause confirmed with
   an in-page probe (`fetch.call(<non-global>)` throws; `fetch.call(undefined)` works;
   live-bundle disk chunk no longer contained the old call pattern, but the old server
   process was still on the port serving a stale manifest — the stale server was the
   immediate cause of the first several failed attempts). Fix: invoke through a local
   reference so `this` is undefined. A regression test asserts the client never passes a
   non-global receiver to `fetch`.
2. **Stale server on the serving port** — killing the pnpm wrapper did not kill the child
   `next-server`, so a stale server kept serving :3000 with old file manifests (500 for
   deleted chunks, 404 for new ones). Fix: killed the actual socket owner (`lsof -t` on the
   listening fd) before restarting.
3. **Stale quiz badge after publish/close/start** — the HTTP quiz read wasn't refreshed
   after mutations, so row badges and the "on screen" label could lag. Fix: re-load the
   affected quiz catalog row after a successful publish/close/start.
4. **Contact interception on scrolled action buttons** — automated clicks that scroll an
   action button into view can land under the sticky header (the header is ~121px tall).
   Real users clicking mid-page are fine; keyboard-driven scroll-to-focus can hide an
   element under the sticky bar. Documented as a polish item (add `scroll-margin-top` to
   action buttons) — not a correctness defect.

Limitations (not bugs, documented):
- HTTP session-state transitions are not broadcast over WS; frontend polls every 6s while
  `CREATED`.
- No "list my sessions" endpoint; the app uses a client-side localStorage session index as
  a workaround.
- The refresh token is in `localStorage`; a stored XSS could mint access tokens until
  rotation/revocation. Documented as a threat-model caveat.
- Dev HMR WebSocket (`_next/hmr`) can fail in this environment and desync React; reload
  once before concluding the app is broken.
- The activity feed is ephemeral and dedups by
  `${questionId}:${participantId}:${attemptNumber}`; a submitter answering multiple
  questions can briefly show a stale prompt next to a fresh verdict across a feed-slot
  collision. Leaderboard and recovered `ownAnswer` are authoritative.
