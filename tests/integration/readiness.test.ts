import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app/app.js";
import { loadConfig } from "../../src/config/index.js";
import { TEST_DATABASE_URL, resetDatabase, startIndependentInstance } from "./helpers.js";
import { PrismaClient } from "@prisma/client";

/**
 * Phase 9.5 readiness contract (/health vs /ready).
 *
 * - /health stays liveness-only (200 while the loop serves).
 * - /ready is traffic readiness: 200 iff PostgreSQL answers; Redis only
 *   ever reports ok/degraded and can never flip the code to 503.
 */
describe("readiness (Phase 9.5)", () => {
  it("R1 — healthy instance: /health 200 unchanged, /ready 200 ready+ok+ok", async () => {
    const instance = await startIndependentInstance("ws-ready-healthy");
    try {
      const health = await instance.app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: "ok" });

      const ready = await instance.app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ ready: true, postgres: "ok", redis: "ok" });
    } finally {
      await instance.close();
    }
  });

  it("R2 — PostgreSQL unreachable: /health stays 200, /ready is 503 with no leaked internals", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://livepulse:livepulse@localhost:5499/livepulse_test",
      REDIS_URL: process.env.LIVEPULSE_TEST_REDIS_URL ?? "redis://localhost:6380",
      PORT: "0",
      INSTANCE_ID: "ws-ready-nopg",
    });
    const app = await buildApp({ config, listen: true });
    try {
      // Let the initial Redis handshake settle so the redis dimension is
      // deterministic (resolves even when Redis is unreachable).
      await app.wsLayer?.distributionReady;
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toEqual({ ready: false, postgres: "unavailable", redis: "ok" });
    } finally {
      await app.close();
    }
  });

  it("R3 — Redis unreachable: /ready stays 200 degraded and local operation still works", async () => {
    const prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
    await resetDatabase(prisma);
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: "redis://localhost:6399",
      PORT: "0",
      INSTANCE_ID: "ws-ready-noredis",
    });
    const app = await buildApp({ config, listen: true });
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ ready: true, postgres: "ok", redis: "degraded" });

      // Degraded is serving, not outage: session creation (PG-backed) works.
      const created = await app.inject({
        method: "POST",
        url: "/sessions",
        payload: JSON.stringify({
          name: `ready-local-${Date.now()}`,
          creator: { displayName: `ready-local-${Date.now()}` },
        }),
        headers: { "content-type": "application/json" },
      });
      expect(created.statusCode).toBe(201);
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  it("R4 — distribution disabled by config reads as degraded, never unready", async () => {
    const instance = await startIndependentInstance("ws-ready-nodist", {
      distributionEnabled: false,
    });
    try {
      const ready = await instance.app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ ready: true, postgres: "ok", redis: "degraded" });
    } finally {
      await instance.close();
    }
  });
});
