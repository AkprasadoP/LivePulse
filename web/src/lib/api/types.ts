/**
 * HTTP DTOs — the exact shapes the Phase 10/11 backend returns.
 * Source of truth: src/modules/**\/*.routes.ts + *.serializer.ts.
 */

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds (900). */
  expiresIn: number;
}

export interface AuthResponse extends AuthTokens {
  user: AuthUser;
}

export interface MeResponse {
  user: AuthUser;
}

export type SessionState = "CREATED" | "LIVE" | "ENDED";

export interface SessionSummary {
  id: string;
  name: string;
  state: SessionState;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  creator: { id: string; displayName: string } | null;
}

export type ParticipantRole = "TEACHER" | "STUDENT";

export interface ParticipantSummary {
  id: string;
  role: ParticipantRole;
  userId: string;
  displayName: string;
  joinedAt: string;
}

export interface SessionDetailResponse {
  session: SessionSummary;
  participants: ParticipantSummary[];
}

export interface CreateSessionResponse {
  session: SessionSummary;
  teacherParticipant: {
    id: string;
    role: ParticipantRole;
    userId: string;
    joinedAt: string;
  };
}

export type QuizState = "DRAFT" | "ACTIVE" | "COMPLETED";
export type QuestionState = "DRAFT" | "PUBLISHED" | "CLOSED";

export interface QuizQuestionView {
  id: string;
  position: number;
  prompt: string;
  /** The answer key itself is never returned — only whether one exists. */
  hasCorrectAnswer: boolean;
  firstCorrectWins: boolean;
  state: QuestionState;
}

export interface QuizView {
  id: string;
  sessionId: string;
  title: string;
  state: QuizState;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  questions: QuizQuestionView[];
}

export interface QuizResponse {
  quiz: QuizView;
}

export interface CreateQuizInput {
  title: string;
  questions?: Array<{
    prompt: string;
    correctAnswer?: string;
    firstCorrectWins?: boolean;
  }>;
}
