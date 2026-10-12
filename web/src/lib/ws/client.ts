import { WS_HEARTBEAT_INTERVAL_MS } from "@/lib/config";
import {
  type ClientEventType,
  type ProtocolError,
  type ServerEnvelope,
} from "./protocol";

/**
 * Connection state surfaced to the UI. CONNECTED / RECONNECTING / RECOVERING /
 * DISCONNECTED are deliberately distinct so the header can tell the truth:
 *
 *   connecting     first socket is opening
 *   authenticating sent auth.authenticate, awaiting auth.authenticated
 *   joining        authenticated, sent session.join
 *   connected      joined; server events flow
 *   reconnecting   socket dropped; backoff timer before the next attempt
 *   recovering     socket reopened; re-authenticating + re-joining (Phase 5
 *                  recovery snapshot arrives with session.joined)
 *   disconnected   closed (by the client, or terminal failure)
 */
export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "joining"
  | "connected"
  | "reconnecting"
  | "recovering"
  | "disconnected";

export interface StatusChange {
  status: ConnectionStatus;
  previous: ConnectionStatus;
  /** Reconnect attempt counter (0 while healthy). */
  attempt: number;
  /** Bounded reason for a drop/failure, for display + diagnostics. */
  reason?: string;
}

export interface LiveSocketOptions {
  url: string;
  sessionId: string;
  /** Resolve a usable access token (refresh if needed). Null ⇒ cannot auth. */
  resolveToken: () => Promise<string | null>;
  WebSocketImpl?: typeof WebSocket;
  heartbeatIntervalMs?: number;
  requestTimeoutMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

type EventHandler = (payload: unknown, envelope: ServerEnvelope) => void;
type StatusHandler = (change: StatusChange) => void;
type ProtocolErrorHandler = (error: ProtocolError) => void;

interface PendingRequest {
  resolve: (envelope: ServerEnvelope) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Frames whose arrival proves the socket is joined and the session exists. */
const FATAL_CODES = new Set<ProtocolError["code"]>(["SESSION_NOT_FOUND"]);

export class LiveSocket {
  private socket: WebSocket | null = null;
  private current: ConnectionStatus = "idle";
  private attempt = 0;
  private closedByUser = false;
  private lastMessageAt = 0;
  private requestSeq = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly protocolErrorHandlers = new Set<ProtocolErrorHandler>();

  private readonly url: string;
  private readonly sessionId: string;
  private readonly resolveToken: () => Promise<string | null>;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly heartbeatIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;

