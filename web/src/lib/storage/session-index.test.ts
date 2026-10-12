import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionIndex } from "./session-index";

const KEY = "livepulse.sessions";

/**
 * Simulate another tab (or tampered storage) writing the index, going through
 * the store's real cross-tab invalidation path.
 */
function reloadFromDisk(): void {
  sessionIndex.list(); // ensure the storage listener is bound
  window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
}

function reset(): void {
  window.localStorage.clear();
  reloadFromDisk();
}

describe("sessionIndex", () => {
  beforeEach(() => {
    reset();
  });

  it("upserts a session and keeps it first after re-touching", () => {
    sessionIndex.upsert({ id: "s1", name: "Physics", role: "TEACHER" });
    sessionIndex.upsert({ id: "s2", name: "Chemistry", role: "STUDENT" });
    expect(sessionIndex.list().map((entry) => entry.id)).toEqual(["s2", "s1"]);

    sessionIndex.upsert({ id: "s1", name: "Physics (renamed)", role: "TEACHER" });

    const entries = sessionIndex.list();
    expect(entries.map((entry) => entry.id)).toEqual(["s1", "s2"]);
    expect(entries[0]!.name).toBe("Physics (renamed)");
    expect(entries).toHaveLength(2);
  });

  it("persists to localStorage so a reload still lists the session", () => {
    sessionIndex.upsert({ id: "s1", name: "Physics", role: "TEACHER" });

    const raw = window.localStorage.getItem(KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toMatchObject([
      { id: "s1", name: "Physics", role: "TEACHER" },
    ]);
  });

  it("removes a session by id", () => {
    sessionIndex.upsert({ id: "s1", name: "Physics", role: "TEACHER" });
    sessionIndex.upsert({ id: "s2", name: "Chemistry", role: "STUDENT" });

    sessionIndex.remove("s1");

    expect(sessionIndex.list().map((entry) => entry.id)).toEqual(["s2"]);
  });

  it("ignores corrupt or foreign entries instead of throwing", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: "ok", name: "Good", role: "STUDENT", lastSeenAt: "2026-01-01T00:00:00.000Z" },
        { id: 123, name: "Bad" },
        null,
        "nope",
        { role: "STUDENT" },
      ]),
    );
    reloadFromDisk();

    expect(sessionIndex.list().map((entry) => entry.id)).toEqual(["ok"]);
  });

  it("survives unparseable JSON in storage", () => {
    window.localStorage.setItem(KEY, "{not json");
    reloadFromDisk();

    expect(sessionIndex.list()).toEqual([]);
  });

  it("notifies subscribers when the index changes", () => {
    const listener = vi.fn();
    const unsubscribe = sessionIndex.subscribe(listener);

    sessionIndex.upsert({ id: "s1", name: "Physics", role: "TEACHER" });
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    unsubscribe();
    sessionIndex.upsert({ id: "s2", name: "Chemistry", role: "STUDENT" });
    expect(listener).not.toHaveBeenCalled();
  });
});
