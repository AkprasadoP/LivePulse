import { describe, expect, it } from "vitest";
import {
  clientEnvelopeSchema,
  isKnownClientEvent,
  sessionJoinedMessage,
  sessionStateMessage,
  errorMessage,
  protocolIssueDetails,
  sessionJoinSchema,
  sessionJoinedPayloadSchema,
  recoverySnapshotSchema,
  doubtCreateSchema,
  doubtResolveSchema,
  doubtViewSchema,
  doubtCreatedPayloadSchema,
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
    expect(isKnownClientEvent("doubt.create")).toBe(true); // Phase 6
    expect(isKnownClientEvent("doubt.resolve")).toBe(true);
    expect(isKnownClientEvent("doubt.dismiss")).toBe(true);
    expect(isKnownClientEvent("doubt.queue.list")).toBe(true);
    expect(isKnownClientEvent("presence.heartbeat")).toBe(false); // later phase
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

describe("doubt queue schemas (Phase 6)", () => {
  it("doubt.create accepts content + optional clientDoubtId and REJECTS server-owned fields", () => {
    expect(doubtCreateSchema.safeParse({ content: "why?" }).success).toBe(true);
    expect(doubtCreateSchema.safeParse({ content: "why?", clientDoubtId: "retry-1" }).success).toBe(
      true,
    );
    expect(doubtCreateSchema.safeParse({ content: "" }).success).toBe(false);
    expect(doubtCreateSchema.safeParse({ content: "x".repeat(1001) }).success).toBe(false);
    // The server owns ordering: a client can never set enqueueSeq or priority.
    expect(doubtCreateSchema.safeParse({ content: "why?", enqueueSeq: 42 }).success).toBe(false);
    expect(doubtCreateSchema.safeParse({ content: "why?", priority: 9 }).success).toBe(false);
  });

  it("doubt.resolve requires a UUID doubtId", () => {
    expect(
      doubtResolveSchema.safeParse({ doubtId: "018f3c2e-7b1a-7d0e-9c2f-3a4b5c6d7e8f" }).success,
    ).toBe(true);
    expect(doubtResolveSchema.safeParse({ doubtId: "nope" }).success).toBe(false);
  });

  it("doubtView carries the ordering authority (enqueueSeq) as a server-assigned int", () => {
    const doubt = {
      doubtId: "018f3c2e-7b1a-7d0e-9c2f-3a4b5c6d7e8f",
      participantId: "018f3c2e-7b1a-7d0e-9c2f-3a4b5c6d7e8a",
      displayName: "Student-1",
      content: "why?",
      priority: 0,
      enqueueSeq: 7,
      status: "OPEN",
      createdAt: "2026-09-25T10:00:00.000Z",
    };
    expect(doubtViewSchema.safeParse(doubt).success).toBe(true);
    expect(doubtViewSchema.safeParse({ ...doubt, status: "CLOSED" }).success).toBe(false);
    expect(
      doubtCreatedPayloadSchema.safeParse({
        sessionId: "018f3c2e-7b1a-7d0e-9c2f-3a4b5c6d7e8b",
        doubt,
      }).success,
    ).toBe(true);
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
      recovery: null,
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
        recovery: null,
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

describe("session recovery snapshot schema (Phase 5)", () => {
  it("accepts a full snapshot and rejects an unknown question state (DRAFT never appears)", () => {
    const snapshot = {
      quizzes: [
        { quizId: "018f3c2e-7b1a-7d0e-9c2f-3a4b5c6d7e8f", state: "ACTIVE", startedAt: null },
      ],
      question: {
        quizId: "018f3c2e-7b1a-7d0e-9c2f-3a4b5c6d7e8f",
        questionId: "018f3c2e-7b1a-7d0e-9c2f-3a4b5c6d7e8a",
        position: 1,
        prompt: "Capital of Germany?",
        firstCorrectWins: true,
        state: "PUBLISHED",
        acceptingAnswers: true,
      },
      ownAnswer: null,
      standings: [],
      doubts: { open: [], truncated: false },
    };
    expect(recoverySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      recoverySnapshotSchema.safeParse({
        ...snapshot,
        question: { ...snapshot.question, state: "DRAFT" },
      }).success,
    ).toBe(false);
  });

  it("rejects a snapshot whose doubts section is missing or malformed", () => {
    const base = {
      quizzes: [],
      question: null,
      ownAnswer: null,
      standings: [],
    };
    expect(recoverySnapshotSchema.safeParse(base).success).toBe(false); // no doubts section
    expect(
      recoverySnapshotSchema.safeParse({ ...base, doubts: { open: [], truncated: "no" } }).success,
    ).toBe(false);
    expect(
      recoverySnapshotSchema.safeParse({ ...base, doubts: { open: [], truncated: false } }).success,
    ).toBe(true);
  });

  it("sessionJoinedPayloadSchema requires the recovery field (shape clients can rely on)", () => {
    const base = {
      sessionId: "018f3c2e-7b1a-7d0e-9c2f-3a4b5c6d7e8f",
      state: "LIVE",
      participantId: null,
      role: null,
      displayName: null,
    };
    expect(sessionJoinedPayloadSchema.safeParse({ ...base, recovery: null }).success).toBe(true);
    expect(sessionJoinedPayloadSchema.safeParse(base).success).toBe(false);
  });
});
