# LivePulse Frontend

Next.js 16 (App Router) frontend for LivePulse — real-time classroom infrastructure.

## Quick Start

The frontend **must run on a different port than the backend** because both default to port 3000.

### Prerequisites

- Backend running on `http://127.0.0.1:3000` (see root [README.md](../README.md))
- Node.js ≥ 22 (see `.nvmrc` / `package.json#engines`)
- pnpm 12 (see `package.json#packageManager`)

### Development

```bash
# Terminal 1: Start backend (port 3000)
cd .. && pnpm dev

# Terminal 2: Start frontend (port 3001)
cd web && PORT=3001 pnpm dev
```

- **Frontend:** <http://localhost:3001>
- **Backend API (proxied):** <http://localhost:3001/api/*>
- **WebSocket (direct):** `ws://127.0.0.1:3000/ws`

### Environment Variables

| Variable                   | Default                  | Description                                                                        |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `PORT`                     | `3000`                   | Frontend dev server port. **Must differ from backend port.**                       |
| `NEXT_PUBLIC_API_BASE_URL` | `/api`                   | Same-origin proxy path. Do not change unless you modify `next.config.ts` rewrites. |
| `NEXT_PUBLIC_WS_URL`       | `ws://127.0.0.1:3000/ws` | Backend WebSocket endpoint. Change if backend runs elsewhere.                      |

Create `web/.env.local` to override:

```bash
PORT=3001
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:3000/ws
```

### Available Scripts

| Command           | Description                     |
| ----------------- | ------------------------------- |
| `pnpm dev`        | Start dev server with Turbopack |
| `pnpm build`      | Production build                |
| `pnpm start`      | Start production server         |
| `pnpm lint`       | Run ESLint                      |
| `pnpm typecheck`  | Run TypeScript compiler check   |
| `pnpm test`       | Run Vitest unit tests           |
| `pnpm test:watch` | Watch mode for tests            |

### Architecture

```
web/src/
├── app/                    # Next.js App Router pages
│   ├── layout.tsx         # Root layout + providers
│   ├── page.tsx           # Landing page
│   ├── login/page.tsx     # Login page
│   ├── register/page.tsx  # Registration page
│   ├── dashboard/page.tsx # Authenticated dashboard
│   └── sessions/[sessionId]/page.tsx # Live session view
├── components/
│   ├── ui/                # Reusable UI primitives (Button, Modal, Card, …)
│   └── layout/            # Shell components (AuthShell, SiteHeader, Logo)
├── features/              # Feature-scoped code (colocated hooks, components, types)
│   ├── auth/              # Login/register forms, auth provider, guards
│   ├── sessions/          # Session list, create/join cards
│   └── live/              # Live session components + state (quizzes, doubt queue, presence)
├── lib/                   # Shared utilities
│   ├── api/               # Typed HTTP client + endpoint modules
│   │   ├── client.ts      # ApiClient (auth, refresh, error mapping)
│   │   ├── auth.ts        # /auth/* endpoints
│   │   ├── sessions.ts    # /sessions/* endpoints
│   │   ├── quizzes.ts     # /quizzes/* endpoints
│   │   ├── types.ts       # Shared DTOs (source of truth = backend serializers)
│   │   └── errors.ts      # ApiError + user-facing messages
│   ├── auth/              # JWT decode / expiry check (client-side only)
│   ├── config.ts          # Runtime config (API_BASE_URL, WS_URL, constants)
│   ├── hooks/             # Reusable React hooks (useNow)
│   ├── storage/           # TokenStore, SessionIndex (localStorage wrappers)
│   └── ws/                # LiveSocket (WebSocket client with reconnection + recovery)
└── providers.tsx          # React context providers (AuthProvider, ToastProvider)
```

### HTTP → Backend Proxy

All HTTP requests go through a **same-origin proxy** configured in `next.config.ts`:

```
Browser → /api/* (Next.js) → http://127.0.0.1:3000/* (Fastify backend)
```

- The backend **does not enable CORS** — proxying keeps every call first-party.
- Access tokens are Bearer headers (never cookies), injected by `ApiClient`.
- `ApiClient` handles one-shot 401 refresh automatically.

### WebSocket → Backend (Direct)

WebSocket connects **directly** to the backend:

```
Browser → ws://127.0.0.1:3000/ws (Fastify backend)
```

- WS handshakes are not subject to CORS.
- The access token travels inside an `auth.authenticate` frame after connection, never in the URL.
- `LiveSocket` manages reconnection, backoff, authentication, session join, and Phase 5 recovery.

### Authentication Flow

1. User submits credentials → `authApi.login()` → `POST /api/auth/login` → backend returns `{ accessToken, refreshToken, user }`
2. `AuthProvider` stores tokens in `tokenStore` (localStorage for refresh, memory for access)
3. `ApiClient` attaches `Authorization: Bearer <accessToken>` to every request
4. On 401, `ApiClient` calls `refreshAccessToken()` once, retries the original request
5. Refresh rotation is single-use on the backend; `AuthProvider` deduplicates concurrent refreshes

### Testing

```bash
pnpm test          # Run all unit tests (jsdom + Testing Library)
pnpm test:watch    # Watch mode
```

Tests use the `@/*` path alias (same as the app). CSS is not processed — tests assert on behaviour, not styling.

### Production Build

```bash
pnpm build
pnpm start
```

The production server reads `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_WS_URL` from the environment. In the Docker Compose production stack, Nginx terminates TLS and proxies both HTTP and WebSocket to the backend instances.

### Troubleshooting

| Symptom                                       | Cause                                                 | Fix                                                            |
| --------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `ECONNREFUSED 127.0.0.1:3000` on `/api/*`     | Backend not running                                   | Start backend: `cd .. && pnpm dev`                             |
| 404 on `/api/health`, `/api/auth/login`, etc. | Frontend running on port 3000 (collides with backend) | Run frontend on different port: `PORT=3001 pnpm dev`           |
| WebSocket fails to connect                    | `NEXT_PUBLIC_WS_URL` points to wrong host/port        | Set `NEXT_PUBLIC_WS_URL=ws://<backend-host>:<backend-port>/ws` |
| "Illegal invocation" fetch error              | `ApiClient` passed as `this` to `fetch`               | Fixed in `client.ts:100` — uses local `fetchFn` reference      |
