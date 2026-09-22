import type { PrismaClient } from "@prisma/client";
import type { Session } from "@prisma/client";
import type { Connection } from "./connection.js";
import type { SessionRegistry } from "./session-registry.js";
import { SessionRepository } from "../modules/sessions/session.repository.js";
import { NotFoundError } from "../shared/errors.js";
import {
  clientEventSchemas,
  clientEnvelopeSchema,
  errorMessage,
  isKnownClientEvent,
  protocolIssueDetails,
  sessionJoinedMessage,
  sessionStateMessage,
  type ServerEnvelope,
} from "./protocol.js";

export interface HandlerDependencies {
  registry: SessionRegistry;
  sessionRepository: SessionRepository;
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
}

/**
 * Serialize and send one envelope, or log if the socket died mid-flight.
 * Send failures never crash the process.
 */
function send(
  connection: Connection,
  message: ServerEnvelope,
  log: HandlerDependencies["log"],
): void {
  if (connection.socket.readyState !== connection.socket.OPEN) return;
  connection.socket.send(JSON.stringify(message), (error) => {
    if (error) log.warn({ err: error.message }, "WebSocket send failed");
  });
}

function serializeSessionState(session: Session, sessionId: string | null) {
  return {
    sessionId,
    state: session.state,
    startedAt: session.startedAt?.toISOString() ?? null,
    endedAt: session.endedAt?.toISOString() ?? null,
    updatedAt: session.updatedAt.toISOString(),
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

  try {
    switch (type) {
      case "session.join":
        await handleSessionJoin(connection, payloadResult.data.sessionId, requestId, deps);
        return;
      case "session.leave":
        handleSessionLeave(connection, requestId, deps);
        return;
    }
  } catch (error) {
    // Known, expected domain failures map to protocol errors...
    if (error instanceof NotFoundError) {
      send(
        connection,
        errorMessage(requestId, {
          code: "SESSION_NOT_FOUND",
          message: "Session does not exist",
          details: null,
        }),
        deps.log,
      );
      return;
    }
    // ...anything else is a genuine server fault: log full details internally,
    // expose nothing (AGENT.md: explicit failure handling without leaking internals).
    deps.log.error({ err: error, eventType: type, requestId }, "WebSocket handler internal error");
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
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleSessionJoin(
  connection: Connection,
  sessionId: string,
  requestId: string,
  deps: HandlerDependencies,
): Promise<void> {
  // PostgreSQL is the only source of session state: read, never mutate,
  // never duplicate the state machine (AGENT.md Phase 2 constraint).
  const session = await deps.sessionRepository.getById(sessionId);
  if (!session) {
    throw new NotFoundError("Session", sessionId);
  }

  // Deterministic join-switch (ADR-003): joining another session while joined
  // is leave(A) then join(B). Re-joining the SAME session is refused so a
  // buggy client loop cannot spin the registry.
  if (connection.joinedSessionId === sessionId) {
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

  const previousSessionId = deps.registry.joinSession(connection, sessionId);
  if (previousSessionId) {
    deps.log.info({ previousSessionId }, "WebSocket session left (switch)");
  }
  deps.log.info({ sessionId }, "WebSocket session joined");

  send(
    connection,
    sessionJoinedMessage(requestId, { sessionId: session.id, state: session.state }),
    deps.log,
  );
  send(
    connection,
    sessionStateMessage(requestId, serializeSessionState(session, session.id)),
    deps.log,
  );
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

  // The authoritative snapshot the client should show after detaching: no
  // session. Sending ENDED + sessionId:null (not a real session row) keeps
  // the payload shape total — the null session id marks detachment.
  send(
    connection,
    sessionStateMessage(requestId, {
      sessionId: null,
      state: "ENDED",
      startedAt: null,
      endedAt: null,
      updatedAt: new Date().toISOString(),
    }),
    deps.log,
  );
}
