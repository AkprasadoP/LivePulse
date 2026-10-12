# LivePulse Frontend — Phase 12 Final Report

Verification date: 2026-10-09; **re-verified end to end on 2026-10-11** (§10 and §11
record the second pass and supersede the first-pass numbers where they differ).
Backend: LivePulse from source, `PORT=3300`, Postgres `5433`, Redis `6380` (both
healthy). Frontend: `web/`, Next.js 16.4.0, Tailwind CSS v4, App Router, TypeScript,
native WebSocket. Build+serve env: `LIVEPULSE_BACKEND_URL=http://127.0.0.1:3300`,
`NEXT_PUBLIC_WS_URL=ws://127.0.0.1:3300/ws`. Browser: production build served on
`:3210`, two browser partitions (teacher + student) for multi-user verification.

This report is the Phase 12 deliverable for the frontend. It covers what was built,
what was verified, what broke during verification and how it was fixed, and the
documented limitations.

---

## 1. Files changed

### New files created

- `web/src/app/page.tsx` — landing page (replaced create-next-app scaffold; static
  product sketch corrected to free-text answer, not multiple choice).
- `web/src/app/login/page.tsx`
- `web/src/app/register/page.tsx`
- `web/src/app/dashboard/page.tsx`
- `web/src/app/sessions/[sessionId]/page.tsx`
- `web/src/components/layout/logo.tsx`, `site-header.tsx`, `auth-shell.tsx`
- `web/src/components/ui/button.tsx`, `feedback.tsx`, `form.tsx` (incl. Checkbox),
  `card.tsx`, `badge.tsx`, `toast.tsx`, `modal.tsx`, `avatar.tsx`
- `web/src/features/auth/auth-provider.tsx`, `login-form.tsx`, `register-form.tsx`,
  `require-auth.tsx`
- `web/src/features/live/live-store.ts`, `use-live-session.ts`, `teacher-room.tsx`,
  `student-room.tsx`, `question-panel.tsx`, `presence-panel.tsx`,
  `leaderboard-panel.tsx`, `answer-activity.tsx`, `doubt-queue.tsx`,
  `raise-doubt-form.tsx` (inside doubt-queue), `create-quiz-dialog.tsx`,
  `session-controls.tsx`, `session-header.tsx`, `student-answer.tsx`
- `web/src/lib/config.ts`, `lib/utils/{cn,format}.ts`, `lib/auth/jwt.ts`,
  `lib/storage/{token-store,session-index}.ts` (+ session-index.test.ts),
  `lib/api/{types,errors,client,auth,sessions,quizzes}.ts` (+ client.test.ts),
  `lib/ws/{protocol,client}.ts` (+ client.test.ts)
- `web/vitest.config.ts`, `vitest.setup.ts`
- `docs/frontend/README.md` — local developer guide (written this session).
- `docs/frontend/report-phase12.md` — this file.

### Files modified this session

- `web/src/lib/api/client.ts` — fixed the `this.fetchImpl(url, …)` brand-check bug;
  added local-reference invocation so `this` is `undefined` instead of the
  `ApiClient` instance. Regression test assertion in the same file.
- `web/src/lib/api/client.test.ts` — added a regression test that proves the client
  never passes a non-global object as `fetch`'s receiver (13 tests total now pass).
- `web/src/lib/api/quizzes.ts` — removed the stale import that triggered the
  unused-var lint warning; publish/close locate the owning quiz from the live
  `quizCatalog` inside `use-live-session` (via `findQuizIdForQuestion`), not from a
  separate snapshot helper.
- `web/src/lib/api/sessions.ts` — no functional change this session.
- `web/src/features/live/use-live-session.ts` — `publishQuestion`/`closeQuestion`/
  `startQuiz` re-load the owning quiz catalog row after a successful mutation (fixes
  the stale badge gap). `findQuizIdForQuestion` was hoisted to module scope so the
  three `useCallback` dependency lists are stable (removes two
  `react-hooks/exhaustive-deps` warnings). The actions keep their **1-arg** shape:
  the hook already closes over `sessionId`, so threading it back in as a parameter is
  dead API surface (an intermediate 2-arg revision was written, then reverted — it
  produced three unused-parameter warnings and broke `tsc` against the panel prop).
- `web/src/features/live/components/teacher-room.tsx` — quiz panel wiring unchanged;
  no longer passes a redundant `sessionId` prop down to it.
- `web/src/features/live/components/teacher-quiz-panel.tsx` — single component;
  publish/close re-load the catalog row after the mutation (badge cure), no redundant
  `sessionId` prop, dead `ok` constant removed. The prop type is
  `startQuiz/publishQuestion/closeQuestion: (id: string) => Promise<ActionResult>`.
- `web/src/features/live/components/role-rooms.test.tsx` — dropped the
  `as LiveSessionController` cast, so the fixture is now **type-checked** against the
  controller interface; that is the check that would have caught the action-signature
  drift which broke `tsc` in the 2026-10-11 pass.
- `web/src/components/ui/modal.tsx` + `web/src/components/ui/modal.test.tsx` +
  `web/src/components/ui/toast.tsx` — portal fix and regression test (modal overlay
  is `fixed inset-0 z-20` parented by `document.body`), plus toast cleanup/polish.
- `web/src/app/globals.css` — documented z-layer scale (z-10 sticky bars, z-20
  modal overlay, z-30 toasts, z-40 skip link) and applied it to header/session-header,
  modal, toast, and skip link; `pb-28` clearance on live/dashboard pages.

### Test counts after this session

- `client.test.ts`: 13 tests (added 1 regression test for the fetch-receiver bug).
- `auth-provider.test`: 8 tests.
- `live-store.test.ts`: 18 tests.
- `modal.test.tsx`: 5 tests (regression test for the portal fix).
- `role-rooms.test.tsx`, `doubt-queue.test.tsx`, `student-answer.test.tsx`,
  `session-index.test.ts`, `require-auth.test.tsx`, etc.
- Total: 94 tests passing across 11 test files (vitest, jsdom + Testing Library).

---

## 2. Architecture summary

### 2.1 Two data paths, one session page

The frontend has two orthogonal data paths to the same session, both wired through
the same `sessions/[sessionId]` page:

1. **HTTP** — for authoritative reads and mutations. One `ApiClient` (`lib/api/
   client.ts`), bearer injection, one-shot 401 refresh retry, typed error mapping
   (`lib/api/errors.ts`), typed endpoint wrappers (`auth.ts`, `sessions.ts`,
   `quizzes.ts`), and the exact backend DTOs (`lib/api/types.ts`).
