/**
 * Frontend runtime configuration.
 *
 * HTTP goes through the same-origin `/api` proxy (see next.config.ts) so the
 * browser never makes a cross-origin request — the backend intentionally has
 * no CORS layer.
 *
 * WebSocket connects directly to the backend: WS handshakes are not subject to
 * CORS, and the access token travels inside an `auth.authenticate` frame, never
 * in the connection URL. Point this at the Nginx entrypoint in production.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://127.0.0.1:3000/ws";

/** Access-token lifetime advertised by the backend (seconds); refresh at 80%. */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 900;

/** Server WS heartbeat cadence (ms); a socket silent for this long is stale. */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * A connection that has produced no frame for this many heartbeats is treated
 * as dead and force-reconnected. The backend pings every heartbeat, so a
 * healthy socket always emits at least pings (transparent to the browser).
 */
export const WS_STALE_AFTER_MS = WS_HEARTBEAT_INTERVAL_MS * 2.5;
