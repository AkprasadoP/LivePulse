// Phase 8.1 load-test runner (measurement-correctness fix, Phase 8.2a).
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
//
// Instruments (separate, equivalent concepts):
// - k6-native metrics in load-tests/http/sessions.js and
//   load-tests/websocket/connections.js are the forward-looking benchmark
//   source (Trend/Counter/Rate series).
// - This file (load-tests/run.js) is the zero-dependency fallback/smoke
//   harness. It measures the same concepts (request/connection counts,
//   duration samples, status/frame counters, per-second rates, percentiles)
//   with plain Node sockets, but it is a separate instrument: numbers from
//   the two harnesses must never be mixed or compared as if they came from
//   one tool.

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
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}
loadDotEnv();

const BASE_URL = (env.BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
// Normalize WS_URL so an http(s) BASE_URL still yields a ws(s) dial target.
// Without this, `new WebSocket("http://...")` fails at the handshake.
function normalizeWsUrl(raw) {
  const trimmed = String(raw || "").replace(/\/+$/, "");
  if (trimmed.startsWith("http://")) return "ws://" + trimmed.slice("http://".length);
  if (trimmed.startsWith("https://")) return "wss://" + trimmed.slice("https://".length);
  return trimmed;
}
const WS_URL = normalizeWsUrl(env.WS_URL || BASE_URL + "/ws");
const TEST_DB_URL = env.TEST_DB_URL || "";
const REDIS_URL = env.REDIS_URL || "";
const ALLOW_NONLOCAL = process.argv.includes("--allow-nonlocal");

// Hard-safety: refuse non-local targets unless explicitly opted in.
{
  const hostname = new URL(BASE_URL).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    if (!ALLOW_NONLOCAL) {
      console.error(
        "[load-tests] SAFETY ABORT: BASE_URL=" +
          BASE_URL +
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
  constructor(values = []) {
    this.values = [...values];
  }
  push(v) {
    this.values.push(v);
  }
  count() {
    return this.values.length;
  }
  min() {
    return this.values.length === 0 ? NaN : Math.min(...this.values);
  }
  max() {
    return this.values.length === 0 ? NaN : Math.max(...this.values);
  }
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
// Diagnostic connectivity probes (NOT throughput metrics).
//
// PG source: `pg_isready`. Redis source: `redis-cli ping`.
// These never represent query/operation throughput and never fabricate
// samples: `queries` stays 0 by design, `connected`/`reachable` only
// reflects whether the probe command succeeded. No pg_stat_statements
// in this phase.
// ---------------------------------------------------------------------------

function pgsProbe() {
  const base = { queries: 0, errors: 0, source: "pg_isready", kind: "connectivity-probe" };
  if (!TEST_DB_URL) return { ...base, reachable: false, skipped: true };
  try {
    execFileSync("pg_isready", ["-h", "localhost", "-p", "5433"], { stdio: "ignore" });
    return { ...base, reachable: true, skipped: false };
  } catch (e) {
    return { ...base, reachable: false, skipped: false };
  }
}

function redisProbe() {
  const base = {
    connected: false,
    errors: 0,
    source: "redis-cli ping",
    kind: "connectivity-probe",
  };
  if (!REDIS_URL) return { ...base, skipped: true };
  try {
    execFileSync("redis-cli", ["-h", "localhost", "-p", "6380", "ping"], { stdio: "ignore" });
    return { ...base, connected: true, skipped: false };
  } catch (e) {
    return { ...base, connected: false, skipped: false };
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
    let runStart = performance.now();
    const results = { requests: 0, failures: 0, statusCounts: {}, durations: [] };

    // Phase 10.7: POST /sessions requires authentication. Register ONE creator
    // up front and reuse its access token. The registration request is setup,
    // not part of the measured set (it never touches `results`).
    let accessToken = null;
    function registerCreator() {
      return new Promise((resolve) => {
        const email = `load-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
        const displayName = `load-creator-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const body = JSON.stringify({ email, password: "load-test-pw-12", displayName });
        const req = http.request(
          {
            hostname,
            port,
            path: "/auth/register",
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              try {
                accessToken = JSON.parse(Buffer.concat(chunks).toString()).accessToken ?? null;
              } catch {
                accessToken = null;
              }
              resolve();
            });
          },
        );
        req.on("error", () => resolve());
        req.end(body);
      });
    }

    // The per-request monotonic id.
    let fired = 0;

    // Track in-flight requests so the snapshot waits for responses that were
    // already inflight when the duration timer fired. Without this, any request
    // whose response arrives after the timer fires is lost from the snapshot,
    // which produces all-zero results on short runs and on slow hosts.
    let inFlight = 0;
    let interval = null;
    let timeout = null;

    // Measurement invariants (Phase 8.2a): duration sample counts must equal
    // completed operation counts. A mismatch is a measurement failure, not a
    // silent zero result. The HTTP runner exposes these counters explicitly
    // and validates them before resolving the snapshot. Missing samples are
    // never fabricated or inferred.
    const stop = () => {
      const end = performance.now();
      const durationSeconds = (end - runStart) / 1000;
      const httpDurationStatistics = new Stats(results.durations);
      const httpDurationCount = httpDurationStatistics.count();
      const httpMeasurementOK = results.requests > 0 && httpDurationCount === results.requests;
      if (!httpMeasurementOK) {
        console.error(
          `[load-tests] MEASUREMENT INVALID: HTTP requests=${results.requests},` +
            ` durationSamples=${httpDurationCount}, expected=${results.requests}.` +
            ` Duration samples are authoritative; refusing to treat this as a benchmark artifact.`,
        );
      }
      const requestsPerSec = results.requests / (durationSeconds || 1e-9);
      const successfulRequestsPerSec =
        results.requests > 0
          ? (results.requests - results.failures) / (durationSeconds || 1e-9)
          : 0;
      resolve({
        // Wall-clock result timestamp (never performance.now()-derived).
        timestamp: new Date().toISOString(),
        vus: options.vus,
        scenario,
        http: {
          requests: results.requests,
          failures: results.failures,
          statusCounts: results.statusCounts,
          durationMs: httpDurationStatistics,
          httpDurationCount,
        },
        ws: {
          connections: 0,
          connectionSuccess: 0,
          connectionFail: 0,
          connectionsOpenAtEnd: 0,
          messagesReceived: 0,
          messagesSent: 0,
          connectionDurationMs: new Stats(),
          messageDurationMs: new Stats(),
        },
        pgs: pgsProbe(),
        redis: redisProbe(),
        summary: {
          durationSeconds,
          vus: options.vus,
          requestsPerSec,
          successfulRequestsPerSec,
          httpMeanMs: httpDurationCount > 0 ? httpDurationStatistics.mean() : 0,
          httpP50Ms: httpDurationCount > 0 ? httpDurationStatistics.percentile(50) : 0,
          httpP90Ms: httpDurationCount > 0 ? httpDurationStatistics.percentile(90) : 0,
          httpP95Ms: httpDurationCount > 0 ? httpDurationStatistics.percentile(95) : 0,
          httpP99Ms: httpDurationCount > 0 ? httpDurationStatistics.percentile(99) : 0,
          wsConnectionsPerSec: 0,
          wsMessageRate: 0,
        },
        measurement: {
          valid: httpMeasurementOK,
          http: {
            requests: results.requests,
            durationSamples: httpDurationCount,
            expected: results.requests,
            ok: httpMeasurementOK,
          },
        },
      });
    };

    // Shared stop helper: drain in-flight responses already on the wire
    // before snapshotting. Caps the drain wait so a hung server cannot hang
    // the harness forever; any still-missing samples then correctly trip the
    // measurement invariant above instead of being silently dropped.
    const waitStart = { at: null };
    function waitForInFlightThenStop() {
      if (waitStart.at === null) waitStart.at = performance.now();
      if (inFlight > 0 && performance.now() - waitStart.at < 10000) {
        // Give the event loop a chance to drain responses already in flight.
        setImmediate(waitForInFlightThenStop);
        return;
      }
      stop();
    }

    function scheduleOne() {
      fired += 1;
      const id = fired;
      const started = performance.now();
      const url = new URL("/sessions", base); // scenario: create session
      url.searchParams.set("name", "e2e-sess-" + Date.now() + "-" + id);
      const body = JSON.stringify({ name: url.searchParams.get("name") });
      inFlight += 1;
      http
        .request(
          {
            hostname,
            port,
            path: url.pathname + url.search,
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              ...(accessToken === null ? {} : { authorization: `Bearer ${accessToken}` }),
            },
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              // performance.now() is already milliseconds: no x1000 scaling.
              const duration = performance.now() - started;
              results.requests += 1;
              const code = res.statusCode || 0;
              results.statusCounts[code] = (results.statusCounts[code] || 0) + 1;
              if (code < 200 || code >= 400) results.failures += 1;
              results.durations.push(duration);
              inFlight -= 1;
            });
          },
        )
        .on("error", () => {
          // A transport error is still a completed attempt: it consumes one
          // duration sample and counts toward requests so that
          // durationMs.count === requests holds by construction.
          const duration = performance.now() - started;
          results.requests += 1;
          results.failures += 1;
          results.durations.push(duration);
          inFlight -= 1;
        })
        .end(body);
    }

    function startScheduling() {
      // Measure only the scenario window, not the setup registration.
      runStart = performance.now();
      // fire the first request for each VU immediately, then repeat.
      for (let i = 0; i < options.vus; i += 1) {
        scheduleOne();
      }
      interval = setInterval(() => {
        for (let i = 0; i < options.vus; i += 1) {
          scheduleOne();
        }
      }, 1000 / options.vus);

      // stop the run after the specified duration. Wait for in-flight responses
      // to be counted before snapshotting so short runs are not empty.
      timeout = setTimeout(() => {
        clearInterval(interval);
        waitForInFlightThenStop();
      }, options.durationMs);
    }

    registerCreator().then(startScheduling);
  });
}

