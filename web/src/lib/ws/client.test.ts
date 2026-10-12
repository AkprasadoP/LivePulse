import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSocket, type ConnectionStatus } from "./client";

interface SentFrame {
  type: string;
  requestId: string;
  payload: Record<string, unknown>;
}

/** A scriptable stand-in for the browser WebSocket, used to drive the client. */
class FakeWebSocket {
  public static instances: FakeWebSocket[] = [];

  public readyState = 0;
  public sent: SentFrame[] = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: ((event: { code: number; reason: string }) => void) | null = null;

  public constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  public send(data: string): void {
    this.sent.push(JSON.parse(data) as SentFrame);
  }

  public close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  // ---- test controls -------------------------------------------------------
  public open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  public receive(envelope: unknown): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }

  public serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "dropped" });
  }

  public lastSent(): SentFrame {
    const frame = this.sent[this.sent.length - 1];
    if (!frame) throw new Error("no frame sent");
    return frame;
  }

  public static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!socket) throw new Error("no socket constructed");
    return socket;
  }
}

const flush = async (times = 4): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function makeSocket() {
  const statuses: ConnectionStatus[] = [];
  const socket = new LiveSocket({
    url: "ws://test/ws",
    sessionId: "session-1",
    resolveToken: async () => "access-token",
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    requestTimeoutMs: 200,
    maxBackoffMs: 20,
  });
  socket.onStatus((change) => statuses.push(change.status));
  return { socket, statuses };
}

