import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import {
  startListeningServer,
  stopTestApp,
  resetDatabase,
  connectWsClient,
  WsTestClient,
  waitFor,
  TEST_DATABASE_URL,
  registerAndCreateSession,
} from "./helpers.js";
import { loadConfig } from "../../src/config/index.js";
import { buildApp } from "../../src/app/app.js";

/**
 * Session association behavior over real sockets: join/leave/switch against
 * real PostgreSQL rows, plus the heartbeat sweep with a genuinely dead peer
 * (a raw TCP handshake that never pongs — the ws CLIENT library answers pings
 * automatically, so a normal client cannot simulate a dead connection).
 */
describe("WebSocket session behavior (integration)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const server = await startListeningServer();
    app = server.app;
  });

  afterAll(async () => {
    await stopTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  async function createSession(name: string): Promise<string> {
    // Phase 10.7: creation requires authentication. resetDatabase() wipes user
    // rows before every test, so each call registers a fresh owner (a token
    // minted in beforeAll would point at a truncated row).
    const { sessionId } = await registerAndCreateSession(app, name);
    return sessionId;
  }

  async function startSession(sessionId: string): Promise<void> {
    const response = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/state`,
      payload: JSON.stringify({ state: "LIVE" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(200);
  }

  it("joins an existing session and receives session.joined + authoritative session.state", async () => {
    const sessionId = await createSession("Join me");
    const client = await connectWsClient();

    client.send({ type: "session.join", requestId: "join-1", payload: { sessionId } });

    const joined = await client.waitFor((m) => m.type === "session.joined");
    expect(joined).toMatchObject({
      type: "session.joined",
      requestId: "join-1",
      payload: { sessionId, state: "CREATED" },
    });

    const state = await client.waitFor((m) => m.type === "session.state");
    expect(state.requestId).toBe("join-1");
    expect(state.payload).toMatchObject({
      sessionId,
      state: "CREATED",
      startedAt: null,
      endedAt: null,
      updatedAt: expect.any(String),
    });

    const layer = app.wsLayer;
    expect(layer?.registry.countForSession(sessionId)).toBe(1);
    await client.close();
  });

  it("reports the authoritative PostgreSQL state at join time (LIVE session)", async () => {
    const sessionId = await createSession("Live session");
    await startSession(sessionId);

    const client = await connectWsClient();
    client.send({ type: "session.join", requestId: "j", payload: { sessionId } });

    const joined = await client.waitFor((m) => m.type === "session.joined");
    expect(joined.payload).toMatchObject({ sessionId, state: "LIVE" });

    const state = await client.waitFor((m) => m.type === "session.state");
    expect(state.payload).toMatchObject({
      state: "LIVE",
      startedAt: expect.any(String),
      endedAt: null,
    });
    await client.close();
  });

  it("rejects a nonexistent session with SESSION_NOT_FOUND and registers nothing", async () => {
    const missingId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const client = await connectWsClient();

    client.send({ type: "session.join", requestId: "missing", payload: { sessionId: missingId } });

    const error = await client.waitFor((m) => m.type === "error");
    expect(error.requestId).toBe("missing");
    expect(error.payload).toMatchObject({ code: "SESSION_NOT_FOUND" });
    expect(app.wsLayer?.registry.connectionCount).toBe(1); // connected, but not joined
    expect(app.wsLayer?.registry.countForSession(missingId)).toBe(0);
    await client.close();
  });

  it("refuses a duplicate join to the same session (SESSION_ALREADY_JOINED, no state change)", async () => {
    const sessionId = await createSession("Once only");
    const client = await connectWsClient();

    client.send({ type: "session.join", requestId: "first", payload: { sessionId } });
    await client.waitFor((m) => m.type === "session.joined");
    expect(app.wsLayer?.registry.countForSession(sessionId)).toBe(1);

    client.send({ type: "session.join", requestId: "second", payload: { sessionId } });
    const error = await client.waitFor((m) => m.type === "error");
    expect(error.requestId).toBe("second");
    expect(error.payload).toMatchObject({ code: "SESSION_ALREADY_JOINED" });
    expect(app.wsLayer?.registry.countForSession(sessionId)).toBe(1);
    await client.close();
  });

  it("switches sessions deterministically: join(A) then join(B) leaves A and joins B", async () => {
    const sessionA = await createSession("Session A");
    const sessionB = await createSession("Session B");
    const client = await connectWsClient();

    client.send({ type: "session.join", requestId: "a", payload: { sessionId: sessionA } });
    await client.waitFor((m) => m.type === "session.joined");

    client.send({ type: "session.join", requestId: "b", payload: { sessionId: sessionB } });
    const joinedB = await client.waitFor((m) => m.type === "session.joined");
    expect(joinedB.requestId).toBe("b");
    expect(joinedB.payload).toMatchObject({ sessionId: sessionB });

    await waitFor(() => app.wsLayer?.registry.countForSession(sessionA) === 0);
    expect(app.wsLayer?.registry.countForSession(sessionB)).toBe(1);
    await client.close();
  });

  it("session.leave detaches from the registry but keeps the socket open", async () => {
    const sessionId = await createSession("Leave me");
    const client = await connectWsClient();

    client.send({ type: "session.join", requestId: "j", payload: { sessionId } });
    await client.waitFor((m) => m.type === "session.joined");

    client.send({ type: "session.leave", requestId: "l", payload: {} });
    // Match on requestId: the join above also produced a session.state that
    // is still buffered in the test client.
    const state = await client.waitFor((m) => m.type === "session.state" && m.requestId === "l");
    expect(state.requestId).toBe("l");
    expect(state.payload).toMatchObject({ sessionId: null, state: "ENDED" });

    await waitFor(() => app.wsLayer?.registry.countForSession(sessionId) === 0);
    expect(client.isOpen).toBe(true);
    await client.close();
  });

  it("many connections join and are counted independently (connection-keyed, no dedup)", async () => {
    const sessionId = await createSession("Crowded");
    const clients: WsTestClient[] = [];
    for (let i = 0; i < 5; i++) {
      const client = await connectWsClient();
      client.send({ type: "session.join", requestId: `r${i}`, payload: { sessionId } });
      await client.waitFor((m) => m.type === "session.joined");
      clients.push(client);
    }
    expect(app.wsLayer?.registry.countForSession(sessionId)).toBe(5);

    for (const client of clients) await client.close();
    await waitFor(() => app.wsLayer?.registry.countForSession(sessionId) === 0);
  });

  it("heartbeat: pings on the interval, terminates a dead peer, keeps healthy peers", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: "redis://localhost:6380",
      PORT: "0",
      WS_HEARTBEAT_INTERVAL_MS: "1000",
    });
    const app = await buildApp({ config, listen: true });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("no TCP address");
    const port = address.port;
    const layer = app.wsLayer;
    if (layer === null) throw new Error("ws layer was not attached to the standalone app");

    // A raw TCP peer that completes the handshake and then NEVER answers
    // pings — exactly what a crashed/frozen client looks like to the server.
    const deadSocket = await openRawWebSocketWithoutPong(port);

    // A normal ws client, which auto-pongs and must survive every sweep.
    const healthy = new WsTestClient();
    await healthy.connect(port);
    expect(layer.registry.connectionCount).toBe(2);

    let pingsReceived = 0;
    deadSocket.on("data", (chunk) => {
      // Server frames are unmasked; ping opcode is 0x9 (first byte 0x89).
      for (const byte of chunk) if (byte === 0x89) pingsReceived++;
    });

    // The server pinged at least once within the first interval.
    await waitFor(() => pingsReceived >= 1, 5_000, 50);

    // The dead peer (no pong) is terminated by the NEXT sweep. A raw TCP
    // socket sees the terminate as an abrupt TCP end (no close frame, no WS
    // code) — its 'close' event carries a boolean, not a code.
    await once(deadSocket, "close");
    await waitFor(() => layer.registry.connectionCount === 1, 5_000, 50);

    // The healthy peer survived the same sweeps.
    expect(healthy.isOpen).toBe(true);
    expect(layer.registry.connectionCount).toBe(1);

    healthy.send({ type: "session.leave", requestId: "alive", payload: {} });
    const state = await healthy.waitFor((m) => m.type === "session.state");
    expect(state.requestId).toBe("alive");

    await healthy.close();
    await app.close();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Raw handshake helper (dead-peer simulation)
// ---------------------------------------------------------------------------

function openRawWebSocketWithoutPong(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const key = Buffer.from("0123456789abcdef").toString("base64");
    socket.on("connect", () => {
      socket.write(
        `GET /ws HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      if (buffer.includes("\r\n\r\n")) {
        if (buffer.startsWith("HTTP/1.1 101")) {
          resolve(socket);
        } else {
          socket.destroy();
          reject(new Error(`handshake refused: ${buffer.split("\r\n")[0]}`));
        }
      }
    });
    socket.on("error", reject);
  });
}
