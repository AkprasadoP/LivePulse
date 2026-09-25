import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { SessionRegistry } from "../../src/ws/session-registry.js";
import { PresenceTracker } from "../../src/ws/presence.js";

/**
 * Phase 7 presence — unit tests for the ephemeral tracker.
 *
 * These cover the semantics that must hold regardless of transport: presence
 * is DERIVED from the live registry (so it cannot drift), multi-connection
 * participants stay online while any connection remains, remote
 * contributions are whole-set and idempotent, and a silent peer expires
 * exactly at 3 × the digest interval.
 */

const SESSION = "018f0000-0000-7000-8000-000000000001";
const PEER_SESSION = "018f0000-0000-7000-8000-000000000002";
const DIGEST_MS = 1_000;

/** A socket stub is enough: the tracker only reads registry bookkeeping. */
function bind(
  registry: SessionRegistry,
  sessionId: string,
  participantId: string | null,
  displayName: string,
  role: "TEACHER" | "STUDENT" = "STUDENT",
) {
  const connection = registry.addConnection({} as unknown as WebSocket);
  registry.joinSession(connection, sessionId);
  connection.participantId = participantId;
  connection.displayName = participantId === null ? null : displayName;
  connection.participantRole = participantId === null ? null : role;
  return connection;
}

