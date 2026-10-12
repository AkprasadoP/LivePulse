"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { sessionsApi } from "@/lib/api/sessions";
import type { SessionState } from "@/lib/api/types";
import { sessionIndex, type IndexedSession } from "@/lib/storage/session-index";
import { Badge, RoleBadge, type Tone } from "@/components/ui/badge";
import { Skeleton, EmptyState } from "@/components/ui/feedback";
import { formatRelative, pluralize } from "@/lib/utils/format";

/** The server's answer for one bookmarked session. */
interface ServerFact {
  name: string;
  state: SessionState;
  participantCount: number;
}

interface Row {
  entry: IndexedSession;
  status: "loading" | "ok" | "missing" | "error";
  name: string;
  state: SessionState | null;
  participantCount: number;
}

const STATE_TONE: Record<SessionState, Tone> = {
  CREATED: "neutral",
  LIVE: "live",
  ENDED: "neutral",
};

const STATE_LABEL: Record<SessionState, string> = {
  CREATED: "Not started",
  LIVE: "Live",
  ENDED: "Ended",
};

/** Stable empty snapshot for SSR/hydration (a new array each call would loop). */
const EMPTY: IndexedSession[] = [];

/**
 * Lists the sessions this browser has seen, reconciled against the server.
 *
 * The index is a bookmark list; every visible fact (name, state, participant
 * count) is read back from `GET /sessions/:id`. Rows are DERIVED during render
 * from the fetched facts, so nothing is set synchronously from an effect. A
 * bookmark the server no longer recognises is shown as unavailable rather than
 * silently dropped.
 */
export function YourSessions() {
  const entries = useSyncExternalStore(
    (listener) => sessionIndex.subscribe(listener),
    () => sessionIndex.list(),
    () => EMPTY,
  );

  const [facts, setFacts] = useState<Record<string, ServerFact | "missing" | "error">>({});

  useEffect(() => {
    let cancelled = false;
    for (const entry of entries) {
      void sessionsApi.get(entry.id).then(
        (detail) => {
          if (cancelled) return;
          const fact: ServerFact = {
            name: detail.session.name,
            state: detail.session.state,
            participantCount: detail.participants.length,
          };
          setFacts((current) => ({ ...current, [entry.id]: fact }));
        },
        (error: unknown) => {
          if (cancelled) return;
          const missing =
            typeof error === "object" && error !== null && "status" in error && error.status === 404;
          setFacts((current) => ({
            ...current,
            [entry.id]: missing ? "missing" : "error",
          }));
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [entries]);

  const rows: Row[] = entries.map((entry) => {
    const fact = facts[entry.id];
    if (fact === undefined) {
      return {
        entry,
        status: "loading",
        name: entry.name,
        state: null,
        participantCount: 0,
      };
    }
    if (fact === "missing" || fact === "error") {
      return { entry, status: fact, name: entry.name, state: null, participantCount: 0 };
    }
    return {
      entry,
      status: "ok",
      name: fact.name,
      state: fact.state,
      participantCount: fact.participantCount,
    };
  });

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No sessions yet"
        description="Open a session as a teacher, or join one with a link — it will show up here."
      />
    );
  }

  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.entry.id} className="flex items-center justify-between gap-4 py-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {row.status === "loading" ? (
                <Skeleton className="h-4 w-40" />
              ) : (
                <Link
                  href={`/sessions/${row.entry.id}`}
                  className="truncate text-sm font-medium text-ink hover:text-accent"
                >
                  {row.name}
                </Link>
              )}
              {row.status === "ok" && row.state ? (
                <Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>
              ) : null}
              {row.status === "missing" ? <Badge tone="warn">Unavailable</Badge> : null}
              {row.status === "error" ? <Badge tone="warn">Couldn&apos;t check</Badge> : null}
            </div>
            <p className="mt-1 text-xs text-ink-subtle">
              {row.status === "ok" ? (
                <>
                  {row.participantCount} {pluralize(row.participantCount, "participant")}
                  {" · "}
                  {formatRelative(row.entry.lastSeenAt)}
                </>
              ) : row.status === "missing" ? (
                "This session is no longer available."
              ) : row.status === "error" ? (
                "We couldn't confirm this session's state."
              ) : (
                "Checking…"
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <RoleBadge role={row.entry.role} />
            {row.status === "missing" ? (
              <button
                type="button"
                onClick={() => sessionIndex.remove(row.entry.id)}
                className="rounded-xs px-2 py-1 text-xs text-ink-subtle hover:bg-surface-muted hover:text-ink"
              >
                Remove
              </button>
            ) : (
              <Link
                href={`/sessions/${row.entry.id}`}
                className="rounded-xs px-2 py-1 text-xs font-medium text-accent hover:underline"
              >
                Open
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
