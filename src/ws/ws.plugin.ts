import type { FastifyInstance } from "fastify";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { SessionRegistry } from "./session-registry.js";
import { SessionRepository } from "../modules/sessions/session.repository.js";
import { QuizRepository } from "../modules/quizzes/quiz.repository.js";
import { AnswerRepository } from "../modules/answers/answer.repository.js";
import { UserRepository } from "../modules/users/user.repository.js";
import { ParticipantRepository } from "../modules/participants/participant.repository.js";
import { DoubtRepository } from "../modules/doubts/doubt.repository.js";
import { handleClientEnvelope } from "./handlers.js";
import { createDistributor, type Distributor } from "./distribution.js";
import { createRedisInfrastructure } from "../infrastructure/redis/index.js";
import {
  clientEnvelopeSchema,
  errorMessage,
  requestIdSchema,
  quizStartedMessage,
  questionPublishedMessage,
  questionClosedMessage,
  answerAcceptedMessage,
  leaderboardUpdatedMessage,
  doubtCreatedMessage,
  doubtResolvedMessage,
  doubtDismissedMessage,
  type ServerEnvelope,
} from "./protocol.js";
import type { AppConfig } from "../config/index.js";

export interface WsLayerOptions {
  /** Config already validated by loadConfig (heartbeat interval etc.). */
  config: AppConfig;
  /** Fastify's underlying HTTP server — WS shares it (single port, one process). */
  httpServer: HttpServer;
  /** Fastify instance, used for its scoped logger and the Prisma decorator. */
  app: FastifyInstance;
}

export interface WebSocketLayer {
  registry: SessionRegistry;
  /** Stop the heartbeat timer, close sockets, close the WebSocketServer. */
  close(): Promise<void>;
  /** Test/diagnostics hook: currently-open socket count. */
  get connectionCount(): number;
  /** Phase 4: inter-instance distributor (present even when disabled, for tests). */
  distributor: Distributor;
  /**
   * Resolves once the Redis connections have finished their initial connect
   * attempt (resolves even when Redis is unreachable — publish/subscribe
   * keep retrying in the background). Await this in tests before asserting
   * on cross-instance delivery.
   */
  distributionReady: Promise<void>;
}

const WS_PATH = "/ws";
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Attach the WebSocket layer to Fastify's HTTP server.
 *
 * Lifecycle (documented in docs/architecture/websocket-architecture.md):
 *
 *   TCP accept -> HTTP Upgrade request -> route check (/ws only)
 *     -> ws 'headers' handler completes the 101 handshake
 *     -> 'connection' initializes Connection state + ping hook
 *     -> 'message' -> parse -> validate -> dispatch to handler
 *     -> heartbeat interval pings + sweeps dead sockets
 *     -> 'close' -> registry cleanup
 *     -> layer.close() on graceful shutdown
 *
 * Upgrade routing is done with our own hook rather than handleUpgrade for
 * every request: anything not targeting /ws is destroyed immediately, and a
 * plain HTTP GET /ws is answered 426 by the normal Fastify route.
 */
