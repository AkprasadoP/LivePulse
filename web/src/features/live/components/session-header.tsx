"use client";

import { useState, type ReactNode } from "react";
import type { ParticipantRole, SessionState } from "@/lib/api/types";
import type { ConnectionStatus } from "@/lib/ws/client";
import { Badge, RoleBadge, StatusDot, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/hooks/use-now";
import { formatElapsed } from "@/lib/utils/format";
import { ConnectionStatusPill, ConnectionBanner, isHealthy } from "./connection-status";

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

export function SessionStateBadge({ state }: { state: SessionState | null }) {
  if (!state) return null;
  return (
    <Badge tone={STATE_TONE[state]}>
      {state === "LIVE" ? <StatusDot tone="live" pulse /> : null}
      {STATE_LABEL[state]}
    </Badge>
  );
}

/**
 * The live header. It answers three questions at a glance: is the session
 * running, am I connected, and how long has it been going.
 */
export function SessionHeader({
  name,
  state,
  status,
  role,
  startedAt,
  onlineCount,
  totalParticipants,
  onRefreshState,
  actions,
}: {
  name: string;
  state: SessionState | null;
  status: ConnectionStatus;
  role: ParticipantRole | null;
  startedAt: string | null;
  onlineCount: number;
  totalParticipants: number;
  onRefreshState: () => void;
  actions?: ReactNode;
}) {
  const now = useNow(1000);
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-canvas/90 backdrop-blur">
      <div className="lp-container flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="truncate text-base font-semibold tracking-tight text-ink">{name}</h1>
            <SessionStateBadge state={state} />
            <RoleBadge role={role} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
            <span>
              {onlineCount} online · {totalParticipants}{" "}
              {totalParticipants === 1 ? "participant" : "participants"}
            </span>
            {state === "LIVE" && startedAt ? (
              <span className="lp-tnum">Running {formatElapsed(startedAt, now)}</span>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ConnectionStatusPill status={status} />
          <Button variant="ghost" size="sm" onClick={copyLink}>
            {copied ? "Link copied" : "Copy link"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefreshState}
            aria-label="Refresh session state"
          >
            Refresh
          </Button>
          {actions}
        </div>
      </div>

      {/* The connection state lives INSIDE the sticky bar so it can never
          scroll behind itself: a reconnect notice that disappears when you
          scroll down is worse than no notice. */}
      {isHealthy(status) ? null : (
        <div className="lp-container pb-3">
          <ConnectionBanner status={status} />
        </div>
      )}
    </header>
  );
}
