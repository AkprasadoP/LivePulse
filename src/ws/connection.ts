import type { WebSocket } from "ws";

/**
 * Per-connection ephemeral state. One instance per accepted WebSocket.
 *
 * This is CONNECTION state, not application state: nothing here survives a
 * process restart, and nothing here is business data. Durable state lives in
 * PostgreSQL only (see docs/architecture/websocket-architecture.md).
 */
export interface Connection {
  /** The live socket. Kept on the record so cleanup needs no lookup. */
  socket: WebSocket;
  /**
   * Session the connection is currently joined to, or null.
   * Invariant (enforced by SessionRegistry + handlers): at most one.
   */
  joinedSessionId: string | null;
  /**
   * Participant bound at session.join time (Phase 10.7): resolved
   * server-side from the authenticated userId via (sessionId, userId).
   * Session-scoped: cleared when the connection leaves the session. Null for
   * view-only joins (a connection that joined without authenticating).
   */
  participantId: string | null;
  participantRole: "TEACHER" | "STUDENT" | null;
  /**
   * Phase 10.5: authenticated user bound by `auth.authenticate` (access
   * token verified server-side). Connection-scoped, NOT session-scoped:
   * survives session.leave; cleared only when the socket closes. Null until
   * the client authenticates — an unauthenticated join is view-only and
   * binds no participant. Never set from client-supplied IDs.
   */
  userId: string | null;
  /** Presentation label of the bound participant (from the DB user row). */
  displayName: string | null;
  /**
   * Heartbeat liveness flag. Server sets true on every interval tick and
   * pings; the socket's 'pong' handler sets it back to true. A connection
   * still false at the next tick missed a full interval of pong and is dead.
   */
  isAlive: boolean;
  /** Accept time, for diagnostics only. */
  connectedAt: Date;
}

export function createConnection(socket: WebSocket): Connection {
  return {
    socket,
    joinedSessionId: null,
    participantId: null,
    participantRole: null,
    userId: null,
    displayName: null,
    isAlive: true,
    connectedAt: new Date(),
  };
}
