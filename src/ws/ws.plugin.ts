import type { FastifyInstance } from "fastify";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { SessionRegistry } from "./session-registry.js";
import type { Connection } from "./connection.js";
import { SessionRepository } from "../modules/sessions/session.repository.js";
import { QuizRepository } from "../modules/quizzes/quiz.repository.js";
import { AnswerRepository } from "../modules/answers/answer.repository.js";
import { ParticipantRepository } from "../modules/participants/participant.repository.js";
import { DoubtRepository } from "../modules/doubts/doubt.repository.js";
import { TokenService } from "../modules/auth/token.service.js";
import { handleClientEnvelope } from "./handlers.js";
import { createDistributor, type Distributor } from "./distribution.js";
import { PresenceTracker } from "./presence.js";
import {
  createRedisInfrastructure,
  type RedisInfrastructure,
} from "../infrastructure/redis/index.js";
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
  presenceSnapshotMessage,
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
   * Phase 9.5: the layer-owned Redis infrastructure, exposed so the /ready
   * route can report dependency state from the same connections the app
   * actually uses (no second client, no new truth mechanism).
   */
  redis: RedisInfrastructure;
  /**
   * Resolves once the Redis connections have finished their initial connect
   * attempt (resolves even when Redis is unreachable — publish/subscribe
   * keep retrying in the background). Await this in tests before asserting
   * on cross-instance delivery.
   */
  distributionReady: Promise<void>;
  /**
   * Phase 9.6: draining flag. Set by beginDraining() on SIGTERM; read by
   * /ready (reports unready) and the upgrade path (refuses new sockets).
   * Existing connections are untouched until close().
   */
  readonly isDraining: boolean;
  /**
   * Phase 9.6: enter draining — refuse NEW upgrade attempts immediately
   * (socket destroyed before any handshake bytes: no registry entry, no
   * presence churn, no close frame to misread as a normal goodbye).
   * Existing connections stay open until close() runs at the drain deadline.
   */
  beginDraining(): void;
}

const WS_PATH = "/ws";
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Minimal, non-sensitive headers we log for upgrade diagnostics.
 * Never log cookies, authorization, or token headers.
 */
const UPGRADE_DIAGNOSTIC_HEADERS = [
  "host",
  "upgrade",
  "connection",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "user-agent",
] as const;

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
 *     -> 'close' -> registry cleanup -> presence refresh
 *     -> layer.close() on graceful shutdown
 *
 * Presence + metrics (Phase 7) hang off exactly these existing lifecycle
 * events — there is deliberately NO second heartbeat and no parallel
 * connection bookkeeping (ADR-008/ADR-009).
 */
