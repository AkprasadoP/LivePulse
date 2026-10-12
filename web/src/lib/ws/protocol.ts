/**
 * WebSocket wire protocol types — a faithful mirror of the backend's
 * `src/ws/protocol.ts`. Types only; the transport lives in ./client.ts.
 *
 * Envelope (both directions): { type, requestId, payload }.
 * Client requestId is REQUIRED (1–128 chars); server replies echo it.
 */
import type { ParticipantRole, SessionState } from "@/lib/api/types";

export interface ClientEnvelope {
  type: ClientEventType;
  requestId: string;
  payload: Record<string, unknown>;
}

export interface ServerEnvelope<T = unknown> {
  type: string;
  requestId: string | null;
  payload: T;
}

export type ClientEventType =
  | "auth.authenticate"
  | "session.join"
  | "session.leave"
  | "quiz.start"
  | "question.publish"
  | "question.close"
  | "quiz.answer"
  | "doubt.create"
  | "doubt.resolve"
  | "doubt.dismiss"
  | "doubt.queue.list";

export type ProtocolErrorCode =
  | "INVALID_MESSAGE"
  | "INVALID_REQUEST"
  | "INVALID_SESSION_ID"
  | "UNAUTHENTICATED"
  | "SESSION_NOT_FOUND"
  | "SESSION_ALREADY_JOINED"
  | "UNSUPPORTED_EVENT"
  | "NOT_JOINED"
  | "NOT_A_PARTICIPANT"
  | "TEACHER_REQUIRED"
  | "SESSION_NOT_LIVE"
  | "QUIZ_NOT_FOUND"
  | "QUESTION_NOT_FOUND"
  | "QUIZ_NOT_ACTIVE"
  | "QUESTION_NOT_ACCEPTING_ANSWERS"
  | "INVALID_STATE_TRANSITION"
  | "DOUBT_NOT_FOUND"
  | "DOUBT_NOT_OPEN"
  | "INTERNAL_ERROR";

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
  details: { issues: Array<{ path: string; message: string }> } | null;
}

// ---- Shared views ----------------------------------------------------------

export interface LeaderboardEntry {
  participantId: string;
  displayName: string;
  correctCount: number;
  isWinner: boolean;
}

export interface PresenceParticipant {
  participantId: string;
  displayName: string;
  role: ParticipantRole;
}

export type DoubtStatus = "OPEN" | "RESOLVED" | "DISMISSED";

export interface DoubtView {
  doubtId: string;
  participantId: string;
  displayName: string;
  content: string;
  priority: number;
  enqueueSeq: number;
  status: DoubtStatus;
  createdAt: string;
}

// ---- Recovery snapshot (Phase 5) -------------------------------------------

export interface RecoveryQuiz {
  quizId: string;
  state: "DRAFT" | "ACTIVE" | "COMPLETED";
  startedAt: string | null;
}

export interface RecoveryQuestion {
  quizId: string;
  questionId: string;
  position: number;
  prompt: string;
  firstCorrectWins: boolean;
  state: "PUBLISHED" | "CLOSED";
  acceptingAnswers: boolean;
}

export interface RecoveryOwnAnswer {
  questionId: string;
  content: string;
  isCorrect: boolean | null;
  isWinner: boolean;
  attemptNumber: number;
  submittedAt: string;
}

export interface RecoverySnapshot {
  quizzes: RecoveryQuiz[];
  question: RecoveryQuestion | null;
  ownAnswer: RecoveryOwnAnswer | null;
  standings: LeaderboardEntry[];
  doubts: { open: DoubtView[]; truncated: boolean };
}

// ---- Server event payloads -------------------------------------------------

export interface SessionJoinedPayload {
  sessionId: string;
  state: SessionState;
  participantId: string | null;
  role: ParticipantRole | null;
  displayName: string | null;
  recovery: RecoverySnapshot | null;
}

export interface SessionStatePayload {
  sessionId: string | null;
  state: SessionState;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export interface AuthAuthenticatedPayload {
  userId: string;
}

export interface QuizStartedPayload {
  sessionId: string;
  quizId: string;
  state: "DRAFT" | "ACTIVE" | "COMPLETED";
}

export interface QuestionPublishedPayload {
  sessionId: string;
  quizId: string;
  questionId: string;
  position: number;
  prompt: string;
  firstCorrectWins: boolean;
  acceptingAnswers: true;
}

export interface QuestionClosedPayload {
  sessionId: string;
  quizId: string;
  questionId: string;
}

export interface AnswerAcceptedPayload {
  sessionId: string;
  questionId: string;
  participantId: string;
  displayName: string;
  isCorrect: boolean | null;
  isWinner: boolean;
  attemptNumber: number;
}

export interface AnswerRejectedPayload {
  sessionId: string;
  questionId: string;
  participantId: string;
  reason: "not_accepting_answers" | "not_a_participant";
}

export interface LeaderboardUpdatedPayload {
  sessionId: string;
  questionId: string;
  standings: LeaderboardEntry[];
}

export interface DoubtCreatedPayload {
  sessionId: string;
  doubt: DoubtView;
}

export interface DoubtResolvedPayload {
  sessionId: string;
  doubtId: string;
  status: "RESOLVED";
  resolvedAt: string;
}

export interface DoubtDismissedPayload {
  sessionId: string;
  doubtId: string;
  status: "DISMISSED";
  resolvedAt: string;
}

export interface DoubtQueueUpdatedPayload {
  sessionId: string;
  doubts: DoubtView[];
  truncated: boolean;
}

export interface PresenceSnapshotPayload {
  sessionId: string;
  participants: PresenceParticipant[];
}

export const SERVER_EVENT_TYPES = [
  "auth.authenticated",
  "session.joined",
  "session.state",
  "quiz.started",
  "question.published",
  "question.closed",
  "answer.accepted",
  "answer.rejected",
  "leaderboard.updated",
  "doubt.created",
  "doubt.resolved",
  "doubt.dismissed",
  "doubt.queue.updated",
  "presence.snapshot",
  "error",
] as const;

export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];
