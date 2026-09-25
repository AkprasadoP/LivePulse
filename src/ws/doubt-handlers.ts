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
  // COMMIT succeeded -> local broadcast (echoing requestId, like the other
  // mutating broadcasts) -> post-commit Redis notice.
  broadcast(deps, sessionId, doubtCreatedMessage(requestId, { sessionId, doubt: view }));
  deps.distributor?.publish({
    type: "doubt.created",
    sessionId,
    payload: { sessionId, doubt: view },
  });
}

/** doubt.resolve — TEACHER only; OPEN -> RESOLVED, atomic. */
export async function handleDoubtResolve(
  connection: Connection,
  payload: { doubtId: string },
  requestId: string,
  deps: HandlerDependencies,
): Promise<void> {
  await transitionDoubt(connection, payload.doubtId, "RESOLVED", requestId, deps);
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

  const transitionStarted = performance.now();
  const updated = await deps.doubtRepository.transitionStatus(doubtId, sessionId, to);
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

  if (to === "RESOLVED") {
    broadcast(
      deps,
      sessionId,
      doubtResolvedMessage(requestId, { sessionId, doubtId, status: to, resolvedAt }),
    );
    deps.distributor?.publish({
      type: "doubt.resolved",
      sessionId,
      payload: { sessionId, doubtId, status: to, resolvedAt },
    });
    return;
  }
  broadcast(
    deps,
    sessionId,
    doubtDismissedMessage(requestId, { sessionId, doubtId, status: to, resolvedAt }),
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
