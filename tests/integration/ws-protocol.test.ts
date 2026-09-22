import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  startListeningServer,
  stopTestApp,
  connectWsClient,
  type WsTestClient,
} from "./helpers.js";

/**
 * Wire-level protocol validation over real sockets. Every malformed message
 * must produce the documented error envelope — and never crash the socket or
 * the server (each test keeps using the connection afterwards where relevant).
 *
 * No database interactions happen in this suite (session.leave without a join
 * never queries PostgreSQL), so no database reset is needed here.
 */
describe("WebSocket protocol validation (integration)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const server = await startListeningServer();
    app = server.app;
  });

  afterAll(async () => {
    await stopTestApp();
  });

  it("rejects malformed JSON with INVALID_MESSAGE (requestId null, socket stays open)", async () => {
    const client = await connectWsClient();
    client.send("{ this is not json");
    const error = await client.waitFor((m) => m.type === "error");
    expect(error).toMatchObject({
      type: "error",
      requestId: null,
      payload: { code: "INVALID_MESSAGE" },
    });
    // The connection survives: a subsequent valid message is processed.
    client.send({ type: "session.leave", requestId: "after-error", payload: {} });
    const state = await client.waitFor((m) => m.type === "session.state");
    expect(state.requestId).toBe("after-error");
    await client.close();
  });

  it("rejects non-object JSON (array, string, number, null) with INVALID_MESSAGE", async () => {
    for (const raw of ["[1,2,3]", '"just a string"', "42", "null"]) {
      const client = await connectWsClient();
      client.send(raw);
      const error = await client.waitFor((m) => m.type === "error");
      expect(error.payload).toMatchObject({ code: "INVALID_MESSAGE" });
      await client.close();
    }
  });

  it("rejects a missing type with INVALID_REQUEST", async () => {
    const client = await connectWsClient();
    client.send({ requestId: "r-no-type", payload: {} });
    const error = await client.waitFor((m) => m.type === "error");
    expect(error.requestId).toBe("r-no-type");
    expect(error.payload).toMatchObject({ code: "INVALID_REQUEST" });
    await client.close();
  });

  it("rejects an invalid requestId (missing, wrong type, oversized) with requestId null", async () => {
    for (const requestId of [undefined, 7, "x".repeat(129)]) {
      const client = await connectWsClient();
      client.send({ type: "session.join", requestId, payload: {} });
      const error = await client.waitFor((m) => m.type === "error");
      expect(error.requestId).toBeNull();
      expect(error.payload).toMatchObject({ code: "INVALID_REQUEST" });
      await client.close();
    }
  });

  it("rejects an invalid session.join payload with INVALID_SESSION_ID and echoed requestId", async () => {
    const client = await connectWsClient();
    client.send({
      type: "session.join",
      requestId: "r-bad-uuid",
      payload: { sessionId: "not-a-uuid" },
    });
    const error = await client.waitFor((m) => m.type === "error");
    expect(error.requestId).toBe("r-bad-uuid");
    expect(error.payload).toMatchObject({ code: "INVALID_SESSION_ID" });
    const details = error.payload.details as { issues: Array<{ path: string }> } | null;
    expect(details?.issues[0]?.path).toBe("payload.sessionId");
    await client.close();
  });

  it("rejects payload unknown fields with INVALID_REQUEST (strict payload)", async () => {
    const client = await connectWsClient();
    client.send({
      type: "session.leave",
      requestId: "r-extra",
      payload: { surprise: true },
    });
    const error = await client.waitFor((m) => m.type === "error");
    expect(error.payload).toMatchObject({ code: "INVALID_REQUEST" });
    await client.close();
  });

  it("rejects unknown event types with UNSUPPORTED_EVENT", async () => {
    const client = await connectWsClient();
    client.send({ type: "quiz.answer", requestId: "r-unknown", payload: {} });
    const error = await client.waitFor((m) => m.type === "error");
    expect(error.requestId).toBe("r-unknown");
    expect(error.payload).toMatchObject({
      code: "UNSUPPORTED_EVENT",
      message: expect.stringContaining("quiz.answer"),
    });
    await client.close();
  });

  it("never uses requestId as a database id (opaque string echoed verbatim)", async () => {
    const client = await connectWsClient();
    const weird = "../../etc/passwd 😄  ";
    client.send({ type: "session.leave", requestId: weird, payload: {} });
    const state = await client.waitFor((m) => m.type === "session.state");
    expect(state.requestId).toBe(weird);
    await client.close();
  });

  it("keeps other connections healthy while one connection sends garbage", async () => {
    const garbage = await connectWsClient();
    const healthy = await connectWsClient();

    garbage.send("$$$");
    await garbage.waitFor((m) => m.type === "error");

    healthy.send({ type: "session.leave", requestId: "still-alive", payload: {} });
    const state = await healthy.waitFor((m) => m.type === "session.state");
    expect(state.requestId).toBe("still-alive");

    await garbage.close();
    await healthy.close();
  });

  it("enforces the 64 KiB max payload limit by closing with code 1009", async () => {
    const client: WsTestClient = await connectWsClient();
    const oversized = JSON.stringify({
      type: "session.join",
      requestId: "r-big",
      payload: { sessionId: "x".repeat(80 * 1024) },
    });
    const closed = client.closed();
    client.send(oversized);
    const { code } = await closed;
    expect(code).toBe(1009);
  });

  it("ignores nothing: every sent frame eventually yields a response or close", async () => {
    const client = await connectWsClient();
    for (let i = 0; i < 5; i++) {
      client.send({ type: "session.leave", requestId: `seq-${i}`, payload: {} });
      const state = await client.waitFor((m) => m.type === "session.state");
      expect(state.requestId).toBe(`seq-${i}`);
    }
    await client.close();
  });
});
