import type { Connection } from "./connection.js";
import type { SessionRegistry } from "./session-registry.js";
import type { PrismaClient } from "@prisma/client";
import { SessionRepository } from "../modules/sessions/session.repository.js";
import { QuizRepository } from "../modules/quizzes/quiz.repository.js";
import { AnswerRepository } from "../modules/answers/answer.repository.js";
import { ParticipantRepository } from "../modules/participants/participant.repository.js";
import { DoubtRepository } from "../modules/doubts/doubt.repository.js";
import { NotFoundError, InvalidStateTransitionError } from "../shared/errors.js";
import { sessionJoinedMessage, sessionStateMessage } from "./protocol.js";
import { buildRecoverySnapshot, type RecoverySnapshot } from "./recovery.js";
import type { PresenceTracker } from "./presence.js";
import { timeOperation, type Metrics } from "../infrastructure/metrics/index.js";
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
import {
  handleDoubtCreate,
  handleDoubtResolve,
  handleDoubtDismiss,
  handleDoubtQueueList,
} from "./doubt-handlers.js";
import type { Distributor } from "./distribution.js";

/**
 * Per-instance handler context: the scoped logger plus Phase 7 metric handles.
 * Bundled so every handler (and the shared `send` funnel) can record
 * observations without threading a second parameter through every call site.
 */
export type HandlerLog = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
  metrics?: Metrics | undefined;
};

export interface HandlerDependencies {
  registry: SessionRegistry;
  sessionRepository: SessionRepository;
  quizRepository: QuizRepository;
  answerRepository: AnswerRepository;
  participantRepository: ParticipantRepository;
  /** Phase 6: the doubt queue (PostgreSQL is the queue's source of truth). */
  doubtRepository: DoubtRepository;
  /** Phase 5: recovery snapshots read PostgreSQL through the shared client. */
  prisma: PrismaClient;
  log: HandlerLog;
  /**
   * Phase 4 distribution (optional so unit-ish usages stay simple): used by
   * handlers ONLY after a successful PostgreSQL commit to fan the event out
   * to other instances. Never called before commit; never called on the
   * Redis receive path.
   */
  distributor?: Distributor;
  /** Phase 7: ephemeral presence (derived from the registry; never durability). */
  presenceTracker: PresenceTracker;
  /** Publish local presence + broadcast a snapshot to the session if it changed. */
  refreshPresence: (sessionId: string, except?: Connection) => void;
  /** Push the current aggregated presence snapshot to one connection. */
  sendPresenceSnapshot: (connection: Connection, sessionId: string) => void;
}

/** Serialize and send one envelope; failures are logged, never thrown. */
export function send(connection: Connection, message: ServerEnvelope, log: HandlerLog): void {
  if (connection.socket.readyState !== connection.socket.OPEN) return;
  connection.socket.send(JSON.stringify(message), (error) => {
    if (error) log.warn({ err: error.message }, "WebSocket send failed");
  });
  log.metrics?.wsMessagesSent.inc();
}

/** Send a protocol error and record it by its (bounded) code. */
export function sendProtocolError(
  connection: Connection,
  requestId: string | null,
  payload: ErrorPayload,
  log: HandlerLog,
): void {
  log.metrics?.wsProtocolErrors.inc({ code: payload.code });
  send(connection, errorMessage(requestId, payload), log);
}

/**
 * Deliver one envelope to every local connection joined to a session.
 * Shared by the quiz and doubt handlers: a broadcast is a per-instance,
 * in-memory fan-out; cross-instance delivery is Redis's job (ADR-005).
 */
