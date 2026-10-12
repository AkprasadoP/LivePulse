"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, describeApiError } from "@/lib/api/errors";
import { quizzesApi } from "@/lib/api/quizzes";
import { sessionsApi } from "@/lib/api/sessions";
import type {
  CreateQuizInput,
  ParticipantSummary,
  QuizView,
  SessionDetailResponse,
  SessionState,
} from "@/lib/api/types";
import { WS_URL } from "@/lib/config";
import { LiveSocket, type ConnectionStatus } from "@/lib/ws/client";
import { SERVER_EVENT_TYPES, type ProtocolError, type ProtocolErrorCode } from "@/lib/ws/protocol";
import { useAuth } from "@/features/auth/auth-provider";
import { useToast } from "@/components/ui/toast";
import { initialLiveSessionState, reduceLiveEvent, type LiveSessionState } from "./live-store";

export type ActionResult = { ok: true } | { ok: false; error: unknown; message: string };

const ok: ActionResult = { ok: true };

function liveErrorText(code: string, fallback: string): string {
  switch (code) {
    case "TEACHER_REQUIRED":
      return "Only the session owner can do that.";
    case "NOT_A_PARTICIPANT":
      return "You're viewing this session without a participant identity.";
    case "NOT_JOINED":
      return "You're not in the session yet.";
    case "QUESTION_NOT_ACCEPTING_ANSWERS":
      return "This question is no longer accepting answers.";
    case "SESSION_NOT_LIVE":
      return "The session needs to be live first.";
    case "QUIZ_NOT_ACTIVE":
      return "Start the quiz before publishing questions.";
    case "UNAUTHENTICATED":
      return "Your session expired. Please sign in again.";
    case "DOUBT_NOT_OPEN":
      return "That doubt was already handled.";
    case "SESSION_NOT_FOUND":
      return "This session no longer exists.";
    case "INTERNAL_ERROR":
      return "LivePulse hit an error. Please try again.";
    default:
      return fallback || "That action failed.";
  }
}

function describeActionError(error: unknown): string {
  if (error instanceof ApiError) return describeApiError(error);
  if (error instanceof Error) {
    const match = /^([A-Z_]+): (.*)$/.exec(error.message);
    if (match) return liveErrorText(match[1]!, match[2]!);
    if (error.message) return error.message;
  }
  return "Something went wrong.";
}

/** The quiz that owns a question, by question id. Falls back to the question id
 * itself when the catalog has not loaded the owning quiz yet (the reload then
 * simply fails soft and reports the error).
 */
function findQuizIdForQuestion(catalog: QuizView[], questionId: string): string {
  const match = catalog.find((quiz) =>
    quiz.questions.some((candidate) => candidate.id === questionId),
  );
  return match?.id ?? questionId;
}

export interface LiveSessionController {
  status: ConnectionStatus;
  state: LiveSessionState;
  sessionName: string | null;
  roster: ParticipantSummary[];
  quizCatalog: QuizView[];
  loadError: string | null;
  /** The session read returned 404 — the session does not exist (or was removed). */
  sessionMissing: boolean;
  actions: {
    setSessionState: (next: Exclude<SessionState, "CREATED">) => Promise<ActionResult>;
    createQuiz: (input: CreateQuizInput) => Promise<ActionResult>;
    loadQuiz: (quizId: string) => Promise<ActionResult>;
    startQuiz: (quizId: string) => Promise<ActionResult>;
    publishQuestion: (questionId: string) => Promise<ActionResult>;
    closeQuestion: (questionId: string) => Promise<ActionResult>;
    submitAnswer: (questionId: string, content: string) => Promise<ActionResult>;
    createDoubt: (content: string, clientDoubtId?: string) => Promise<ActionResult>;
    resolveDoubt: (doubtId: string) => Promise<ActionResult>;
    dismissDoubt: (doubtId: string) => Promise<ActionResult>;
    refreshDoubts: () => Promise<ActionResult>;
  };
  verifyConnection: () => void;
  leave: () => void;
  refreshSessionState: () => Promise<void>;
}

/**
 * Owns exactly one LiveSocket for a session and projects its frames into React
 * state. Server state is never invented here: every field comes from a frame or
 * the Phase 5 recovery snapshot.
 */
