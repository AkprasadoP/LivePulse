import { describe, expect, it } from "vitest";
import { initialLiveSessionState, reduceLiveEvent, type LiveSessionState } from "./live-store";

const SESSION = "session-1";

function reduce(
  state: LiveSessionState,
  type: string,
  payload: Record<string, unknown>,
): LiveSessionState {
  return reduceLiveEvent(state, { type, payload });
}

function doubt(id: string, priority: number, enqueueSeq: number) {
  return {
    doubtId: id,
    participantId: "p1",
    displayName: "Ana",
    content: `doubt ${id}`,
    priority,
    enqueueSeq,
    status: "OPEN" as const,
    createdAt: "2026-01-01T10:00:00.000Z",
  };
}

const base = () => initialLiveSessionState(SESSION);

describe("live-store session.joined", () => {
  it("applies the recovery snapshot when one is present", () => {
    const state = reduce(base(), "session.joined", {
      sessionId: SESSION,
      state: "LIVE",
      participantId: "p-self",
      role: "STUDENT",
      displayName: "Ana",
      recovery: {
        quizzes: [{ quizId: "qz1", state: "ACTIVE", startedAt: "2026-01-01T09:00:00.000Z" }],
        question: {
          quizId: "qz1",
          questionId: "q1",
          position: 1,
          prompt: "Capital of Germany?",
          firstCorrectWins: true,
          state: "PUBLISHED",
          acceptingAnswers: true,
        },
        ownAnswer: {
          questionId: "q1",
          content: "Berlin",
          isCorrect: true,
          isWinner: true,
          attemptNumber: 1,
          submittedAt: "2026-01-01T09:01:00.000Z",
        },
        standings: [{ participantId: "p-self", displayName: "Ana", correctCount: 1, isWinner: true }],
        doubts: { open: [doubt("d1", 0, 1)], truncated: false },
      },
    });

    expect(state.joined).toBe(true);
    expect(state.role).toBe("STUDENT");
    expect(state.currentQuestion?.questionId).toBe("q1");
    expect(state.ownAnswer?.content).toBe("Berlin");
    expect(state.answerResult).toMatchObject({ status: "accepted", isCorrect: true, isWinner: true });
    expect(state.standings).toHaveLength(1);
    expect(state.doubts.map((d) => d.doubtId)).toEqual(["d1"]);
    expect(state.recoveryReceived).toBe(true);
  });

  it("handles a null recovery without inventing state", () => {
    const state = reduce(base(), "session.joined", {
      sessionId: SESSION,
      state: "CREATED",
      participantId: null,
      role: null,
      displayName: null,
      recovery: null,
    });

    expect(state.joined).toBe(true);
    expect(state.sessionState).toBe("CREATED");
    expect(state.currentQuestion).toBeNull();
    expect(state.ownAnswer).toBeNull();
    expect(state.answerResult).toBeNull();
    expect(state.standings).toEqual([]);
    expect(state.doubts).toEqual([]);
  });

  it("handles a recovery with a question but no own answer", () => {
    const state = reduce(base(), "session.joined", {
      sessionId: SESSION,
      state: "LIVE",
      participantId: "p-self",
      role: "STUDENT",
      displayName: "Ana",
      recovery: {
        quizzes: [],
        question: {
          quizId: "qz1",
          questionId: "q9",
          position: 2,
          prompt: "Second?",
          firstCorrectWins: false,
          state: "CLOSED",
          acceptingAnswers: false,
        },
        ownAnswer: null,
        standings: [],
        doubts: { open: [], truncated: false },
      },
    });

    expect(state.currentQuestion).toMatchObject({ questionId: "q9", state: "CLOSED", acceptingAnswers: false });
    expect(state.ownAnswer).toBeNull();
    expect(state.answerResult).toBeNull();
  });
});

