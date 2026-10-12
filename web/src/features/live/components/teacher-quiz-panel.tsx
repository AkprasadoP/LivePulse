"use client";

import { useState } from "react";
import type { CreateQuizInput, QuizQuestionView, QuizView, SessionState } from "@/lib/api/types";
import type { RecoveryQuiz } from "@/lib/ws/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, InlineAlert } from "@/components/ui/feedback";
import type { ActionResult } from "../use-live-session";
import type { CurrentQuestion } from "../live-store";
import { CreateQuizDialog } from "./create-quiz-dialog";

const QUESTION_STATE_LABEL: Record<QuizQuestionView["state"], string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  CLOSED: "Closed",
};

/**
 * Teacher controls for quizzes.
 *
 * The quiz *state* shown here comes from the live session state (frames +
 * recovery snapshot); the quiz *content* (title, questions) comes from the
 * HTTP quiz read. The backend never returns the answer key — only
 * `hasCorrectAnswer` — so this panel can never leak it.
 *
 * Publish/close re-load the owning quiz after a successful mutation so the
 * question-state badges stop serving a stale HTTP read (the stale-badge fix).
 */
export function TeacherQuizPanel({
  quizzes,
  liveQuizzes,
  currentQuestion,
  sessionState,
  actions,
  onCreateQuiz,
  onLoadQuiz,
}: {
  quizzes: QuizView[];
  liveQuizzes: RecoveryQuiz[];
  currentQuestion: CurrentQuestion | null;
  sessionState: SessionState | null;
  actions: {
    startQuiz: (quizId: string) => Promise<ActionResult>;
    publishQuestion: (questionId: string) => Promise<ActionResult>;
    closeQuestion: (questionId: string) => Promise<ActionResult>;
  };
  onCreateQuiz: (input: CreateQuizInput) => Promise<ActionResult>;
  onLoadQuiz: (quizId: string) => Promise<ActionResult>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isLive = sessionState === "LIVE";
  const ended = sessionState === "ENDED";

  function stateOf(quiz: QuizView): RecoveryQuiz["state"] {
    return liveQuizzes.find((q) => q.quizId === quiz.id)?.state ?? quiz.state;
  }

  async function run(key: string, action: () => Promise<ActionResult>) {
    setBusy(key);
    setError(null);
    const result = await action();
    if (!result.ok) setError(result.message);
    setBusy(null);
  }

  return (
    <Card>
      <CardHeader
        title="Quizzes"
        description={
          isLive
            ? "Start a quiz, then publish its questions."
            : ended
              ? "This session has ended."
              : "Start the session to run a quiz."
        }
        action={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDialogOpen(true)}
            disabled={ended}
          >
            New quiz
          </Button>
        }
      />
      <CardBody className="space-y-5">
        {error ? (
          <InlineAlert tone="danger" role="alert">
            {error}
          </InlineAlert>
        ) : null}

        {quizzes.length === 0 ? (
          <EmptyState
            title="No quizzes yet"
            description="Create a quiz with a few questions. You can publish them one at a time once the quiz starts."
            action={
              <Button size="sm" variant="accent" onClick={() => setDialogOpen(true)}>
                Create a quiz
              </Button>
            }
          />
        ) : (
          <div className="space-y-6">
            {quizzes.map((quiz) => {
              const quizState = stateOf(quiz);
              return (
                <section key={quiz.id} className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-ink">{quiz.title}</h3>
                      <Badge tone={quizState === "ACTIVE" ? "live" : "neutral"}>
                        {quizState.toLowerCase()}
                      </Badge>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => void onLoadQuiz(quiz.id)}>
                        Reload
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!isLive || quizState !== "DRAFT"}
                        loading={busy === `start-${quiz.id}`}
                        onClick={() =>
                          void run(`start-${quiz.id}`, () => actions.startQuiz(quiz.id))
                        }
                      >
                        Start quiz
                      </Button>
                    </div>
                  </div>

                  <ol className="divide-y divide-border rounded-sm border border-border">
                    {quiz.questions.map((question) => {
                      const isCurrent = currentQuestion?.questionId === question.id;
                      const canPublish =
                        quizState === "ACTIVE" &&
                        question.state === "DRAFT" &&
                        (!currentQuestion || currentQuestion.state === "CLOSED");
                      return (
                        <li
                          key={question.id}
                          className="flex items-start justify-between gap-3 px-3.5 py-3"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="lp-tnum text-xs text-ink-subtle">
                                {question.position}
                              </span>
                              <Badge
                                tone={
                                  question.state === "PUBLISHED"
                                    ? "live"
                                    : question.state === "CLOSED"
                                      ? "neutral"
                                      : "accent"
                                }
                              >
                                {QUESTION_STATE_LABEL[question.state]}
                              </Badge>
                              {question.hasCorrectAnswer ? (
                                <Badge tone="neutral">scored</Badge>
                              ) : (
                                <Badge tone="neutral">unscored</Badge>
                              )}
                            </div>
                            <p className="mt-1.5 line-clamp-2 text-sm text-ink">
                              {question.prompt}
                            </p>
                          </div>
                          <div className="flex shrink-0 gap-2">
                            <Button
                              size="sm"
                              variant="accent"
                              disabled={!canPublish}
                              loading={busy === `publish-${question.id}`}
                              onClick={() =>
                                void run(`publish-${question.id}`, () =>
                                  actions.publishQuestion(question.id),
                                )
                              }
                            >
                              Publish
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={question.state !== "PUBLISHED"}
                              loading={busy === `close-${question.id}`}
                              onClick={() =>
                                void run(`close-${question.id}`, () =>
                                  actions.closeQuestion(question.id),
                                )
                              }
                            >
                              Close
                            </Button>
                            {isCurrent ? (
                              <span className="self-center text-xs text-live">on screen</span>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              );
            })}
          </div>
        )}
      </CardBody>

      <CreateQuizDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={onCreateQuiz}
      />
    </Card>
  );
}
