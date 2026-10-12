import type { Connection } from "./connection.js";
import type { HandlerDependencies } from "./handlers.js";
import { send, broadcast, sendProtocolError } from "./handlers.js";
import { NotFoundError } from "../shared/errors.js";
import {
  doubtCreatedMessage,
  doubtResolvedMessage,
  doubtDismissedMessage,
  doubtQueueUpdatedMessage,
  type DoubtView,
} from "./protocol.js";
import type { Doubt } from "@prisma/client";
import type { DoubtWithAuthor } from "../modules/doubts/doubt.repository.js";
import { DOUBT_SNAPSHOT_LIMIT } from "./recovery.js";

/**
 * Phase 6 doubt queue handlers (ADR-007).
 *
 * PostgreSQL is the queue's source of truth; the ordering authority is the
 * server-assigned `enqueueSeq`. The flow for every mutation follows the Phase
 * 4 discipline: validate -> PostgreSQL transaction -> COMMIT -> local
 * broadcast -> Redis notice. Redis failure can never roll back a commit.
 *
 * Ordering is never derived from frame arrival: `doubt.created` carries the
 * canonical `enqueueSeq`, and clients sort by (priority DESC, enqueueSeq ASC).
 */

function toDoubtView(doubt: Doubt, displayName: string): DoubtView {
  return {
    doubtId: doubt.id,
    participantId: doubt.participantId,
    displayName,
    content: doubt.content,
    priority: doubt.priority,
    enqueueSeq: doubt.enqueueSeq,
    status: doubt.status,
    createdAt: doubt.createdAt.toISOString(),
    explanation: doubt.explanation ?? null,
  };
}

function toDoubtViewWithAuthor(doubt: DoubtWithAuthor): DoubtView {
  return toDoubtView(doubt, doubt.participant.user.displayName);
}

/** doubt.create — any bound participant; session must be LIVE. */
export async function handleDoubtCreate(
  connection: Connection,
  payload: { content: string; clientDoubtId?: string },
  requestId: string,
  deps: HandlerDependencies,
): Promise<void> {
  const sessionId = connection.joinedSessionId;
  const participantId = connection.participantId;
  if (sessionId === null || participantId === null) return;

  const createStarted = performance.now();
  const result = await deps.doubtRepository.create({
    sessionId,
    participantId,
    content: payload.content,
    clientDoubtId: payload.clientDoubtId,
  });
  deps.log.metrics?.doubtOperationDuration.observe(
    { operation: "create" },
    (performance.now() - createStarted) / 1000,
  );

  if (result.outcome === "session_not_found") {
    throw new NotFoundError("Session", sessionId);
  }
  if (result.outcome === "not_live") {
    sendProtocolError(
      connection,
      requestId,
      {
        code: "SESSION_NOT_LIVE",
        message: "Raise doubts while the session is LIVE",
        details: null,
      },
      deps.log,
    );
    return;
  }

  const view = toDoubtView(result.doubt, connection.displayName ?? "");
  deps.log.metrics?.doubtCreated.inc({
    result: result.outcome === "duplicate" ? "duplicate" : "created",
  });

  // Idempotent retry: re-send the stored doubt privately and do NOT broadcast.
  // A retry is not a second enqueue (same as the Phase 3 answer replay).
  if (result.outcome === "duplicate") {
    deps.log.info(
      { sessionId, doubtId: result.doubt.id, participantId },
      "WebSocket duplicate doubt replay",
    );
    send(connection, doubtCreatedMessage(requestId, { sessionId, doubt: view }), deps.log);
    return;
  }

  deps.log.info(
    { sessionId, doubtId: result.doubt.id, enqueueSeq: result.doubt.enqueueSeq },
    "WebSocket doubt created",
  );
  // Private response to the creator (correlated by requestId)
  send(connection, doubtCreatedMessage(requestId, { sessionId, doubt: view }), deps.log);
  // Broadcast to session (server-initiated, requestId = null)
  broadcast(deps, sessionId, doubtCreatedMessage(null, { sessionId, doubt: view }));
  deps.distributor?.publish({
    type: "doubt.created",
    sessionId,
    payload: { sessionId, doubt: view },
  });
}

/** doubt.resolve — TEACHER only; OPEN -> RESOLVED, atomic. Requires explanation. */
export async function handleDoubtResolve(
  connection: Connection,
  payload: { doubtId: string; explanation: string },
  requestId: string,
  deps: HandlerDependencies,
): Promise<void> {
  await transitionDoubt(
    connection,
    payload.doubtId,
    "RESOLVED",
    requestId,
    deps,
    payload.explanation,
  );
}

/** doubt.dismiss — TEACHER only; OPEN -> DISMISSED, atomic. */
export async function handleDoubtDismiss(
  connection: Connection,
  payload: { doubtId: string },
  requestId: string,
  deps: HandlerDependencies,
): Promise<void> {
  await transitionDoubt(connection, payload.doubtId, "DISMISSED", requestId, deps);
}