export function attachWebSocketLayer(options: WsLayerOptions): WebSocketLayer {
  const { config, httpServer, app } = options;
  const registry = new SessionRegistry();
  const sessionRepository = new SessionRepository(app.prisma);
  const quizRepository = new QuizRepository(app.prisma);
  const answerRepository = new AnswerRepository(app.prisma);
  const participantRepository = new ParticipantRepository(
    app.prisma,
    new UserRepository(app.prisma),
  );
  const doubtRepository = new DoubtRepository(app.prisma);

  const wss = new WebSocketServer({
    noServer: true, // we own the upgrade routing (single shared HTTP server)
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  // ---- Phase 4 distribution (Redis Pub/Sub) --------------------------------
  // Post-commit event fan-out ONLY (ADR-005). The subscriber path is
  // read-only: validate -> version check -> echo drop -> local-interest
  // filter -> render frames. It never writes PostgreSQL and never republishes.
  const redis = createRedisInfrastructure({ config, log: app.log });
  const distributor = createDistributor({
    instanceId: config.INSTANCE_ID,
    redis,
    registry,
    log: app.log,
    render: (event) => {
      switch (event.type) {
        case "quiz.started":
          return quizStartedMessage(null, event.payload as never);
        case "question.published":
          return questionPublishedMessage(null, event.payload as never);
        case "question.closed":
          return questionClosedMessage(null, event.payload as never);
        case "answer.accepted":
          return answerAcceptedMessage(null, event.payload as never);
        case "leaderboard.updated":
          return leaderboardUpdatedMessage(null, event.payload as never);
        case "doubt.created":
          return doubtCreatedMessage(null, event.payload as never);
        case "doubt.resolved":
          return doubtResolvedMessage(null, event.payload as never);
        case "doubt.dismissed":
          return doubtDismissedMessage(null, event.payload as never);
      }
    },
  });
  const distributionReady: Promise<void> = config.DISTRIBUTION_ENABLED
    ? redis.connect() // resolves even if Redis is unreachable; reconnects with capped backoff
    : Promise.resolve();
  // The layer owns Redis now; an unhandled rejection here must not crash the
  // process (connect() already allSettles internally — this is belt-and-braces).
  distributionReady.catch(() => {});

  // ---- HTTP Upgrade routing ----------------------------------------------
  const upgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { pathname } = new URL(request.url ?? "/", "ws://localhost");
    if (pathname !== WS_PATH) {
      // Unknown upgrade target: refuse before any handshake bytes are sent.
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  };
  httpServer.on("upgrade", upgradeListener);
  // (The plain-HTTP GET /ws -> 426 route belongs to the HTTP surface and is
  // registered by app.ts BEFORE listening — Fastify rejects post-listen routes.)

  // ---- Connection lifecycle ----------------------------------------------
  // TCP accept -> HTTP Upgrade -> path check -> 101 -> 'connection'.
  // Deliberately NOT using wss.on('connection')-only: the registry entry is
  // created synchronously with the socket so no message can race it.
  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    // Phase 4: a connecting socket is marked alive immediately and the
    // instance-local registry entry exists before any client frame can be
    // processed (the 'message' handlers attach below, synchronously).
    const connection = registry.addConnection(socket);
    app.log.info({ remoteAddress: request.socket.remoteAddress }, "WebSocket connection opened");

    connection.socket.on("pong", () => {
      connection.isAlive = true;
    });

    connection.socket.on("message", (data: unknown) => {
      void processMessage(connection, data).catch((error) => {
        // processMessage is written not to throw, but the safety net stays:
        // a bug in one message must never kill the socket or the process.
        app.log.error({ err: error }, "WebSocket message processing failed unexpectedly");
        safeSend(
          connection,
          errorMessage(null, {
            code: "INTERNAL_ERROR",
            message: "Internal server error",
            details: null,
          }),
        );
      });
    });

    connection.socket.on("error", (error: Error) => {
      // Socket-level failures (reset, frame errors). 'close' always follows,
      // so cleanup happens there; here we only record the cause.
      app.log.warn({ err: error.message }, "WebSocket connection error");
    });

    connection.socket.on("close", (code, reason) => {
      registry.removeConnection(connection);
      app.log.info({ code, reason: reason.toString() || undefined }, "WebSocket connection closed");
    });
  });

  // ---- Heartbeat ----------------------------------------------------------
  // One interval for the whole server. Each tick: mark everyone as needing a
  // pong, ping them; at the NEXT tick, anyone still !isAlive missed a full
  // interval's pong -> terminate. Terminated sockets fire 'close', which runs
  // the normal registry cleanup.
  const heartbeat = setInterval(() => {
    for (const connection of registry.getAllConnections()) {
      if (!connection.isAlive) {
        app.log.info(
          { connectedAt: connection.connectedAt.toISOString() },
          "WebSocket heartbeat cleanup",
        );
        connection.socket.terminate();
        continue;
      }
      connection.isAlive = false;
      connection.socket.ping();
    }
  }, config.WS_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref(); // never keep the process alive just for pings

  // ---- Shutdown -----------------------------------------------------------
  // Order (Phase 4 §13): sockets first (as in Phase 2), then Redis
  // unsubscribe/quit, then the WSS. Nothing here can hang: disconnect() is
  // socket-level, not command-level.
  const close = async (): Promise<void> => {
    clearInterval(heartbeat);
    httpServer.removeListener("upgrade", upgradeListener);
    for (const connection of registry.getAllConnections()) {
      connection.socket.close(1001, "server shutting down");
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await distributor.close();
  };

  return {
    registry,
    close,
    distributor,
    distributionReady,
    get connectionCount() {
      return registry.connectionCount;
    },
  };

  // ---- Message pipeline ---------------------------------------------------
  async function processMessage(
    connection: ReturnType<SessionRegistry["addConnection"]>,
    data: unknown,
  ): Promise<void> {
    const log = {
      info: (obj: Record<string, unknown>, msg: string) => app.log.info(obj, msg),
      warn: (obj: Record<string, unknown>, msg: string) => app.log.warn(obj, msg),
      error: (obj: Record<string, unknown>, msg: string) => app.log.error(obj, msg),
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      app.log.warn("WebSocket protocol error: invalid JSON");
      safeSend(
        connection,
        errorMessage(null, {
          code: "INVALID_MESSAGE",
          message: "Message is not valid JSON",
          details: null,
        }),
      );
      return;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      app.log.warn("WebSocket protocol error: non-object message");
      safeSend(
        connection,
        errorMessage(null, {
          code: "INVALID_MESSAGE",
          message: "Message must be a JSON object",
          details: null,
        }),
      );
      return;
    }

    // Best-effort requestId extraction (docs §3 rule 4): echo the requestId
    // whenever it is itself a valid request id, even if the rest of the
    // envelope failed validation; null only when it is missing/invalid.
    const candidate = (parsed as { requestId?: unknown }).requestId;
    const extracted = typeof candidate === "string" ? requestIdSchema.safeParse(candidate) : null;
    const requestId = extracted !== null && extracted.success ? extracted.data : null;

    const envelope = clientEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      app.log.warn(
        { issues: envelope.error.issues.length },
        "WebSocket protocol error: invalid envelope",
      );
      safeSend(
        connection,
        errorMessage(requestId, {
          code: "INVALID_REQUEST",
          message: "Invalid message envelope",
          details: {
            issues: envelope.error.issues.map((issue) => ({
              path: issue.path.map(String).join("."),
              message: issue.message,
            })),
          },
        }),
      );
      return;
    }

    await handleClientEnvelope(connection, envelope.data, {
      registry,
      sessionRepository,
      quizRepository,
      answerRepository,
      participantRepository,
      doubtRepository,
      prisma: app.prisma,
      log,
      distributor,
    });
  }

  function safeSend(
    connection: ReturnType<SessionRegistry["addConnection"]>,
    message: ServerEnvelope,
  ): void {
    if (connection.socket.readyState !== connection.socket.OPEN) return;
    connection.socket.send(JSON.stringify(message), (error) => {
      if (error) app.log.warn({ err: error.message }, "WebSocket send failed");
    });
  }
}
