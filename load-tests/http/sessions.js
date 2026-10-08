// Phase 8.1 — HTTP session baseline scenario.
//
// k6 scenario shape (the intended interpreter). When k6 is installed:
//   k6 run load-tests/http/sessions.js --vus 10 --duration 30s
// This file is also runnable by the zero-dependency Node fallback
// (load-tests/run.js --scenario http-sessions).
//
// Baseline goals:
//   - POST /sessions creates a real session with a unique name per VU/iter
//   - a creator is registered once in setup(); every request carries that
//     bearer token (Phase 10.7: POST /sessions requires authentication)
//   - record status-code distribution, request count, failures, and latency
//
// Not a capacity claim: in 8.1 we only validate that the instrumented stack
// accepts and persists a valid session creation request.

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";

// Native metrics (k6-native): one series per scenario run.
export const httpDuration = new Trend("http_duration_ms");
export const httpRequests = new Counter("http_requests");
export const httpStatuses = new Counter("http_statuses");
export const httpFailures = new Counter("http_failures");

// Warm-up: 10 VUs, 30 seconds. The goal is to **validate the instrumented
// stack**, not to size a system under load.
export const options = {
  stages: [{ duration: "30s", target: 10 }],
  thresholds: {
    // No performance targets — these are recorded, not asserted.
    http_duration_ms: ["p(95)<1000"], // provisional only; replaced by measured data in 8.2
  },
};

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:3000";

// Keep every VU/iter distinct so the smoke exercises the happy path.
export function generateSessionName(vu, iter) {
  return `e2e-sesh-${vu}-${iter}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// Phase 10.7: POST /sessions requires authentication. Register ONE creator in
// setup() (k6 runs setup once per test) and reuse its access token for every
// VU — sessions stay distinct; the creator identity is authenticated, never a
// client-supplied displayName.
export function setup() {
  const email = `load-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const displayName = `load-creator-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const res = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ email, password: "load-test-pw-12", displayName }),
    { headers: { "content-type": "application/json" } },
  );
  check(res, { "creator registered (201)": (r) => r.status === 201 });
  return { accessToken: res.json("accessToken") };
}

export default function (data) {
  const sessionName = generateSessionName(__VU, __ITER);

  const url = new URL(BASE_URL);
  url.pathname = "/sessions";
  url.searchParams.set("name", sessionName);

  const res = http.request("POST", url.toString(), JSON.stringify({ name: sessionName }), {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${data.accessToken}`,
    },
  });

  httpRequests.add(1);
  httpStatuses.add(res.status);
  const status = res.status;
  const ok = status === 201;
  if (ok) {
    httpDuration.add(res.timings.duration);
  } else {
    httpFailures.add(1);
  }

  check(res, {
    "HTTP 201 created": (r) => r.status === 201,
    "response has a session id": (r) => {
      try {
        const body = r.json();
        return !!body.session && typeof body.session.id === "string";
      } catch {
        return false;
      }
    },
  });

  // A failed HTTP request is a valid observation for the baseline. We record it
  // rather than hard-terminating the scenario. The harness/Node fallback mirrors
  // this behavior: failures are counted, not silently accepted as success.
  if (status >= 400) {
    // Do not swallow the failure or reinterpret 409 as success. Record it.
    const body = res.body ?? "";
    console.error(
      `[load-tests/http/sessions] unexpected status ${status} for ${url.toString()}: ${body.slice(0, 500)}`,
    );
  }

  sleep(0.25);
}
