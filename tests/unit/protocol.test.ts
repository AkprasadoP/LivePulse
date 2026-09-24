import { describe, expect, it } from "vitest";
import {
  clientEnvelopeSchema,
  isKnownClientEvent,
  sessionJoinedMessage,
  sessionStateMessage,
  errorMessage,
  protocolIssueDetails,
  sessionJoinSchema,
} from "../../src/ws/protocol.js";
import { z } from "zod";

describe("clientEnvelopeSchema", () => {
  const valid = { type: "session.join", requestId: "req-1", payload: { sessionId: "x" } };

  it("accepts a well-formed envelope", () => {
    expect(clientEnvelopeSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a missing or empty type", () => {
    expect(() => clientEnvelopeSchema.parse({ requestId: "r", payload: {} })).toThrow(z.ZodError);
    expect(() => clientEnvelopeSchema.parse({ type: "", requestId: "r", payload: {} })).toThrow(
      z.ZodError,
    );
  });

  it("rejects a type longer than 64 chars", () => {
    expect(() =>
      clientEnvelopeSchema.parse({ type: "a".repeat(65), requestId: "r", payload: {} }),
    ).toThrow(z.ZodError);
  });

  it("rejects a missing, non-string or oversized requestId", () => {
    expect(() => clientEnvelopeSchema.parse({ type: "session.join", payload: {} })).toThrow(
      z.ZodError,
    );
    expect(() =>
      clientEnvelopeSchema.parse({ type: "session.join", requestId: 42, payload: {} }),
    ).toThrow(z.ZodError);
    expect(() =>
      clientEnvelopeSchema.parse({ type: "session.join", requestId: "r".repeat(129), payload: {} }),
    ).toThrow(z.ZodError);
  });

  it("rejects a missing payload", () => {
    expect(() => clientEnvelopeSchema.parse({ type: "session.join", requestId: "r" })).toThrow(
      z.ZodError,
    );
  });
});

describe("clientEventSchemas / dispatch", () => {
  it("knows exactly the current client events", () => {
    expect(isKnownClientEvent("session.join")).toBe(true);
    expect(isKnownClientEvent("session.leave")).toBe(true);
    expect(isKnownClientEvent("quiz.start")).toBe(true);
    expect(isKnownClientEvent("question.publish")).toBe(true);
    expect(isKnownClientEvent("question.close")).toBe(true);
    expect(isKnownClientEvent("quiz.answer")).toBe(true);
    expect(isKnownClientEvent("doubt.create")).toBe(false); // Phase 8
    expect(isKnownClientEvent("SESSION.JOIN")).toBe(false); // case-sensitive
  });

  it("sessionJoinSchema requires a UUID sessionId", () => {
    expect(
      sessionJoinSchema.safeParse({ sessionId: "018f3c2e-7b1a-7d0e-9c2f-3a4b5c6d7e8f" }).success,
    ).toBe(true);
    expect(sessionJoinSchema.safeParse({ sessionId: "not-a-uuid" }).success).toBe(false);
    expect(sessionJoinSchema.safeParse({}).success).toBe(false);
  });
});

describe("server message factories", () => {
  it("sessionJoinedMessage echoes the requestId", () => {
    const message = sessionJoinedMessage("req-9", {
      sessionId: "018f3c2e-7b1a-7d0e-9c2f-3a4b5c6d7e8f",
      state: "LIVE",
      participantId: null,
      role: null,
      displayName: null,
    });
    expect(message).toEqual({
      type: "session.joined",
      requestId: "req-9",
      payload: {
        sessionId: "018f3c2e-7b1a-7d0e-9c2f-3a4b5c6d7e8f",
        state: "LIVE",
        participantId: null,
        role: null,
        displayName: null,
      },
    });
  });

  it("sessionStateMessage allows null requestId for server-initiated events", () => {
    const message = sessionStateMessage(null, {
      sessionId: null,
      state: "ENDED",
      startedAt: null,
      endedAt: null,
      updatedAt: "2026-09-22T10:00:00.000Z",
    });
    expect(message.requestId).toBeNull();
    expect(message.type).toBe("session.state");
  });

  it("errorMessage carries code, message and nullable details", () => {
    const message = errorMessage("req-2", {
      code: "SESSION_NOT_FOUND",
      message: "Session does not exist",
      details: null,
    });
    expect(message.type).toBe("error");
    expect(message.payload.code).toBe("SESSION_NOT_FOUND");
  });
});

describe("protocolIssueDetails", () => {
  it("prefixes issue paths with payload. for client-side debugging", () => {
    const result = sessionJoinSchema.safeParse({ sessionId: "nope" });
    expect(result.success).toBe(false);
    const details = protocolIssueDetails(result.error!);
    expect(details?.issues[0]?.path).toBe("payload.sessionId");
  });
});
