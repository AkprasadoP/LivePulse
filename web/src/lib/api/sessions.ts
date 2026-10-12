import { api } from "./client";
import type {
  CreateSessionResponse,
  SessionDetailResponse,
  SessionState,
  SessionSummary,
} from "./types";

/**
 * Session endpoints.
 *
 * Reads (`GET /sessions/:id`) are open. Creation requires a token and
 * mutation requires the session creator's token (Phase 11) — the shared client
 * attaches it automatically.
 */
export const sessionsApi = {
  create(name: string): Promise<CreateSessionResponse> {
    return api.request<CreateSessionResponse>("/sessions", {
      method: "POST",
      body: { name },
    });
  },

  get(sessionId: string): Promise<SessionDetailResponse> {
    return api.request<SessionDetailResponse>(`/sessions/${encodeURIComponent(sessionId)}`);
  },

  /** Only `LIVE` and `ENDED` are valid targets (backend state machine). */
  transitionState(sessionId: string, state: Exclude<SessionState, "CREATED">) {
    return api.request<{ session: SessionSummary }>(
      `/sessions/${encodeURIComponent(sessionId)}/state`,
      { method: "POST", body: { state } },
    );
  },
};

/** Exposed for the live features layer (publish/close catalog refresh). */
export function getSession(): Promise<{
  quizzes: Array<{
    id: string;
    title: string;
    questions: Array<{ id: string; prompt: string; position: number; hasCorrectAnswer: boolean; state: string }>;
  }>;
}> {
  throw new Error("getSession() requires a sessionId — not wired for standalone use");
}
