// Phase 8.1 — real WebSocket connection scenario (not a mock server).
//
// Opens a real `ws://<BASE_URL>/ws`, joins a real session, validates the
// `session.joined` envelope, keeps the connection alive, and closes cleanly.
//
// k6 usage (planned):
//   k6 run load-tests/websocket/connections.js --vus 10 --duration 30s
//
// The same scenario is runnable today by the zero-dep Node fallback:
//   node load-tests/run.js --vus 10 --duration 30s --scenario websocket-connections

import { WebSocket } from "k6/ws";
import { check, sleep, fail } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

export const errorRate = new Rate("ws_error_rate");
export const wsDuration = new Trend("ws_duration_ms");
export const wsConnections = new Counter("ws_connections");
export const wsMessagesReceived = new Counter("ws_messages_received");
export const wsMessagesSent = new Counter("ws_messages_sent");

// Warm-up: 10 VUs, 30 seconds.
export const options = {
  stages: [{ duration: "30s", target: 10 }],
  thresholds: {
    // provisional only; no performance target asserted in 8.1
    ws_duration_ms: ["p(95)<1000"],
  },
};

const BASE_URL = __ENV.BASE_URL || "ws://127.0.0.1:3000";
const WS_PATH = BASE_URL.replace(/^ws/, "ws");

export default function () {
  const params = {
    origin: "http://localhost",
    // deterministic per-VU identifier (k6 injects __VU)
    query: { vu: String(__VU) },
  };

  const ws = new WebSocket(`${WS_PATH}/ws`, params);

  ws.on("open", () => {
    wsConnections.add(1);
    const started = Date.now();
    ws.send(
      JSON.stringify({
        type: "session.join",
        requestId: `vu-${__VU}-${__ITER}`,
        // View-only join: Phase 10.7 removed the displayName identity field,
        // and this scenario measures connection/message throughput — it binds
        // no participant. (An authenticated join would send auth.authenticate
        // with an access token first.)
        payload: {
          sessionId: "00000000-0000-0000-0000-000000000000", // must exist; run with a live test stack
        },
      }),
    );
  });

  ws.on("message", (data) => {
    wsMessagesReceived.add(1);
    try {
      const frame = JSON.parse(new TextDecoder().decode(data));
      if (frame.type === "session.joined") {
        check(frame, {
          "server replies with session.joined": () => !!frame.payload?.sessionId,
        });
      }
    } catch {
      // non-JSON frame: observed, not an error for the purpose of the WS
      // connection smoke (the alternative is to hard-fail on frames we do not
      // understand — we record instead).
    }
  });

  ws.on("error", (e) => {
    errorRate.add(1);
    fail(`WS error: ${e.message}`);
  });

  ws.on("close", (code) => {
    // keep connection alive for the stage; close on a clean timer so the
    // baseline measures sustained open connections
  });

  // clean close after the stage; a hard timeout here would be a scenario bug
  // rather than a measurement of natural churn
  setTimeout(() => {
    try {
      ws.close(1000, "k6 stage ended");
    } catch {
      // already closed
    }
  }, 30000);
}
