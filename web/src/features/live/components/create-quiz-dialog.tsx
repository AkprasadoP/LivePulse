"use client";

import { useState } from "react";
import type { CreateQuizInput } from "@/lib/api/types";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/form";
import { InlineAlert } from "@/components/ui/feedback";
import type { ActionResult } from "../use-live-session";

interface DraftQuestion {
  key: number;
  prompt: string;
  correctAnswer: string;
  firstCorrectWins: boolean;
}

let nextKey = 1;

function blankQuestion(): DraftQuestion {
  return { key: nextKey++, prompt: "", correctAnswer: "", firstCorrectWins: true };
}

/**
 * The quiz composer. Questions are created in DRAFT — nothing reaches students
 * until the teacher starts the quiz and publishes a question. The answer key
 * is write-only: the server never returns it, so it is never rendered back.
 */
export function CreateQuizDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: CreateQuizInput) => Promise<ActionResult>;
}) {
  const [title, setTitle] = useState("");
  const [questions, setQuestions] = useState<DraftQuestion[]>([blankQuestion()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTitle("");
    setQuestions([blankQuestion()]);
    setError(null);
    setSubmitting(false);
  }

  function patch(key: number, changes: Partial<DraftQuestion>) {
    setQuestions((current) =>
      current.map((question) => (question.key === key ? { ...question, ...changes } : question)),
    );
  }

  async function submit() {
    setError(null);
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      setError("Give the quiz a title.");
      return;
    }
    const payloadQuestions = questions
      .map((question) => ({
        prompt: question.prompt.trim(),
        correctAnswer: question.correctAnswer.trim(),
        firstCorrectWins: question.firstCorrectWins,
      }))
      .filter((question) => question.prompt.length > 0);

    if (payloadQuestions.length === 0) {
      setError("Add at least one question with a prompt.");
      return;
    }

    const input: CreateQuizInput = {
      title: trimmedTitle,
      questions: payloadQuestions.map((question) => ({
        prompt: question.prompt,
        ...(question.correctAnswer.length > 0 ? { correctAnswer: question.correctAnswer } : {}),
        firstCorrectWins: question.firstCorrectWins,
      })),
    };

    setSubmitting(true);
    const result = await onCreate(input);
    if (result.ok) {
      reset();
      onClose();
    } else {
      setError(result.message);
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!submitting) {
          reset();
          onClose();
        }
      }}
      title="Create a quiz"
      description="Questions start as drafts. Start the quiz, then publish them one at a time."
      size="lg"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button variant="accent" loading={submitting} onClick={() => void submit()}>
            Create quiz
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error ? (
          <InlineAlert tone="danger" role="alert">
            {error}
          </InlineAlert>
        ) : null}

        <Field label="Quiz title">
          {(props) => (
            <Input
              {...props}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Cell structure — quick check"
              maxLength={200}
            />
          )}
        </Field>

        <div className="space-y-4">
          {questions.map((question, index) => (
            <div
              key={question.key}
              className="rounded-md border border-border bg-surface-muted/60 p-3.5"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Question {index + 1}
                </span>
                {questions.length > 1 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setQuestions((current) => current.filter((q) => q.key !== question.key))
                    }
                    className="rounded-xs px-2 py-0.5 text-xs text-ink-subtle hover:bg-surface-inset hover:text-danger"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <div className="mt-3 space-y-3">
                <Field label="Prompt">
                  {(props) => (
                    <Textarea
                      {...props}
                      value={question.prompt}
                      onChange={(event) => patch(question.key, { prompt: event.target.value })}
                      placeholder="Which organelle produces ATP?"
                      maxLength={2000}
                      className="min-h-16 bg-surface"
                    />
                  )}
                </Field>
                <Field label="Correct answer" hint="optional — leave blank to score nothing">
                  {(props) => (
                    <Input
                      {...props}
                      value={question.correctAnswer}
                      onChange={(event) =>
                        patch(question.key, { correctAnswer: event.target.value })
                      }
                      placeholder="Mitochondrion"
                      maxLength={2000}
                      className="bg-surface"
                    />
                  )}
                </Field>
                <Checkbox
                  label="First correct answer wins"
                  description="Only the fastest correct submission is flagged as the winner."
                  checked={question.firstCorrectWins}
                  onChange={(event) =>
                    patch(question.key, { firstCorrectWins: event.target.checked })
                  }
                />
              </div>
            </div>
          ))}
        </div>

        {questions.length < 100 ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setQuestions((current) => [...current, blankQuestion()])}
          >
            Add question
          </Button>
        ) : null}
      </div>
    </Modal>
  );
}
