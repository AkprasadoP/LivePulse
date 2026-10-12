"use client";

import type { ReactNode } from "react";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import type { CurrentQuestion } from "../live-store";

/**
 * The question everyone is looking at. It renders only what the server sent:
 * the prompt, its position, whether answers are being accepted, and whether
 * the first correct answer wins. The answer key is never available to the
 * client, so it cannot be shown even by mistake.
 */
export function QuestionPanel({
  question,
  children,
  emptyHint,
}: {
  question: CurrentQuestion | null;
  children?: ReactNode;
  emptyHint: string;
}) {
  if (!question) {
    return (
      <Card>
        <CardHeader title="Current question" />
        <CardBody>
          <EmptyState title="No question is open" description={emptyHint} />
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={`Question ${question.position}`}
        action={
          question.acceptingAnswers ? (
            <Badge tone="live">
              <StatusDot tone="live" pulse />
              Accepting answers
            </Badge>
          ) : (
            <Badge tone="neutral">Closed</Badge>
          )
        }
      />
      <CardBody className="space-y-5">
        <p className="text-lg font-medium leading-snug text-ink sm:text-xl">{question.prompt}</p>
        <p className="text-xs text-ink-subtle">
          {question.hasCorrectAnswer
            ? "Scored — the first correct answer wins."
            : "Answers are recorded for this question (not scored)."}
        </p>
        {children}
      </CardBody>
    </Card>
  );
}