2. **WebSocket** — for live updates. `LiveSocket` (`lib/ws/client.ts`) is a small
   state machine with backoff and a `verifyAlive` probe; `live-store.ts` is the pure
   reducer (no React); `use-live-session.ts` is the singleton controller that owns
   one socket per session and subscribes to all 15 `SERVER_EVENT_TYPES`.

The page mounts `use-live-session(sessionId)`, immediately HTTP-reads
`GET /sessions/:id` and folds it into local state as a `session.state` event, then
connects the WS, authenticates, joins, and applies the `session.joined` recovery
snapshot. From there both paths run in parallel.

### 2.2 How the two paths divide responsibility

- HTTP owns: registration/login/refresh/logout, `/me`, session create/read, session
  state transitions, quiz create/read, the initial session detail read.
- WS owns: `quiz.started`, `question.published/closed`, `answer.accepted/rejected`,
  `leaderboard.updated`, `doubt.created/resolved/dismissed/queue.updated`,
  `presence.snapshot`, `session.state` (live), `auth.authenticated`.

The absence of an HTTP↔WS bridge for session-state transitions is a backend choice:
**HTTP session-state transitions (CREATED → LIVE → ENDED) are not broadcast over the
WebSocket.** The frontend therefore polls `GET /sessions/:id` every 6s while the
session is in `CREATED`, stopping the moment the state is no longer `CREATED`. This
is a documented backend limitation (see section 12).

### 2.3 Role model

One account works for both teaching and attending; the role is per-session, set by
how you joined. `require-auth` guards the session page; inside, the controller reads
the role from the `session.joined` event (`TEACHER` vs `STUDENT`) and the page renders
the matching room component. There is no separate teacher/student listing page — the
role is read from the live state at join time.

### 2.4 No "list my sessions" endpoint

The backend has no "list the sessions I've been in/own" endpoint. The frontend keeps
a small client-side bookmark of recently-touched session ids in `localStorage`
(`lib/storage/session-index.ts`). This is a workaround for a backend limitation (see
section 12).

### 2.5 Correct-answer secrecy

Both the HTTP quiz serializer and the WS protocol never return the answer key.
The frontend only ever sees `hasCorrectAnswer` on a question and an `isCorrect/
isWinner` verdict on accepted answers. The frontend stores and renders answers as
free text; it never displays, searches, or carries the answer key. This is enforced
server-side and reflected in the DTOs and in the question-panel / teacher-quiz-panel
code (which shows "scored"/"unscored" badges derived from `hasCorrectAnswer`, never
any answer text).

---

## 3. Design system

Tokens live in `src/app/globals.css`:

- **Colors**: warm canvas `#f6f6f3`, ink `#15171c`, single cobalt accent `#2f4bd8`.
  Status tokens: live / warn / danger / neutral, each with a soft variant.
- **Dark mode**: `prefers-color-scheme` driven, with a `@theme inline` block. No
  manual toggle class; the theme follows the OS.
- **Radii**: 5 / 7 / 10 / 14. **Container**: 76rem.
- **Shadows**: one pop shadow (`--lp-shadow-pop`) and one card shadow
  (`--lp-shadow-card`).
- **Fonts**: Inter for UI text; Instrument Serif as the display face (`lp-display`)
  for the landing page, auth pages, and product sketch only (editorial contrast,
  not in the live room); Geist Mono for monospace/tabular-nums (`lp-tnum`).

### 3.1 Documented and applied z-layer scale

The globals.css comment records the intended z scale and the code applies it:

- **z-10** — sticky bars: site header and session header are `sticky top-0 z-10`.
- **z-20** — modal overlay: portaled to `document.body` as `fixed inset-0 z-20`.
- **z-30** — toasts: `fixed inset-x-0 bottom-0 z-30`.
- **z-40** — skip link: `sr-only` until focused, then `fixed z-40`.

Practical layout choices that flow from this:

- Toasts anchor **bottom-left** on desktop (the right rail holds actions); live and
  dashboard pages carry `pb-28` bottom clearance so the toast band never covers
  content.
- Modals are **vertically centered** (never bottom sheets) to avoid colliding with
  the toast band.
- Status is **never color-only** (dot + text label).
- `:focus-visible` outlines, `prefers-reduced-motion`, and a skip-to-content link
  (sr-only until focused) are all in place.

### 3.2 Modal portal fix (applied this session)

The "End session" dialog was originally rendered inside the sticky header's
`backdrop-blur` stacking context, which trapped it. The modal now portals the overlay
to `document.body` as `fixed inset-0 z-20`. A regression test
(`components/ui/modal.test.tsx`, 5 tests) asserts the overlay wrapper is
`fixed inset-0` and its parent is `document.body`.

---

## 4. Inspo principles applied

The frontend used Nutlope's `inspo` repo as **design inspiration only** — not as a
copy target, not for its product logic, not for its stack. The principles taken from
it and applied to LivePulse:

- **Editorial-quality typography** — the Instrument Serif display face on the landing
  and auth pages gives the product sketch an editorial, non-dashboard feel; the live
  room stays clean Inter so the live information doesn't fight the typography.
- **Strong visual hierarchy** — a single accent, clear heading scale, and the
  sticky header + rail layout keep the live room's information hierarchy legible
  (question + controls in the main column, pulse of the class in the rail).
- **Intentional spacing** — the 5 / 7 / 10 / 14 radius set, the 76rem container, and
  the card/pop-shadow tokens come from a restrained, consistent system rather than
  per-component jury-rigging.
- **Restrained color** — one accent, warm neutral canvas, and status tokens with soft
  variants instead of a multi-hue palette. Status is never color-only.
- **Component polish over volume** — the UI kit is deliberately small (button, form,
  card, badge, toast, modal, avatar, feedback) and each is finished (focus states,
  loading states, portal correctness, toast anchoring) before the room components
  consume it.

What was **not** taken from Inspo: no product logic, no architecture, no API design,
no component API shaped to Inspo's products. Inspo influenced the look and feel; the
LivePulse backend contracts and the live-room UX are LivePulse's own.

---

## 5. HTTP/WS integration (how the frontend talks to the backend)

### 5.1 HTTP through the same-origin proxy

`next.config.ts` rewrites `/api/:path*` to `${LIVEPULSE_BACKEND_URL}/:path*`. The
browser never makes a cross-origin request:

- The backend deliberately does not enable CORS.
- Access tokens are bearer tokens (never cookies), injected by the app client as
  `Authorization: Bearer …`.