describe("live-store question lifecycle", () => {
  it("resets per-question state when a question is published", () => {
    const joined = reduce(base(), "session.joined", {
      sessionId: SESSION,
      state: "LIVE",
      participantId: "p-self",
      role: "STUDENT",
      displayName: "Ana",
      recovery: null,
    });
    const withOld = reduce(
      reduce(joined, "question.published", {
        quizId: "qz1",
        questionId: "q1",
        position: 1,
        prompt: "First",
        firstCorrectWins: true,
      }),
      "answer.accepted",
      { participantId: "p-self", questionId: "q1", isCorrect: true, isWinner: true, attemptNumber: 1 },
    );
    expect(withOld.ownAnswer).not.toBeNull();

    const next = reduce(withOld, "question.published", {
      quizId: "qz1",
      questionId: "q2",
      position: 2,
      prompt: "Second",
      firstCorrectWins: false,
    });

    expect(next.currentQuestion).toMatchObject({
      questionId: "q2",
      prompt: "Second",
      state: "PUBLISHED",
      acceptingAnswers: true,
      firstCorrectWins: false,
    });
    expect(next.ownAnswer).toBeNull();
    expect(next.answerResult).toBeNull();
    expect(next.standings).toEqual([]);
    expect(next.activity).toEqual([]);
  });

  it("closes the current question without touching other state", () => {
    const open = reduce(base(), "question.published", {
      quizId: "qz1",
      questionId: "q1",
      position: 1,
      prompt: "First",
      firstCorrectWins: true,
    });
    const closed = reduce(open, "question.closed", { quizId: "qz1", questionId: "q1" });

    expect(closed.currentQuestion).toMatchObject({ state: "CLOSED", acceptingAnswers: false });
    expect(closed.currentQuestion?.prompt).toBe("First");
  });

  it("tracks quiz.started for a quiz that was not in the snapshot", () => {
    const state = reduce(base(), "quiz.started", { quizId: "qz1", state: "ACTIVE" });
    expect(state.quizzes).toEqual([{ quizId: "qz1", state: "ACTIVE", startedAt: null }]);
  });
});

describe("live-store answers", () => {
  it("keeps own-answer state only for the local participant", () => {
    const state = reduce(base(), "session.joined", {
      sessionId: SESSION,
      state: "LIVE",
      participantId: "p-self",
      role: "STUDENT",
      displayName: "Ana",
      recovery: null,
    });

    const other = reduce(state, "answer.accepted", {
      participantId: "p-other",
      displayName: "Bo",
      questionId: "q1",
      isCorrect: true,
      isWinner: true,
      attemptNumber: 1,
    });

    expect(other.ownAnswer).toBeNull();
    expect(other.answerResult).toBeNull();
    expect(other.activity).toHaveLength(1);
    expect(other.activity[0]).toMatchObject({ displayName: "Bo", isWinner: true });
  });

  it("records the local verdict and dedupes the private + broadcast pair", () => {
    const state = reduce(base(), "session.joined", {
      sessionId: SESSION,
      state: "LIVE",
      participantId: "p-self",
      role: "STUDENT",
      displayName: "Ana",
      recovery: null,
    });

    const payload = {
      participantId: "p-self",
      displayName: "Ana",
      questionId: "q1",
      isCorrect: true,
      isWinner: false,
      attemptNumber: 1,
    };
    const once = reduce(state, "answer.accepted", payload);
    const twice = reduce(once, "answer.accepted", payload);

    expect(once.answerResult).toMatchObject({ status: "accepted", isCorrect: true });
    expect(twice.activity).toHaveLength(1);
  });

  it("records a rejection against the current question", () => {
    const joined = reduce(base(), "session.joined", {
      sessionId: SESSION,
      state: "LIVE",
      participantId: "p-self",
      role: "STUDENT",
      displayName: "Ana",
      recovery: null,
    });
    const state = reduce(joined, "answer.rejected", {
      questionId: "q1",
      participantId: "p-self",
      reason: "not_accepting_answers",
    });

    expect(state.answerResult).toMatchObject({
      questionId: "q1",
      status: "rejected",
      reason: "not_accepting_answers",
    });
  });

  it("ignores a rejection aimed at another participant", () => {
    const joined = reduce(base(), "session.joined", {
      sessionId: SESSION,
      state: "LIVE",
      participantId: "p-self",
      role: "STUDENT",
      displayName: "Ana",
      recovery: null,
    });
    const state = reduce(joined, "answer.rejected", {
      questionId: "q1",
      participantId: "p-other",
      reason: "not_accepting_answers",
    });

    expect(state.answerResult).toBeNull();
  });
});

