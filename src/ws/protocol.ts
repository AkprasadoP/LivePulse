import { z } from "zod";

/**
 * WebSocket wire protocol — the single source of truth for every frame.
 * Documented externally in docs/api/websocket-protocol.md; keep both in sync.
 *
 * Two-stage validation:
 *  1. Envelope: is this a client request at all? (extractable requestId)
 *  2. Event: is `type` known and does `payload` match its schema?
 *
 * The split lets us reject unparseable frames (INVALID_MESSAGE) differently
 * from recognizable requests with bad shapes (INVALID_REQUEST).
 */

/** Server → client envelope. */
export interface ServerEnvelope<T extends object = Record<string, unknown>> {
  type: string;
  requestId: string | null;
  payload: T;
}

export const requestIdSchema = z.string().min(1).max(128);

/**
 * Client envelope schema, deliberately payload-agnostic.
 * Payload validation happens per-event after `type` dispatch, so the same
 * envelope schema serves every client event.
 */
export const clientEnvelopeSchema = z.object({
  type: z.string().min(1).max(64),
  requestId: requestIdSchema,
  payload: z.record(z.string(), z.unknown()),
});

export type ClientEnvelope = z.infer<typeof clientEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Client events
// ---------------------------------------------------------------------------

export const sessionJoinSchema = z.strictObject({
  sessionId: z.uuid(),
  /**
   * Development identity seam (Phase 3): the participant to bind to this
   * connection. NOT authentication — displayName is the temporary
   * credential; see docs/decisions/002 and the protocol doc identity section.
   */
  participant: z
    .strictObject({
      displayName: z.string().min(1).max(100),
    })
    .optional(),
});

export const sessionLeaveSchema = z.strictObject({});

/**
 * Phase 10.5: bind the connection to an authenticated user. The token
 * travels in a WS frame (never in the upgrade URL — Nginx access logs
 * record upgrade lines, never frame bodies). Deliberately minimal: the
 * ONLY accepted identity claim is an access token. userId / participantId /
 * role are not accepted anywhere — strictObject rejects them outright.
 */
export const authAuthenticateSchema = z.strictObject({
  token: z.string().min(1).max(2048),
});

export const quizStartSchema = z.strictObject({
  quizId: z.uuid(),
});

export const questionPublishSchema = z.strictObject({
  questionId: z.uuid(),
});

export const questionCloseSchema = z.strictObject({
  questionId: z.uuid(),
});

export const quizAnswerSchema = z.strictObject({
  questionId: z.uuid(),
  content: z.string().min(1).max(2_000),
});

// ---- Phase 6: doubt queue -------------------------------------------------
// enqueueSeq and priority are deliberately absent from every client schema:
// the server owns ordering, clients never set it (ADR-007).

export const doubtCreateSchema = z.strictObject({
  content: z.string().min(1).max(1_000),
  /**
   * Optional idempotency key: a retried create (e.g. after a reconnect) with
   * the same key resolves to the existing doubt instead of enqueuing a second.
   */
  clientDoubtId: z.string().min(1).max(64).optional(),
});

export const doubtResolveSchema = z.strictObject({ doubtId: z.uuid() });
export const doubtDismissSchema = z.strictObject({ doubtId: z.uuid() });
export const doubtQueueListSchema = z.strictObject({});

/** Client event name -> its payload schema. The dispatch table for handlers. */
export const clientEventSchemas = {
  "auth.authenticate": authAuthenticateSchema,
  "session.join": sessionJoinSchema,
  "session.leave": sessionLeaveSchema,
  "quiz.start": quizStartSchema,
  "question.publish": questionPublishSchema,
  "question.close": questionCloseSchema,
  "quiz.answer": quizAnswerSchema,
  "doubt.create": doubtCreateSchema,
  "doubt.resolve": doubtResolveSchema,
  "doubt.dismiss": doubtDismissSchema,
  "doubt.queue.list": doubtQueueListSchema,
} as const;

export type ClientEventType = keyof typeof clientEventSchemas;

/** Is this `type` a known client event? (Valid string, but maybe not supported.) */
export function isKnownClientEvent(type: string): type is ClientEventType {
  return type in clientEventSchemas;
}

/** Events that require a bound participant (anything but bare join/leave). */
const PARTICIPANT_REQUIRED_EVENTS: ReadonlySet<ClientEventType> = new Set([
  "quiz.start",
  "question.publish",
  "question.close",
  "quiz.answer",
  "doubt.create",
  "doubt.resolve",
  "doubt.dismiss",
]);

