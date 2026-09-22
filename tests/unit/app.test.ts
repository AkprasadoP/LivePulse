import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app/app.js";
import { loadConfig } from "../../src/config/index.js";
import type { FastifyInstance } from "fastify";

// These tests exercise the real application wiring. PrismaClient is lazily
// connected (no query is executed here), so no database is required.
// The config source is explicit: Vitest does not load `.env` files, and tests
// must not depend on a local env file existing.
const testConfig = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://livepulse:livepulse@localhost:5433/livepulse",
  REDIS_URL: "redis://localhost:6380",
});

describe("application", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ config: testConfig });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("boots and becomes ready", () => {
    expect(app.ready).toBeTruthy();
  });

  it("GET /health returns 200 with status ok", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("GET / returns service identification", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ name: "livepulse", status: "ok" });
  });

  it("returns 404 JSON for unknown routes", async () => {
    const response = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ statusCode: 404 });
  });
});