describe("live-store leaderboard", () => {
  it("ignores a leaderboard for a question we already moved past", () => {
    const open = reduce(base(), "question.published", {
      quizId: "qz1",
      questionId: "q2",
      position: 2,
      prompt: "Second",
      firstCorrectWins: true,
    });

    const stale = reduce(open, "leaderboard.updated", {
      questionId: "q1",
      standings: [{ participantId: "p1", displayName: "Bo", correctCount: 9, isWinner: true }],
    });

    expect(stale.standings).toEqual([]);
  });

  it("accepts standings for the current question", () => {
    const open = reduce(base(), "question.published", {
      quizId: "qz1",
      questionId: "q2",
      position: 2,
      prompt: "Second",
      firstCorrectWins: true,
    });

    const updated = reduce(open, "leaderboard.updated", {
      questionId: "q2",
      standings: [{ participantId: "p1", displayName: "Bo", correctCount: 1, isWinner: true }],
    });

    expect(updated.standings).toHaveLength(1);
  });
});

describe("live-store doubts", () => {
  it("orders the queue by priority DESC then enqueueSeq ASC", () => {
    const state = [
      { type: "doubt.created", payload: { doubt: doubt("low", 0, 1) } },
      { type: "doubt.created", payload: { doubt: doubt("high", 5, 9) } },
      { type: "doubt.created", payload: { doubt: doubt("mid", 5, 3) } },
    ].reduce<LiveSessionState>(
      (current, event) => reduce(current, event.type, event.payload),
      base(),
    );

    expect(state.doubts.map((d) => d.doubtId)).toEqual(["mid", "high", "low"]);
  });

  it("removes a doubt when it is resolved or dismissed", () => {
    const seeded = reduce(base(), "doubt.created", { doubt: doubt("d1", 0, 1) });

    expect(reduce(seeded, "doubt.resolved", { doubtId: "d1" }).doubts).toEqual([]);
    expect(reduce(seeded, "doubt.dismissed", { doubtId: "d1" }).doubts).toEqual([]);
  });

  it("does not keep a doubt that arrives already terminal", () => {
    const state = reduce(base(), "doubt.created", {
      doubt: { ...doubt("d1", 0, 1), status: "RESOLVED" as const },
    });
    expect(state.doubts).toEqual([]);
  });

  it("replaces the queue wholesale on doubt.queue.updated", () => {
    const state = reduce(base(), "doubt.queue.updated", {
      doubts: [doubt("d3", 0, 3), doubt("d2", 0, 2)],
      truncated: true,
    });

    expect(state.doubts.map((d) => d.doubtId)).toEqual(["d3", "d2"]);
    expect(state.doubtsTruncated).toBe(true);
  });
});

describe("live-store errors", () => {
  it("stores the last protocol error", () => {
    const state = reduce(base(), "error", {
      code: "TEACHER_REQUIRED",
      message: "no",
      details: null,
    });
    expect(state.lastError?.code).toBe("TEACHER_REQUIRED");
  });

  it("never stores a correct answer even if a payload tried to carry one", () => {
    const state = reduce(base(), "question.published", {
      quizId: "qz1",
      questionId: "q1",
      position: 1,
      prompt: "Capital of Germany?",
      firstCorrectWins: true,
      // The backend never sends this; the reducer must not adopt it anyway.
      correctAnswer: "Berlin",
    });

    expect(JSON.stringify(state.currentQuestion)).not.toContain("Berlin");
    expect(Object.keys(state.currentQuestion ?? {})).not.toContain("correctAnswer");
  });
});
