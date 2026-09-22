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
});

export const sessionLeaveSchema = z.strictObject({});

export type SessionJoinPayload = z.infer<typeof sessionJoinSchema>;

/** Client event name -> its payload schema. The dispatch table for handlers. */
export const clientEventSchemas = {
  "session.join": sessionJoinSchema,
  "session.leave": sessionLeaveSchema,
} as const;

export type ClientEventType = keyof typeof clientEventSchemas;

/** Is this `type` a known client event? (Valid string, but maybe not supported.) */
export function isKnownClientEvent(type: string): type is ClientEventType {
  return type in clientEventSchemas;
}

// ---------------------------------------------------------------------------
// Server events
// ---------------------------------------------------------------------------

export const sessionJoinedPayloadSchema = z.object({
  sessionId: z.uuid(),
  state: z.enum(["CREATED", "LIVE", "ENDED"]),
});
export type SessionJoinedPayload = z.infer<typeof sessionJoinedPayloadSchema>;

export const sessionStatePayloadSchema = z.object({
  /** The session the connection is now associated with, or null when detached. */
  sessionId: z.uuid().nullable(),
  state: z.enum(["CREATED", "LIVE", "ENDED"]),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type SessionStatePayload = z.infer<typeof sessionStatePayloadSchema>;

export const errorPayloadSchema = z.object({
  code: z.enum([
    "INVALID_MESSAGE",
    "INVALID_REQUEST",
    "INVALID_SESSION_ID",
    "SESSION_NOT_FOUND",
    "SESSION_ALREADY_JOINED",
    "UNSUPPORTED_EVENT",
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
  payload: SessionJoinedPayload,
): ServerEnvelope<SessionJoinedPayload> {
  return { type: "session.joined", requestId, payload };
}

export function sessionStateMessage(
  requestId: string | null,
  payload: SessionStatePayload,
): ServerEnvelope<SessionStatePayload> {
  return { type: "session.state", requestId, payload };
}

export function errorMessage(
  requestId: string | null,
  payload: ErrorPayload,
): ServerEnvelope<ErrorPayload> {
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
