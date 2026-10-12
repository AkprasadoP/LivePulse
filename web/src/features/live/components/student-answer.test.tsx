import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StudentAnswer } from "./student-answer";
import type { AnswerResult, CurrentQuestion, OwnAnswer } from "../live-store";

const question: CurrentQuestion = {
  questionId: "q1",
  quizId: "qz1",
  position: 1,
  prompt: "Capital of Germany?",
  firstCorrectWins: true,
  state: "PUBLISHED",
  acceptingAnswers: true,
};

const ok = () => Promise.resolve({ ok: true } as const);

function renderAnswer(overrides: {
  question?: CurrentQuestion;
  ownAnswer?: OwnAnswer | null;
  answerResult?: AnswerResult | null;
  canAnswer?: boolean;
  onSubmit?: (questionId: string, content: string) => Promise<{ ok: true } | { ok: false; error: unknown; message: string }>;
}) {
  const onSubmit = overrides.onSubmit ?? vi.fn(ok);
  render(
    <StudentAnswer
      question={overrides.question ?? question}
      ownAnswer={overrides.ownAnswer ?? null}
      answerResult={overrides.answerResult ?? null}
      canAnswer={overrides.canAnswer ?? true}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit };
}

describe("StudentAnswer", () => {
  it("submits the typed answer against the current question", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderAnswer({});

    await user.type(screen.getByLabelText("Your answer"), "Berlin");
    await user.click(screen.getByRole("button", { name: "Submit answer" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("q1", "Berlin"));
  });

  it("blocks submission until something is typed", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderAnswer({});

    await user.click(screen.getByRole("button", { name: "Submit answer" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Write your answer first.")).toBeInTheDocument();
  });

  it("reports a rejection and lets the student try again", async () => {
    const onSubmit = vi.fn(() =>
      Promise.resolve({ ok: false as const, error: new Error("x"), message: "Not accepted." }),
    );
    renderAnswer({ answerResult: { questionId: "q1", status: "rejected", reason: "not_accepting_answers" }, onSubmit });

    expect(
      screen.getByText("This question stopped accepting answers before yours arrived."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("shows the stored answer alongside a correct verdict", () => {
    const ownAnswer: OwnAnswer = {
      questionId: "q1",
      content: "Berlin",
      isCorrect: true,
      isWinner: true,
      attemptNumber: 1,
      submittedAt: "2026-01-01T10:00:00.000Z",
    };
    renderAnswer({
      ownAnswer,
      answerResult: {
        questionId: "q1",
        status: "accepted",
        isCorrect: true,
        isWinner: true,
        attemptNumber: 1,
      },
    });

    expect(screen.getByText("Berlin")).toBeInTheDocument();
    expect(screen.getByText("Correct.")).toBeInTheDocument();
    expect(screen.getByText("first correct")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit answer" })).not.toBeInTheDocument();
  });

  it("shows an incorrect verdict without giving the right answer away", () => {
    renderAnswer({
      ownAnswer: {
        questionId: "q1",
        content: "Hamburg",
        isCorrect: false,
        isWinner: false,
        attemptNumber: 1,
        submittedAt: "2026-01-01T10:00:00.000Z",
      },
      answerResult: { questionId: "q1", status: "accepted", isCorrect: false, isWinner: false },
    });

    expect(screen.getByText("Not quite.")).toBeInTheDocument();
    expect(screen.getByText("Hamburg")).toBeInTheDocument();
    // The answer key never crosses the wire, so nothing can render it.
    expect(document.body.textContent).not.toContain("Berlin");
  });

  it("describes an ungraded answer as recorded", () => {
    renderAnswer({
      answerResult: { questionId: "q1", status: "accepted", isCorrect: null, isWinner: false },
    });

    expect(screen.getByText("Answer recorded.")).toBeInTheDocument();
    expect(screen.getByText("This question is not scored.")).toBeInTheDocument();
  });

  it("disables the form when the question is closed", () => {
    renderAnswer({
      question: { ...question, state: "CLOSED", acceptingAnswers: false },
      canAnswer: true,
    });

    expect(screen.getByLabelText("Your answer")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeDisabled();
    expect(screen.getByText("This question is closed. Wait for the next one.")).toBeInTheDocument();
  });

  it("disables the form when the connection is not healthy", () => {
    renderAnswer({ canAnswer: false });

    expect(screen.getByLabelText("Your answer")).toBeDisabled();
    expect(
      screen.getByText("You are not connected to the session, so answers are paused."),
    ).toBeInTheDocument();
  });
});