- Proxying keeps every HTTP call first-party, so no CORS relaxation of the backend is
  required.

The app client (`lib/api/client.ts`) is a singleton; UI components never call `fetch`.

### 5.2 WebSocket direct to the backend

`NEXT_PUBLIC_WS_URL` points the WS connect at the backend directly (for example
`ws://127.0.0.1:3300/ws`). WebSocket handshakes are not subject to CORS, and the
token travels inside an `auth.authenticate` frame, never in the connection URL.

### 5.3 Token refresh is single-flight

The backend rotates the refresh token on every use and invalidates the previous one.
The frontend therefore:

- makes refresh **single-flight** (concurrent 401s share one in-flight refresh via
  the auth provider, not the client),
- sends the **freshly-returned** token on the 401 retry (not a re-read of the auth
  store, which could race),
- treats a failed refresh as "session gone" and signs out.

This is a correctness requirement, not an optimization.

### 5.4 Auth endpoints and token lifetimes

`lib/api/auth.ts` defines `register`, `login`, `refresh`, `logout`, `me` with
`auth: false` so they never 401-retry. The access token lifetime is 900s; the app
refreshes at 80% of that lifetime via the auth provider.

### 5.5 Error envelope and field issues

The backend returns `{statusCode, error, message, details}`. The frontend's
`ApiError` (`lib/api/errors.ts`) maps this, and `fieldIssues` parses the backend's
**flat-array** `details` shape (and defensively handles a nested `{issues:[]}` shape
without crashing). Validation issues are mapped back to form fields from the Zod
paths.

### 5.6 HTTP vs WS state reconciliation

The initial session read folds into local state as a `session.state` event. The WS
`session.joined` frame carries a **recovery snapshot** (quizzes, current question,
own answer, standings, open doubts) that overwrites transient fields with the
server's authoritative state. After that, live events drive the panels and HTTP reads
re-sync session state. The two paths never fight because transient live state comes
from WS and the window of authority (name, roster, session-state transitions) comes
from HTTP + the recovery snapshot.

### 5.7 What's not bridged

- HTTP session-state transitions are not broadcast over WS (frontend polls while
  `CREATED`).
- There is no "list my sessions" endpoint (frontend uses a localStorage session index
  as a workaround).

---

## 6. Auth flow (end to end)

1. Cold start: the auth provider hydrates from its in-memory store if a token is
   present (SSR/initial render).
2. A user registers or logs in via the proxy (`/api/auth/register` or `/api/auth/login`
   → backend); the auth provider stores the access token in memory and the refresh
   token in `localStorage` under `livepulse.refresh_token`.
3. The access token is used for all HTTP calls (bearer injection) and for the WS
   `auth.authenticate` frame.
4. When the access token expires, the auth provider refreshes at 80% of the lifetime
   (single-flight, deduped across concurrent 401s), stores the new refresh token,
   and the client retries once with the freshly-returned access token.
5. On a 401 that can't be refreshed, the app signs out (logout is idempotent even for
   an unknown token — 204 — so sign-out never blocks).
6. Cross-tab: the auth provider listens for `storage` events to keep same-origin tabs
   in sync; refreshing in one tab rotates the token and the other tab picks it up.

LocalStorage caveat: the refresh token is long-lived relative to the access token and
is stored in `localStorage`. In the app's threat model the page is trusted to run only
first-party code; a stored XSS could mint access tokens until the refresh token is
rotated or revoked. This is documented as a threat-model caveat, not a bug to fix
in this phase (see section 12).

Multi-identity testing caveat: do not test two different user identities in two tabs
of the same browser partition — the second registration/log-in will overwrite the first
tab's refresh token and trigger cross-tab sync, dropping the first user. Use a separate
browser partition (for example an incognito window) for the second identity.

---

## 7. Teacher flow (verified end to end)

Re-run end to end on 2026-10-11 with teacher "Ms. Ray", session "Physics — Period 3" and
quiz "Newton's Laws" — see §11.2 for that pass's evidence and §12.7/§12.13 for the two
defects it uncovered. The steps below are the 2026-10-09 pass.

1. **Register** (teacher) via the proxy → dashboard ("Hello, Ada.").
2. **Create a session** ("Phase 12 Live Quiz") → session page, NOT STARTED, TEACHER,
   1 online, WS CONNECTED.
3. **Go live** → LIVE, timer running, "End session" appears.
4. **Create a quiz** ("Warm-up round", one question "What is 2 + 2?", correct answer
   "4", first-correct-wins) → DRAFT row.
5. **Start the quiz** → ACTIVE (verified: the quiz catalog row badge re-loads and
   shows ACTIVE after the mutation — the stale-badge fix).
6. **Publish the question** → on-screen, ACCEPTING ANSWERS, student sees it live.
7. **Close the question** → CLOSED badge refreshed without pressing "Reload" (the
   stale-badge fix unblocks the gate that was previously keyed on the stale HTTP read).
8. **Create quiz 2** ("Round two", "Name the largest planet.", correct "Jupiter") →
   start → publish → student sees it live.
9. **Resolve a doubt** raised by the student → "No open doubts" on both sides.

Teacher-side live panels verified working: session header (banner inside the sticky
header, connection status, presence counts, go-live/end-session controls), question
panel, teacher quiz panel (create/start/publish/close, badges), presence panel,
leaderboard panel, answer activity panel, doubt queue panel.

---

## 8. Student flow (verified end to end)

Re-run end to end on 2026-10-11 with student "Ana" — see §11.2. The steps below are the
2026-10-09 pass; note that step 3's "Scored — the first correct answer wins." line is the
string that can be wrong for an unscored question (§12.7).

1. **Register** (student, in a separate browser partition) via the proxy → dashboard
   ("Hello, Grace.").
2. **Join the session** by pasting the teacher's session link/id → session page,
   STUDENT, 2 online, WS CONNECTED, both users listed in the room.
