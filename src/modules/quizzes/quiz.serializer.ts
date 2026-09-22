import type { QuizWithQuestions } from "./quiz.repository.js";

/** JSON-safe quiz representation; questions are ordered by position. */
export function serializeQuiz(quiz: QuizWithQuestions) {
  return {
    id: quiz.id,
    sessionId: quiz.sessionId,
    title: quiz.title,
    state: quiz.state,
    startedAt: quiz.startedAt?.toISOString() ?? null,
    endedAt: quiz.endedAt?.toISOString() ?? null,
    createdAt: quiz.createdAt.toISOString(),
    updatedAt: quiz.updatedAt.toISOString(),
    questions: quiz.questions.map((q) => ({
      id: q.id,
      position: q.position,
      prompt: q.prompt,
      // correctAnswer is deliberately NOT exposed — it is teacher-only data
      // and grading arrives in later phases.
      hasCorrectAnswer: q.correctAnswer !== null,
      firstCorrectWins: q.firstCorrectWins,
      state: q.state,
    })),
  };
}
