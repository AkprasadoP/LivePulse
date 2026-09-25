import { z } from "zod";
import type { RedisInfrastructure } from "../infrastructure/redis/index.js";
import type { SessionRegistry } from "./session-registry.js";
import type { Connection } from "./connection.js";
import {
  quizStartedPayloadSchema,
  questionPublishedPayloadSchema,
  questionClosedPayloadSchema,
  answerAcceptedPayloadSchema,
  leaderboardUpdatedPayloadSchema,
  doubtCreatedPayloadSchema,
  doubtResolvedPayloadSchema,
  doubtDismissedPayloadSchema,
  type ServerEnvelope,
} from "./protocol.js";

/**
 * Inter-instance event distribution (Phase 4).
 *
 * Boundary (ADR-005 / docs/architecture/distributed-websockets.md):
 *   - Redis carries ONLY post-commit, session-scoped event notices.
 *   - PostgreSQL is the sole source of truth; a notice is a hint.
 *   - The receive path never writes PostgreSQL and never republishes.
 *   - Delivery is at-most-once; loss costs a push, never durable data.
 *
 * Publish sequence enforced by the handlers:
 *   validate -> PostgreSQL transaction -> COMMIT -> local broadcast
 *   -> publish notice. Redis failure can never roll back a commit.
 */
export const DISTRIBUTION_CHANNEL = "livepulse:events";
export const EVENT_SCHEMA_VERSION = 1;

/**
 * UUIDv7 event IDs (RFC 9562): 48-bit millisecond timestamp + version/variant
 * bits, random remainder. Same id family as the database's ids; generated
 * app-side because node:crypto has no uuidv7 primitive.
 */
