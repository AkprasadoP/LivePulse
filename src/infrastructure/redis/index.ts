import { createClient, type RedisClientType } from "redis";
import type { AppConfig } from "../../config/index.js";
import type { Metrics } from "../metrics/index.js";

/**
 * Redis infrastructure for the Phase 4 distribution layer.
 *
 * Connection architecture (Pub/Sub requires separate connections):
 *
 *   publisher  — plain command connection; used ONLY for PUBLISH
 *   subscriber — a second connection in subscriber mode; SUBSCRIBE only
 *
 * Lifecycle rules (docs/architecture/distributed-websockets.md):
 *   - Reconnect with capped backoff (250 ms doubling to 2 s max, jittered),
 *     forever — a Redis outage degrades propagation but must not kill the
 *     instance.
 *   - Redis failure NEVER affects PostgreSQL work: publish is post-commit
 *     and best-effort (failures logged, never thrown into handlers).
 *   - close() unsubscribes and quits both connections; idempotent.
 */
export interface RedisInfrastructure {
  /** Publish one raw JSON string to the channel. Fire-and-forget. */
  publish(channel: string, message: string): Promise<void>;
  /** Register the message handler (must be set before connect). */
  onMessage(handler: (channel: string, message: string) => void): void;
  /** Connect both connections. Resolves even if Redis is unreachable. */
  connect(): Promise<void>;
  /** Unsubscribe + quit both connections; safe to call twice. */
  close(): Promise<void>;
  /** Diagnostics: whether the publisher connection is currently open. */
  get publisherReady(): boolean;
}

export interface RedisInfrastructureOptions {
  config: AppConfig;
  /** Phase 7 metrics (optional; absent in unit-ish usages). */
  metrics?: Metrics | undefined;
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
}

/** Capped, jittered backoff schedule (AGENT.md §4: no vague claims). */
const RECONNECT_BASE_MS = 250;
const RECONNECT_CAP_MS = 2_000;

export function createRedisInfrastructure(
  options: RedisInfrastructureOptions,
): RedisInfrastructure {
  const { config, log, metrics } = options;

  const reconnectStrategy = (retries: number): number | Error => {
    if (closing) return new Error("Redis client is shutting down");
    // node-redis socket reconnect strategy: retries forever; our cap bounds
    // the delay, jitter avoids thundering herds of instances.
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** retries, RECONNECT_CAP_MS);
    return backoff + Math.floor(Math.random() * 100);
  };

  const publisher = createClient({
    url: config.REDIS_URL,
    socket: { reconnectStrategy },
  }) as RedisClientType;
  const subscriber = createClient({
    url: config.REDIS_URL,
    socket: { reconnectStrategy },
  }) as RedisClientType;

  let messageHandler: ((channel: string, message: string) => void) | null = null;
  let closing = false;

  // Connection-lifecycle observability (ADR-009): 'ready' = usable, 'end' =
  // closed, 'reconnecting' = attempting again. Never fatal (Phase 4 degrade).
  const trackConnection = (client: RedisClientType, name: "publisher" | "subscriber") => {
    client.on("error", (error: Error) => {
      // 'error' fires on every failed reconnect attempt too — warn, never throw.
      log.warn({ err: error.message, connection: name }, `Redis ${name} connection error`);
      metrics?.redisConnectionErrors.inc({ connection: name });
    });
    client.on("ready", () => metrics?.redisConnected.set({ connection: name }, 1));
    client.on("end", () => metrics?.redisConnected.set({ connection: name }, 0));
    client.on("reconnecting", () => metrics?.redisConnected.set({ connection: name }, 0));
    // Presence-agnostic initial value: not connected until proven ready.
    metrics?.redisConnected.set({ connection: name }, 0);
  };
  trackConnection(publisher, "publisher");
  trackConnection(subscriber, "subscriber");

  return {
    async publish(channel, message) {
      // Publish is post-commit, best-effort: a Redis outage must not break
      // the handler (the commit already succeeded; the notice is a hint).
      if (closing) return;
      try {
        await publisher.publish(channel, message);
        metrics?.redisPublish.inc({ result: "ok" });
      } catch (error) {
        metrics?.redisPublish.inc({ result: "error" });
        log.warn(
          { err: error instanceof Error ? error.message : String(error), channel },
          "Redis publish failed (propagation degraded, PostgreSQL state is authoritative)",
        );
      }
    },

    onMessage(handler) {
      messageHandler = handler;
    },

    async connect() {
      // Promise.allSettled on purpose: one side failing must not prevent the
      // other from subscribing; reconnect strategy keeps retrying anyway.
      const results = await Promise.allSettled([publisher.connect(), subscriber.connect()]);
      for (const result of results) {
        if (result.status === "rejected") {
          log.warn(
            { err: result.reason instanceof Error ? result.reason.message : String(result.reason) },
            "Redis connection failed at startup (will keep retrying in the background)",
          );
        }
      }
      if (messageHandler !== null) {
        await subscriber.subscribe("livepulse:events", (message) => {
          if (messageHandler !== null) messageHandler("livepulse:events", message);
        });
      }
    },

    async close() {
      if (closing) return;
      closing = true;
      // Disconnect (not quit): kills the socket immediately regardless of
      // subscriber mode — graceful but not dependent on Redis answering.
      // Defensive on purpose: disconnect on a never-connected client throws
      // in node-redis v6, and shutdown must never hang on Redis.
      const shutdownOne = async (client: RedisClientType, name: string): Promise<void> => {
        try {
          if (!client.isReady) return; // never connected (or already dead)
          await Promise.race([
            Promise.resolve(client.disconnect()),
            new Promise((resolve) => setTimeout(resolve, 1_000)),
          ]);
        } catch (error) {
          log.warn(
            { err: error instanceof Error ? error.message : String(error), connection: name },
            "Redis disconnect issue during shutdown (ignored)",
          );
        }
      };
      await Promise.all([
        shutdownOne(publisher, "publisher"),
        shutdownOne(subscriber, "subscriber"),
      ]);
    },

    get publisherReady() {
      return publisher.isReady;
    },
  };
}
