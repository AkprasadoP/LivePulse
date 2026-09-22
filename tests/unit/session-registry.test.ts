import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { SessionRegistry } from "../../src/ws/session-registry.js";
import type { Connection } from "../../src/ws/connection.js";

/** The registry never touches socket methods — a bare stub is enough here. */
function fakeSocket(): WebSocket {
  return {} as WebSocket;
}

describe("SessionRegistry", () => {
  it("tracks connections and removes them fully", () => {
    const registry = new SessionRegistry();
    const connection = registry.addConnection(fakeSocket());

    expect(registry.connectionCount).toBe(1);
    registry.removeConnection(connection);
    expect(registry.connectionCount).toBe(0);
    // Idempotent removal must not throw.
    registry.removeConnection(connection);
    expect(registry.connectionCount).toBe(0);
  });

  it("joinSession associates a connection with exactly one session", () => {
    const registry = new SessionRegistry();
    const connection = registry.addConnection(fakeSocket());
    const a = "018f3c2e-7b1a-7d0e-9c2f-000000000001";
    const b = "018f3c2e-7b1a-7d0e-9c2f-000000000002";

    expect(registry.joinSession(connection, a)).toBeNull();
    expect(registry.countForSession(a)).toBe(1);
    expect(registry.getConnectionsForSession(a)).toHaveLength(1);
  });

  it("joinSession switches sessions and returns the previous one", () => {
    const registry = new SessionRegistry();
    const connection = registry.addConnection(fakeSocket());
    const a = "018f3c2e-7b1a-7d0e-9c2f-000000000001";
    const b = "018f3c2e-7b1a-7d0e-9c2f-000000000002";

    registry.joinSession(connection, a);
    const previous = registry.joinSession(connection, b);

    expect(previous).toBe(a);
    expect(registry.countForSession(a)).toBe(0);
    expect(registry.countForSession(b)).toBe(1);
  });

  it("leaveSession detaches and prunes empty session buckets", () => {
    const registry = new SessionRegistry();
    const connection = registry.addConnection(fakeSocket());
    const a = "018f3c2e-7b1a-7d0e-9c2f-000000000001";

    registry.joinSession(connection, a);
    expect(registry.leaveSession(connection)).toBe(a);
    expect(registry.countForSession(a)).toBe(0);
    expect(registry.getConnectionsForSession(a)).toEqual([]);
    // Leaving while detached is a no-op returning null (idempotent).
    expect(registry.leaveSession(connection)).toBeNull();
  });

  it("tracks multiple connections per session independently", () => {
    const registry = new SessionRegistry();
    const a = "018f3c2e-7b1a-7d0e-9c2f-000000000001";
    const first = registry.addConnection(fakeSocket());
    const second = registry.addConnection(fakeSocket());
    const third = registry.addConnection(fakeSocket());

    registry.joinSession(first, a);
    registry.joinSession(second, a);
    registry.joinSession(third, a);

    expect(registry.countForSession(a)).toBe(3);
    expect(registry.connectionCount).toBe(3);

    registry.removeConnection(second);
    expect(registry.countForSession(a)).toBe(2);
    expect(registry.connectionCount).toBe(2);
  });

  it("removeConnection detaches from its session too", () => {
    const registry = new SessionRegistry();
    const a = "018f3c2e-7b1a-7d0e-9c2f-000000000001";
    const connection: Connection = registry.addConnection(fakeSocket());
    registry.joinSession(connection, a);

    registry.removeConnection(connection);
    expect(registry.countForSession(a)).toBe(0);
    expect(registry.connectionCount).toBe(0);
  });

  it("getAllConnections snapshots live connections for the heartbeat sweeper", () => {
    const registry = new SessionRegistry();
    const first = registry.addConnection(fakeSocket());
    const second = registry.addConnection(fakeSocket());

    const snapshot = registry.getAllConnections();
    expect(snapshot).toHaveLength(2);
    expect(snapshot).toContain(first);
    expect(snapshot).toContain(second);

    registry.removeConnection(first);
    // Snapshot was a copy: the later mutation does not affect it.
    expect(snapshot).toHaveLength(2);
  });
});
