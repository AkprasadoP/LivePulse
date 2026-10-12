"use client";

import type { AnswerActivity } from "../live-store";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";

/**
 * The last few answers as they were broadcast. Purely a pulse-reader for the
 * teacher: everything authoritative lives in the leaderboard and the recovery
 * snapshot. Order is arrival order at this client, newest first.
 */
export function AnswerActivityPanel({
  activity,
  hasQuestion,
}: {
  activity: AnswerActivity[];
  hasQuestion: boolean;
}) {
  return (
    <Card>
      <CardHeader
        title="Answer activity"
        description={hasQuestion ? "Newest first" : undefined}
      />
      <CardBody>
        {!hasQuestion ? (
          <EmptyState
            title="Waiting for a question"
            description="Answers show up here as they arrive."
          />
        ) : activity.length === 0 ? (
          <EmptyState
            title="No answers yet"
            description="Submissions will appear here the moment the server accepts them."
          />
        ) : (
          <ul className="space-y-2">
            {activity.map((entry) => (
              <li key={entry.key} className="flex items-center gap-3">
                <Avatar name={entry.displayName} seed={entry.participantId} size="xs" />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {entry.displayName}
                </span>
                {entry.isWinner ? (
                  <Badge tone="live">first correct</Badge>
                ) : entry.isCorrect === true ? (
                  <Badge tone="live">correct</Badge>
                ) : entry.isCorrect === false ? (
                  <Badge tone="danger">incorrect</Badge>
                ) : (
                  <Badge tone="neutral">recorded</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
