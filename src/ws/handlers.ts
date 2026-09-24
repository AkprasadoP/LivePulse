import type { Connection } from "./connection.js";
import type { SessionRegistry } from "./session-registry.js";
import { SessionRepository } from "../modules/sessions/session.repository.js";
import { QuizRepository } from "../modules/quizzes/quiz.repository.js";
import { AnswerRepository } from "../modules/answers/answer.repository.js";
import { ParticipantRepository } from "../modules/participants/participant.repository.js";
import { NotFoundError, InvalidStateTransitionError } from "../shared/errors.js";
import { sessionJoinedMessage, sessionStateMessage } from "./protocol.js";
import {
  clientEventSchemas,
  errorMessage,
  isKnownClientEvent,
  protocolIssueDetails,
  requiresParticipant,
  type ErrorPayload,
  type ServerEnvelope,
} from "./protocol.js";
import {
  handleQuizStart,
  handleQuestionPublish,
  handleQuestionClose,
  handleQuizAnswer,
} from "./quiz-handlers.js";

export type HandlerLog = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export interface HandlerDependencies {
  registry: SessionRegistry;
  sessionRepository: SessionRepository;
  quizRepository: QuizRepository;
  answerRepository: AnswerRepository;
  participantRepository: ParticipantRepository;
  log: HandlerLog;
}

/** Serialize and send one envelope; failures are logged, never thrown. */
export function send(connection: Connection, message: ServerEnvelope, log: HandlerLog): void {
  if (connection.socket.readyState !== connection.socket.OPEN) return;
  connection.socket.send(JSON.stringify(message), (error) => {
    if (error) log.warn({ err: error.message }, "WebSocket send failed");
  });
}

export function serializeSessionState(session: {
  id: string;
  state: "CREATED" | "LIVE" | "ENDED";
  startedAt: Date | null;
  endedAt: Date | null;
  updatedAt: Date;
}) {
  return {
    sessionId: session.id,
    state: session.state,
    startedAt: session.startedAt?.toISOString() ?? null,
    endedAt: session.endedAt?.toISOString() ?? null,
    updatedAt: session.updatedAt.toISOString(),
  };
}