// ---------------------------------------------------------------------------
// WebSocket client (real sockets, real app)
// ---------------------------------------------------------------------------

function websocketScenario(options) {
  return new Promise(async (resolve) => {
    // Phase 1: Create a real session via HTTP (setup, outside measured window)
    // Reuse the same pattern as HTTP scenario: register a creator, create session
    const base = new URL(BASE_URL);
    const hostname = base.hostname;
    const port = Number(base.port || (base.protocol === "https:" ? 443 : 80));

    let accessToken = null;
    let sessionId = null;

    // Register creator and create session (setup phase, not measured)
    await new Promise((resolveSetup) => {
      const email = `load-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
      const displayName = `load-creator-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const body = JSON.stringify({ email, password: "load-test-pw-12", displayName });
      const req = http.request(
        {
          hostname,
          port,
          path: "/auth/register",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              accessToken = JSON.parse(Buffer.concat(chunks).toString()).accessToken ?? null;
            } catch {
              accessToken = null;
            }
            resolveSetup();
          });
        },
      );
      req.on("error", () => resolveSetup());
      req.end(body);
    });

    if (!accessToken) {
      console.error("[load-tests] Failed to register creator for WebSocket scenario");
      resolve(buildInvalidSnapshot(options.vus, "creator registration failed"));
      return;
    }

    await new Promise((resolveSetup) => {
      const sessionName = `load-ws-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const body = JSON.stringify({ name: sessionName });
      const req = http.request(
        {
          hostname,
          port,
          path: "/sessions",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            authorization: `Bearer ${accessToken}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString());
              sessionId = body.session?.id ?? null;
            } catch {
              sessionId = null;
            }
            resolveSetup();
          });
        },
      );
      req.on("error", () => resolveSetup());
      req.end(body);
    });

    if (!sessionId) {
      console.error("[load-tests] Failed to create session for WebSocket scenario");
      resolve(buildInvalidSnapshot(options.vus, "session creation failed"));
      return;
    }

    console.log(`[load-tests] WebSocket scenario using session ${sessionId}`);

    // Phase 2: Measured WebSocket scenario
    const runStart = performance.now();
    let seq = 0;
    const clients = new Map();
    const connectionEstablishmentDuration = new Stats(); // Time from dial to open
    const connectionLifetimeDuration = new Stats(); // Time from open to close/stop
    const messageRoundtripDuration = new Stats();
    let connectionSuccess = 0;
    let connectionFail = 0;
    let connectionTimeouts = 0;
    let protocolErrors = 0;
    let unexpectedCloses = 0;
    let messagesSent = 0;
    let messagesReceived = 0;
    let joinResponsesReceived = 0;
    let timeout = null;

    // Track in-flight join requests for correlation
    const pendingJoins = new Map(); // requestId -> { startTime, record }

    function scheduleConnection() {
      const id = ++seq;
      const dialStartAt = performance.now(); // Start of connection attempt
      const record = {
        id,
        socket: null,
        dialStartAt,
        opened: false,
        connectedAt: null, // Set at open event
        connectionDurationRecorded: false,
        lifetimeDurationRecorded: false,
        joinRequestId: null,
        joinStartTime: null,
      };
      const ws = new WebSocket(WS_URL + "?vu=" + id);
      record.socket = ws;
      clients.set(id, record);

      ws.once("open", () => {
        const openAt = performance.now();
        record.opened = true;
        record.connectedAt = openAt;
        connectionSuccess += 1;

        // Record connection establishment latency (dial to open)
        connectionEstablishmentDuration.push(openAt - record.dialStartAt);

        // Send session.join with unique requestId
        const requestId = `join-${id}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        record.joinRequestId = requestId;
        record.joinStartTime = performance.now();

        const payload = JSON.stringify({
          type: "session.join",
          requestId,
          payload: { sessionId },
        });
        try {
          ws.send(payload);
          messagesSent += 1;
          // Track this in-flight request
          pendingJoins.set(requestId, { startTime: record.joinStartTime, record });
        } catch (e) {
          // send failure surfaces as an error/close below; do not double-count.
        }
      });

      ws.once("error", (err) => {
        // Transport-level failure
        connectionFail += 1;
        if (record.opened && !record.connectionDurationRecorded) {
          record.connectionDurationRecorded = true;
          connectionLifetimeDuration.push(performance.now() - record.connectedAt);
        }
      });

      ws.once("close", (code, reason) => {
        if (record.opened && !record.lifetimeDurationRecorded) {
          record.lifetimeDurationRecorded = true;
          connectionLifetimeDuration.push(performance.now() - record.connectedAt);
        }
        // Track unexpected closes (not clean 1000/1001)
        if (record.opened && code !== 1000 && code !== 1001) {
          unexpectedCloses += 1;
        }
        clients.delete(id);
      });

      ws.on("message", (data) => {
        messagesReceived += 1;
        try {
          const frame = JSON.parse(String(data));
          // Correlate by requestId and expected type
          if (frame.requestId && pendingJoins.has(frame.requestId)) {
            const pending = pendingJoins.get(frame.requestId);
            if (pending && frame.type === "session.joined") {
              // Valid response to our join request
              const latency = performance.now() - pending.startTime;
              messageRoundtripDuration.push(latency);
              joinResponsesReceived += 1;
              pendingJoins.delete(frame.requestId);
              return;
            }
            // If it's an error response to our join, still count as completed
            if (pending && frame.type === "error") {
              const latency = performance.now() - pending.startTime;
              messageRoundtripDuration.push(latency);
              protocolErrors += 1;
              pendingJoins.delete(frame.requestId);
              return;
            }
          }
          // Ignore unrelated frames (broadcasts, session.state, etc.)
          // They are counted in messagesReceived but NOT in round-trip latency
        } catch (e) {
          protocolErrors += 1;
        }
      });
    }

    function stop() {
      const stopAt = performance.now();

      // Count any pending joins that timed out
      connectionTimeouts = pendingJoins.size;
      pendingJoins.clear();

      // Capture completed connection lifetimes for sockets still open at stop
      clients.forEach((rec) => {
        if (rec.opened && !rec.lifetimeDurationRecorded) {
          rec.lifetimeDurationRecorded = true;
          connectionLifetimeDuration.push(stopAt - rec.connectedAt);
        }
      });

      const connectionsOpenAtEnd = [...clients.values()].filter((r) => r.opened).length;
      const totalConnections = connectionSuccess;

      clients.forEach((c) => {
        try {
          c.socket.terminate();
        } catch (e) {}
      });

      if (timeout) clearTimeout(timeout);

      const durationSeconds = (stopAt - runStart) / 1000;
      const summary = {
        durationSeconds,
        vus: options.vus,
        connections: totalConnections,
        connectivity: connectionSuccess,
        failures: connectionFail,
        openAtEnd: connectionsOpenAtEnd,
        messagesReceived,
        messagesSent,
      };

      resolve(buildSnapshot("websocket-connections", options.vus, summary, {
        connectionEstablishmentDuration,
        connectionLifetimeDuration,
        messageRoundtripDuration,
        connectionSuccess,
        connectionFail,
        connectionTimeouts,
        protocolErrors,
        unexpectedCloses,
        messagesReceived,
        messagesSent,
        joinResponsesReceived,
      }));
    }

    function buildSnapshot(scenario, vus, summary, metrics) {
      const connectionEstablishmentCount = metrics.connectionEstablishmentDuration.count();
      const connectionLifetimeCount = metrics.connectionLifetimeDuration.count();
      const messageDurationCount = metrics.messageRoundtripDuration.count();

      // Invariants:
      // - one connection-establishment sample per successfully opened connection
      // - one connection-lifetime sample per successfully opened connection
      // - one message-duration sample per *completed measured operation* (join response)
      const connEstabOK =
        metrics.connectionSuccess === 0
          ? connectionEstablishmentCount === 0
          : connectionEstablishmentCount === metrics.connectionSuccess;
      const connLifetimeOK =
        metrics.connectionSuccess === 0
          ? connectionLifetimeCount === 0
          : connectionLifetimeCount === metrics.connectionSuccess;
      const msgOK = messageDurationCount === metrics.joinResponsesReceived;
      const wsMeasurementOK = metrics.connectionSuccess > 0 && connEstabOK && connLifetimeOK && msgOK;

      if (!wsMeasurementOK) {
        console.error(
          `[load-tests] MEASUREMENT INVALID (ws): success=${metrics.connectionSuccess},` +
            ` estabSamples=${connectionEstablishmentCount}, lifetimeSamples=${connectionLifetimeCount},` +
            ` joinResponses=${metrics.joinResponsesReceived}, msgSamples=${messageDurationCount},` +
            ` timeouts=${metrics.connectionTimeouts}, protocolErrors=${metrics.protocolErrors},` +
            ` unexpectedCloses=${metrics.unexpectedCloses}. Refusing to treat this as a benchmark artifact.`,
        );
      }

      return {
        timestamp: new Date().toISOString(),
        vus,
        scenario,
        http: { requests: 0, failures: 0, durationMs: new Stats(), statusCounts: {} },
        ws: {
          connections: summary.connections,
          connectionSuccess: summary.connectivity,
          connectionFail: summary.failures,
          connectionTimeouts: metrics.connectionTimeouts,
          protocolErrors: metrics.protocolErrors,
          unexpectedCloses: metrics.unexpectedCloses,
          connectionsOpenAtEnd: summary.openAtEnd,
          messagesReceived: summary.messagesReceived,
          messagesSent: summary.messagesSent,
          joinResponsesReceived: metrics.joinResponsesReceived,
          connectionEstablishmentDurationMs: metrics.connectionEstablishmentDuration,
          connectionLifetimeDurationMs: metrics.connectionLifetimeDuration,
          messageRoundtripDurationMs: metrics.messageRoundtripDuration,
          connectionEstablishmentCount,
          connectionLifetimeCount,
          messageDurationCount,
        },
        pgs: pgsProbe(),
        redis: redisProbe(),
        summary: {
          durationSeconds: summary.durationSeconds,
          vus,
          requestsPerSec: 0,
          successfulRequestsPerSec: 0,
          wsConnectionsPerSec: summary.connections / (summary.durationSeconds || 1e-9),
          wsMessageRate: summary.messagesReceived / (summary.durationSeconds || 1e-9),
          wsMeanConnectionEstabMs: connectionEstablishmentCount > 0 ? metrics.connectionEstablishmentDuration.mean() : 0,
          wsP50ConnectionEstabMs: connectionEstablishmentCount > 0 ? metrics.connectionEstablishmentDuration.percentile(50) : 0,
          wsP90ConnectionEstabMs: connectionEstablishmentCount > 0 ? metrics.connectionEstablishmentDuration.percentile(90) : 0,
          wsP95ConnectionEstabMs: connectionEstablishmentCount > 0 ? metrics.connectionEstablishmentDuration.percentile(95) : 0,
          wsP99ConnectionEstabMs: connectionEstablishmentCount > 0 ? metrics.connectionEstablishmentDuration.percentile(99) : 0,
          wsMeanConnectionLifetimeMs: connectionLifetimeCount > 0 ? metrics.connectionLifetimeDuration.mean() : 0,
          wsP50ConnectionLifetimeMs: connectionLifetimeCount > 0 ? metrics.connectionLifetimeDuration.percentile(50) : 0,
          wsP90ConnectionLifetimeMs: connectionLifetimeCount > 0 ? metrics.connectionLifetimeDuration.percentile(90) : 0,
          wsP95ConnectionLifetimeMs: connectionLifetimeCount > 0 ? metrics.connectionLifetimeDuration.percentile(95) : 0,
          wsP99ConnectionLifetimeMs: connectionLifetimeCount > 0 ? metrics.connectionLifetimeDuration.percentile(99) : 0,
          wsMeanMessageMs: messageDurationCount > 0 ? metrics.messageRoundtripDuration.mean() : 0,
          wsP50MessageMs: messageDurationCount > 0 ? metrics.messageRoundtripDuration.percentile(50) : 0,
          wsP90MessageMs: messageDurationCount > 0 ? metrics.messageRoundtripDuration.percentile(90) : 0,
          wsP95MessageMs: messageDurationCount > 0 ? metrics.messageRoundtripDuration.percentile(95) : 0,
          wsP99MessageMs: messageDurationCount > 0 ? metrics.messageRoundtripDuration.percentile(99) : 0,
        },
        measurement: {
          valid: wsMeasurementOK,
          ws: {
            connectionSuccess: metrics.connectionSuccess,
            connectionEstablishmentSamples: connectionEstablishmentCount,
            connectionEstablishmentExpected: metrics.connectionSuccess,
            connectionEstablishmentOk: connEstabOK,
            connectionLifetimeSamples: connectionLifetimeCount,
            connectionLifetimeExpected: metrics.connectionSuccess,
            connectionLifetimeOk: connLifetimeOK,
            connectionFail: metrics.connectionFail,
            connectionTimeouts: metrics.connectionTimeouts,
            protocolErrors: metrics.protocolErrors,
            unexpectedCloses: metrics.unexpectedCloses,
            joinResponsesReceived: metrics.joinResponsesReceived,
            messageSamples: messageDurationCount,
            messageExpected: metrics.joinResponsesReceived,
            messageOk: msgOK,
            ok: wsMeasurementOK,
          },
        },
      };
    }

    function buildInvalidSnapshot(vus, reason) {
      return {
        timestamp: new Date().toISOString(),
        vus,
        scenario: "websocket-connections",
        http: { requests: 0, failures: 0, durationMs: new Stats(), statusCounts: {} },
        ws: {
          connections: 0, connectionSuccess: 0, connectionFail: 0, connectionTimeouts: 0,
          protocolErrors: 0, unexpectedCloses: 0, connectionsOpenAtEnd: 0,
          messagesReceived: 0, messagesSent: 0, joinResponsesReceived: 0,
          connectionEstablishmentDurationMs: new Stats(), connectionLifetimeDurationMs: new Stats(),
          messageRoundtripDurationMs: new Stats(),
          connectionEstablishmentCount: 0, connectionLifetimeCount: 0, messageDurationCount: 0,
        },
        pgs: pgsProbe(),
        redis: redisProbe(),
        summary: { durationSeconds: 0, vus, requestsPerSec: 0, successfulRequestsPerSec: 0,
          wsConnectionsPerSec: 0, wsMessageRate: 0,
          wsMeanConnectionEstabMs: 0, wsP50ConnectionEstabMs: 0, wsP90ConnectionEstabMs: 0, wsP95ConnectionEstabMs: 0, wsP99ConnectionEstabMs: 0,
          wsMeanConnectionLifetimeMs: 0, wsP50ConnectionLifetimeMs: 0, wsP90ConnectionLifetimeMs: 0, wsP95ConnectionLifetimeMs: 0, wsP99ConnectionLifetimeMs: 0,
          wsMeanMessageMs: 0, wsP50MessageMs: 0, wsP90MessageMs: 0, wsP95MessageMs: 0, wsP99MessageMs: 0 },
        measurement: { valid: false, ws: { ok: false, reason } },
      };
    }

    // Start connections
    for (let i = 0; i < options.vus; i += 1) {
      scheduleConnection();
    }

    timeout = setTimeout(() => {
      stop();
    }, options.durationMs);
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
  console.log(
    "[load-tests] scenario=" +
      scenarioName +
      " vus=" +
      vus +
      " duration=" +
      durationMs +
      "ms base=" +
      BASE_URL,
  );
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
  console.log(
    JSON.stringify(
      {
        timestamp: snapshot.timestamp,
        vus,
        scenario: snapshot.scenario,
        durationSeconds: elapsed,
        http: {
          requests: http.requests,
          failures: http.failures,
          requestsPerSec: http.requests / elapsed,
          successfulRequestsPerSec: (http.requests - http.failures) / elapsed,
          statusCounts: http.statusCounts,
          durationMs: http.durationMs,
        },
        ws: {
          connections: ws.connections,
          connectionSuccess: ws.connectionSuccess,
          connectionFail: ws.connectionFail,
          connectionTimeouts: ws.connectionTimeouts,
          protocolErrors: ws.protocolErrors,
          unexpectedCloses: ws.unexpectedCloses,
          connectionsOpenAtEnd: ws.connectionsOpenAtEnd,
          messagesReceived: ws.messagesReceived,
          messagesSent: ws.messagesSent,
          joinResponsesReceived: ws.joinResponsesReceived,
          connectionEstablishmentDurationMs: ws.connectionEstablishmentDurationMs,
          connectionLifetimeDurationMs: ws.connectionLifetimeDurationMs,
          messageRoundtripDurationMs: ws.messageRoundtripDurationMs,
        },
        pgs: snapshot.pgs,
        redis: snapshot.redis,
        measurement: snapshot.measurement,
        summary: {
          durationSeconds: elapsed,
          vus,
          requestsPerSec: http.requests / elapsed,
          successfulRequestsPerSec: (http.requests - http.failures) / elapsed,
          wsConnectionsPerSec: ws.connections / elapsed,
          httpMeanMs: http.durationMs.mean(),
          httpP50Ms: http.durationMs.percentile(50),
          httpP90Ms: http.durationMs.percentile(90),
          httpP95Ms: http.durationMs.percentile(95),
          httpP99Ms: http.durationMs.percentile(99),
          wsMeanConnectionEstabMs: summary.wsMeanConnectionEstabMs,
          wsP50ConnectionEstabMs: summary.wsP50ConnectionEstabMs,
          wsP90ConnectionEstabMs: summary.wsP90ConnectionEstabMs,
          wsP95ConnectionEstabMs: summary.wsP95ConnectionEstabMs,
          wsP99ConnectionEstabMs: summary.wsP99ConnectionEstabMs,
          wsMeanConnectionLifetimeMs: summary.wsMeanConnectionLifetimeMs,
          wsP50ConnectionLifetimeMs: summary.wsP50ConnectionLifetimeMs,
          wsP90ConnectionLifetimeMs: summary.wsP90ConnectionLifetimeMs,
          wsP95ConnectionLifetimeMs: summary.wsP95ConnectionLifetimeMs,
          wsP99ConnectionLifetimeMs: summary.wsP99ConnectionLifetimeMs,
          wsMeanMessageMs: summary.wsMeanMessageMs,
          wsP50MessageMs: summary.wsP50MessageMs,
          wsP90MessageMs: summary.wsP90MessageMs,
          wsP95MessageMs: summary.wsP95MessageMs,
          wsP99MessageMs: summary.wsP99MessageMs,
          wsMessageRate: ws.messagesReceived / elapsed,
        },
      },
      null,
      2,
    ),
  );

  // append a JSON summary to the results directory
  try {
    const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "results");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const fname = scenarioName + "-" + vus + "VUs-" + Date.now() + ".json";
    fs.writeFileSync(
      path.join(outDir, fname),
      JSON.stringify({ ...snapshot, durationSeconds: elapsed }, null, 2),
    );
    console.log("\n[load-tests] wrote " + path.join(outDir, fname));
  } catch (e) {
    console.error("[load-tests] could not write results:", e.message);
  }
}

main().catch((err) => {
  console.error("[load-tests] FATAL", err);
  process.exit(1);
});
