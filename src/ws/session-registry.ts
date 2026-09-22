import type { WebSocket } from "ws";
import type { Connection } from "./connection.js";
import { createConnection } from "./connection.js";

/**
 * In-memory, per-process association of connections with sessions.
 *
 *   sessionId -> Set<Connection>
 *
 * Deliberately EPHEMERAL:
 *  - lives and dies with the process; lost on restart (documented in ADR-003)
 *  - keyed by connection, not user — there is no identity yet, and a logical
 *    client may hold several connections on purpose (no dedup in Phase 2)
 *  - never stores business state; PostgreSQL stays authoritative for sessions
 *
 * The registry is also the single place that keeps the Connection record
 * consistent with the socket it wraps, so handlers never mutate two
 * structures independently.
 */
export class SessionRegistry {
  private readonly bySession = new Map<string, Set<Connection>>();
  private readonly all = new Set<Connection>();

  /** Register a freshly accepted socket and start tracking its lifecycle. */
  public addConnection(socket: WebSocket): Connection {
    const connection = createConnection(socket);
    this.all.add(connection);
    return connection;
  }

  /** Number of distinct live connections (all sessions). */
  public get connectionCount(): number {
    return this.all.size;
  }

  /** Number of connections currently joined to a given session. */
  public countForSession(sessionId: string): number {
    return this.bySession.get(sessionId)?.size ?? 0;
  }

  /**
   * Associate a connection with a session. Any previous association is
   * removed first (a connection joins at most one session). Returns the
   * previous session id if there was one.
   */
  public joinSession(connection: Connection, sessionId: string): string | null {
    const previous = this.leaveSession(connection);
    let members = this.bySession.get(sessionId);
    if (!members) {
      members = new Set();
      this.bySession.set(sessionId, members);
    }
    members.add(connection);
    connection.joinedSessionId = sessionId;
    return previous;
  }

  /** Detach a connection from its session, if any. Returns the old session id. */
  public leaveSession(connection: Connection): string | null {
    const previous = connection.joinedSessionId;
    if (previous) {
      const members = this.bySession.get(previous);
      members?.delete(connection);
      // Drop the bucket eagerly: no session should accumulate empty sets,
      // and countForSession relies on this.
      if (members && members.size === 0) {
        this.bySession.delete(previous);
      }
      connection.joinedSessionId = null;
    }
    return previous;
  }

  /** Fully remove a connection (socket closing or died). Idempotent. */
  public removeConnection(connection: Connection): void {
    this.leaveSession(connection);
    this.all.delete(connection);
  }

  /** All connections joined to a session (snapshot; empty if none). */
  public getConnectionsForSession(sessionId: string): Connection[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  /** Every live connection (snapshot). Used by the heartbeat sweeper. */
  public getAllConnections(): Connection[] {
    return [...this.all];
  }
}
