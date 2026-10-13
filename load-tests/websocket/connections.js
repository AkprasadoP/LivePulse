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
//
// Measurement correctness (Phase 8.2a):
// - Setup: create a real session via HTTP in setup() (outside measured window)
// - Each VU connects, sends session.join with unique requestId
// - Latency measured from send to matching session.joined response (by requestId)
// - Connection establishment latency reported separately from message round-trip
// - Connection lifetime (open to close) reported as separate metric
// - Unrelated broadcasts (presence.snapshot, session.state) are ignored for latency
// - Timeouts, protocol errors, unexpected closes tracked separately

import { WebSocket } from "k6/ws";
import { check, sleep, fail } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";
import http from "k6/http";

// Native metrics (k6-native): one series per scenario run.
export const wsErrorRate = new Rate("ws_error_rate");
export const wsConnectionEstablishmentDuration = new Trend("ws_connection_establishment_duration_ms");
export const wsConnectionLifetimeDuration = new Trend("ws_connection_lifetime_duration_ms");
export const wsMessageRoundtripDuration = new Trend("ws_message_roundtrip_duration_ms");
export const wsConnections = new Counter("ws_connections");
export const wsConnectionSuccess = new Counter("ws_connection_success");
export const wsConnectionFail = new Counter("ws_connection_fail");
export const wsConnectionTimeouts = new Counter("ws_connection_timeouts");
export const wsProtocolErrors = new Counter("ws_protocol_errors");
export const wsUnexpectedCloses = new Counter("ws_unexpected_closes");
export const wsMessagesReceived = new Counter("ws_messages_received");
export const wsMessagesSent = new Counter("ws_messages_sent");
export const wsJoinResponsesReceived = new Counter("ws_join_responses_received");

// Warm-up: 2 VUs, 5 seconds (first local smoke test)
export const options = {
  stages: [{ duration: "5s", target: 2 }],
  thresholds: {
    // provisional only; no performance target asserted in 8.1
    ws_message_roundtrip_duration_ms: ["p(95)<1000"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:3000";
const WS_URL = BASE_URL.replace(/^http/, "ws");

// Setup: create a real session via HTTP (outside measured window)
export function setup() {
  // Register creator
  const email = `load-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const displayName = `load-creator-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const regRes = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ email, password: "load-test-pw-12", displayName }),
    { headers: { "content-type": "application/json" } },
  );
  check(regRes, { "creator registered (201)": (r) => r.status === 201 });
  const accessToken = regRes.json("accessToken");

  // Create session
  const sessionName = `load-ws-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const sessRes = http.post(
    `${BASE_URL}/sessions`,
    JSON.stringify({ name: sessionName }),
    { headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` } },
  );
  check(sessRes, { "session created (201)": (r) => r.status === 201 });
  const sessionId = sessRes.json("session.id");

  console.log(`[load-tests] WebSocket scenario using session ${sessionId}`);
  return { sessionId };
}

export default function (data) {
  const sessionId = data.sessionId;
  const params = {
    origin: "http://localhost",
    // deterministic per-VU identifier (k6 injects __VU)
    query: { vu: String(__VU) },
  };

  const ws = new WebSocket(`${WS_URL}/ws`, params);
  const connectionStart = Date.now();
  let connectionEstablished = false;
  let connectedAt = null;
  let joinRequestId = null;
  let joinStartTime = null;

  ws.on("open", () => {
    wsConnections.add(1);
    wsConnectionSuccess.add(1);
    connectionEstablished = true;
    connectedAt = Date.now();
    wsConnectionEstablishmentDuration.add(connectedAt - connectionStart);

    // Send session.join with unique requestId
    joinRequestId = `join-vu-${__VU}-iter-${__ITER}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    joinStartTime = Date.now();
    ws.send(
      JSON.stringify({
        type: "session.join",
        requestId: joinRequestId,
        payload: { sessionId },
      }),
    );
    wsMessagesSent.add(1);
  });

  ws.on("message", (data) => {
    wsMessagesReceived.add(1);
    try {
      const frame = JSON.parse(new TextDecoder().decode(data));
      // Correlate by requestId and expected type
      if (frame.requestId === joinRequestId) {
        if (frame.type === "session.joined") {
          check(frame, {
            "server replies with session.joined": () => !!frame.payload?.sessionId,
          });
          const latency = Date.now() - joinStartTime;
          wsMessageRoundtripDuration.add(latency);
          wsJoinResponsesReceived.add(1);
          joinRequestId = null; // only measure first join response
          joinStartTime = null;
        } else if (frame.type === "error") {
          // Error response to our join - still a completed operation
          const latency = Date.now() - joinStartTime;
          wsMessageRoundtripDuration.add(latency);
          wsProtocolErrors.add(1);
          wsJoinResponsesReceived.add(1);
          joinRequestId = null;
          joinStartTime = null;
        }
        // Ignore unrelated frames (presence.snapshot, session.state, etc.)
        // They are counted in messagesReceived but NOT in round-trip latency
      }
    } catch {
      // non-JSON frame: observed, not an error for the purpose of the WS
      // connection smoke (the alternative is to hard-fail on frames we do not
      // understand — we record instead).
      wsProtocolErrors.add(1);
    }
  });

  ws.on("error", (e) => {
    wsErrorRate.add(1);
    wsConnectionFail.add(1);
    fail(`WS error: ${e.message}`);
  });

  ws.on("close", (code) => {
    if (connectionEstablished && connectedAt !== null) {
      // Record connection lifetime (open to close)
      wsConnectionLifetimeDuration.add(Date.now() - connectedAt);
      // Track unexpected closes (not clean 1000/1001)
      if (code !== 1000 && code !== 1001) {
        wsUnexpectedCloses.add(1);
      }
    }
  });

  // Track timeout for join response
  setTimeout(() => {
    if (joinRequestId !== null) {
      wsConnectionTimeouts.add(1);
      joinRequestId = null;
      joinStartTime = null;
    }
  }, 10000); // 10s timeout for join response

  // clean close after the stage
  setTimeout(() => {
    try {
      ws.close(1000, "k6 stage ended");
    } catch {
      // already closed
    }
  }, 5000);
}
