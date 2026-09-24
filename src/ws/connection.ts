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
   * Participant bound at session.join time via the development identity seam
   * (Phase 3). Session-scoped: cleared when the connection leaves the
   * session. NOT authentication — see docs/decisions/002 and the Phase 3
   * identity-seam section of the protocol doc.
   */
  participantId: string | null;
  participantRole: "TEACHER" | "STUDENT" | null;
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
    displayName: null,
    isAlive: true,
    connectedAt: new Date(),
  };
}
