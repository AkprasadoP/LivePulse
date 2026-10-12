"use client";

import type { ParticipantSummary } from "@/lib/api/types";
import type { PresenceParticipant } from "@/lib/ws/protocol";
import { Avatar } from "@/components/ui/avatar";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";

/**
 * Who is here right now.
 *
 * The ONLINE list is the authoritative Phase 7 presence snapshot (derived
 * server-side from live connections). The roster from the HTTP session read is
 * used only to show the people who have joined at some point but are not
 * currently connected — it is never merged into the online set.
 */
export function PresencePanel({
  presence,
  roster,
  selfParticipantId,
}: {
  presence: PresenceParticipant[];
  roster: ParticipantSummary[];
  selfParticipantId: string | null;
}) {
  const onlineIds = new Set(presence.map((p) => p.participantId));
  const offline = roster.filter((participant) => !onlineIds.has(participant.id));
  const teacher = presence.find((p) => p.role === "TEACHER");

  return (
    <Card>
      <CardHeader
        title="In the room"
        description={`${presence.length} online`}
        action={
          onlineIds.size > 0 && teacher ? (
            <Badge tone="accent">Teacher online</Badge>
          ) : undefined
        }
      />
      <CardBody className="space-y-4">
        {presence.length === 0 ? (
          <EmptyState
            title="Nobody is connected yet"
            description="Share the session link — participants appear here as they join."
          />
        ) : (
          <ul className="space-y-2.5">
            {presence.map((participant) => (
              <li key={participant.participantId} className="flex items-center gap-3">
                <Avatar
                  name={participant.displayName}
                  seed={participant.participantId}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">
                    {participant.displayName}
                    {participant.participantId === selfParticipantId ? (
                      <span className="ml-1.5 text-xs text-ink-subtle">(you)</span>
                    ) : null}
                  </p>
                </div>
                {participant.role === "TEACHER" ? (
                  <Badge tone="accent">teacher</Badge>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-live">
                    <StatusDot tone="live" />
                    online
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {offline.length > 0 ? (
          <div className="border-t border-border pt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
              Not connected
            </p>
            <ul className="mt-2 space-y-2">
              {offline.map((participant) => (
                <li key={participant.id} className="flex items-center gap-3">
                  <Avatar
                    name={participant.displayName}
                    seed={participant.id}
                    size="xs"
                    dimmed
                  />
                  <span className="truncate text-sm text-ink-subtle">
                    {participant.displayName}
                    {participant.id === selfParticipantId ? " (you)" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
