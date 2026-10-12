import { api } from "./client";
import type { CreateQuizInput, QuizResponse } from "./types";

/** Quiz endpoints. Creation requires the session creator (Phase 11). */
export const quizzesApi = {
  create(sessionId: string, input: CreateQuizInput): Promise<QuizResponse> {
    return api.request<QuizResponse>(`/sessions/${encodeURIComponent(sessionId)}/quizzes`, {
      method: "POST",
      body: input,
    });
  },

  /**
   * Fetch a quiz with its questions. `correctAnswer` is never included in the
   * response — the serializer exposes only `hasCorrectAnswer`.
   */
  get(quizId: string): Promise<QuizResponse> {
    return api.request<QuizResponse>(`/quizzes/${encodeURIComponent(quizId)}`);
  },
};
