import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { once } from "node:events";
import { PrismaClient } from "@prisma/client";
import {
  startListeningServer,
  stopTestApp,
  resetDatabase,
  WsTestClient,
  connectWsClient,
  waitFor,
  TEST_DATABASE_URL,
} from "./helpers.js";
import { loadConfig } from "../../src/config/index.js";
import { buildApp } from "../../src/app/app.js";

/**
 * WebSocket connection lifecycle tests — real TCP + HTTP upgrade + real ws
 * clients against the shared listening test server (helpers.ts). No socket
 * mocks anywhere.
 */
describe("WebSocket connection lifecycle (integration)", () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    const server = await startListeningServer();
    app = server.app;
    port = server.port;
  });

  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("completes a real WebSocket upgrade at /ws", async () => {
    const client = await connectWsClient();
    expect(client.isOpen).toBe(true);
    await client.close();
  });

  it("answers 426 for plain HTTP GET /ws without an Upgrade header", async () => {
    // The shared test app serves plain HTTP through app.inject too; the /ws
    // route is a normal GET handler that replies 426 without an Upgrade header.
    const response = await app.inject({ method: "GET", url: "/ws" });
    expect(response.statusCode).toBe(426);
    expect(response.json()).toMatchObject({ statusCode: 426, error: "Upgrade Required" });
  });

  it("closes an unknown upgrade target by destroying the socket before handshake", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/not-ws`);
    // The server destroys the TCP socket pre-handshake: the client observes
    // a transport-level failure (ECONNRESET/socket hang up), never a 101.
    // NB: events.once() RESOLVES with 'error' event args — do not use rejects.
    const [error] = (await once(socket, "error")) as [Error];
    expect(error).toBeInstanceOf(Error);
  });

  it("tracks multiple connections to the same session independently", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: JSON.stringify({ name: "Multi-conn" }),
      headers: { "content-type": "application/json" },
    });
    const sessionId = (created.json() as { session: { id: string } }).session.id;

    const first = await connectWsClient();
    const second = await connectWsClient();
    const third = await connectWsClient();

    for (const client of [first, second, third]) {
      client.send({ type: "session.join", requestId: "r", payload: { sessionId } });
      const joined = await client.waitFor((m) => m.type === "session.joined");
      expect(joined.payload).toMatchObject({ sessionId, state: "CREATED" });
    }

    const layer = app.wsLayer;
    expect(layer).not.toBeNull();
    expect(layer?.registry.countForSession(sessionId)).toBe(3);
    expect(layer?.connectionCount).toBe(3);

    // Leaving removes exactly one member; the others stay tracked.
    second.send({ type: "session.leave", requestId: "r2", payload: {} });
    await second.waitFor((m) => m.type === "session.state");
    await waitFor(() => layer?.registry.countForSession(sessionId) === 2);
    expect(layer?.registry.countForSession(sessionId)).toBe(2);
    expect(layer?.connectionCount).toBe(3); // still connected, just detached

    await first.close();
    await second.close();
    await third.close();
    await waitFor(() => layer?.connectionCount === 0);
  });

  it("removes a connection from the registry when its socket closes", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: JSON.stringify({ name: "Cleanup" }),
      headers: { "content-type": "application/json" },
    });
    const sessionId = (created.json() as { session: { id: string } }).session.id;

    const layer = app.wsLayer;
    const client = await connectWsClient();
    client.send({ type: "session.join", requestId: "r", payload: { sessionId } });
    await client.waitFor((m) => m.type === "session.joined");
    expect(layer?.registry.countForSession(sessionId)).toBe(1);

    await client.close(1000);
    await waitFor(() => layer?.registry.countForSession(sessionId) === 0);
    expect(layer?.connectionCount).toBe(0);
  });

  it("shuts down cleanly with open WebSocket connections (close code 1001)", async () => {
    // Standalone app with its own lifecycle (buildApp attaches the WS layer
    // itself when listen: true — no second attach here).
    const standaloneConfig = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: "redis://localhost:6380",
      PORT: "0",
    });
    const standalone = await buildApp({ config: standaloneConfig, listen: true });
    const address = standalone.server.address();
    if (address === null || typeof address === "string") throw new Error("no TCP address");

    const first = new WsTestClient();
    const second = new WsTestClient();
    await first.connect(address.port);
    await second.connect(address.port);
    const layer = standalone.wsLayer;
    expect(layer?.registry.connectionCount).toBe(2);

    const firstClose = first.closed();
    const secondClose = second.closed();
    await standalone.close(); // onClose hook -> layer.close() -> close(1001) everywhere
    expect((await firstClose).code).toBe(1001);
    expect((await secondClose).code).toBe(1001);
    expect(layer?.registry.connectionCount).toBe(0);
  });
});