export function requiresParticipant(type: ClientEventType): boolean {
  return PARTICIPANT_REQUIRED_EVENTS.has(type);
}

// ---------------------------------------------------------------------------
// Server events
// ---------------------------------------------------------------------------

export const leaderboardEntrySchema = z.object({
  participantId: z.uuid(),
  displayName: z.string(),
  correctCount: z.number().int(),
  isWinner: z.boolean(),
});

/**
 * Public representation of one doubt, shared by `doubt.created`, the
 * `doubt.queue.updated` snapshot and the Phase 5 recovery snapshot — so a
 * doubt has exactly one wire shape everywhere. `enqueueSeq` is the ordering
 * authority; `priority` is server-controlled (bump deferred).
 */
export const doubtViewSchema = z.object({
  doubtId: z.uuid(),
  participantId: z.uuid(),
  displayName: z.string(),
  content: z.string(),
  priority: z.number().int(),
  enqueueSeq: z.number().int(),
  status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]),
  createdAt: z.string().datetime(),
});
export type DoubtView = z.infer<typeof doubtViewSchema>;

/**
 * Phase 5 recovery snapshot — one entry per quiz of the session.
 * Distinct from quizStartedPayloadSchema: a snapshot describes persisted
 * state (id + state + timestamps), not an event that just happened.
 */
export const recoveryQuizSchema = z.object({
  quizId: z.uuid(),
  state: z.enum(["DRAFT", "ACTIVE", "COMPLETED"]),
  startedAt: z.string().datetime().nullable(),
});

/** The CURRENT published/closed question (never DRAFT), or null. */
export const recoveryQuestionSchema = z.object({
  quizId: z.uuid(),
  questionId: z.uuid(),
  position: z.number().int(),
  prompt: z.string(),
  /** Absent from student-visible payloads; always null over the wire. */
  firstCorrectWins: z.boolean(),
  state: z.enum(["PUBLISHED", "CLOSED"]),
  /** true iff state === "PUBLISHED" (mirrors question.published semantics). */
  acceptingAnswers: z.boolean(),
});

/** The bound participant's stored attempt-1 verdict, or null. */
export const recoveryOwnAnswerSchema = z.object({
  questionId: z.uuid(),
  content: z.string(),
  isCorrect: z.boolean().nullable(),
  isWinner: z.boolean(),
  attemptNumber: z.number().int(),
  submittedAt: z.string().datetime(),
});

/**
 * Phase 5 session recovery snapshot (ADR-006): the authoritative state a
 * reconnecting client needs, read from PostgreSQL at join time. NOT a
 * replay of missed events — the snapshot says what IS, not what changed.
 * `null` when the session has no quizzes yet.
 */
export const recoverySnapshotSchema = z.object({
  quizzes: z.array(recoveryQuizSchema),
  question: recoveryQuestionSchema.nullable(),
  ownAnswer: recoveryOwnAnswerSchema.nullable(),
  standings: z.array(leaderboardEntrySchema),
  /**
   * Phase 6: the session's OPEN doubt queue in canonical order, capped as a
   * payload bound (never a capacity limit — PostgreSQL keeps every row).
   * `truncated` is true when OPEN doubts exist beyond the cap.
   */
  doubts: z.object({
    open: z.array(doubtViewSchema),
    truncated: z.boolean(),
  }),
});

export const sessionJoinedPayloadSchema = z.object({
  sessionId: z.uuid(),
  state: z.enum(["CREATED", "LIVE", "ENDED"]),
  /** Null for view-only joins (no participant in the join payload). */
  participantId: z.uuid().nullable(),
  role: z.enum(["TEACHER", "STUDENT"]).nullable(),
  displayName: z.string().nullable(),
  /**
   * Phase 5: authoritative snapshot for reconnecting clients. Always present
   * on the payload; null only when the session has no quizzes at all.
   */
  recovery: recoverySnapshotSchema.nullable(),
});

export const sessionStatePayloadSchema = z.object({
  /** The session the connection is now associated with, or null when detached. */
  sessionId: z.uuid().nullable(),
  state: z.enum(["CREATED", "LIVE", "ENDED"]),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});

export const quizStartedPayloadSchema = z.object({
  sessionId: z.uuid(),
  quizId: z.uuid(),
  state: z.enum(["DRAFT", "ACTIVE", "COMPLETED"]),
});