async function transitionDoubt(
  connection: Connection,
  doubtId: string,
  to: "RESOLVED" | "DISMISSED",
  requestId: string,
  deps: HandlerDependencies,
  explanation?: string,
): Promise<void> {
  const sessionId = connection.joinedSessionId;
  if (sessionId === null) return;

  // Ownership check first so unknown and cross-session doubts are
  // indistinguishable (they leak nothing). The transition itself is still the
  // atomic, conditional operation below.
  const doubt = await deps.doubtRepository.getById(doubtId);
  if (!doubt || doubt.sessionId !== sessionId) {
    throw new NotFoundError("Doubt", doubtId);
  }

  // Teacher check must happen before explanation validation to preserve
  // the existing error codes (TEACHER_REQUIRED, DOUBT_NOT_FOUND).
  if (connection.participantRole !== "TEACHER") {
    sendProtocolError(
      connection,
      requestId,
      {
        code: "TEACHER_REQUIRED",
        message: "Only the session teacher can resolve or dismiss doubts",
        details: null,
      },
      deps.log,
    );
    return;
  }

  // Validate explanation for RESOLVED
  if (to === "RESOLVED") {
    if (!explanation || explanation.trim().length === 0) {
      sendProtocolError(
        connection,
        requestId,
        {
          code: "INVALID_REQUEST",
          message: "An explanation is required to resolve a doubt",
          details: {
            issues: [{ path: "payload.explanation", message: "Explanation cannot be empty" }],
          },
        },
        deps.log,
      );
      return;
    }
  }

  const transitionStarted = performance.now();
  const updated = await deps.doubtRepository.transitionStatus(doubtId, sessionId, to, explanation);
  deps.log.metrics?.doubtOperationDuration.observe(
    { operation: to === "RESOLVED" ? "resolve" : "dismiss" },
    (performance.now() - transitionStarted) / 1000,
  );
  if (!updated) {
    // Lost the race (already RESOLVED/DISMISSED) — or it was completed
    // concurrently. Exactly one transition can succeed by construction.
    sendProtocolError(
      connection,
      requestId,
      {
        code: "DOUBT_NOT_OPEN",
        message: "Doubt is no longer open",
        details: null,
      },
      deps.log,
    );
    return;
  }

  deps.log.metrics?.doubtTransitions.inc({ status: to });

  const resolvedAt = (updated.resolvedAt ?? new Date()).toISOString();
  deps.log.info({ sessionId, doubtId, status: to }, "WebSocket doubt transitioned");

  // Private response to the requesting teacher (correlated by requestId)
  if (to === "RESOLVED") {
    send(
      connection,
      doubtResolvedMessage(requestId, {
        sessionId,
        doubtId,
        status: to,
        resolvedAt,
        explanation: explanation!,
      }),
      deps.log,
    );
    // Broadcast to session (server-initiated, requestId = null)
    broadcast(
      deps,
      sessionId,
      doubtResolvedMessage(null, {
        sessionId,
        doubtId,
        status: to,
        resolvedAt,
        explanation: explanation!,
      }),
    );
    deps.distributor?.publish({
      type: "doubt.resolved",
      sessionId,
      payload: { sessionId, doubtId, status: to, resolvedAt, explanation: explanation! },
    });
    return;
  }
  // DISMISSED
  send(
    connection,
    doubtDismissedMessage(requestId, { sessionId, doubtId, status: to, resolvedAt }),
    deps.log,
  );
  broadcast(
    deps,
    sessionId,
    doubtDismissedMessage(null, { sessionId, doubtId, status: to, resolvedAt }),
  );
  deps.distributor?.publish({
    type: "doubt.dismissed",
    sessionId,
    payload: { sessionId, doubtId, status: to, resolvedAt },
  });
}

/**
 * doubt.queue.list — private, authoritative re-read of the OPEN queue.
 *
 * This is a convenience, NOT a correctness requirement: the durable queue is
 * PostgreSQL, recovery supplies it on join, and the granular events keep it
 * current. If this response is lost, nothing is corrupted (Phase 5 contract).
 */
export async function handleDoubtQueueList(
  connection: Connection,
  requestId: string,
  deps: HandlerDependencies,
): Promise<void> {
  const sessionId = connection.joinedSessionId;
  if (sessionId === null) return;

  const doubts = await deps.doubtRepository.listOpen(sessionId, DOUBT_SNAPSHOT_LIMIT);
  const total = await deps.doubtRepository.countOpen(sessionId);
  send(
    connection,
    doubtQueueUpdatedMessage(requestId, {
      sessionId,
      doubts: doubts.map(toDoubtViewWithAuthor),
      truncated: total > doubts.length,
    }),
    deps.log,
  );
}
