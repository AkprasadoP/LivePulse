import type { SessionRegistry } from "./session-registry.js";

/**
 * Phase 7 presence tracker (ADR-008).
 *
 * Presence is EPHEMERAL connection state — never PostgreSQL, never a Redis
 * key. Each instance owns its local truth; cross-instance visibility comes
 * from Redis `presence.update` notices carrying an instance's COMPLETE local
 * online set for a session (idempotent, order-tolerant, self-healing via a
 * periodic digest).
 *
 * Divergence is impossible by construction: `localParticipants` is DERIVED
 * from the live SessionRegistry on every read, so there is no parallel
 * connection structure that could drift from it. The tracker holds only
 * remote contributions (in memory) and the last snapshot sent per session.
 *
 * Definition (documented in docs/architecture/presence.md):
 *   A participant is ONLINE for a session iff at least one healthy bound
 *   connection exists on some live instance. "Healthy" = registered and not
 *   terminated by the heartbeat sweep. Local presence is exact; cross-instance
 *   presence is eventually consistent within the digest interval.
 */

export interface ParticipantView {
  participantId: string;
  displayName: string;
  role: "TEACHER" | "STUDENT";
}

interface RemoteContribution {
  /** Highest per-instance sequence applied (late/duplicate updates ignored). */
  seq: number;
  /** Last time this instance was heard from (staleness clock). */
  updatedAt: number;
  sessions: Map<string, Map<string, ParticipantView>>;
}

export interface PresenceTrackerOptions {
  registry: SessionRegistry;
  /** An instance not heard from for this long is dropped (3 × digest interval). */
  staleMs: number;
  /** Injectable clock for deterministic staleness tests. */
  now?: () => number;
}

function compareParticipants(a: ParticipantView, b: ParticipantView): number {
  return (
    a.displayName.localeCompare(b.displayName) || a.participantId.localeCompare(b.participantId)
  );
}

export class PresenceTracker {
  private readonly remote = new Map<string, RemoteContribution>();
  private readonly lastSnapshot = new Map<string, string>();
  private localSeq = 0;

  public constructor(private readonly options: PresenceTrackerOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Monotonic per-instance sequence stamped on each local presence notice. */
  public nextLocalSeq(): number {
    this.localSeq += 1;
    return this.localSeq;
  }

  /** Locally online participants of a session, derived from the live registry. */
  public localParticipants(sessionId: string): ParticipantView[] {
    const byParticipant = new Map<string, ParticipantView>();
    for (const connection of this.options.registry.getConnectionsForSession(sessionId)) {
      if (connection.participantId === null || connection.participantRole === null) continue;
      if (!byParticipant.has(connection.participantId)) {
        byParticipant.set(connection.participantId, {
          participantId: connection.participantId,
          displayName: connection.displayName ?? "",
          role: connection.participantRole,
        });
      }
    }
    return [...byParticipant.values()].sort(compareParticipants);
  }

  /** Sessions with at least one local bound participant (digest scope). */
  public localSessions(): string[] {
    const sessions = new Set<string>();
    for (const connection of this.options.registry.getAllConnections()) {
      if (connection.joinedSessionId !== null && connection.participantId !== null) {
        sessions.add(connection.joinedSessionId);
      }
    }
    return [...sessions];
  }

  /** Distinct locally online participants across all sessions (metric only). */
  public localParticipantCount(): number {
    const ids = new Set<string>();
    for (const connection of this.options.registry.getAllConnections()) {
      if (connection.participantId !== null) ids.add(connection.participantId);
    }
    return ids.size;
  }

  /** Number of local connections currently bound to a participant. */
  public localBoundConnectionCount(): number {
    let count = 0;
    for (const connection of this.options.registry.getAllConnections()) {
      if (connection.participantId !== null) count += 1;
    }
    return count;
  }

  /**
   * Apply a peer's local online set for one session. Returns false when the
   * update is stale (older than what this instance already applied). The
   * instance's whole freshness clock advances on every accepted update.
   */
  public recordRemote(
    instanceId: string,
    seq: number,
    sessionId: string,
    participants: ParticipantView[],
  ): boolean {
    const existing = this.remote.get(instanceId);
    if (existing && seq <= existing.seq) return false;
    const sessions = existing?.sessions ?? new Map<string, Map<string, ParticipantView>>();
    sessions.set(sessionId, new Map(participants.map((p) => [p.participantId, p])));
    this.remote.set(instanceId, { seq, updatedAt: this.now(), sessions });
    return true;
  }

  /**
   * The aggregated online set: local participants ∪ every fresh remote
   * contribution. This is what clients receive.
   */
  public aggregate(sessionId: string): ParticipantView[] {
    const byParticipant = new Map<string, ParticipantView>();
    for (const view of this.localParticipants(sessionId))
      byParticipant.set(view.participantId, view);
    for (const contribution of this.remote.values()) {
      const session = contribution.sessions.get(sessionId);
      if (!session) continue;
      for (const view of session.values()) byParticipant.set(view.participantId, view);
    }
    return [...byParticipant.values()].sort(compareParticipants);
  }

  /**
   * Drop contributions from instances silent longer than `staleMs` (crashed or
   * partitioned peers). Returns the sessions whose aggregate may have changed
   * so the caller can refresh/clients converge.
   */
  public expireStale(): string[] {
    const cutoff = this.now() - this.options.staleMs;
    const touched = new Set<string>();
    for (const [instanceId, contribution] of this.remote) {
      if (contribution.updatedAt > cutoff) continue;
      for (const sessionId of contribution.sessions.keys()) touched.add(sessionId);
      this.remote.delete(instanceId);
    }
    return [...touched];
  }

  /** Fresh (not-expired) remote instances — metric/ops visibility. */
  public remoteInstanceCount(): number {
    const cutoff = this.now() - this.options.staleMs;
    let count = 0;
    for (const contribution of this.remote.values()) {
      if (contribution.updatedAt > cutoff) count += 1;
    }
    return count;
  }

  /**
   * Current aggregate, returned only when it differs from the last snapshot
   * sent for this session (change detection — no redundant broadcasts).
   * Duplicate/out-of-order inputs cannot corrupt it: the snapshot is a whole
   * set, recomputed from source.
   */
  public snapshotIfChanged(sessionId: string): ParticipantView[] | null {
    const participants = this.aggregate(sessionId);
    const serialized = JSON.stringify(participants);
    if (this.lastSnapshot.get(sessionId) === serialized) return null;
    this.lastSnapshot.set(sessionId, serialized);
    return participants;
  }

  /** Forget broadcast state for a session (no local listeners left). */
  public forgetSession(sessionId: string): void {
    this.lastSnapshot.delete(sessionId);
  }
}