/** Drive a socket all the way to `connected`. */
async function bringOnline(socket: LiveSocket): Promise<FakeWebSocket> {
  socket.connect();
  await flush();
  const fake = FakeWebSocket.latest();
  fake.open();
  await flush(1);
  const authFrame = fake.lastSent();
  fake.receive({
    type: "auth.authenticated",
    requestId: authFrame.requestId,
    payload: { userId: "u1" },
  });
  await flush(2);
  const joinFrame = fake.lastSent();
  fake.receive({
    type: "session.joined",
    requestId: joinFrame.requestId,
    payload: {
      sessionId: "session-1",
      state: "LIVE",
      participantId: "p1",
      role: "STUDENT",
      displayName: "Ana",
      recovery: null,
    },
  });
  await flush(2);
  return fake;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

describe("LiveSocket connection lifecycle", () => {
  it("authenticates before joining and reports each state", async () => {
    const { socket, statuses } = makeSocket();

    const fake = await bringOnline(socket);

    expect(fake.sent[0]!.type).toBe("auth.authenticate");
    expect(fake.sent[0]!.payload).toEqual({ token: "access-token" });
    expect(fake.sent[1]!.type).toBe("session.join");
    expect(fake.sent[1]!.payload).toEqual({ sessionId: "session-1" });
    expect(socket.status).toBe("connected");
    expect(socket.isJoined).toBe(true);
    expect(statuses).toEqual(["connecting", "authenticating", "joining", "connected"]);
  });

  it("never puts the token in the connection URL", async () => {
    const { socket } = makeSocket();
    await bringOnline(socket);
    expect(FakeWebSocket.latest().url).toBe("ws://test/ws");
  });

  it("disconnects without retrying when no token can be resolved", async () => {
    const socket = new LiveSocket({
      url: "ws://test/ws",
      sessionId: "session-1",
      resolveToken: async () => null,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    socket.connect();
    await flush();

    expect(socket.status).toBe("disconnected");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe("LiveSocket request correlation", () => {
  it("resolves a request when the server echoes its requestId", async () => {
    const { socket } = makeSocket();
    const fake = await bringOnline(socket);

    const pending = socket.request("doubt.queue.list", {});
    const frame = fake.lastSent();
    expect(frame.type).toBe("doubt.queue.list");

    fake.receive({
      type: "doubt.queue.updated",
      requestId: frame.requestId,
      payload: { sessionId: "session-1", doubts: [], truncated: false },
    });

    await expect(pending).resolves.toMatchObject({ type: "doubt.queue.updated" });
  });

  it("rejects a request on a correlated error frame with the protocol code", async () => {
    const { socket } = makeSocket();
    const fake = await bringOnline(socket);

    const pending = socket.request("quiz.answer", { questionId: "q1", content: "x" });
    const frame = fake.lastSent();
    fake.receive({
      type: "error",
      requestId: frame.requestId,
      payload: { code: "QUESTION_NOT_ACCEPTING_ANSWERS", message: "closed", details: null },
    });

    await expect(pending).rejects.toThrow("QUESTION_NOT_ACCEPTING_ANSWERS: closed");
  });

  it("rejects a request that never gets a reply", async () => {
    const { socket } = makeSocket();
    await bringOnline(socket);

    await expect(socket.request("doubt.queue.list", {}, 20)).rejects.toThrow(/timed out/i);
  });

  it("dispatches server events to subscribers without a requestId", async () => {
    const { socket } = makeSocket();
    const fake = await bringOnline(socket);
    const seen: unknown[] = [];
    socket.on("presence.snapshot", (payload) => seen.push(payload));

    fake.receive({
      type: "presence.snapshot",
      requestId: null,
      payload: { sessionId: "session-1", participants: [{ participantId: "p1" }] },
    });

    expect(seen).toEqual([{ sessionId: "session-1", participants: [{ participantId: "p1" }] }]);
  });
});

describe("LiveSocket resilience", () => {
  it("reconnects with backoff after an unexpected close and re-joins", async () => {
    const { socket, statuses } = makeSocket();
    const first = await bringOnline(socket);

    first.serverClose(1006);
    expect(socket.status).toBe("reconnecting");

    // Backoff is capped by maxBackoffMs (20) + jitter (<200).
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 1500 });

    const second = FakeWebSocket.latest();
    second.open();
    await flush(1);
    second.receive({
      type: "auth.authenticated",
      requestId: second.lastSent().requestId,
      payload: { userId: "u1" },
    });
    await flush(2);
    second.receive({
      type: "session.joined",
      requestId: second.lastSent().requestId,
      payload: {
        sessionId: "session-1",
        state: "LIVE",
        participantId: "p1",
        role: "STUDENT",
        displayName: "Ana",
        recovery: {
          quizzes: [],
          question: null,
          ownAnswer: null,
          standings: [],
          doubts: { open: [], truncated: false },
        },
      },
    });
    await flush(2);

    expect(socket.status).toBe("connected");
    expect(statuses).toContain("recovering");
  });

  it("stops reconnecting when the session does not exist", async () => {
    const { socket } = makeSocket();
    const fake = await bringOnline(socket);

    fake.receive({
      type: "error",
      requestId: null,
      payload: { code: "SESSION_NOT_FOUND", message: "gone", details: null },
    });

    expect(socket.status).toBe("disconnected");
    await flush(4);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("surfaces protocol errors to listeners without closing the socket", async () => {
    const { socket } = makeSocket();
    const fake = await bringOnline(socket);
    const codes: string[] = [];
    socket.onProtocolError((error) => codes.push(error.code));

    fake.receive({
      type: "error",
      requestId: null,
      payload: { code: "TEACHER_REQUIRED", message: "no", details: null },
    });

    expect(codes).toEqual(["TEACHER_REQUIRED"]);
    expect(socket.status).toBe("connected");
  });

  it("verifyAlive probes the server over the open socket", async () => {
    const { socket } = makeSocket();
    const fake = await bringOnline(socket);

    socket.verifyAlive();

    expect(fake.lastSent().type).toBe("doubt.queue.list");
    expect(socket.status).toBe("connected");
  });

  it("verifyAlive forces a reconnect when the socket is no longer open", async () => {
    const { socket } = makeSocket();
    const fake = await bringOnline(socket);
    fake.readyState = 3;

    socket.verifyAlive();

    expect(socket.status).toBe("reconnecting");
  });

  it("reports disconnected after an explicit close and does not retry", async () => {
    const { socket } = makeSocket();
    await bringOnline(socket);

    socket.close();

    expect(socket.status).toBe("disconnected");
    await flush(4);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
