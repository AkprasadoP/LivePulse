import type { QuestionState, QuizState } from "@prisma/client";

/**
 * Explicit lifecycle state machines for quizzes and questions.
 * Modeled since Phase 1 (schema enums); driven by teacher actions since
 * Phase 3. Deliberately NOT mirrors of the session state machine:
 * a quiz can outlive questions (COMPLETED with closed questions), and one
 * quiz runs inside a LIVE session.
 *
 *   Quiz:     DRAFT -> ACTIVE             (quiz.start)
 *             ACTIVE -> COMPLETED         (not exposed yet; questions close
 *                                          individually during ACTIVE)
 *
 *   Question: DRAFT -> PUBLISHED          (question.publish — starts accepting
 *                                          answers; at most one per quiz,
 *                                          enforced by a partial unique index)
 *             PUBLISHED -> CLOSED         (question.close — stops accepting)
 *
 * "Accepting answers" == question.state === PUBLISHED (single state: publish
 * and accept are one atomic transition, so no broadcast/event ordering gap
 * can exist between "announced" and "accepting").
 */

export const QUIZ_TRANSITIONS: Record<QuizState, QuizState[]> = {
  DRAFT: ["ACTIVE"],
  ACTIVE: ["COMPLETED"],
  COMPLETED: [],
};

export const QUESTION_TRANSITIONS: Record<QuestionState, QuestionState[]> = {
  DRAFT: ["PUBLISHED"],
  PUBLISHED: ["CLOSED"],
  CLOSED: [],
};

export function canTransitionQuiz(from: QuizState, to: QuizState): boolean {
  return QUIZ_TRANSITIONS[from].includes(to);
}

export function canTransitionQuestion(from: QuestionState, to: QuestionState): boolean {
  return QUESTION_TRANSITIONS[from].includes(to);
}