export const questionPublishedPayloadSchema = z.object({
  sessionId: z.uuid(),
  quizId: z.uuid(),
  questionId: z.uuid(),
  position: z.number().int(),
  prompt: z.string(),
  /** Absent from student-visible payloads; always null over the wire. */
  firstCorrectWins: z.boolean(),
  acceptingAnswers: z.literal(true),
});

export const questionClosedPayloadSchema = z.object({
  sessionId: z.uuid(),
  quizId: z.uuid(),
  questionId: z.uuid(),
});

export const answerAcceptedPayloadSchema = z.object({
  sessionId: z.uuid(),
  questionId: z.uuid(),
  participantId: z.uuid(),
  displayName: z.string(),
  isCorrect: z.boolean().nullable(),
  isWinner: z.boolean(),
  attemptNumber: z.number().int(),
});

export const answerRejectedPayloadSchema = z.object({
  sessionId: z.uuid(),
  questionId: z.uuid(),
  participantId: z.uuid(),
  reason: z.enum(["not_accepting_answers", "not_a_participant"]),
});

export const leaderboardUpdatedPayloadSchema = z.object({
  sessionId: z.uuid(),
  questionId: z.uuid(),
  // Reuses leaderboardEntrySchema (declared above, shared with the Phase 5
  // recovery snapshot) so standings have exactly one wire shape.
  standings: z.array(leaderboardEntrySchema),
});

// ---- Phase 6: doubt queue server events -----------------------------------

/** Session broadcast on a fresh `doubt.create`. */
export const doubtCreatedPayloadSchema = z.object({
  sessionId: z.uuid(),
  doubt: doubtViewSchema,
});

/** Session broadcast on `doubt.resolve`. */
export const doubtResolvedPayloadSchema = z.object({
  sessionId: z.uuid(),
  doubtId: z.uuid(),
  status: z.literal("RESOLVED"),
  resolvedAt: z.string().datetime(),
});

/** Session broadcast on `doubt.dismiss`. */
export const doubtDismissedPayloadSchema = z.object({
  sessionId: z.uuid(),
  doubtId: z.uuid(),
  status: z.literal("DISMISSED"),
  resolvedAt: z.string().datetime(),
});

/**
 * Private response to `doubt.queue.list`: the authoritative OPEN queue. This
 * is a convenience read, NOT a correctness requirement — clients converge via
 * the recovery snapshot and the granular created/resolved/dismissed events.
 */
export const doubtQueueUpdatedPayloadSchema = z.object({
  sessionId: z.uuid(),
  doubts: z.array(doubtViewSchema),
  /** True when OPEN doubts exist beyond the payload cap. */
  truncated: z.boolean(),
});

// ---- Phase 7: presence -----------------------------------------------------

/**
 * A participant as seen by presence. Deliberately minimal: no connection ids,
 * no instance ids, no infrastructure detail — membership in the snapshot list
 * means "online".
 */
export const presenceParticipantSchema = z.object({
  participantId: z.uuid(),
  displayName: z.string(),
  role: z.enum(["TEACHER", "STUDENT"]),
});
export type PresenceParticipant = z.infer<typeof presenceParticipantSchema>;

/**
 * Server → client presence update. Idempotent and order-insensitive: it is the
 * whole aggregated online set for the session, so a client replaces its view
 * wholesale and duplicate/late snapshots are harmless.
 */
export const presenceSnapshotPayloadSchema = z.object({
  sessionId: z.uuid(),
  participants: z.array(presenceParticipantSchema),
});

/**
 * Internal (Redis) notice: one instance's COMPLETE local online set for one
 * session. Idempotent by construction, so a missed notice is repaired by the
 * next update/digest rather than by replaying deltas.
 */
export const presenceUpdatePayloadSchema = z.object({
  sessionId: z.uuid(),
  seq: z.number().int(),
  participants: z.array(presenceParticipantSchema),
});