function build(options: { now?: () => number } = {}) {
  const registry = new SessionRegistry();
  const tracker = new PresenceTracker({
    registry,
    staleMs: DIGEST_MS * 3,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { registry, tracker };
}

describe("PresenceTracker (unit)", () => {
  it("counts a participant once no matter how many connections they hold", () => {
    const { registry, tracker } = build();
    bind(registry, SESSION, "p1", "Alice");
    bind(registry, SESSION, "p1", "Alice");
    bind(registry, SESSION, "p2", "Bob", "TEACHER");

    const participants = tracker.localParticipants(SESSION);
    expect(participants.map((p) => p.participantId)).toEqual(["p1", "p2"]);
    expect(participants.map((p) => p.role)).toEqual(["STUDENT", "TEACHER"]);
    // Two sockets, two participants, one local connection each is NOT assumed.
    expect(tracker.localBoundConnectionCount()).toBe(3);
    expect(tracker.localParticipantCount()).toBe(2);
  });

  it("keeps a participant online while ANY bound connection remains", () => {
    const { registry, tracker } = build();
    const phone = bind(registry, SESSION, "p1", "Alice");
    const laptop = bind(registry, SESSION, "p1", "Alice");

    registry.removeConnection(phone);
    expect(tracker.localParticipants(SESSION).map((p) => p.participantId)).toEqual(["p1"]);

    registry.removeConnection(laptop);
    expect(tracker.localParticipants(SESSION)).toEqual([]);
  });

  it("does not treat view-only connections as presence", () => {
    const { registry, tracker } = build();
    bind(registry, SESSION, null, "not-bound");
    expect(tracker.localParticipants(SESSION)).toEqual([]);
  });

  it("scopes local presence per session and lists only bound sessions", () => {
    const { registry, tracker } = build();
    bind(registry, SESSION, "p1", "Alice");
    bind(registry, PEER_SESSION, "p2", "Bob");
    bind(registry, PEER_SESSION, null, "viewer");

    expect(tracker.localSessions().sort()).toEqual([SESSION, PEER_SESSION].sort());
    expect(tracker.localParticipants(SESSION).map((p) => p.participantId)).toEqual(["p1"]);
    expect(tracker.localParticipants(PEER_SESSION).map((p) => p.participantId)).toEqual(["p2"]);
  });

  it("aggregates whole-set remote contributions and ignores stale or duplicate seq", () => {
    const { registry, tracker } = build();
    bind(registry, SESSION, "local", "Local");

    expect(
      tracker.recordRemote("ws-far", 1, SESSION, [
        { participantId: "remote", displayName: "Remote", role: "STUDENT" },
      ]),
    ).toBe(true);
    expect(tracker.aggregate(SESSION).map((p) => p.participantId)).toEqual(["local", "remote"]);

    // A duplicate or older sequence is a stale notice: ignored wholesale.
    expect(
      tracker.recordRemote("ws-far", 1, SESSION, [
        { participantId: "ghost", displayName: "Ghost", role: "STUDENT" },
      ]),
    ).toBe(false);
    expect(
      tracker.recordRemote("ws-far", 0, SESSION, [
        { participantId: "ghost", displayName: "Ghost", role: "STUDENT" },
      ]),
    ).toBe(false);
    expect(tracker.aggregate(SESSION).map((p) => p.participantId)).toEqual(["local", "remote"]);

    // A newer sequence REPLACES the instance's whole contribution (idempotent
    // full-set semantics), so a missed notice is repaired, not accumulated.
    expect(
      tracker.recordRemote("ws-far", 2, SESSION, [
        { participantId: "other", displayName: "Other", role: "TEACHER" },
      ]),
    ).toBe(true);
    expect(tracker.aggregate(SESSION).map((p) => p.participantId)).toEqual(["local", "other"]);

    // ...and an empty set withdraws the instance's presence entirely.
    expect(tracker.recordRemote("ws-far", 3, SESSION, [])).toBe(true);
    expect(tracker.aggregate(SESSION).map((p) => p.participantId)).toEqual(["local"]);
  });

  it("expires a peer silent for 3 × the digest interval and reports affected sessions", () => {
    let clock = 1_000_000;
    const { registry, tracker } = build({ now: () => clock });
    bind(registry, SESSION, "local", "Local");
    tracker.recordRemote("ws-far", 1, SESSION, [
      { participantId: "remote", displayName: "Remote", role: "STUDENT" },
    ]);
    tracker.recordRemote("ws-other", 1, PEER_SESSION, [
      { participantId: "remote2", displayName: "Remote2", role: "STUDENT" },
    ]);
    expect(tracker.remoteInstanceCount()).toBe(2);

    // Just under the window: still fresh.
    clock += DIGEST_MS * 3 - 1;
    expect(tracker.expireStale()).toEqual([]);
    expect(tracker.remoteInstanceCount()).toBe(2);

    // Crossing the window drops both silent peers and names their sessions.
    clock += 1;
    expect(tracker.expireStale().sort()).toEqual([SESSION, PEER_SESSION].sort());
    expect(tracker.remoteInstanceCount()).toBe(0);
    expect(tracker.aggregate(SESSION).map((p) => p.participantId)).toEqual(["local"]);

    // Expiring again is a no-op (idempotent).
    expect(tracker.expireStale()).toEqual([]);
  });

  it("keeps a peer alive as long as ANY session update arrives from it", () => {
    let clock = 2_000_000;
    const { tracker } = build({ now: () => clock });
    tracker.recordRemote("ws-far", 1, SESSION, [
      { participantId: "remote", displayName: "Remote", role: "STUDENT" },
    ]);

    clock += DIGEST_MS * 2;
    // Digest for a DIFFERENT session still refreshes the instance heartbeat.
    tracker.recordRemote("ws-far", 2, PEER_SESSION, [
      { participantId: "remote", displayName: "Remote", role: "STUDENT" },
    ]);

    clock += DIGEST_MS * 2;
    expect(tracker.expireStale()).toEqual([]);
    expect(tracker.remoteInstanceCount()).toBe(1);
    // The older session's contribution is still there (whole-set per session).
    expect(tracker.aggregate(SESSION).map((p) => p.participantId)).toEqual(["remote"]);
    expect(tracker.aggregate(PEER_SESSION).map((p) => p.participantId)).toEqual(["remote"]);
  });

  it("emits a snapshot only when the aggregate changed, and forgets on demand", () => {
    const { registry, tracker } = build();
    const first = bind(registry, SESSION, "p1", "Alice");

    const initial = tracker.snapshotIfChanged(SESSION);
    expect(initial?.map((p) => p.participantId)).toEqual(["p1"]);
    // Unchanged aggregate -> no redundant frame.
    expect(tracker.snapshotIfChanged(SESSION)).toBeNull();

    // Change -> a new snapshot.
    const second = bind(registry, SESSION, "p2", "Bob");
    expect(tracker.snapshotIfChanged(SESSION)?.map((p) => p.participantId)).toEqual(["p1", "p2"]);

    // Closed connection -> changed again, then stable.
    registry.removeConnection(second);
    expect(tracker.snapshotIfChanged(SESSION)?.map((p) => p.participantId)).toEqual(["p1"]);
    expect(tracker.snapshotIfChanged(SESSION)).toBeNull();

    // forgetSession re-arms the comparison (used when local listeners vanish).
    tracker.forgetSession(SESSION);
    expect(tracker.snapshotIfChanged(SESSION)?.map((p) => p.participantId)).toEqual(["p1"]);

    registry.removeConnection(first);
    expect(tracker.snapshotIfChanged(SESSION)).toEqual([]);
  });

  it("stamps monotonically increasing local sequence numbers", () => {
    const { tracker } = build();
    expect([tracker.nextLocalSeq(), tracker.nextLocalSeq(), tracker.nextLocalSeq()]).toEqual([
      1, 2, 3,
    ]);
  });
});
