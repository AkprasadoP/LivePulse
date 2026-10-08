import { buildApp } from "./app/app.js";
import { loadConfig, loadEnvFile, ConfigValidationError, type AppConfig } from "./config/index.js";

/**
 * Process entrypoint.
 *
 * Responsibilities:
 *  1. Load `.env` (real environment variables still take precedence).
 *  2. Load and validate configuration — fail fast, before anything else.
 *  3. Build the app: HTTP listener + WebSocket layer on one shared server.
 *  4. Install SIGINT/SIGTERM handlers for graceful shutdown.
 *
 * The WebSocket layer is torn down by the app's onClose hook (sockets closed
 * 1001, heartbeat stopped, upgrade listener removed) as part of app.close().
 */
async function main(): Promise<void> {
  loadEnvFile();
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      // No logger exists yet — the configuration itself failed. Print and exit.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const app = await buildApp({ config, listen: true });
  app.log.info({ port: config.PORT }, "HTTP and WebSocket server listening");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // second signal must not double-run teardown
    shuttingDown = true;
    app.log.info({ signal }, "Graceful shutdown starting");
    try {
      // Phase 9.6 draining: stop admitting NEW work first — the WS layer
      // refuses upgrades and /ready flips to 503 (draining:true) so Nginx
      // and reconnecting clients pick a healthy instance — while EXISTING
      // connections finish for up to DRAIN_TIMEOUT_MS. Only then does
      // app.close() run the pre-existing teardown (in-flight HTTP drains,
      // presence withdrawal, 1001 socket closes, distributor close).
      app.wsLayer?.beginDraining();
      app.log.info(
        { drainTimeoutMs: config.DRAIN_TIMEOUT_MS },
        "Draining: no new WebSocket connections until shutdown",
      );
      await new Promise((resolve) => setTimeout(resolve, config.DRAIN_TIMEOUT_MS));
      // app.close() runs Fastify lifecycle hooks in order: stop accepting
      // connections, await in-flight requests, close WS layer, onClose hooks
      // ($disconnect etc.).
      await app.close();
      app.log.info("Graceful shutdown complete");
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "Error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