export const errorPayloadSchema = z.object({
  code: z.enum([
    "INVALID_MESSAGE",
    "INVALID_REQUEST",
    "INVALID_SESSION_ID",
    "UNAUTHENTICATED",
    "SESSION_NOT_FOUND",
    "SESSION_ALREADY_JOINED",
    "UNSUPPORTED_EVENT",
    "NOT_JOINED",
    "NOT_A_PARTICIPANT",
    "TEACHER_REQUIRED",
    "SESSION_NOT_LIVE",
    "QUIZ_NOT_FOUND",
    "QUESTION_NOT_FOUND",
    "QUIZ_NOT_ACTIVE",
    "QUESTION_NOT_ACCEPTING_ANSWERS",
    "INVALID_STATE_TRANSITION",
    "DOUBT_NOT_FOUND",
    "DOUBT_NOT_OPEN",
    "INTERNAL_ERROR",
  ]),
  message: z.string(),
  /** Present only for INVALID_REQUEST: Zod issue paths for client developers. */
  details: z
    .object({
      issues: z.array(z.object({ path: z.string(), message: z.string() })),
    })
    .nullable(),
});
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

// ---------------------------------------------------------------------------
// Server message factories
// ---------------------------------------------------------------------------

export function sessionJoinedMessage(
  requestId: string,
  payload: z.infer<typeof sessionJoinedPayloadSchema>,
): ServerEnvelope {
  return { type: "session.joined", requestId, payload };
}

export const authAuthenticatedPayloadSchema = z.object({
  userId: z.uuid(),
});

/** Server confirmation of `auth.authenticate`: the bound authenticated user. */
export function authAuthenticatedMessage(
  requestId: string,
  payload: z.infer<typeof authAuthenticatedPayloadSchema>,
): ServerEnvelope {
  return { type: "auth.authenticated", requestId, payload };
}

export function sessionStateMessage(
  requestId: string | null,
  payload: z.infer<typeof sessionStatePayloadSchema>,
): ServerEnvelope {
  return { type: "session.state", requestId, payload };
}

export function quizStartedMessage(
  requestId: string | null,
  payload: z.infer<typeof quizStartedPayloadSchema>,
): ServerEnvelope {
  return { type: "quiz.started", requestId, payload };
}

export function questionPublishedMessage(
  requestId: string | null,
  payload: z.infer<typeof questionPublishedPayloadSchema>,
): ServerEnvelope {
  return { type: "question.published", requestId, payload };
}

export function questionClosedMessage(
  requestId: string | null,
  payload: z.infer<typeof questionClosedPayloadSchema>,
): ServerEnvelope {
  return { type: "question.closed", requestId, payload };
}

export function answerAcceptedMessage(
  requestId: string | null,
  payload: z.infer<typeof answerAcceptedPayloadSchema>,
): ServerEnvelope {
  return { type: "answer.accepted", requestId, payload };
}

export function answerRejectedMessage(
  requestId: string | null,
  payload: z.infer<typeof answerRejectedPayloadSchema>,
): ServerEnvelope {
  return { type: "answer.rejected", requestId, payload };
}

export function leaderboardUpdatedMessage(
  requestId: string | null,
  payload: z.infer<typeof leaderboardUpdatedPayloadSchema>,
): ServerEnvelope {
  return { type: "leaderboard.updated", requestId, payload };
}

export function doubtCreatedMessage(
  requestId: string | null,
  payload: z.infer<typeof doubtCreatedPayloadSchema>,
): ServerEnvelope {
  return { type: "doubt.created", requestId, payload };
}

export function doubtResolvedMessage(
  requestId: string | null,
  payload: z.infer<typeof doubtResolvedPayloadSchema>,
): ServerEnvelope {
  return { type: "doubt.resolved", requestId, payload };
}

export function doubtDismissedMessage(
  requestId: string | null,
  payload: z.infer<typeof doubtDismissedPayloadSchema>,
): ServerEnvelope {
  return { type: "doubt.dismissed", requestId, payload };
}

export function doubtQueueUpdatedMessage(
  requestId: string | null,
  payload: z.infer<typeof doubtQueueUpdatedPayloadSchema>,
): ServerEnvelope {
  return { type: "doubt.queue.updated", requestId, payload };
}

export function presenceSnapshotMessage(
  requestId: string | null,
  payload: z.infer<typeof presenceSnapshotPayloadSchema>,
): ServerEnvelope {
  return { type: "presence.snapshot", requestId, payload };
}

export function errorMessage(requestId: string | null, payload: ErrorPayload): ServerEnvelope {
  return { type: "error", requestId, payload };
}

export function protocolIssueDetails(error: z.ZodError): ErrorPayload["details"] {
  return {
    issues: error.issues.map((issue) => ({
      // Issue paths from payload schemas are relative to the payload; prefix
      // so client developers see the full envelope location (payload.sessionId).
      path: `payload.${issue.path.map(String).join(".")}`,
      message: issue.message,
    })),
  };
}
