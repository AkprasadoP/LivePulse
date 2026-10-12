"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form";
import { InlineAlert } from "@/components/ui/feedback";
import { Badge } from "@/components/ui/badge";
import type { ActionResult } from "../use-live-session";
import type { AnswerResult, CurrentQuestion, OwnAnswer } from "../live-store";

const REJECTION_TEXT: Record<string, string> = {
  not_accepting_answers: "This question stopped accepting answers before yours arrived.",
  not_a_participant: "You are viewing this session without joining it.",
  QUESTION_NOT_ACCEPTING_ANSWERS: "This question stopped accepting answers before yours arrived.",
  NOT_A_PARTICIPANT: "You are viewing this session without joining it.",
};

function Verdict({ result }: { result: AnswerResult }) {
  if (result.status === "rejected") {
    return (
      <InlineAlert tone="warn" role="alert">
        {REJECTION_TEXT[result.reason ?? ""] ?? "That answer was not accepted. Try again."}
      </InlineAlert>
    );
  }

  if (result.isCorrect === true) {
    return (
      <InlineAlert tone="success" role="status">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Correct.</span>
          {result.isWinner ? <Badge tone="live">first correct</Badge> : null}
        </span>
        <span className="mt-0.5 block opacity-90">
          {result.isWinner
            ? "You were the first with the right answer."
            : "Your answer was recorded before the question closed."}
        </span>
      </InlineAlert>
    );
  }

  if (result.isCorrect === false) {
    return (
      <InlineAlert tone="danger" role="status">
        <span className="font-medium">Not quite.</span>{" "}
        <span className="opacity-90">That was not the correct answer.</span>
      </InlineAlert>
    );
  }

  return (
    <InlineAlert tone="info" role="status">
      <span className="font-medium">Answer recorded.</span>{" "}
      <span className="opacity-90">This question is not scored.</span>
    </InlineAlert>
  );
}

/**
 * The student's answer surface.
 *
 * Answer content is free text — the protocol carries a single `content`
 * string, and the answer key stays on the server. The client only ever learns
 * whether *its own* submission was correct.
 */
export function StudentAnswer({
  question,
  ownAnswer,
  answerResult,
  canAnswer,
  onSubmit,
}: {
  question: CurrentQuestion;
  ownAnswer: OwnAnswer | null;
  answerResult: AnswerResult | null;
  canAnswer: boolean;
  onSubmit: (questionId: string, content: string) => Promise<ActionResult>;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const settled = answerResult !== null && answerResult.status === "accepted";
  const rejected = answerResult?.status === "rejected";

  if (settled) {
    return (
      <div className="space-y-4">
        {ownAnswer ? (
          <div className="rounded-sm border border-border bg-surface-muted px-3.5 py-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
              Your answer
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{ownAnswer.content}</p>
          </div>
        ) : null}
        {answerResult ? <Verdict result={answerResult} /> : null}
      </div>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const content = draft.trim();
    if (content.length === 0) {
      setFormError("Write your answer first.");
      return;
    }
    setSubmitting(true);
    const result = await onSubmit(question.questionId, content);
    if (!result.ok) setFormError(result.message);
    setSubmitting(false);
  }

  const closed = !question.acceptingAnswers;

  return (
    <form onSubmit={submit} className="space-y-3">
      {rejected && answerResult ? <Verdict result={answerResult} /> : null}
      {formError ? (
        <InlineAlert tone="danger" role="alert">
          {formError}
        </InlineAlert>
      ) : null}
      {closed ? (
        <InlineAlert tone="info">This question is closed. Wait for the next one.</InlineAlert>
      ) : !canAnswer ? (
        <InlineAlert tone="warn">
          You are not connected to the session, so answers are paused.
        </InlineAlert>
      ) : null}

      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Type your answer…"
        maxLength={2000}
        disabled={closed || !canAnswer || submitting}
        aria-label="Your answer"
      />
      <div className="flex items-center justify-between gap-3">
        <span className="lp-tnum text-xs text-ink-subtle">{draft.length} / 2000</span>
        <Button type="submit" variant="accent" loading={submitting} disabled={closed || !canAnswer}>
          {rejected ? "Try again" : "Submit answer"}
        </Button>
      </div>
    </form>
  );
}
