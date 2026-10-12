import type { ParticipantRole, SessionState } from "@/lib/api/types";
import type {
  DoubtView,
  LeaderboardEntry,
  PresenceParticipant,
  ProtocolError,
  RecoveryQuiz,
} from "@/lib/ws/protocol";

/**
 * Live session state, derived ONLY from server frames and the Phase 5 recovery
 * snapshot. Nothing here is invented locally: if the server did not say it, it
 * is not in this state.
 */
export interface CurrentQuestion {
  questionId: string;
  quizId: string;
  position: number;
  prompt: string;
  firstCorrectWins: boolean;
  state: "PUBLISHED" | "CLOSED";
  acceptingAnswers: boolean;
}

export interface OwnAnswer {
  questionId: string;
  content: string;
  isCorrect: boolean | null;
  isWinner: boolean;
  attemptNumber: number;
  submittedAt: string;
}

export interface AnswerResult {
  questionId: string;
  status: "accepted" | "rejected";
  isCorrect?: boolean | null;
  isWinner?: boolean;
  attemptNumber?: number;
  reason?: string;
}

/**
 * One answer as it was broadcast to the room. Every field comes from the
 * server's `answer.accepted`; `receivedAt` is only when THIS client saw it.
 * The feed is a nicety for the teacher — no state anywhere depends on it.
 */
export interface AnswerActivity {
  /** `${questionId}:${participantId}:${attemptNumber}` — the dedupe key. */
  key: string;
  participantId: string;
  displayName: string;
  isCorrect: boolean | null;
  isWinner: boolean;
  receivedAt: number;
}

const ACTIVITY_LIMIT = 12;

export interface LiveSessionState {
  joined: boolean;
  sessionId: string;
  sessionState: SessionState | null;
  startedAt: string | null;
  endedAt: string | null;
  role: ParticipantRole | null;
  participantId: string | null;
  displayName: string | null;
  presence: PresenceParticipant[];
  quizzes: RecoveryQuiz[];
  currentQuestion: CurrentQuestion | null;
  ownAnswer: OwnAnswer | null;
  answerResult: AnswerResult | null;
  standings: LeaderboardEntry[];
  activity: AnswerActivity[];
  doubts: DoubtView[];
  doubtsTruncated: boolean;
  recoveryReceived: boolean;
  lastError: ProtocolError | null;
}

export function initialLiveSessionState(sessionId: string): LiveSessionState {
  return {
    joined: false,
    sessionId,
    sessionState: null,
    startedAt: null,
    endedAt: null,
    role: null,
    participantId: null,
    displayName: null,
    presence: [],
    quizzes: [],
    currentQuestion: null,
    ownAnswer: null,
    answerResult: null,
    standings: [],
    activity: [],
    doubts: [],
    doubtsTruncated: false,
    recoveryReceived: false,
    lastError: null,
  };
}

export interface LiveEvent {
  type: string;
  payload: unknown;
}

/** OPEN doubts only; terminal ones leave the queue view. */
function upsertDoubt(list: DoubtView[], doubt: DoubtView): DoubtView[] {
  const without = list.filter((d) => d.doubtId !== doubt.doubtId);
  if (doubt.status !== "OPEN") return without;
  return [...without, doubt].sort(
    (a, b) => b.priority - a.priority || a.enqueueSeq - b.enqueueSeq,
  );
}