export function detachedStateSnapshot() {
  return {
    sessionId: null,
    state: "ENDED" as const,
    startedAt: null,
    endedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Handle one validated-in-shape client envelope. Every branch responds via
 * the wire protocol — handlers never throw past this function.
 */
export async function handleClientEnvelope(
  connection: Connection,
  envelope: { type: string; requestId: string; payload: Record<string, unknown> },
  deps: HandlerDependencies,
): Promise<void> {
  const { requestId, type } = envelope;

  if (!isKnownClientEvent(type)) {
    deps.log.warn({ eventType: type }, "WebSocket protocol error: unsupported event");
    send(
      connection,
      errorMessage(requestId, {
        code: "UNSUPPORTED_EVENT",
        message: `Unsupported event type: ${type}`,
        details: null,
      }),
      deps.log,
    );
    return;
  }

  const payloadResult = clientEventSchemas[type].safeParse(envelope.payload);
  if (!payloadResult.success) {
    // INVALID_SESSION_ID only when the sole failing field is payload.sessionId;
    // every other payload problem is INVALID_REQUEST (keeps codes precise).
    const sessionIdInvalidOnly =
      type === "session.join" &&
      payloadResult.error.issues.length > 0 &&
      payloadResult.error.issues.every((issue) => issue.path.join(".") === "sessionId");
    const code = sessionIdInvalidOnly ? "INVALID_SESSION_ID" : "INVALID_REQUEST";
    const message = sessionIdInvalidOnly ? "sessionId must be a UUID" : "Invalid request payload";
    deps.log.warn(
      { eventType: type, code, issues: payloadResult.error.issues.length },
      "WebSocket protocol error: invalid payload",
    );
    send(
      connection,
      errorMessage(requestId, {
        code,
        message,
        details: protocolIssueDetails(payloadResult.error),
      }),
      deps.log,
    );
    return;
  }

  // Guard: participant-bound events need a bound participant...
  if (requiresParticipant(type)) {
    if (connection.participantId === null) {
      deps.log.warn({ eventType: type }, "WebSocket protocol error: participant required");
      send(
        connection,
        errorMessage(requestId, {
          code: "NOT_A_PARTICIPANT",
          message: "Join with a participant identity before sending this event",
          details: null,
        }),
        deps.log,
      );
      return;
    }
    if (connection.joinedSessionId === null) {
      send(
        connection,
        errorMessage(requestId, {
          code: "NOT_JOINED",
          message: "Join a session first",
          details: null,
        }),
        deps.log,
      );
      return;
    }
  }
  // ...and teacher events additionally need the TEACHER role.
  const teacherEvents = ["quiz.start", "question.publish", "question.close"] as const;
  if (
    (teacherEvents as readonly string[]).includes(type) &&
    connection.participantRole !== "TEACHER"
  ) {
    deps.log.warn({ eventType: type }, "WebSocket protocol error: teacher required");
    send(
      connection,
      errorMessage(requestId, {
        code: "TEACHER_REQUIRED",
        message: "This event requires a TEACHER participant",
        details: null,
      }),
      deps.log,
    );
    return;
  }

  try {
    // The dispatch table shares one payload type; each event's schema already
    // validated its own payload, so the per-case cast is safe.
    const payload = payloadResult.data as
      | { sessionId: string; participant?: { displayName: string } }
      | { quizId: string }
      | { questionId: string }
      | { questionId: string; content: string }
      | Record<string, never>;
    switch (type) {
      case "session.join":
        await handleSessionJoin(
          connection,
          payload as { sessionId: string; participant?: { displayName: string } },
          requestId,
          deps,
        );
        return;
      case "session.leave":
        handleSessionLeave(connection, requestId, deps);
        return;
      case "quiz.start":
        await handleQuizStart(connection, payload as { quizId: string }, requestId, deps);
        return;
      case "question.publish":
        await handleQuestionPublish(connection, payload as { questionId: string }, requestId, deps);
        return;
      case "question.close":
        await handleQuestionClose(connection, payload as { questionId: string }, requestId, deps);
        return;
      case "quiz.answer":
        await handleQuizAnswer(
          connection,
          payload as { questionId: string; content: string },
          requestId,
          deps,
        );
        return;
    }
  } catch (error) {
    handleError(connection, error, requestId, type, deps);
  }
}

function protocolErrorFor(error: unknown): ErrorPayload | null {
  if (error instanceof NotFoundError) {
    const resource = error.resource.toLowerCase();
    if (resource === "quiz") {
      return { code: "QUIZ_NOT_FOUND", message: "Quiz does not exist", details: null };
    }
    if (resource === "question") {
      return { code: "QUESTION_NOT_FOUND", message: "Question does not exist", details: null };
    }
    return { code: "SESSION_NOT_FOUND", message: "Session does not exist", details: null };
  }
  if (error instanceof InvalidStateTransitionError) {
    return {
      code: "INVALID_STATE_TRANSITION",
      message: error.message,
      details: null,
    };
  }
  return null;
}

export function handleError(
  connection: Connection,
  error: unknown,
  requestId: string,
  eventType: string,
  deps: HandlerDependencies,
): void {
  const mapped = protocolErrorFor(error);
  if (mapped) {
    send(connection, errorMessage(requestId, mapped), deps.log);
    return;
  }
  // Genuine server fault: log fully server-side, expose nothing.
  deps.log.error({ err: error, eventType, requestId }, "WebSocket handler internal error");
  send(
    connection,
    errorMessage(requestId, {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      details: null,
    }),
    deps.log,
  );
}

// ---------------------------------------------------------------------------
// session.join / session.leave
// ---------------------------------------------------------------------------

async function handleSessionJoin(
  connection: Connection,
  payload: { sessionId: string; participant?: { displayName: string } },
  requestId: string,
  deps: HandlerDependencies,
): Promise<void> {
  // PostgreSQL is the only source of session state: read, never mutate the
  // session state machine.
  const session = await deps.sessionRepository.getById(payload.sessionId);
  if (!session) {
    throw new NotFoundError("Session", payload.sessionId);
  }

  // Re-joining the SAME session is refused so a buggy client loop cannot
  // spin the registry (ADR-003). Switching sessions remains leave-then-join.
  if (connection.joinedSessionId === payload.sessionId) {
    send(
      connection,
      errorMessage(requestId, {
        code: "SESSION_ALREADY_JOINED",
        message: "Connection is already joined to this session",
        details: null,
      }),
      deps.log,
    );
    return;
  }

  // Identity seam (Phase 3): bind (or rebind) the participant atomically.
  // A join without `participant` stays view-only (Phase 2 compatibility).
  let participant: { id: string; role: "TEACHER" | "STUDENT"; displayName: string } | null = null;
  if (payload.participant) {
    deps.registry.leaveSession(connection);
    const found = await deps.participantRepository.findOrCreate(
      payload.sessionId,
      payload.participant.displayName,
    );
    connection.participantId = found.participant.id;
    connection.participantRole = found.participant.role;
    connection.displayName = payload.participant.displayName;
    participant = {
      id: found.participant.id,
      role: found.participant.role,
      displayName: payload.participant.displayName,
    };
  } else {
    deps.registry.leaveSession(connection);
  }

  const previousSessionId = deps.registry.joinSession(connection, payload.sessionId);
  if (previousSessionId) {
    deps.log.info({ previousSessionId }, "WebSocket session left (switch)");
  }
  deps.log.info(
    { sessionId: payload.sessionId, participantId: participant?.id ?? null },
    "WebSocket session joined",
  );

  send(
    connection,
    sessionJoinedMessage(requestId, {
      sessionId: session.id,
      state: session.state,
      participantId: participant?.id ?? null,
      role: participant?.role ?? null,
      displayName: participant?.displayName ?? null,
    }),
    deps.log,
  );
  send(connection, sessionStateMessage(requestId, serializeSessionState(session)), deps.log);
}

function handleSessionLeave(
  connection: Connection,
  requestId: string,
  deps: HandlerDependencies,
): void {
  // Idempotent: leaving while not joined still acks with a detached snapshot.
  const previousSessionId = deps.registry.leaveSession(connection);
  if (previousSessionId) {
    deps.log.info({ sessionId: previousSessionId }, "WebSocket session left");
  }
  // The participant binding is session-scoped: leaving detaches it too.
  connection.participantId = null;
  connection.participantRole = null;
  connection.displayName = null;

  send(connection, sessionStateMessage(requestId, detachedStateSnapshot()), deps.log);
}