function uuidv7(): string {
  const bytes = new Uint8Array(16);
  const ms = Date.now();
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes.subarray(6));
  } else {
    for (let i = 6; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-` +
    `${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`
  );
}

// ---------------------------------------------------------------------------
// Envelope schema
// ---------------------------------------------------------------------------

export const distributionEventSchema = z.object({
  eventId: z.uuid(),
  type: z.string().min(1).max(64),
  sessionId: z.uuid(),
  originInstanceId: z.string().min(1).max(64),
  schemaVersion: z.number().int(),
  occurredAt: z.string(), // ISO timestamp; diagnostic only, never ordering
  payload: z.record(z.string(), z.unknown()),
});
export type DistributionEvent = z.infer<typeof distributionEventSchema>;

/**
 * Events that cross Redis (design §8): exactly the session-scoped,
 * state-changing broadcasts. Connection-local frames (session.joined,
 * private answer verdicts, errors, heartbeats) are deliberately absent.
 */
export const DISTRIBUTED_EVENT_TYPES = [
  "quiz.started",
  "question.published",
  "question.closed",
  "answer.accepted",
  "leaderboard.updated",
  // Phase 6 — doubt queue mutations. The queue itself never lives in Redis;
  // these are post-commit notices whose receivers render frames. `occurredAt`
  // is diagnostic: doubt ordering comes from payload.enqueueSeq, never from
  // Redis delivery order. `doubt.queue.updated` is connection-local (a private
  // response) and deliberately NOT distributed.
  "doubt.created",
  "doubt.resolved",
  "doubt.dismissed",
] as const;
export type DistributedEventType = (typeof DISTRIBUTED_EVENT_TYPES)[number];

const payloadSchemas: Record<DistributedEventType, z.ZodTypeAny> = {
  "quiz.started": quizStartedPayloadSchema,
  "question.published": questionPublishedPayloadSchema,
  "question.closed": questionClosedPayloadSchema,
  "answer.accepted": answerAcceptedPayloadSchema,
  "leaderboard.updated": leaderboardUpdatedPayloadSchema,
  "doubt.created": doubtCreatedPayloadSchema,
  "doubt.resolved": doubtResolvedPayloadSchema,
  "doubt.dismissed": doubtDismissedPayloadSchema,
};

/** Narrow a validated envelope to a known event type (or null). */
function asDistributedType(type: string): DistributedEventType | null {
  return (DISTRIBUTED_EVENT_TYPES as readonly string[]).includes(type)
    ? (type as DistributedEventType)
    : null;
}

// ---------------------------------------------------------------------------
// Publisher (origin side)
// ---------------------------------------------------------------------------

export interface Distributor {
  /**
   * Publish one event notice. MUST be called only after the PostgreSQL
   * commit succeeded. Fire-and-forget: Redis failure is logged, never thrown.
   */
  publish(input: {
    type: DistributedEventType;
    sessionId: string;
    payload: Record<string, unknown>;
  }): void;
  /** Stop the Redis connections (graceful shutdown). Idempotent. */
  close(): Promise<void>;
  /** Diagnostics. */
  readonly instanceId: string;
  readonly enabled: boolean;
}

export interface DistributorOptions {
  instanceId: string;
  redis: RedisInfrastructure;
  registry: SessionRegistry;
  /** Renders the wire frame for a validated remote event. */
  render: (event: {
    type: DistributedEventType;
    payload: Record<string, unknown>;
  }) => ServerEnvelope;
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
  enabled?: boolean;
}

export function createDistributor(options: DistributorOptions): Distributor {
  const { instanceId, redis, registry, render, log } = options;
  const enabled = options.enabled ?? true;

  if (enabled) {
    redis.onMessage((channel, raw) => {
      void handleIncoming(raw, channel);
    });
  }

  async function handleIncoming(raw: string, channel: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn({ channel }, "Distribution: received non-JSON message, ignoring");
      return;
    }

    const envelope = distributionEventSchema.safeParse(parsed);
    if (!envelope.success) {
      log.warn(
        { channel, issues: envelope.error.issues.length },
        "Distribution: received invalid event envelope, ignoring",
      );
      return;
    }
    const event = envelope.data;

    // Hard rule: never interpret unknown schema versions (locked decision c).
    if (event.schemaVersion !== EVENT_SCHEMA_VERSION) {
      log.warn(
        {
          eventId: event.eventId,
          schemaVersion: event.schemaVersion,
          expected: EVENT_SCHEMA_VERSION,
        },
        "Distribution: unsupported schema version, rejecting event",
      );
      return;
    }

    const eventType = asDistributedType(event.type);
    if (eventType === null) {
      log.warn(
        { eventId: event.eventId, type: event.type },
        "Distribution: unknown event type, ignoring",
      );
      return;
    }

    // Echo suppression (design §5). Also satisfies Test E locally.
    if (event.originInstanceId === instanceId) {
      return;
    }

    const payload = payloadSchemas[eventType].safeParse(event.payload);
    if (!payload.success) {
      log.warn(
        { eventId: event.eventId, type: event.type, issues: payload.error.issues.length },
        "Distribution: event payload failed schema validation, ignoring",
      );
      return;
    }

    // Local-interest filter: zero local connections for the session -> ignore.
    const targets = registry.getConnectionsForSession(event.sessionId);
    if (targets.length === 0) return;

    const message = render({ type: eventType, payload: payload.data as Record<string, unknown> });
    for (const connection of targets) {
      sendFrame(connection, message, log);
    }
    log.info(
      {
        eventId: event.eventId,
        type: event.type,
        sessionId: event.sessionId,
        from: event.originInstanceId,
        receivers: targets.length,
      },
      "Distribution: remote event rendered to local connections",
    );
  }

  return {
    instanceId,
    enabled,
    publish(input) {
      if (!enabled) return;
      const event = {
        eventId: uuidv7(),
        type: input.type,
        sessionId: input.sessionId,
        originInstanceId: instanceId,
        schemaVersion: EVENT_SCHEMA_VERSION,
        occurredAt: new Date().toISOString(),
        payload: input.payload,
      };
      const raw = JSON.stringify(event);
      void redis.publish(DISTRIBUTION_CHANNEL, raw).catch((error) => {
        // publish() already catches internally; this is a last-resort net.
        log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Distribution: publish rejected unexpectedly",
        );
      });
    },
    async close() {
      await redis.close();
    },
  };
}

function sendFrame(
  connection: Connection,
  message: ServerEnvelope,
  log: { warn: (obj: Record<string, unknown>, msg: string) => void },
): void {
  if (connection.socket.readyState !== connection.socket.OPEN) return;
  connection.socket.send(JSON.stringify(message), (error) => {
    if (error) log.warn({ err: error.message }, "WebSocket send failed (remote event)");
  });
}