3. **See the published question live** (free-text input, 0/2000 counter, "Scored —
   the first correct answer wins.").
4. **Submit an answer** → `answer.accepted` → "Correct. FIRST CORRECT — You were the
   first with the right answer.", own-answer row shows the submitted text, leaderboard
   updates live (Grace Student, FIRST CORRECT, 1).
5. **Raise a doubt** → teacher sees it live → (in the teacher branch) resolve → student
   sees "No open doubts".
6. **Answer a second question live** (Jupiter to "Name the largest planet.") → same
   live verdict + leaderboard update, confirmed across a reconnect/recovery cycle.

Student-side live panels verified working: current question + free-text answer input,
leaderboard, doubt queue (raise, resolve seen live), presence.

---

## 9. Real-time architecture (detailed)

### 9.1 One socket, one reducer, one controller

`use-live-session` is a singleton controller per session. It creates exactly one
`LiveSocket` in a `useEffect` and destroys it on unmount. All other components read
from the state that controller projects. Components never create their own sockets and
never call the WS layer directly — they call the action helpers.

### 9.2 Event subscription

The controller registers a listener for **every** `SERVER_EVENT_TYPES` entry
(`auth.authenticated`, `session.joined`, `session.state`, `quiz.started`,
`question.published`, `question.closed`, `answer.accepted`, `answer.rejected`,
`leaderboard.updated`, `doubt.created`, `doubt.resolved`, `doubt.dismissed`,
`doubt.queue.updated`, `presence.snapshot`, `error`). Each frame is folded into React
state by `reduceLiveEvent` from `live-store`. Because the subscription is a single
`SERVER_EVENT_TYPES.map(...)`, adding a new server event is a reducer change plus a
protocol constant — no component wiring change.

### 9.3 The reducer is the authority on shape

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

### 9.4 Answer submission

`submitAnswer` sends `quiz.answer{questionId, content}` over WS (free text, content
1–2000 chars, **not** multiple choice). The backend replies on the same connection
with an `answer.accepted` (or `answer.rejected` on validation) correlated by
`requestId` — that private verdict drives the student's `ownAnswer`/`answerResult`.
The same server event is also broadcast to the session; the reducer dedups by attempt
key so the activity feed shows each answer once.

### 9.5 Presence

`presence.snapshot` frames carry the current room roster. The teacher and student
panels both render from this. Presence is ephemeral and reconciled on every join and
on every `presence.snapshot` frame.

### 9.6 Doubt queue

`doubt.queue.list` is the probe the controller sends to `verifyAlive` (a frame the
backend always replies to when connected). `doubt.queue.updated` refreshes the visible
queue. Raise/resolve/dismiss go through `doubt.create/resolve/dismiss`.

### 9.7 Reconnect + recovery

The `LiveSocket` state machine treats brief silences as recoverable (backoff with
jitter, capped) and long silences as dead (force reconnect). On reconnect it
re-authenticates with the current access token, re-joins, and the `session.joined`
response includes a **recovery snapshot** with exactly five keys — `quizzes` (states),
`question` (or null), `ownAnswer` (the submitter's own verdict record), `standings`
(leaderboard) and `doubts` (open queue + truncation flag) — verified on the wire in
§11.2. Applying that snapshot also sets the frontend-only `recoveryReceived` flag in
`LiveSessionState` (a reducer field, not a protocol field).

**What survives reconnect:** session identity, role, participant id, display name,
roster from the session read, quiz catalog from HTTP reads, current question and its
prompt/state from the recovery snapshot, leaderboard from the recovery snapshot, open
doubts.

**What resets on rejoin:** the answer activity feed (ephemeral; a fresh join starts
empty; the leaderboard and the recovered `ownAnswer` are the authoritative records,
not the feed).

**Verified (2026-10-11, measured):** a real socket close (`close(4000, …)`) on both the
teacher's and the student's live socket produced the exact sequence
`Connected → Reconnecting → Recovering → Connecting → Connected`, captured with a
`MutationObserver` on the connection pill, with the snapshot applied before the header
returns to `Connected` (the full evidence, including the captured `session.joined`
recovery payload, is in §11.2). After recovery: current question, quiz catalog,
leaderboard and presence intact; the student's `ownAnswer` re-rendered with its verdict;
the answer-activity feed empty (by design). The 2026-10-09 pass additionally ran a
teacher-kill-WS cycle plus five consecutive reloads of both teacher and student, each
re-joining and recovering without losing the leaderboard or own answer.

The live `ownAnswer` row is the authoritative record for "what did I answer and how
was it judged" — that record is recovered from the snapshot. The ephemeral activity
feed is not; that is by design.

### 9.8 Feed slot collision (documented limitation)

The activity feed dedups by `${questionId}:${participantId}:${attemptNumber}`. If the
same submitter answers two different questions and the second verdict lands in the same
feed slot as the first (when the feed is short and the key collides across questions),
the feed can briefly show a stale prompt next to a fresh "first correct" badge. The
leaderboard and the recovered `ownAnswer` are authoritative; the feed is a pulse-reader.
A user can reload the quiz or the page to refresh badges. This limitation was observed
live during the reconnect verification (the reconnected feed briefly showed the fresh
Jupiter verdict next to the old "What is 2 + 2?" prompt) and is documented, not a
defect to fix in this phase.

---

## 10. Test, typecheck, lint, build results

**Re-verified 2026-10-11 with explicit exit-status capture** (`cmd; echo "EXIT=$?"`).
The package scripts are POSIX shell shims in this environment (running
`node node_modules/.bin/<tool>` fails with `SyntaxError: Invalid or unexpected token`),
so each gate was invoked through its real Node entrypoint:

| Gate | Command (cwd `LivePulse/web`) | Exit | Output |
| --- | --- | --- | --- |
| Typecheck | `node node_modules/typescript/bin/tsc --noEmit` | **0** | no diagnostics |
| Lint | `node node_modules/eslint/bin/eslint.js .` | **0** | 0 errors, 2 warnings |
| Tests | `node node_modules/vitest/vitest.mjs run` | **0** | 11 files, 94 tests passed |
| Build | `LIVEPULSE_BACKEND_URL=… NEXT_PUBLIC_WS_URL=… node node_modules/next/dist/bin/next build` | **0** | compiled, 6 routes |

Build output: `✓ Compiled successfully in 478ms`, TypeScript checked by the build,
static `/`, `/_not-found`, `/dashboard`, `/login`, `/register` plus dynamic
`/sessions/[sessionId]`.

Notes:

- The only two lint warnings are `@typescript-eslint/no-unused-vars` on the injected
  fetch-stub parameters (`_url`, `_init`) at `lib/api/client.test.ts:177`. Both are
  intentional (the stub must match `fetch`'s arity) and unrelated to any code changed
  here.
- The "Cannot access variable before it is declared at line 327 of a 238-line file"
  diagnostic recorded in the 2026-10-09 revision **no longer reproduces**; the current
  lint output is clean apart from the two `_url`/`_init` warnings above. It is not a
  real finding and needs no suppression.
- The test harness uses `vitest.config.ts` with the `@/*` alias to `src/` so tests
  import real modules (not mocks of the modules under test), and `vitest.setup.ts`
  shims `window.localStorage` (jsdom 30 delegates to Node's disabled webstorage, which
  is undefined) plus jest-dom + cleanup. There is no React/Vite plugin; Vitest
  transpiles JSX through esbuild via `jsx: react-jsx` from tsconfig, which is
  sufficient. The `turbopack` loader rule in `next.config.ts` is only relevant for
  Next/Turbopack and is not used by the vitest/esbuild path.


---

## 11. Browser verification report (real backend, production build)

### 11.0 Serving the build for verification (environment traps worth recording)

The 2026-10-11 pass served the production build on **`:3210`**, deliberately not
`:3000`/`:3200`:

- `:3000` is held by a two-day-old `next-server` process from the 2026-10-09 pass; it
  was left running rather than killed.
- `:3200` is bound by the Docker `livepulse-nginx-prod` container
  (`127.0.0.1:3200->80`). `next start -p 3200` still reports "Ready", but macOS routes
  loopback traffic to the container's more specific `127.0.0.1` bind first, so requests
  silently reach the **stale prod image** (whose `/api/*` 404s — §12.6). Symptom:
  `/api/me` answered `Route GET:/api/me not found` from `nginx/1.28.3` instead of a
  Fastify `401`.
- Before any browser work, `lsof -nP -iTCP:3210 -sTCP:LISTEN` showed the port free and
  the fresh server answered `GET /` → `200` plus `GET /api/me` →
  `{"statusCode":401,"error":"Unauthorized","message":"Authentication required"}`,
  proving the `/api` rewrite reached the from-source backend. Backend pre-flight:
  `GET :3300/` → `{"name":"livepulse","status":"ok"}`, `GET :3300/ws` → `426`.

Takeaway: on this machine, prove the *serving process* is the one you built before
trusting any browser result (a `200` from `/` plus a Fastify `401` from `/api/me` is a
good signature).

### 11.1 First pass (2026-10-09) — teacher "Ada", student "Grace"

That pass ran against the backend from source on `:3300` and the production build on
`:3000` (the production build was chosen because Next dev HMR WebSocket can fail in this
environment and desync React; a failed HMR frame makes the page look unresponsive even
when the app is healthy — reload once before concluding the app is broken).

By the numbers:

- **Register (teacher)** via proxy → dashboard ("Hello, Ada.").
- **Create session** ("Phase 12 Live Quiz") → NOT STARTED, TEACHER, 1 online, WS
  CONNECTED.
- **Go live** → LIVE, timer running.
- **Create quiz** ("Warm-up round", "What is 2 + 2?", correct "4", first-correct-wins)
  → DRAFT row.
- **Start the quiz** → ACTIVE (badge re-loads and shows ACTIVE — stale-badge fix).
- **Publish the question** → on-screen, ACCEPTING ANSWERS; student sees it instantly.
- **Register student** (separate browser partition) → join session → STUDENT, 2 online,
  WS CONNECTED, both users listed.
- **Live presence** confirmed on both sides ("2 online", both users listed).
- **Student answers** "4" → `answer.accepted` → "Correct. FIRST CORRECT", leaderboard
  updates live (Grace Student, FIRST CORRECT, 1), teacher's answer activity feed
  populates.
- **Create quiz 2** ("Round two", "Name the largest planet.", correct "Jupiter") →
  start → publish → student sees it live.
- **Student answers** "Jupiter" → same live verdict + leaderboard update.
- **Raise a doubt** (student) → teacher sees it live → teacher resolves → student sees
  "No open doubts".
- **Kill teacher WS** → student observes RECONNECTING → RECOVERING → recovery snapshot
  applied → leaderboard + own answer preserved, feed starts fresh → `question.published`
  caught live → feed populates again.
- **Five consecutive reloads** of teacher **and** five of student — each re-joined and
  recovered without losing leaderboard or own answer.
- **No `correctAnswer` anywhere** — verified by reading the full DOM text of both the
  teacher and student pages after reconnect and after reloads; the pages contain only
  the prompt, the student's submitted text, and the verdict labels. The answer key never
  appears.

### 11.2 Second pass (2026-10-11) — teacher "Ms. Ray", student "Ana", session "Physics — Period 3"

The whole flow was re-run from scratch against the real backend on a freshly built and
served production bundle, with the evidence recorded as it happened.

Teacher → student flow:

- **Register (teacher)** via `/register` → `/dashboard` ("Hello, Ms.." — see §12.12).
- **Create session** "Physics — Period 3" → `/sessions/…`, `NOT STARTED`, `TEACHER`,
  `1 online · 1 participant`, `Connection: Connected`.
- **Go live** → `LIVE`, timer running, "End session" replaces "Go live".
- **Create quiz** "Newton's Laws", two questions: Q1 "What is the SI unit of force?"
  with correct answer `newton` + first-correct-wins; Q2 "What is the SI unit of
  energy?" with **no** correct answer → DRAFT row, Q1 `scored`, Q2 `unscored`.
- **Start quiz** → `ACTIVE`; both Publish buttons became enabled and "Start quiz"
  disabled **with no manual reload** (the catalog re-load after the mutation, §13.4).
- **Publish Q1** → "Question 1 / ACCEPTING ANSWERS"; Q1 badge `PUBLISHED` + "on screen".
- **Register student** (separate incognito partition) → session URL → auto-joins as
  `STUDENT`, `Connection: Connected`, 2 online, both participants listed.
- **Student answers** `newton` → "YOUR ANSWER / Correct. / FIRST CORRECT / You were the
  first with the right answer."; leaderboard becomes `1 · A · Ana · FIRST CORRECT · 1`.
  The teacher received it over WS with no action of its own: leaderboard
  `Ana FIRST CORRECT 1` and answer activity `Ana · FIRST CORRECT`.
- **Student raises a doubt** → teacher's queue shows `1 open · Ana · just now`;
  **teacher resolves** → student shows "No open doubts" (`doubt.resolved` broadcast, no
  student action).
- **Close Q1, publish Q2** → Q1 `CLOSED` with both its buttons disabled, Q2 `PUBLISHED` +
  "on screen" — again with no manual reload.
- **Student answers Q2** (unscored) → "Answer recorded. This question is not scored."
- **End session** (confirm dialog "End this session? Ending is permanent…") → teacher
  shows `ENDED` + "This session has ended. Answers and doubts are frozen."

WebSocket drop + recovery (both sides, real sockets):

- Nothing was simulated: the live `WebSocket` instance was captured by wrapping
  `WebSocket.prototype.send` (the app's own `verifyAlive` probe sends
  `doubt.queue.list`), then `close(4000, …)` was called on it.
- Teacher, observed via a `MutationObserver` on the connection pill (not a sampler, so
  sub-frame states are visible):
  `Connected → Reconnecting (+605ms) → Recovering → Connecting (+3ms) → Connected`,
  the whole cycle in ~530ms. After recovery the current question, quiz catalog,
  leaderboard (`Ana FIRST CORRECT 1`) and presence were all intact; the answer-activity
  feed restarted empty (by design, §9.7).
- Student: the same sequence, and **the recovered `ownAnswer` re-rendered as "YOUR
  ANSWER / newton / Correct. / FIRST CORRECT"** with leaderboard and current question
  intact.
- The reconnect frames were intercepted to prove what recovery actually carries:
  `auth.authenticated` → `session.joined` → `session.state` → `presence.snapshot`, with
  `recovery: {quizzes, question, ownAnswer, standings, doubts}` and
  `ownAnswer: {content:"joules", isCorrect:null, isWinner:false, attemptNumber:1}`.

Answer-key secrecy (checked on the wire, not just in the DOM):

- **No WS frame contains a `correctAnswer` field or the key value**: `/correctAnswer/i`
  and `/\bnewton(?!'s)/i` both fail across every captured frame, **including the
  recovery snapshot**.
- **Neither page's DOM contains the key** after publishing, after answering, after
  recovery and after Q2 publication. (The only `newton` in either page is the quiz
  title "Newton's Laws"; the check deliberately excludes `Newton's`.)
- **The HTTP quiz read returns only a boolean**:
  `{"question":{"prompt":"What is the SI unit of force?","hasCorrectAnswer":true,
  "firstCorrectWins":true,"state":"CLOSED"}}` — the key value never crosses HTTP
  either (§12.11 notes that this read answers `200` anonymously).

### 11.3 Issues found and fixed during verification (2026-10-09 pass)

1. **`fetch` brand-check illegal invocation** — the app client called
   `this.fetchImpl(url, …)`, passing the `ApiClient` instance as `this`. Browsers
   brand-check `fetch` and throw "Illegal invocation" for any non-global receiver, which
   the client's network-failure catch misreports as "Can't reach LivePulse.". Tests
   never caught it because they inject `vi.fn` mocks (no brand check). Root cause
   confirmed with an in-page probe. **Cure:** invoke through a local reference so `this`
   is `undefined` instead of the `ApiClient` instance. A regression test asserts the
   client never passes a non-global receiver to `fetch`. **Note:** several of the first
   verification attempts failed not because of the code bug alone but because the server
   on `:3000` was a stale process still serving old file manifests (the pnpm wrapper
   kill did not kill the child `next-server`). After killing the actual socket owner
   and restarting, the production build served the fixed bundle consistently.
2. **Stale simulator on the serving port** — killing the pnpm wrapper did not kill the
   child `next-server`, so a stale server kept serving `:3000` with old file manifests
   (500 for deleted chunks, 404 for new ones). **Cure:** killed the actual socket owner
   (`lsof -t` on the listening fd) before restarting.
3. **Stale quiz badge after publish/close/start** — the HTTP quiz read wasn't refreshed
   after mutations, so row badges and the "on screen" label could lag (e.g., a closed
   question still showing "Draft" until the teacher pressed "Reload"). **Cure:** re-load
   the affected quiz catalog row after a successful publish/close/start (and after
   `quiz.start`).
4. **Sticky-header click interception** — automated clicks that scroll an action button
   into view can land under the sticky header (the header is ~121px tall). Real users
   clicking mid-page are fine; keyboard-driven scroll-to-focus can hide an element under
   the sticky bar. Documented as a polish item (add `scroll-margin-top` to action
   buttons) — not a correctness defect.

### 11.4 Defects and staleness found in the second pass

The second pass surfaced five things the green unit suite could not see. Two are real
user-visible defects (§12.7, §12.13); the other three are staleness/readability notes
(§12.8–§12.10). None is patched in this pass, and the reasons are given in each section
— §12.7 and §12.13 both need a decision that is not a frontend call (a shared payload
field, and a server-side guard).

1. **An unscored question is labelled "Scored"** in the live question panel, so the same
   screen reads "Scored — the first correct answer wins." *and* "Answer recorded. This
   question is not scored." (§12.7). Reachable by any teacher who ticks
   "First correct answer wins" but leaves the answer blank.
2. **`quiz.answer` is still accepted after the session has ended**, while `doubt.create`
   is correctly rejected with `SESSION_NOT_LIVE` — so the UI's "Answers and doubts are
   frozen" banner is only half-enforced (§12.13, backend gap).
3. **The question card still says "ACCEPTING ANSWERS" after the session ends** (§12.8).
4. **The participant total lags the live online count** — "2 online · 1 participant"
   until the next session re-read (§12.9).
5. **`RECOVERING` is painted for ~3 ms** on the cached-token path, so the recovery banner
   is effectively invisible in practice (§12.10).

Everything else in the second pass matched the documented behaviour exactly, including
the stale-badge cure (start/close/publish each updated the catalog row with no manual
reload) and every answer-key secrecy check.

---

## 12. Documented limitations (not bugs to fix in this phase)

Sections 12.1–12.6 are the backend/environment limitations recorded on 2026-10-09.
Sections 12.7–12.13 were added by the 2026-10-11 pass: 12.7 and 12.13 are **defects**
(one frontend, one backend enforcement gap), the rest are staleness or readability
findings.

### 12.1 HTTP session-state transitions are not broadcast over WS

The backend does not broadcast HTTP session-state transitions (`CREATED` → `LIVE` →
`ENDED`) over the WebSocket. The frontend therefore polls `GET /sessions/:id` every
6s while the session is in `CREATED`, stopping the moment the state is no longer
`CREATED`. This is a backend design choice, not a frontend bug. The frontend handles it
cleanly (the poll is bounded, stops immediately once live, and the WS `session.joined`
recovery snapshot also carries the authoritative session state on join).

### 12.2 No "list my sessions" endpoint

The backend has no "list the sessions I've been in/own" endpoint. The frontend uses a
client-side `localStorage` session index (`lib/storage/session-index.ts`) as a
workaround so reopening a recently-touched session works. This is a documented backend
limitation; the frontend workaround is thin and documented in the README.

### 12.3 LocalStorage refresh-token XSS caveat

The refresh token is stored in `localStorage` (key `livepulse.refresh_token`). It is
long-lived relative to the access token, and any script running in the page can read it.
In the app's threat model the page is trusted to run only first-party code; a stored XSS
could mint access tokens until the refresh token is rotated or revoked. The backend's
single-use refresh rotation limits the blast radius somewhat, but the storage location
is still a bearer secret. Do not treat `localStorage` as a safe place for untrusted
code. This is a documented caveat, not a bug fixed in this phase (fixing it properly
would mean HttpOnly cookies or a different token-delivery model, which is a product/
infra decision beyond a frontend phase).

### 12.4 Dev HMR WebSocket can fail in this environment

Next dev HMR WebSocket (`_next/hmr`) can fail with `ERR_INVALID_HTTP_RESPONSE` in
this environment and desync React, making the page look unresponsive even when the app
is healthy. This is an environment-specific dev-mode issue, not an app bug. For
verification, the production build (`pnpm start`) was used. For day-to-day dev, reload
once before concluding the app is broken.

### 12.5 Activity feed is ephemeral and can show a stale prompt across a slot collision

The activity feed dedups by `${questionId}:${participantId}:${attemptNumber}`. A
submitter answering two different questions can briefly show a stale prompt next to a
fresh verdict across a feed-slot collision. The leaderboard and the recovered `ownAnswer`
are authoritative; the feed is a pulse-reader. A user can reload the quiz or the page
to refresh badges. This limitation was observed live and is documented, not a defect.

### 12.6 Stale production Docker image (environment note)

The nginx entrypoint fronts a Docker image that, in this workspace, is known to be
**stale for auth routes** (`dist/modules` has no `auth` module, so `/me` and
`/auth/*` 404). This is an environment fact, not a frontend bug. Because of it:

- Do not verify auth flows (`/register`, `/login`, `/me`, token refresh) against
  `:3100`/`:3200`. The proxy will 404 before the app can even register.
- Verify against the backend **running from source** (this workspace uses `PORT=3300`).
- When pointing the frontend at the nginx entrypoint in production, set
  `LIVEPULSE_BACKEND_URL` to the nginx origin and keep `NEXT_PUBLIC_WS_URL` pointing at
  the WS path nginx forwards. Confirm the image is current before relying on it for
  auth verification.

### 12.7 An unscored question is labelled "Scored" in the live question panel

**Observed** (2026-10-11), student view of a question created with "First correct
answer wins" left ticked but **no** correct answer entered:

```text
Question 2
ACCEPTING ANSWERS
What is the SI unit of energy?
Scored — the first correct answer wins.        <- claims it is scored
YOUR ANSWER
Answer recorded. This question is not scored.   <- says it is not
```

**Root cause.** `QuestionPanel` derives its scoring line from `firstCorrectWins` alone
(`components/question-panel.tsx:52-55`): true → "Scored — the first correct answer
wins.", false → "Answers are recorded for this question." But the live
`question.published` payload and the recovery snapshot's `question` both carry
`firstCorrectWins` and **not** `hasCorrectAnswer`, so the panel cannot tell a scored
question from an unscored one and infers scoring from the flag. Confirmed on the wire:
that question's HTTP read reports
`{"prompt":"What is the SI unit of energy?","hasCorrectAnswer":false,"firstCorrectWins":true}`.

The teacher's quiz panel does **not** have this problem (it uses the HTTP quiz read, so
it correctly shows `unscored`), and neither does the student's verdict line (it uses the
authoritative `isCorrect: null`). That is exactly why the contradiction is visible: two
surfaces, two sources of truth for "is this scored".

**Fix options** (both small; neither weakens a check):

1. **Preferred — send the missing field.** Add `hasCorrectAnswer` to
   `question.published` and to the recovery snapshot's `question`, mirror it in
   `QuestionPublishedPayload`/`RecoveryQuestion`, and let the panel tri-state its copy.
   This keeps one source of truth. It is a backend change (Phase 10/11 module) plus a
   one-line frontend type update.
2. **Frontend-only stopgap.** Reword the line so it states the configured *rule* rather
   than the outcome (`firstCorrectWins` → "First correct answer wins."), which is never
   false. Immediate, but it drops the explicit "Scored" cue for genuinely scored
   questions.

Not patched in this pass: the frontend must not invent server state, and option 1
changes a shared backend contract.

### 12.8 The question card keeps saying "ACCEPTING ANSWERS" after the session ends

Because HTTP session-state transitions are not broadcast (§12.1), the student's page kept
showing `LIVE` + "Running 05:38" + "ACCEPTING ANSWERS" after the teacher ended the
session. Dispatching the app's own `online` handler (what regaining focus does) corrected
the header to `ENDED` — "This session has ended. Thanks for taking part — the
leaderboard below is final." — but the question card still read "ACCEPTING ANSWERS",
because the card renders the last `question.published` frame's `acceptingAnswers` and
nothing recomputes it when the session state arrives over HTTP.

Impact: cosmetic *by itself* — a student who loads or refreshes into an `ENDED` session
sees the correct banner immediately — but it compounds with §12.13, because the server
really does keep accepting answers for a question that stays `PUBLISHED` after the end.

### 12.9 The participant total lags the live online count

The header reads `N online · M participants` from two different sources: `N` from the WS
`presence.snapshot` (live) and `M` from the last HTTP `GET /sessions/:id` read (the
roster). A student who joins after that read shows `2 online · 1 participant` until the
next re-read — which happens only on reconnect, tab focus or the `online` event, because
the 6s poll stops as soon as the session is no longer `CREATED` (§12.1).

Impact: cosmetic and self-correcting. Observed in this pass (`2 online · 1 participant`
right after the student joined, `2 online · 2 participants` after the reconnect/refresh).
If a live count is wanted, the fix is to take `M` from presence as well (or to re-read on
every `presence.snapshot`) rather than from the roster.

### 12.10 `RECOVERING` is painted for ~3 ms on the fast path

The observed reconnect sequence was
`Connected → Reconnecting (+605ms) → Recovering → Connecting (+3ms) → Connected`
(measured with a `MutationObserver` on the connection pill, so the intermediate renders
are real and not a sampling artifact). The `Recovering` state is entered before the
socket is re-opened and leaves as soon as re-authentication starts; with the access token
still cached, `resolveToken()` resolves in a microtask, so the state lasts ~3 ms and the
recovery banner ("Recovering. Restoring the current question, leaderboard and doubts.")
is effectively never readable.

Impact: cosmetic — recovery itself is correct and the snapshot is applied in time (the
header only flips to `connected` after `session.joined` has been dispatched). If a human-
readable recovery notice matters, the state needs a minimum display time (or the banner
should be driven from the recovery result rather than the transient status).

### 12.11 Quiz and session content is readable anonymously (backend read policy)

`GET /api/quizzes/:id` returned `200` with the full quiz (title, prompts, question
states) to a request carrying **no** `Authorization` header, and `GET /api/sessions/:id`
reads are open by the same policy (`lib/api/sessions.ts` documents that reads are open,
creation and mutation require a token). The frontend mirrors the policy rather than
inventing a guard.

Impact: accepted backend read policy, recorded here because browser verification is where
it becomes visible. The answer key is still never returned (§9.7/§11.2), so the exposure
is the question *text* to anyone holding a quiz id, not the answers.

### 12.12 A display name ending in a period greets as "Hello, Ms.."

The dashboard greeting renders `Hello, <first token>.<period>`, so a display name of
`Ms. Ray` produces `Hello, Ms..`. Purely cosmetic; noted because it was the first thing
rendered in the verified flow. A fix would be to trim a trailing period (or greet with
the full display name).

### 12.13 `quiz.answer` is accepted after the session has ENDED (backend enforcement gap)

**Observed** (2026-10-11), on a session whose authoritative state was `ENDED`
(confirmed by `GET /api/sessions/:id` → `"state":"ENDED"`), using the student's own
still-open session socket:

- `quiz.answer` for the published question → **`answer.accepted`**
  (`{sessionId, questionId, participantId, displayName:"Ana", isCorrect:null,
  isWinner:false, attemptNumber:1}`).
- `doubt.create` on the same live socket → **`error SESSION_NOT_LIVE`**
  ("Raise doubts while the session is LIVE").
- The question itself stays `state: "PUBLISHED"` after the session ends — the quiz read
  reports `[{state:"CLOSED"},{state:"PUBLISHED"}]` post-end — so `acceptingAnswers`
  remains true and the question never transitions to `CLOSED` on session end.

So the two guards are asymmetric: doubt creation is gated on the session being `LIVE`,
answer submission is gated only on the *question* accepting answers. This matters because
of what the product promises: the teacher's dialog says "Answers and doubts are frozen"
and the student's ended banner says "the leaderboard below is final" — neither is
enforced server-side for answers.

**Reachable path.** A student sitting on an open (unanswered) question when the session
ends keeps a working, enabled answer form until their page refreshes (§12.8 — on an
`ENDED` session the card still renders "ACCEPTING ANSWERS"), and the submission is
accepted. For a scored question that means the "final" leaderboard can still change after
the session ended.

**Fix.** The backend should reject `quiz.answer` when the session is not `LIVE`, exactly
as `doubt.create` does (`SESSION_NOT_LIVE`); the frontend already maps that code to
"The session needs to be live first." and would surface it through the existing rejection
path. An optional frontend belt-and-braces would disable the answer form whenever the
session state is `ENDED`, but that is a client-side guard around a server-side rule and
is not a substitute for the check.

---

## 13. Decision notes and trade-offs

### 13.1 Proxy vs direct HTTP

Chose the same-origin `/api` proxy over direct cross-origin HTTP because the backend
intentionally has no CORS layer and access tokens are bearer tokens. Proxying keeps
every HTTP call first-party. Trade-off: the frontend now depends on the Next server
proxying correctly, and the WS path must still be pointed directly at the backend. This
is the right trade-off for this backend's constraints.

### 13.2 One `LiveSocket` per session, owned by `use-live-session`

Chose a single controller owning one socket per session, with all other components
reading from the controller's projected state. This avoids socket-per-component churn
and keeps reconnection, backoff, and the `verifyAlive` probe in one place. Trade-off:
the controller is a little larger, but it's the right place for reconnect/recovery
logic and it keeps the reducer the single source of truth for WS state shape.

### 13.3 Reducer is pure and tested in isolation

`live-store.ts` is pure and has 18 tests. The reducer is the authority on WS state
shape, so adding a new server event is a reducer change plus a protocol constant — no
component wiring change. Trade-off: the reducer is a little more central than a
diffuse event handler spread across components, but that's exactly the property that
makes reconnect/recovery and the feed-dedup logic testable and reviewable.

### 13.4 Catalog re-load after mutations (the badge fix)

The quiz row badges come from the HTTP quiz read, which can be stale after a publish/
close/start. Rather than trying to derive badge state from WS frames alone (which would
be a second source of truth with its own staleness), the fix re-loads the affected quiz
catalog row after a successful mutation. This keeps HTTP as the badge authority and
keeps the live frames as the live-state authority. Trade-off: an extra HTTP call per
successful publish/close/start, but that's cheap and it removes the visible staleness.

### 13.5 Why the fetch-receiver bug wasn't caught by tests

The app client stores `fetch` and calls it through `this.fetchImpl(url, …)`, which
passes the `ApiClient` instance as `this`. Browsers brand-check `fetch` and throw
"Illegal invocation" for any non-global receiver. The test suite injects `vi.fn` mocks
(which don't brand-check), so the bug was invisible in tests. The bug was found by
driving the real browser. The fix (invoke through a local reference so `this` is
`undefined`) and a regression test (assert the client never passes a non-global
receiver to `fetch`) close the gap. This is a good example of why real-backend browser
verification matters even when the unit suite is green.

---

## Appendix A. How to run it locally

```sh
# backend on :3300 (from source), then:

cd LivePulse/web
LIVEPULSE_BACKEND_URL=http://127.0.0.1:3300 \
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:3300/ws \
pnpm dev --port 3000        # dev
# or
LIVEPULSE_BACKEND_URL=http://127.0.0.1:3300 \
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:3300/ws \
pnpm build && pnpm start --port 3000   # production
```

Gates:

```sh
cd LivePulse/web
pnpm exec tsc --noEmit && pnpm lint && pnpm test && pnpm build
```

Multi-user verification: use two browser partitions (for example two separate Chromium
profiles or one normal + one incognito) because the same partition's two tabs share
`localStorage` and will drop each other's session via cross-tab sync.

---

## Appendix B. Where the contracts live

- HTTP auth + API: `docs/api/{authentication,http-api}.md` and `src/modules/**/*.routes.ts`.
- WS protocol: `docs/api/websocket-protocol.md`, `src/ws/protocol.ts`.
- Frontend contracts in code: `web/src/lib/api/{types,errors,client,auth,sessions,
  quizzes}.ts`, `web/src/lib/ws/{protocol,client}.ts`, `web/src/lib/config.ts`.
- Recovery: `src/ws/recovery.ts`.

This doc describes the frontend side only; the backend-side contracts are the source of
truth for request/response shapes and WS frames.