export function useLiveSession(sessionId: string): LiveSessionController {
  const { ensureAccessToken } = useAuth();
  const { toast } = useToast();

  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [state, setState] = useState<LiveSessionState>(() => initialLiveSessionState(sessionId));
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [roster, setRoster] = useState<ParticipantSummary[]>([]);
  const [quizCatalog, setQuizCatalog] = useState<QuizView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionMissing, setSessionMissing] = useState(false);

  const socketRef = useRef<LiveSocket | null>(null);
  const ensureTokenRef = useRef(ensureAccessToken);
  useEffect(() => {
    ensureTokenRef.current = ensureAccessToken;
  }, [ensureAccessToken]);

  /** Fold an HTTP session read into local state (the read is authoritative too). */
  const applySessionDetail = useCallback((detail: SessionDetailResponse) => {
    setSessionName(detail.session.name);
    setRoster(detail.participants);
    setLoadError(null);
    setSessionMissing(false);
    setState((prev) =>
      reduceLiveEvent(prev, {
        type: "session.state",
        payload: {
          sessionId: detail.session.id,
          state: detail.session.state,
          startedAt: detail.session.startedAt,
          endedAt: detail.session.endedAt,
          updatedAt: detail.session.updatedAt,
        },
      }),
    );
  }, []);

  const handleLoadError = useCallback((error: unknown) => {
    // A 404 is terminal and distinct from a transient failure: the session
    // genuinely does not exist, so the page shows a not-found state instead of
    // a retry banner.
    if (error instanceof ApiError && error.isNotFound) {
      setSessionMissing(true);
      setLoadError(null);
    } else {
      setLoadError(describeApiError(error));
    }
  }, []);

  const refreshSessionState = useCallback(async () => {
    try {
      applySessionDetail(await sessionsApi.get(sessionId));
    } catch (error) {
      handleLoadError(error);
    }
  }, [sessionId, applySessionDetail, handleLoadError]);

  // ---- socket lifecycle ---------------------------------------------------
  useEffect(() => {
    const socket = new LiveSocket({
      url: WS_URL,
      sessionId,
      resolveToken: () => ensureTokenRef.current(),
    });
    socketRef.current = socket;

    const offStatus = socket.onStatus((change) => setStatus(change.status));
    const offEvents = SERVER_EVENT_TYPES.map((type) =>
      socket.on(type, (payload) => {
        setState((prev) => reduceLiveEvent(prev, { type, payload }));
      }),
    );
    const offError = socket.onProtocolError((error: ProtocolError) => {
      // Answer rejections are surfaced through the answer result, not a toast.
      if (error.code === "QUESTION_NOT_ACCEPTING_ANSWERS" || error.code === "INVALID_REQUEST") {
        return;
      }
      toast({ title: liveErrorText(error.code, error.message), tone: "warn" });
    });

    socket.connect();

    // Browsers do not surface WS ping/pong, so liveness is verified when the
    // tab regains focus or the network returns — not on frame silence.
    const onVisible = () => {
      if (document.visibilityState === "visible") socket.verifyAlive();
    };
    const onOnline = () => socket.verifyAlive();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      offStatus();
      for (const off of offEvents) off();
      offError();
      socket.close();
      socketRef.current = null;
    };
  }, [sessionId, toast]);

  // ---- session detail + bounded state reconciliation ----------------------
  // The initial read is kicked off here and folded in from a promise
  // continuation (never a synchronous setState in the effect body).
  useEffect(() => {
    void sessionsApi.get(sessionId).then(applySessionDetail, handleLoadError);
  }, [sessionId, applySessionDetail, handleLoadError]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshSessionState();
    };
    window.addEventListener("online", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshSessionState]);

  // The backend does not broadcast HTTP session-state transitions over the WS
  // distribution layer, so a session waiting to go live is reconciled with a
  // bounded poll that STOPS the moment the session is no longer CREATED. See
  // the "genuine backend limitation" note in the frontend README.
  useEffect(() => {
    if (state.sessionState !== "CREATED") return;
    const timer = setInterval(() => void refreshSessionState(), 6000);
    return () => clearInterval(timer);
  }, [state.sessionState, refreshSessionState]);

  // ---- action helpers ------------------------------------------------------
  const socketRequest = useCallback(
    async (type: Parameters<LiveSocket["request"]>[0], payload: Record<string, unknown>) => {
      const socket = socketRef.current;
      if (!socket) throw new Error("OFFLINE: Not connected to the session.");
      return socket.request(type, payload);
    },
    [],
  );

  const setSessionState = useCallback(
    async (next: Exclude<SessionState, "CREATED">): Promise<ActionResult> => {
      try {
        const result = await sessionsApi.transitionState(sessionId, next);
        setState((prev) =>
          reduceLiveEvent(prev, {
            type: "session.state",
            payload: {
              sessionId: result.session.id,
              state: result.session.state,
              startedAt: result.session.startedAt,
              endedAt: result.session.endedAt,
              updatedAt: result.session.updatedAt,
            },
          }),
        );
        toast(
          next === "LIVE"
            ? { title: "Session is live", description: "Students can answer now.", tone: "live" }
            : { title: "Session ended", tone: "neutral" },
        );
        return ok;
      } catch (error) {
        return { ok: false, error, message: describeActionError(error) };
      }
    },
    [sessionId, toast],
  );

  const createQuiz = useCallback(
    async (input: CreateQuizInput): Promise<ActionResult> => {
      try {
        const { quiz } = await quizzesApi.create(sessionId, input);
        setQuizCatalog((prev) => [...prev.filter((q) => q.id !== quiz.id), quiz]);
        toast({
          title: "Quiz created",
          description: `${quiz.questions.length} question(s) in draft.`,
          tone: "accent",
        });
        return ok;
      } catch (error) {
        return { ok: false, error, message: describeActionError(error) };
      }
    },
    [sessionId, toast],
  );

  /** After a publish/close/start mutation the HTTP quiz read can be stale
   * (quizzes/:id is the source of question-state badges). Refresh the
   * affected quiz so the row badges, publish/close enable and the "on"
   * state label match what actually happened.
   */
  const loadQuiz = useCallback(async (quizId: string): Promise<ActionResult> => {
    try {
      const { quiz } = await quizzesApi.get(quizId);
      setQuizCatalog((prev) => [...prev.filter((q) => q.id !== quiz.id), quiz]);
      return ok;
    } catch (error) {
      return { ok: false, error, message: describeActionError(error) };
    }
  }, []);

  const startQuiz = useCallback(
    async (quizId: string) => {
      try {
        await socketRequest("quiz.start", { quizId });
        await loadQuiz(quizId);
        return ok;
      } catch (error) {
        return { ok: false as const, error, message: describeActionError(error) };
      }
    },
    [socketRequest, loadQuiz],
  );

  const publishQuestion = useCallback(
    async (questionId: string) => {
      try {
        const quizId = findQuizIdForQuestion(quizCatalog, questionId);
        await socketRequest("question.publish", { questionId });
        await loadQuiz(quizId);
        return ok;
      } catch (error) {
        return { ok: false as const, error, message: describeActionError(error) };
      }
    },
    [socketRequest, loadQuiz, quizCatalog],
  );

  const closeQuestion = useCallback(
    async (questionId: string) => {
      try {
        const quizId = findQuizIdForQuestion(quizCatalog, questionId);
        await socketRequest("question.close", { questionId });
        await loadQuiz(quizId);
        return ok;
      } catch (error) {
        return { ok: false as const, error, message: describeActionError(error) };
      }
    },
    [socketRequest, loadQuiz, quizCatalog],
  );

  const submitAnswer = useCallback(
    async (questionId: string, content: string) => {
      try {
        await socketRequest("quiz.answer", { questionId, content });
        return ok;
      } catch (error) {
        const code = error instanceof Error ? /^([A-Z_]+):/.exec(error.message)?.[1] : undefined;
        setState((prev) =>
          reduceLiveEvent(prev, {
            type: "local.answer-rejected",
            payload: { questionId, reason: code ?? "rejected" },
          }),
        );
        return { ok: false as const, error, message: describeActionError(error) };
      }
    },
    [socketRequest],
  );

  const createDoubt = useCallback(
    async (content: string, clientDoubtId?: string) => {
      try {
        await socketRequest("doubt.create", {
          content,
          ...(clientDoubtId ? { clientDoubtId } : {}),
        });
        return ok;
      } catch (error) {
        return { ok: false as const, error, message: describeActionError(error) };
      }
    },
    [socketRequest],
  );

  const resolveDoubt = useCallback(
    async (doubtId: string) => {
      try {
        await socketRequest("doubt.resolve", { doubtId });
        return ok;
      } catch (error) {
        return { ok: false as const, error, message: describeActionError(error) };
      }
    },
    [socketRequest],
  );

  const dismissDoubt = useCallback(
    async (doubtId: string) => {
      try {
        await socketRequest("doubt.dismiss", { doubtId });
        return ok;
      } catch (error) {
        return { ok: false as const, error, message: describeActionError(error) };
      }
    },
    [socketRequest],
  );

  const refreshDoubts = useCallback(async () => {
    try {
      await socketRequest("doubt.queue.list", {});
      return ok;
    } catch (error) {
      return { ok: false as const, error, message: describeActionError(error) };
    }
  }, [socketRequest]);

  const verifyConnection = useCallback(() => socketRef.current?.verifyAlive(), []);
  const leave = useCallback(() => socketRef.current?.send("session.leave"), []);

  const actions = useMemo(
    () => ({
      setSessionState,
      createQuiz,
      loadQuiz,
      startQuiz,
      publishQuestion,
      closeQuestion,
      submitAnswer,
      createDoubt,
      resolveDoubt,
      dismissDoubt,
      refreshDoubts,
    }),
    [
      setSessionState,
      createQuiz,
      loadQuiz,
      startQuiz,
      publishQuestion,
      closeQuestion,
      submitAnswer,
      createDoubt,
      resolveDoubt,
      dismissDoubt,
      refreshDoubts,
    ],
  );

  return {
    status,
    state,
    sessionName,
    roster,
    quizCatalog,
    loadError,
    sessionMissing,
    actions,
    verifyConnection,
    leave,
    refreshSessionState,
  };
}

export type { ProtocolErrorCode };
