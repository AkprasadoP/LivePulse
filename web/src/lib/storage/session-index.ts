/**
 * Session index — a client-side index of sessions this user has created or
 * joined.
 *
 * IMPORTANT: this stores only *identifiers we already learned from a real
 * server response* (a `POST /sessions` 201, or a `session.joined` frame). It
 * is a bookmark list, never a source of truth: the dashboard reconciles every
 * entry against `GET /sessions/:id` and renders whatever the server says.
 *
 * Why it exists at all: the Phase 10/11 backend exposes no "list my sessions"
 * endpoint, so the frontend cannot ask the server for a user's sessions. It
 * can only remember the ids it has seen. This is reported as a backend
 * limitation in docs/frontend/README.md rather than papered over with a fake
 * endpoint.
 */
export interface IndexedSession {
  id: string;
  name: string;
  /** The role the user held when they last interacted with the session. */
  role: "TEACHER" | "STUDENT";
  /** Last time this entry was touched (ISO), for ordering only. */
  lastSeenAt: string;
}

const STORAGE_KEY = "livepulse.sessions";
const MAX_ENTRIES = 60;

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isIndexedSession(value: unknown): value is IndexedSession {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    (record.role === "TEACHER" || record.role === "STUDENT") &&
    typeof record.lastSeenAt === "string"
  );
}

class SessionIndexStore {
  private cache: IndexedSession[] | null = null;
  private readonly listeners = new Set<() => void>();
  private storageBound = false;

  public list(): IndexedSession[] {
    if (this.cache) return this.cache;
    if (!canUseStorage()) return [];
    let parsed: unknown = null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const entries = Array.isArray(parsed) ? parsed.filter(isIndexedSession) : [];
    entries.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    this.cache = entries;
    this.bindStorage();
    return entries;
  }

  public upsert(entry: Omit<IndexedSession, "lastSeenAt"> & { lastSeenAt?: string }): void {
    const next: IndexedSession = {
      id: entry.id,
      name: entry.name,
      role: entry.role,
      lastSeenAt: entry.lastSeenAt ?? new Date().toISOString(),
    };
    const rest = this.list().filter((existing) => existing.id !== next.id);
    this.commit([next, ...rest].slice(0, MAX_ENTRIES));
  }

  public remove(id: string): void {
    this.commit(this.list().filter((entry) => entry.id !== id));
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.bindStorage();
    return () => this.listeners.delete(listener);
  }

  private commit(entries: IndexedSession[]): void {
    this.cache = entries;
    if (canUseStorage()) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      } catch {
        /* quota/private-mode: the in-memory index still works for this tab */
      }
    }
    for (const listener of this.listeners) listener();
  }

  private bindStorage(): void {
    if (this.storageBound || !canUseStorage()) return;
    this.storageBound = true;
    window.addEventListener("storage", (event) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      this.cache = null;
      for (const listener of this.listeners) listener();
    });
  }
}

export const sessionIndex = new SessionIndexStore();