export function broadcast(
  deps: HandlerDependencies,
  sessionId: string,
  message: ServerEnvelope,
): void {
  for (const target of deps.registry.getConnectionsForSession(sessionId)) {
    send(target, message, deps.log);
  }
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
  const started = performance.now();

  if (!isKnownClientEvent(type)) {
    deps.log.warn({ eventType: type }, "WebSocket protocol error: unsupported event");
    sendProtocolError(
      connection,
      requestId,
      {
        code: "UNSUPPORTED_EVENT",
        message: `Unsupported event type: ${type}`,
        details: null,
      },
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
    sendProtocolError(
      connection,
      requestId,
      {
        code,
        message,
        details: protocolIssueDetails(payloadResult.error),
      },
      deps.log,
    );
    return;
  }

  // Guard: participant-bound events need a bound participant...
  if (requiresParticipant(type)) {
    if (connection.participantId === null) {
      deps.log.warn({ eventType: type }, "WebSocket protocol error: participant required");
      sendProtocolError(
        connection,
        requestId,
        {
          code: "NOT_A_PARTICIPANT",
          message: "Join with a participant identity before sending this event",
          details: null,
        },
        deps.log,
      );
      return;
    }
    if (connection.joinedSessionId === null) {
      sendProtocolError(
        connection,
        requestId,
        { code: "NOT_JOINED", message: "Join a session first", details: null },
        deps.log,
      );
      return;
    }
  }
  // ...and teacher events additionally need the TEACHER role.
  const teacherEvents = [
    "quiz.start",
    "question.publish",
    "question.close",
    "doubt.resolve",
    "doubt.dismiss",
  ] as const;
  if (
    (teacherEvents as readonly string[]).includes(type) &&
    connection.participantRole !== "TEACHER"
  ) {
    deps.log.warn({ eventType: type }, "WebSocket protocol error: teacher required");
    sendProtocolError(
      connection,
      requestId,
      {
        code: "TEACHER_REQUIRED",
        message: "This event requires a TEACHER participant",
        details: null,
      },
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
      | { content: string; clientDoubtId?: string }
      | { doubtId: string }
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
      case "doubt.create":
        await handleDoubtCreate(
          connection,
          payload as { content: string; clientDoubtId?: string },
          requestId,
          deps,
        );
        return;
      case "doubt.resolve":
        await handleDoubtResolve(connection, payload as { doubtId: string }, requestId, deps);
        return;
      case "doubt.dismiss":
        await handleDoubtDismiss(connection, payload as { doubtId: string }, requestId, deps);
        return;
      case "doubt.queue.list":
        await handleDoubtQueueList(connection, requestId, deps);
        return;
    }
  } catch (error) {
    handleError(connection, error, requestId, type, deps);
  } finally {
    deps.log.metrics?.wsHandlerDuration.observe(
      { event: type },
      (performance.now() - started) / 1000,
    );
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
    if (resource === "doubt") {
      return { code: "DOUBT_NOT_FOUND", message: "Doubt does not exist", details: null };
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
    sendProtocolError(connection, requestId, mapped, deps.log);
    return;
  }
  // Genuine server fault: log fully server-side, expose nothing.
  deps.log.error({ err: error, eventType, requestId }, "WebSocket handler internal error");
  sendProtocolError(
    connection,
    requestId,
    { code: "INTERNAL_ERROR", message: "Internal server error", details: null },
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
  const session = await timeOperation(deps.log.metrics, "session.join", () =>
    deps.sessionRepository.getById(payload.sessionId),
  );
  if (!session) {
    throw new NotFoundError("Session", payload.sessionId);
  }

  // Re-joining the SAME session is refused so a buggy client loop cannot
  // spin the registry (ADR-003). Switching sessions remains leave-then-join.
  if (connection.joinedSessionId === payload.sessionId) {
    sendProtocolError(
      connection,
      requestId,
      {
        code: "SESSION_ALREADY_JOINED",
        message: "Connection is already joined to this session",
        details: null,
      },
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
    deps.log.metrics?.sessionLeaves.inc({ reason: "switch" });
  }
  deps.log.metrics?.sessionJoins.inc({ role: participant?.role ?? "viewer" });
  deps.log.info(
    { sessionId: payload.sessionId, participantId: participant?.id ?? null },
    "WebSocket session joined",
  );

  // Phase 5 recovery snapshot (ADR-006): assembled from PostgreSQL on EVERY
  // join (first join and reconnect are the same code path — reconnect is not
  // a distinct server-side concept). Failure is non-fatal by design: a
  // broken recovery path degrades to `recovery: null`, it never breaks the
  // join itself.
  let recovery: RecoverySnapshot | null = null;
  const recoveryStarted = performance.now();
  try {
    recovery = await buildRecoverySnapshot(
      {
        prisma: deps.prisma,
        answerRepository: deps.answerRepository,
        doubtRepository: deps.doubtRepository,
      },
      payload.sessionId,
      participant?.id ?? null,
    );
    deps.log.metrics?.recoveryBuilds.inc({ result: "ok" });
    if (recovery?.doubts.truncated === true) deps.log.metrics?.recoveryTruncated.inc();
    deps.log.info(
      {
        sessionId: payload.sessionId,
        participantId: participant?.id ?? null,
        recovered: recovery !== null && (recovery.question !== null || recovery.ownAnswer !== null),
      },
      "Recovery snapshot built",
    );
  } catch (error) {
    deps.log.metrics?.recoveryBuilds.inc({ result: "error" });
    deps.log.warn(
      { err: error instanceof Error ? error.message : String(error), sessionId: payload.sessionId },
      "Recovery snapshot failed (joining continues without recovery data)",
    );
  } finally {
    deps.log.metrics?.recoveryDuration.observe((performance.now() - recoveryStarted) / 1000);
  }

  send(
    connection,
    sessionJoinedMessage(requestId, {
      sessionId: session.id,
      state: session.state,
      participantId: participant?.id ?? null,
      role: participant?.role ?? null,
      displayName: participant?.displayName ?? null,
      recovery,
    }),
    deps.log,
  );
  send(connection, sessionStateMessage(requestId, serializeSessionState(session)), deps.log);

  // Phase 7 presence, after session.joined/session.state (lifecycle order:
  // registry updated -> presence published -> snapshot emitted). The joining
  // connection gets its own snapshot; others get one only if the aggregate
  // changed. A presence failure can never break the join.
  deps.sendPresenceSnapshot(connection, payload.sessionId);
  deps.refreshPresence(payload.sessionId, connection);
  if (previousSessionId !== null) deps.refreshPresence(previousSessionId);
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
    deps.log.metrics?.sessionLeaves.inc({ reason: "leave" });
  }
  // The participant binding is session-scoped: leaving detaches it too.
  connection.participantId = null;
  connection.participantRole = null;
  connection.displayName = null;

  send(connection, sessionStateMessage(requestId, detachedStateSnapshot()), deps.log);
  if (previousSessionId !== null) deps.refreshPresence(previousSessionId);
}
