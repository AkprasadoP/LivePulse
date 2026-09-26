// Phase 8.1 load-test runner.
//
// Zero external dependencies (Node >= 22 built-ins only). Reuses the real
// `ws` client package and the real Fastify HTTP surface the app already owns.
// It is a simulation harness, not a production-grade load tool - the goal of
// Phase 8.1 is to (a) prove the load-test infrastructure works, (b) keep the
// scenario layout k6-compatible, and (c) collect measurements without changing
// the application under test.
//
// When k6 becomes available, the same scenario files are run with
// `k6 run <scenario>` - only the interpreter changes, not the inputs.

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import http from "node:http";
import { URL, fileURLToPath } from "node:url";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";

const DOTENV = path.resolve(process.cwd(), ".env");
const env = { ...process.env };

function loadDotEnv() {
  if (!fs.existsSync(DOTENV)) return;
  for (const line of fs.readFileSync(DOTENV, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}
loadDotEnv();

const BASE_URL = (env.BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const WS_URL = (env.WS_URL || BASE_URL + "/ws").replace(/\/+$/, "");
const TEST_DB_URL = env.TEST_DB_URL || "";
const REDIS_URL = env.REDIS_URL || "";
const ALLOW_NONLOCAL = process.argv.includes("--allow-nonlocal");

// Hard-safety: refuse non-local targets unless explicitly opted in.
{
  const hostname = new URL(BASE_URL).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    if (!ALLOW_NONLOCAL) {
      console.error(
        "[load-tests] SAFETY ABORT: BASE_URL=" + BASE_URL +
        " is not local. Pass --allow-nonlocal to override (production targets are refused).",
      );
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Tiny stat / percentile helpers (no dependency, deterministic)
// ---------------------------------------------------------------------------

class Stats {
  constructor() { this.values = []; }
  push(v) { this.values.push(v); }
  count() { return this.values.length; }
  min() { return this.values.length === 0 ? NaN : Math.min(...this.values); }
  max() { return this.values.length === 0 ? NaN : Math.max(...this.values); }
  mean() {
    if (this.values.length === 0) return NaN;
    const sum = this.values.reduce((a, b) => a + b, 0);
    return sum / this.values.length;
  }
  // linear interpolation, identical to k6's default p(95) on the sorted set
  percentile(p) {
    if (this.values.length === 0) return NaN;
    const sorted = [...this.values].sort((a, b) => a - b);
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    const frac = idx - lo;
    return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
  }
  toJSON() {
    return {
      count: this.count(),
      min: this.min(),
      max: this.max(),
      mean: this.mean(),
      p50: this.percentile(50),
      p90: this.percentile(90),
      p95: this.percentile(95),
      p99: this.percentile(99),
    };
  }
}

// ---------------------------------------------------------------------------
// HTTP client (real sockets, no mocking)
// ---------------------------------------------------------------------------

function httpRequestRunner(scenario, options) {
  return new Promise((resolve) => {
    const base = new URL(BASE_URL);
    const port = Number(base.port || (base.protocol === "https:" ? 443 : 80));
    const hostname = base.hostname;
    const results = { requests: 0, failures: 0, statusCounts: {}, durations: [] };
    function waitForInFlightThenStop() {
      if (inFlight > 0) {
        // Give the event loop a chance to drain responses already in flight.
        setImmediate(waitForInFlightThenStop);
        return;
      }
      stop();
    }

    const stop = () => {
      const end = performance.now();
      const durationSeconds = (end - 0) / 1000;
      resolve({
        timestamp: new Date(end).toISOString(),
        vus: options.vus,
        scenario,
        http: {
          requests: results.requests,
          failures: results.failures,
          statusCounts: results.statusCounts,
          durationMs: new Stats(),
        },
        ws: { connections: 0, connectionSuccess: 0, connectionFail: 0,
          connectionsOpenAtEnd: 0, messagesReceived: 0, messagesSent: 0,
          connectionDurationMs: new Stats(), messageDurationMs: new Stats() },
        pgs: { queries: 0, errors: 0 },
        redis: { connected: false, errors: 0 },
        summary: {
          durationSeconds,
          vus: options.vus,
          requestsPerSec: results.requests / (durationSeconds || 1e-9),
          wsConnectionsPerSec: 0,
          httpMeanMs: 0,
          httpP95Ms: 0,
          wsMessageRate: 0,
        },
      });
    };

    // Track in-flight requests so the snapshot waits for responses that were
    // already inflight when the duration timer fired. Without this, any request
    // whose response arrives after the timer fires is lost from the snapshot,
    // which produces all-zero results on short runs and on slow hosts.
    let inFlight = 0;
    let timer = null;
    let fired = 0;

    // Per-VU identity so concurrent VUs create distinct sessions and distinct
    // auto-provisioned creator display names. Two VUs submitting the same
    // displayName will collide on users.displayName uniqueness (P2002 -> 409),
    // which is correct app behavior but NOT the successful smoke path we want
    // for the baseline.
    const vuCreatorDisplayName = (vu) =>
      `smoke-creator-VU-${vu}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    function scheduleOne() {
      fired += 1;
      const id = fired;
      const started = performance.now();
      const url = new URL("/sessions", base); // scenario: create session
      url.searchParams.set("name", "e2e-sess-" + Date.now() + "-" + id);
      const body = JSON.stringify({
        name: url.searchParams.get("name"),
        creator: { displayName: vuCreatorDisplayName(options.vus) },
      });
      inFlight += 1;
      const req = http.request(
        { hostname, port, path: url.pathname + url.search, method: "POST",
          headers: { "content-type": "application/json",
                      "content-length": Buffer.byteLength(body) } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const duration = (performance.now() - started) * 1000;
            results.requests += 1;
            const code = res.statusCode || 0;
            results.statusCounts[code] = (results.statusCounts[code] || 0) + 1;
            if (code < 200 || code >= 400) results.failures += 1;
            results.durations.push(duration);
            inFlight -= 1;
          });
        },
      )
        .on("error", (err) => {
          const duration = (performance.now() - started) * 1000;
          results.failures += 1;
          results.durations.push(duration);
          inFlight -= 1;
        })
        .end(body);
    }

    // fire the first request for each VU immediately, then repeat.
    for (let i = 0; i < options.vus; i += 1) {
      scheduleOne();
    }
    timer = setInterval(() => {
      for (let i = 0; i < options.vus; i += 1) {
        scheduleOne();
      }
    }, 1000 / options.vus);

    // stop the run after the specified duration. Wait for in-flight responses
    // to be counted before snapshotting so short runs are not empty.
    timer = setTimeout(() => {
      clearInterval(timer);
      waitForInFlightThenStop();
    }, options.durationMs);
  });
}

function pgsProbe() {
  if (!TEST_DB_URL) return { queries: 0, errors: 0 };
  try {
    execFileSync("pg_isready", ["-h", "localhost", "-p", "5433"]);
    return { queries: 0, errors: 0 };
  } catch (e) {
    return { queries: 0, errors: 0 };
  }
}

function redisProbe() {
  if (!REDIS_URL) return { connected: false, errors: 0 };
  try {
    execFileSync("redis-cli", ["-h", "localhost", "-p", "6380", "ping"]);
    return { connected: true, errors: 0 };
  } catch (e) {
    return { connected: false, errors: 0 };
  }
}

// ---------------------------------------------------------------------------
// WebSocket client (real sockets, real app)
// ---------------------------------------------------------------------------

function websocketScenario(options) {
  return new Promise((resolve) => {
    const base = new URL(WS_URL);
    const port = Number(base.port || (base.protocol === "wss:" ? 443 : 80));
    const hostname = base.hostname;
    let seq = 0;
    const clients = new Map();
    const connectionDuration = new Stats();
    let connections = 0;
    let connectionSuccess = 0;
    let connectionFail = 0;
    let messagesReceived = 0;
    let messagesSent = 0;
    let timeout = null;
    let postTimer = null;

    function scheduleConnection() {
      const id = ++seq;
      const ws = new WebSocket(WS_URL + "?vu=" + id);
      ws.once("open", () => {
        connectionSuccess += 1;
        connections += 1;
        const connectedAt = performance.now();
        ws.once("close", (code) => {
          connectionDuration.push(performance.now() - connectedAt);
          connectionFail += 1;
          connections -= 1;
          clients.delete(id);
        });
        ws.on("message", (data) => {
          messagesReceived += 1;
          messagesSent += 1;
        });
        ws.send(JSON.stringify({
          type: "session.join",
          requestId: "vu-" + id,
          payload: { sessionId: "00000000-0000-0000-0000-000000000000" },
        }));
        clients.set(id, { id, socket: ws, connectedAt, open: true, messages: 0, closed: false });
      });
      ws.once("error", () => {
        connectionFail += 1;
        connectionSuccess += 1;
        connections += 1;
        ws.close();
      });
      ws.on("close", (code) => {
        connectionDuration.push(performance.now() - (clients.get(id) ? clients.get(id).connectedAt : 0));
        connections -= 1;
        clients.delete(id);
      });
      clients.set(id, { id, socket: ws, connectedAt: performance.now(), open: true, messages: 0, closed: false, closeCode: undefined });
    }

    function stop() {
      state = "stopped";
      clients.forEach((c) => { try { c.socket.terminate(); } catch (e) {} });
      if (timeout) clearTimeout(timeout);
      if (postTimer) clearTimeout(postTimer);
      const clientsAlive = clients.size;
      const summary = {
        durationSeconds: (performance.now() - 0) / 1000,
        vus: options.vus,
        connections: connections,
        connectivity: connectionSuccess,
        failures: connectionFail,
        openAtEnd: clientsAlive,
        messagesReceived: messagesReceived,
        messagesSent: messagesSent,
      };
      resolve(buildSnapshot("websocket-connections", options.vus, summary));
    }

    function buildSnapshot(scenario, vus, summary) {
      return {
        timestamp: new Date().toISOString(),
        vus,
        scenario,
        http: { requests: 0, failures: 0, durationMs: new Stats(), statusCounts: {} },
        ws: {
          connections: summary.connections,
          connectionSuccess: summary.connectivity,
          connectionFail: summary.failures,
          connectionsOpenAtEnd: summary.openAtEnd,
          messagesReceived: summary.messagesReceived,
          messagesSent: summary.messagesSent,
          connectionDurationMs: new Stats(),
          messageDurationMs: new Stats(),
        },
        pgs: { queries: 0, errors: 0 },
        redis: { connected: false, errors: 0 },
        summary: {
          durationSeconds: summary.durationSeconds,
          vus,
          requestsPerSec: 0,
          wsConnectionsPerSec: summary.connections / summary.durationSeconds,
          httpMeanMs: 0,
          httpP95Ms: 0,
          wsMessageRate: summary.messagesReceived / summary.durationSeconds,
        },
      };
    }

    // The app owns the /ws upgrade; we only talk to it.
    for (let i = 0; i < options.vus; i += 1) {
      scheduleConnection();
    }
    timeout = setTimeout(() => { stop(); }, options.durationMs);
    postTimer = setTimeout(() => {}, options.durationMs + 5000);
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

// argv parsing intentionally tolerates both `--vus 2` and `--vus=2` forms, and
// treats `--duration 5s` / `--duration=5s` / `--duration 5000` / `--duration=5000`
// identically. When the value after the flag is missing or unparseable we bail
// instead of silently falling back to a 30s default, because a silent 30s run
// is what caused empty snapshots on the 5s smoke in Phase 8.1.
function nextArgValue(flag) {
  const idx = args.findIndex((a) => a === flag || a.startsWith(flag + "="));
  if (idx === -1) return undefined;
  const raw = args[idx];
  if (raw.includes("=")) return raw.slice(flag.length + 1);
  const candidate = args[idx + 1];
  if (candidate === undefined || candidate.startsWith("--")) return undefined;
  return candidate;
}

const vusRaw = nextArgValue("--vus");
if (vusRaw === undefined) {
  console.error("[load-tests] ERROR: --vus is required (e.g. --vus 2).");
  process.exit(2);
}
const vus = Number(vusRaw);
if (!Number.isFinite(vus) || vus <= 0) {
  console.error("[load-tests] ERROR: --vus must be a positive number, got:", vusRaw);
  process.exit(2);
}

const durationRaw = nextArgValue("--duration");
if (durationRaw === undefined) {
  console.error("[load-tests] ERROR: --duration is required (e.g. --duration 5s).");
  process.exit(2);
}
const parseDuration = (s) => {
  if (typeof s !== "string") return Number.NaN;
  const trimmed = s.trim();
  if (trimmed.endsWith("ms")) return Number(trimmed.slice(0, -2));
  if (trimmed.endsWith("s")) return Number(trimmed.slice(0, -1)) * 1000;
  return Number(trimmed);
};
const durationMs = parseDuration(durationRaw);
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  console.error("[load-tests] ERROR: --duration must be a positive duration, got:", durationRaw);
  process.exit(2);
}

const scenarioNameRaw = nextArgValue("--scenario");
const scenarioName = scenarioNameRaw || "http-sessions";

async function main() {
  console.log("[load-tests] scenario=" + scenarioName + " vus=" + vus +
    " duration=" + durationMs + "ms base=" + BASE_URL);
  let snapshot;
  const start = performance.now();
  if (scenarioName === "websocket-connections") {
    snapshot = await websocketScenario({ vus, durationMs });
  } else {
    snapshot = await httpRequestRunner(scenarioName, { vus, durationMs });
  }
  const elapsed = (performance.now() - start) / 1000;

  const http = snapshot.http;
  const ws = snapshot.ws;
  const summary = snapshot.summary;

  console.log("\n=== PHASE 8.1 RAW OBSERVED (NOT A CAPACITY LIMIT) ===");
  console.log(JSON.stringify({
    timestamp: snapshot.timestamp,
    vus,
    scenario: snapshot.scenario,
    durationSeconds: elapsed,
    http: {
      requests: http.requests,
      failures: http.failures,
      requestsPerSec: http.requests / elapsed,
      statusCounts: http.statusCounts,
      durationMs: http.durationMs,
    },
    ws: {
      connections: ws.connections,
      connectionSuccess: ws.connectionSuccess,
      connectionFail: ws.connectionFail,
      connectionsOpenAtEnd: ws.connectionsOpenAtEnd,
      messagesReceived: ws.messagesReceived,
      messagesSent: ws.messagesSent,
      connectionDurationMs: ws.connectionDurationMs,
      messageDurationMs: ws.messageDurationMs,
    },
    pgs: snapshot.pgs,
    redis: snapshot.redis,
    summary: {
      durationSeconds: elapsed,
      vus,
      requestsPerSec: http.requests / elapsed,
      wsConnectionsPerSec: ws.connections / elapsed,
      httpMeanMs: http.durationMs.mean(),
      httpP95Ms: http.durationMs.percentile(95),
      wsMessageRate: ws.messagesReceived / elapsed,
    },
  }, null, 2));

  // append a JSON summary to the results directory
  try {
    const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "results");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const fname = scenarioName + "-" + vus + "VUs-" + Date.now() + ".json";
    fs.writeFileSync(path.join(outDir, fname), JSON.stringify({ ...snapshot, durationSeconds: elapsed }, null, 2));
    console.log("\n[load-tests] wrote " + path.join(outDir, fname));
  } catch (e) {
    console.error("[load-tests] could not write results:", e.message);
  }
}

main().catch((err) => {
  console.error("[load-tests] FATAL", err);
  process.exit(1);
});