  public constructor(options: LiveSocketOptions) {
    this.url = options.url;
    this.sessionId = options.sessionId;
    this.resolveToken = options.resolveToken;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? WS_HEARTBEAT_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 12_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  public get status(): ConnectionStatus {
    return this.current;
  }

  public get isJoined(): boolean {
    return this.current === "connected";
  }

  public on(type: string, handler: EventHandler): () => void {
    let set = this.eventHandlers.get(type);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(type, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  public onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  public onProtocolError(handler: ProtocolErrorHandler): () => void {
    this.protocolErrorHandlers.add(handler);
    return () => this.protocolErrorHandlers.delete(handler);
  }

  public connect(): void {
    this.closedByUser = false;
    void this.openSocket(false);
  }

  public close(reason = "closed by client"): void {
    this.closedByUser = true;
    this.clearTimers();
    this.rejectAllPending(new Error("Connection closed"));
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
      try {
        socket.close(1000, "client closing");
      } catch {
        /* already closing */
      }
    }
    this.setStatus("disconnected", reason);
  }

  /**
   * Send a client event and await its correlated server reply (the frame that
   * echoes the requestId), or reject on a matching `error` frame / timeout.
   */
  public request(
    type: ClientEventType,
    payload: Record<string, unknown> = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<ServerEnvelope> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new Error("Socket is not open"));
    }
    const requestId = this.nextRequestId();
    return new Promise<ServerEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ type, requestId, payload }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error("Send failed"));
      }
    });
  }

  /** Fire-and-forget send (used for session.leave). */
  public send(type: ClientEventType, payload: Record<string, unknown> = {}): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify({ type, requestId: this.nextRequestId(), payload }));
    } catch {
      /* dropped frame; reconnect will resync via recovery */
    }
  }

  /**
   * Verify the transport is genuinely alive and, if not, force a reconnect.
   *
   * The browser WebSocket API does not surface ping/pong frames, so frame
   * silence is NOT a staleness signal (a healthy idle session is silent). This
   * probe is called on tab-focus and on `online`, and uses a cheap, real
   * request whose reply proves the socket still round-trips.
   */
  public verifyAlive(): void {
    if (this.closedByUser) return;
    if (!this.socket || this.socket.readyState !== 1) {
      this.forceReconnect("socket not open");
      return;
    }
    if (this.current !== "connected") return; // already re-establishing
    this.clearLivenessTimer();
    const sentAt = this.now();
    void this.request("doubt.queue.list", {}, 5000).catch(() => {
      // No reply within the window while the tab is focused ⇒ treat as stale.
      if (this.now() - sentAt >= 4900) this.forceReconnect("liveness probe timed out");
    });
  }

  public get lastMessageTimestamp(): number {
    return this.lastMessageAt;
  }

  // ---- internals -----------------------------------------------------------

  private nextRequestId(): string {
    this.requestSeq += 1;
    return `c${this.requestSeq}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private setStatus(next: ConnectionStatus, reason?: string): void {
    if (next === this.current && reason === undefined) return;
    const previous = this.current;
    this.current = next;
    const change: StatusChange = { status: next, previous, attempt: this.attempt };
    if (reason !== undefined) change.reason = reason;
    for (const handler of this.statusHandlers) handler(change);
  }

  private async openSocket(isReconnect: boolean): Promise<void> {
    this.setStatus(isReconnect ? "recovering" : "connecting");
    let token: string | null;
    try {
      token = await this.resolveToken();
    } catch {
      token = null;
    }
    if (this.closedByUser) return;
    if (!token) {
      // Cannot authenticate: stop retrying. The auth layer owns re-login and
      // its `onAuthFailure` redirects; spinning here would just add noise.
      this.setStatus("disconnected", "unauthenticated");
      return;
    }

    let socket: WebSocket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch {
      this.scheduleReconnect("socket construction failed");
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      void this.authenticateAndJoin(socket, token);
    };
    socket.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };
    socket.onerror = () => {
      // 'onclose' always follows; nothing to do but note it.
    };
    socket.onclose = (event: CloseEvent) => {
      this.handleClose(event);
    };
  }

  private async authenticateAndJoin(socket: WebSocket, token: string): Promise<void> {
    this.setStatus("authenticating");
    try {
      await this.request("auth.authenticate", { token });
    } catch {
      if (this.socket === socket && !this.closedByUser) {
        this.forceReconnect("authentication failed");
      }
      return;
    }
    if (this.socket !== socket || this.closedByUser) return;
    this.setStatus("joining");
    try {
      await this.request("session.join", { sessionId: this.sessionId });
    } catch {
      if (this.socket === socket && !this.closedByUser) {
        this.forceReconnect("join failed");
      }
      return;
    }
    if (this.socket !== socket || this.closedByUser) return;
    this.attempt = 0;
    // `connected` is announced AFTER session.joined is dispatched to listeners,
    // so the recovery snapshot is applied before the header flips to CONNECTED.
    queueMicrotask(() => {
      if (this.socket === socket && !this.closedByUser) this.setStatus("connected");
    });
  }

  private handleMessage(event: MessageEvent): void {
    this.lastMessageAt = this.now();
    let envelope: ServerEnvelope;
    try {
      envelope = JSON.parse(String(event.data)) as ServerEnvelope;
    } catch {
      return; // a malformed server frame is ignored; the socket stays usable
    }
    if (typeof envelope !== "object" || envelope === null || typeof envelope.type !== "string") {
      return;
    }

    if (envelope.type === "error") {
      const error = envelope.payload as ProtocolError;
      if (envelope.requestId !== null) this.settle(envelope.requestId, envelope);
      for (const handler of this.protocolErrorHandlers) handler(error);
      if (FATAL_CODES.has(error.code)) {
        this.closedByUser = true;
        this.setStatus("disconnected", error.code);
        try {
          this.socket?.close(1000, error.code);
        } catch {
          /* noop */
        }
      }
    } else if (envelope.requestId !== null) {
      this.settle(envelope.requestId, envelope);
    }

    const handlers = this.eventHandlers.get(envelope.type);
    if (handlers) {
      for (const handler of handlers) handler(envelope.payload, envelope);
    }
  }

  private settle(requestId: string, envelope: ServerEnvelope): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (envelope.type === "error") {
      const error = envelope.payload as ProtocolError;
      pending.reject(new Error(`${error.code}: ${error.message}`));
    } else {
      pending.resolve(envelope);
    }
  }

  private handleClose(event: CloseEvent): void {
    this.rejectAllPending(new Error("Connection closed"));
    if (this.closedByUser) {
      this.setStatus("disconnected");
      return;
    }
    // 1009 (message too big) is a client bug, not a transport blip — still
    // reconnect, since the session view is more useful alive than dead.
    const reason = event.code === 1001 ? "server draining" : `closed (${event.code})`;
    this.scheduleReconnect(reason);
  }

  private forceReconnect(reason: string): void {
    this.clearTimers();
    this.rejectAllPending(new Error(reason));
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.onclose = null;
        socket.onmessage = null;
        socket.onopen = null;
        socket.close(4000, "client reconnect");
      } catch {
        /* noop */
      }
    }
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.closedByUser) return;
    this.attempt += 1;
    const backoff = Math.min(400 * 2 ** (this.attempt - 1), this.maxBackoffMs);
    const delay = backoff + Math.floor(Math.random() * 200);
    this.setStatus("reconnecting", reason);
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket(true);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearLivenessTimer(): void {
    if (this.livenessTimer !== null) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    this.clearLivenessTimer();
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** The heartbeat interval is the server's; exported for tests/diagnostics. */
export const SERVER_HEARTBEAT_INTERVAL_MS = WS_HEARTBEAT_INTERVAL_MS;
