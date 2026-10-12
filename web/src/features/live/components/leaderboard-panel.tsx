"use client";

import type { LeaderboardEntry } from "@/lib/ws/protocol";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";

/**
 * Standings for the current question, exactly as the server published them
 * (`leaderboard.updated` / the recovery snapshot). No client-side re-ranking —
 * the server already decided the order and who won.
 */
export function LeaderboardPanel({
  standings,
  hasQuestion,
  selfParticipantId,
}: {
  standings: LeaderboardEntry[];
  hasQuestion: boolean;
  selfParticipantId: string | null;
}) {
  return (
    <Card>
      <CardHeader
        title="Leaderboard"
        description={hasQuestion ? "Correct answers for this question" : undefined}
      />
      <CardBody>
        {!hasQuestion ? (
          <EmptyState
            title="No question yet"
            description="Standings appear once a question is published."
          />
        ) : standings.length === 0 ? (
          <EmptyState
            title="No answers scored yet"
            description="Correct answers will show up here as they land."
          />
        ) : (
          <ol className="space-y-2">
            {standings.map((entry, index) => (
              <li
                key={entry.participantId}
                className="flex items-center gap-3 rounded-sm border border-transparent px-1.5 py-1.5 data-[self=true]:border-border data-[self=true]:bg-surface-muted"
                data-self={entry.participantId === selfParticipantId}
              >
                <span className="lp-tnum w-5 text-center text-xs text-ink-subtle">
                  {index + 1}
                </span>
                <Avatar name={entry.displayName} seed={entry.participantId} size="xs" />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {entry.displayName}
                </span>
                {entry.isWinner ? <Badge tone="live">first correct</Badge> : null}
                <span className="lp-tnum text-sm font-medium text-ink">{entry.correctCount}</span>
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}