export function attachWebSocketLayer(options: WsLayerOptions): WebSocketLayer {
  const { config, httpServer, app } = options;
  const metrics = app.metrics ?? undefined;
  const registry = new SessionRegistry();
  // Phase 10.5: one token service per layer (same secret as HTTP auth).
  const tokens = new TokenService(config.AUTH_ACCESS_SECRET);
  // Phase 9.6 drain flag: checked synchronously per upgrade attempt.
  let draining = false;
  const sessionRepository = new SessionRepository(app.prisma);
  const quizRepository = new QuizRepository(app.prisma);
  const answerRepository = new AnswerRepository(app.prisma);
  const participantRepository = new ParticipantRepository(app.prisma);
  const doubtRepository = new DoubtRepository(app.prisma);

  const wss = new WebSocketServer({
    noServer: true, // we own the upgrade routing (single shared HTTP server)
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  /**
   * Log minimal, non-sensitive upgrade diagnostics.
   * Never logs cookies, authorization, or token headers.
   */
  function logUpgradeDiagnostics(request: IncomingMessage, context: string): void {
    const headers: Record<string, string | undefined> = {};
    for (const h of UPGRADE_DIAGNOSTIC_HEADERS) {
      const v = request.headers[h];
      if (v !== undefined) headers[h] = Array.isArray(v) ? v[0] : v;
    }
    app.log.debug({ pathname: request.url, headers, context }, "WebSocket upgrade diagnostic");
  }

  // ---- Phase 7 presence (ephemeral, instance-local + Redis notices) --------
  // Presence is DERIVED from the live registry, never stored: PostgreSQL holds
  // durable business state, Redis only carries notices. A peer silent for
  // 3 × the digest interval is dropped (crashed/partitioned). See ADR-008.
  const presenceTracker = new PresenceTracker({
    registry,
    staleMs: config.PRESENCE_DIGEST_INTERVAL_MS * 3,
  });
  /** Last local contribution published per session (avoids redundant notices). */
  const lastPublishedLocal = new Map<string, string>();
  /** Local per-participant connection counts (transition metrics only). */
  const localCounts = new Map<string, Map<string, number>>();
  /** Connections killed by the heartbeat sweep — for the close-reason metric. */
  const heartbeatTerminated = new WeakSet<Connection>();

  /** Keep the bounded infrastructure gauges in step with the registry. */
  function syncGauges(): void {
    if (!metrics) return;
    const sessions = new Set<string>();
    for (const connection of registry.getAllConnections()) {
      if (connection.joinedSessionId !== null) sessions.add(connection.joinedSessionId);
    }
    metrics.wsConnectionsActive.set(registry.connectionCount);
    metrics.sessionsWithConnections.set(sessions.size);
    metrics.presenceLocalParticipants.set(presenceTracker.localParticipantCount());
    metrics.presenceRemoteInstances.set(presenceTracker.remoteInstanceCount());
  }

  /**
   * Local presence TRANSITIONS (0 -> 1 = online, 1 -> 0 = offline) for a
   * session. Multi-connection correctness lives here: while any connection is
   * still bound, no offline transition is recorded.
   */
  function reflectLocalTransitions(sessionId: string): void {
    const current = new Map<string, number>();
    for (const connection of registry.getConnectionsForSession(sessionId)) {
      if (connection.participantId === null) continue;
      current.set(connection.participantId, (current.get(connection.participantId) ?? 0) + 1);
    }
    const previous = localCounts.get(sessionId) ?? new Map<string, number>();
    if (metrics) {
      for (const participantId of current.keys()) {
        if (!previous.has(participantId)) metrics.presenceTransitions.inc({ state: "online" });
      }
      for (const participantId of previous.keys()) {
        if (!current.has(participantId)) metrics.presenceTransitions.inc({ state: "offline" });
      }
    }
    if (current.size === 0) localCounts.delete(sessionId);
    else localCounts.set(sessionId, current);
  }

  /**
   * Publish this instance's COMPLETE local online set for a session. Full-set
   * (not deltas) is what makes a missed notice self-healing: the next notice
   * or digest simply overwrites the receiver's contribution.
   */
  function publishLocalPresence(sessionId: string, force = false): void {
    const local = presenceTracker.localParticipants(sessionId);
    const serialized = JSON.stringify(local);
    if (!force && lastPublishedLocal.get(sessionId) === serialized) return;
    lastPublishedLocal.set(sessionId, serialized);
    distributor.publish({
      type: "presence.update",
      sessionId,
      payload: { sessionId, seq: presenceTracker.nextLocalSeq(), participants: local },
    });
  }

  /** Broadcast the aggregated snapshot if the set actually changed. */
  function broadcastPresenceSnapshot(sessionId: string, except?: Connection): void {
    const participants = presenceTracker.snapshotIfChanged(sessionId);
    if (participants === null) return;
    const message = presenceSnapshotMessage(null, { sessionId, participants });
    for (const target of registry.getConnectionsForSession(sessionId)) {
      if (target === except) continue;
      sendFrame(target, message);
    }
  }

  /**
   * Release derived presence bookkeeping once the LAST local connection for
   * a session is gone. Local presence truth is the registry; these maps are
   * caches keyed by sessionId, and sessions are created continuously over the
   * process lifetime, so leaving them behind would grow without bound. Called
   * from every presence refresh, so it covers socket close, session.leave and
   * session switch identically.
   */
  function releaseSessionBookkeepingIfEmpty(sessionId: string): void {
    if (registry.countForSession(sessionId) > 0) return;
    presenceTracker.forgetSession(sessionId);
    lastPublishedLocal.delete(sessionId);
  }

  /**
   * Presence refresh after a lifecycle event: publish our local set (only if
   * it changed, unless forced by the digest), then push the recomputed
   * aggregate to local clients. Failure here must never break the lifecycle
   * that called it, so nothing in this path throws.
   */
  function refreshPresence(sessionId: string, except?: Connection, force = false): void {
    reflectLocalTransitions(sessionId);
    publishLocalPresence(sessionId, force);
    broadcastPresenceSnapshot(sessionId, except);
    syncGauges();
    releaseSessionBookkeepingIfEmpty(sessionId);
  }

  /** Send one connection the current aggregated presence snapshot. */
  function sendPresenceSnapshot(connection: Connection, sessionId: string): void {
    sendFrame(
      connection,
      presenceSnapshotMessage(null, {
        sessionId,
        participants: presenceTracker.aggregate(sessionId),
      }),
    );
  }

  // ---- Phase 4 distribution (Redis Pub/Sub) --------------------------------
  // Post-commit event fan-out ONLY (ADR-005). The subscriber path is
  // read-only: validate -> version check -> echo drop -> local-interest
  // filter -> render frames. It never writes PostgreSQL and never republishes.
  const redis = createRedisInfrastructure({ config, log: app.log, metrics });
  const distributor = createDistributor({
    instanceId: config.INSTANCE_ID,
    redis,
    registry,
    log: app.log,
    metrics,
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
    // Presence notices are not client frames: they update ephemeral local
    // state, after which THIS instance decides what its clients see.
    onPresenceUpdate: (payload, originInstanceId) => {
      const applied = presenceTracker.recordRemote(
        originInstanceId,
        payload.seq,
        payload.sessionId,
        payload.participants,
      );
      if (!applied) return; // stale/duplicate (older seq) — harmless to ignore
      broadcastPresenceSnapshot(payload.sessionId);
      syncGauges();
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
    // First line of defense: log every incoming upgrade attempt at info level
    // so we can confirm the event reaches Node even when debug is not enabled
    // or upstream proxies drop the connection.
    const upgradeHeaders: Record<string, string | undefined> = {};
    for (const h of ["host", "upgrade", "connection", "x-forwarded-proto"] as const) {
      const v = request.headers[h];
      if (v !== undefined) upgradeHeaders[h] = Array.isArray(v) ? v[0] : v;
    }
    app.log.info({ url: request.url, headers: upgradeHeaders }, "HTTP upgrade event received");

    // Parse defensively: a malformed request target must never throw out of the
    // HTTP 'upgrade' event (an uncaught throw there would crash the process).
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "ws://localhost").pathname;
    } catch {
      logUpgradeDiagnostics(request, "url-parse-failed");
      socket.destroy();
      return;
    }
    if (pathname !== WS_PATH) {
      // Unknown upgrade target: refuse before any handshake bytes are sent.
      logUpgradeDiagnostics(request, "path-mismatch");
      socket.destroy();
      return;
    }
    if (draining) {
      // Planned shutdown in progress: never admit a connection we are about
      // to terminate. Destroy (not a polite close — there is no Connection
      // yet, and a 1012 here would still churn registry/presence). The
      // client reconnects through Nginx to a healthy instance.
      logUpgradeDiagnostics(request, "draining");
      socket.destroy();
      return;
    }
    logUpgradeDiagnostics(request, "handle-upgrade");

    // Track this upgrade attempt to scope error handling narrowly.
    // Avoids the global wss "error" listener race where concurrent upgrades
    // could steal each other's error events.
    const pendingUpgrades = new WeakSet<IncomingMessage>();
    pendingUpgrades.add(request);

    wss.handleUpgrade(request, socket, head, (ws) => {
      pendingUpgrades.delete(request);
      logUpgradeDiagnostics(request, "upgrade-success");
      wss.emit("connection", ws, request);
    });

    // handleUpgrade can emit 'error' on the wss if the upgrade fails.
    // We attach a one-time listener but only act if our request is still pending.
    const onUpgradeError = (err: Error) => {
      if (!pendingUpgrades.has(request)) return; // another upgrade's error
      pendingUpgrades.delete(request);
      logUpgradeDiagnostics(request, "upgrade-error");
      app.log.warn({ err: err.message, pathname }, "WebSocket upgrade failed");
    };
    wss.once("error", onUpgradeError);

    // Clean up the error listener once the upgrade completes or fails.
    // The 'connection' event on wss fires after successful upgrade.
    wss.once("connection", () => {
      if (pendingUpgrades.has(request)) pendingUpgrades.delete(request);
      wss.off("error", onUpgradeError);
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
    metrics?.wsConnectionsActive.inc();
    metrics?.wsConnectionsOpened.inc();
    app.log.info({ remoteAddress: request.socket.remoteAddress }, "WebSocket connection opened");

    connection.socket.on("pong", () => {
      connection.isAlive = true;
    });

    connection.socket.on("message", (data: unknown) => {
      metrics?.wsMessagesReceived.inc();
      void processMessage(connection, data).catch((error) => {
        // processMessage is written not to throw, but the safety net stays:
        // a bug in one message must never kill the socket or the process.
        app.log.error({ err: error }, "WebSocket message processing failed unexpectedly");
        sendFrame(
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

    connection.socket.on("close", (code, closeReason) => {
      // Capture the session BEFORE cleanup so presence can be refreshed for
      // the session this connection is leaving (lifecycle order: registry
      // cleanup -> presence refresh -> snapshot).
      const sessionId = connection.joinedSessionId;
      const byHeartbeat = heartbeatTerminated.has(connection);
      registry.removeConnection(connection);
      metrics?.wsConnectionsActive.set(registry.connectionCount);
      metrics?.wsConnectionsClosed.inc({ reason: byHeartbeat ? "heartbeat" : "client" });
      if (sessionId !== null) {
        metrics?.sessionLeaves.inc({ reason: "disconnect" });
        // refreshPresence releases per-session caches once the last local
        // connection is gone, so nothing lingers for the process lifetime.
        refreshPresence(sessionId);
      } else {
        syncGauges();
      }
      app.log.info(
        {
          code,
          closeReason: closeReason.toString() || undefined,
          reason: byHeartbeat ? "heartbeat" : "client",
        },
        "WebSocket connection closed",
      );
    });
  });

  // ---- Heartbeat ----------------------------------------------------------
  // One interval for the whole server. Each tick: mark everyone as needing a
  // pong, ping them; at the NEXT tick, anyone still !isAlive missed a full
  // interval's pong -> terminate. Terminated sockets fire 'close', which runs
  // the normal registry + presence cleanup.
  const heartbeat = setInterval(() => {
    for (const connection of registry.getAllConnections()) {
      if (!connection.isAlive) {
        heartbeatTerminated.add(connection);
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

  // ---- Presence digest ----------------------------------------------------
  // Redis Pub/Sub is at-most-once, so every instance republishes its full
  // local set on this cadence. A missed notice therefore costs freshness, not
  // correctness — the next digest repairs it. Expiring silent peers is the
  // only way a crashed instance's participants disappear.
  const presenceDigest = setInterval(() => {
    const sessions = presenceTracker.localSessions();
    for (const sessionId of sessions) refreshPresence(sessionId, undefined, true);
    if (sessions.length > 0) metrics?.presenceReconcile.inc({ result: "digest" });
    const touched = presenceTracker.expireStale();
    if (touched.length > 0) {
      metrics?.presenceReconcile.inc({ result: "expired" });
      for (const sessionId of touched) broadcastPresenceSnapshot(sessionId);
    }
    syncGauges();
  }, config.PRESENCE_DIGEST_INTERVAL_MS);
  presenceDigest.unref();

  // ---- Shutdown -----------------------------------------------------------
  // Order (Phase 4 §13): sockets first (as in Phase 2), then Redis
  // unsubscribe/quit, then the WSS. Nothing here can hang: disconnect() is
  // socket-level, not command-level.
  const close = async (): Promise<void> => {
    clearInterval(heartbeat);
    clearInterval(presenceDigest);
    httpServer.removeListener("upgrade", upgradeListener);
    // Graceful departure: withdraw our local presence BEFORE Redis closes so
    // peers stop counting our participants immediately instead of waiting for
    // the 3 × digest staleness window. Best-effort (publish never throws).
    for (const sessionId of presenceTracker.localSessions()) {
      distributor.publish({
        type: "presence.update",
        sessionId,
        payload: { sessionId, seq: presenceTracker.nextLocalSeq(), participants: [] },
      });
    }
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
    redis,
    beginDraining() {
      draining = true;
    },
    get isDraining() {
      return draining;
    },
    get connectionCount() {
      return registry.connectionCount;
    },
  };

  // ---- Message pipeline ---------------------------------------------------
  async function processMessage(connection: Connection, data: unknown): Promise<void> {
    const log = {
      info: (obj: Record<string, unknown>, msg: string) => app.log.info(obj, msg),
      warn: (obj: Record<string, unknown>, msg: string) => app.log.warn(obj, msg),
      error: (obj: Record<string, unknown>, msg: string) => app.log.error(obj, msg),
      metrics,
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      app.log.warn("WebSocket protocol error: invalid JSON");
      metrics?.wsProtocolErrors.inc({ code: "INVALID_MESSAGE" });
      sendFrame(
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
      metrics?.wsProtocolErrors.inc({ code: "INVALID_MESSAGE" });
      sendFrame(
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
      metrics?.wsProtocolErrors.inc({ code: "INVALID_REQUEST" });
      sendFrame(
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
      presenceTracker,
      refreshPresence,
      sendPresenceSnapshot,
      tokens,
    });
  }

  /** Serialize + send one envelope on a connection; failures are logged only. */
  function sendFrame(connection: Connection, message: ServerEnvelope): void {
    if (connection.socket.readyState !== connection.socket.OPEN) return;
    connection.socket.send(JSON.stringify(message), (error) => {
      if (error) app.log.warn({ err: error.message }, "WebSocket send failed");
    });
    metrics?.wsMessagesSent.inc();
  }
}