export function reduceLiveEvent(state: LiveSessionState, event: LiveEvent): LiveSessionState {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "session.joined": {
      const recovery = payload.recovery as
        | {
            quizzes: RecoveryQuiz[];
            question: CurrentQuestion | null;
            ownAnswer: OwnAnswer | null;
            standings: LeaderboardEntry[];
            doubts: { open: DoubtView[]; truncated: boolean };
          }
        | null
        | undefined;
      const question = recovery?.question ?? null;
      return {
        ...state,
        joined: true,
        sessionId: (payload.sessionId as string) ?? state.sessionId,
        sessionState: payload.state as SessionState,
        role: (payload.role as ParticipantRole | null) ?? null,
        participantId: (payload.participantId as string | null) ?? null,
        displayName: (payload.displayName as string | null) ?? null,
        quizzes: recovery?.quizzes ?? [],
        currentQuestion: question,
        ownAnswer: recovery?.ownAnswer ?? null,
        // A fresh join's answer result starts empty; the recovery `ownAnswer`
        // is the authoritative record of what already happened.
        answerResult: recovery?.ownAnswer
          ? {
              questionId: recovery.ownAnswer.questionId,
              status: "accepted",
              isCorrect: recovery.ownAnswer.isCorrect,
              isWinner: recovery.ownAnswer.isWinner,
              attemptNumber: recovery.ownAnswer.attemptNumber,
            }
          : null,
        standings: recovery?.standings ?? [],
        // The activity feed is transient and is NOT replayed; a fresh join
        // starts with an empty feed rather than inventing a history.
        activity: [],
        doubts: recovery?.doubts.open ?? [],
        doubtsTruncated: recovery?.doubts.truncated ?? false,
        recoveryReceived: true,
        lastError: null,
      };
    }

    case "session.state": {
      return {
        ...state,
        sessionState: payload.state as SessionState,
        startedAt: (payload.startedAt as string | null) ?? null,
        endedAt: (payload.endedAt as string | null) ?? null,
      };
    }

    case "presence.snapshot": {
      return { ...state, presence: (payload.participants as PresenceParticipant[]) ?? [] };
    }

    case "quiz.started": {
      const quizId = payload.quizId as string;
      const quizState = payload.state as RecoveryQuiz["state"];
      const exists = state.quizzes.some((q) => q.quizId === quizId);
      return {
        ...state,
        quizzes: exists
          ? state.quizzes.map((q) => (q.quizId === quizId ? { ...q, state: quizState } : q))
          : [...state.quizzes, { quizId, state: quizState, startedAt: null }],
      };
    }

    case "question.published": {
      return {
        ...state,
        currentQuestion: {
          questionId: payload.questionId as string,
          quizId: payload.quizId as string,
          position: payload.position as number,
          prompt: payload.prompt as string,
          firstCorrectWins: (payload.firstCorrectWins as boolean) ?? true,
          state: "PUBLISHED",
          acceptingAnswers: true,
        },
        // A newly published question starts unanswered for everyone.
        ownAnswer: null,
        answerResult: null,
        standings: [],
        activity: [],
      };
    }

    case "question.closed": {
      if (!state.currentQuestion) return state;
      return {
        ...state,
        currentQuestion: { ...state.currentQuestion, state: "CLOSED", acceptingAnswers: false },
      };
    }

    case "answer.accepted": {
      const mine = payload.participantId === state.participantId;
      const isCorrect = (payload.isCorrect as boolean | null) ?? null;
      const isWinner = (payload.isWinner as boolean) ?? false;
      const participantId = payload.participantId as string;
      const questionId = payload.questionId as string;
      const attemptNumber = (payload.attemptNumber as number) ?? 1;
      // The submitter receives the same attempt twice: once as the correlated
      // private verdict, once in the session broadcast. Dedupe on the attempt
      // key so the feed shows each answer once.
      const key = `${questionId}:${participantId}:${attemptNumber}`;
      const activity = state.activity.some((entry) => entry.key === key)
        ? state.activity
        : [
            {
              key,
              participantId,
              displayName: (payload.displayName as string) ?? "",
              isCorrect,
              isWinner,
              receivedAt: Date.now(),
            },
            ...state.activity,
          ].slice(0, ACTIVITY_LIMIT);

      if (!mine) return { ...state, activity };

      const answer: OwnAnswer = {
        questionId,
        content: "",
        isCorrect,
        isWinner,
        attemptNumber,
        submittedAt: new Date().toISOString(),
      };
      return {
        ...state,
        activity,
        ownAnswer: answer,
        answerResult: {
          questionId: answer.questionId,
          status: "accepted",
          isCorrect: answer.isCorrect,
          isWinner: answer.isWinner,
          attemptNumber: answer.attemptNumber,
        },
      };
    }

    case "answer.rejected": {
      if (payload.participantId !== state.participantId) return state;
      return {
        ...state,
        answerResult: {
          questionId: payload.questionId as string,
          status: "rejected",
          reason: payload.reason as string,
        },
      };
    }

    // Synthetic, dispatched by the action layer when a correlated answer
    // request fails (the backend surfaces rejections as `error` frames).
    case "local.answer-rejected": {
      return {
        ...state,
        answerResult: {
          questionId: payload.questionId as string,
          status: "rejected",
          reason: (payload.reason as string) ?? "rejected",
        },
      };
    }

    case "leaderboard.updated": {
      // Ignore a stale leaderboard for a question we already moved past.
      if (state.currentQuestion && payload.questionId !== state.currentQuestion.questionId) {
        return state;
      }
      return { ...state, standings: (payload.standings as LeaderboardEntry[]) ?? [] };
    }

    case "doubt.created": {
      const doubt = payload.doubt as DoubtView;
      if (!doubt) return state;
      return { ...state, doubts: upsertDoubt(state.doubts, doubt) };
    }

    case "doubt.resolved":
    case "doubt.dismissed": {
      const doubtId = payload.doubtId as string;
      return { ...state, doubts: state.doubts.filter((d) => d.doubtId !== doubtId) };
    }

    case "doubt.queue.updated": {
      return {
        ...state,
        doubts: (payload.doubts as DoubtView[]) ?? [],
        doubtsTruncated: (payload.truncated as boolean) ?? false,
      };
    }

    case "error": {
      return { ...state, lastError: event.payload as ProtocolError };
    }

    default:
      return state;
  }
}
