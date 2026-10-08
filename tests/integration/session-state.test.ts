import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestApp, stopTestApp, resetDatabase, type IntegrationContext } from "./helpers.js";
import { canTransition, SESSION_TRANSITIONS } from "../../src/modules/sessions/session.state.js";
import { SessionRepository } from "../../src/modules/sessions/session.repository.js";

describe("Session state machine", () => {
  let ctx: IntegrationContext;
  let sessions: SessionRepository;

  beforeAll(async () => {
    ctx = await startTestApp();
    sessions = new SessionRepository(ctx.prisma);
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  // Phase 10.7: sessions are created for existing users (no auto-provisioning).
  async function createSessionForTest(name: string) {
    const user = await ctx.prisma.user.create({
      data: { displayName: `State-${Date.now()}-${Math.floor(Math.random() * 1e6)}` },
    });
    const { session } = await sessions.createWithExistingCreator({ name, creatorId: user.id });
    return { session };
  }

  afterAll(async () => {
    await stopTestApp();
  });

  it("exposes exactly the approved transition table", () => {
    expect(SESSION_TRANSITIONS.CREATED).toEqual(["LIVE", "ENDED"]);
    expect(SESSION_TRANSITIONS.LIVE).toEqual(["ENDED"]);
    expect(SESSION_TRANSITIONS.ENDED).toEqual([]);
  });

  it("canTransition matches the table", () => {
    expect(canTransition("CREATED", "LIVE")).toBe(true);
    expect(canTransition("CREATED", "ENDED")).toBe(true);
    expect(canTransition("LIVE", "ENDED")).toBe(true);
    expect(canTransition("LIVE", "CREATED")).toBe(false);
    expect(canTransition("ENDED", "LIVE")).toBe(false);
    expect(canTransition("ENDED", "CREATED")).toBe(false);
  });

  it("sets startedAt on LIVE and endedAt on ENDED, preserving startedAt", async () => {
    const { session } = await createSessionForTest("Timestamps");

    const live = await sessions.transitionState(session.id, "LIVE");
    expect(live.startedAt).not.toBeNull();
    expect(live.endedAt).toBeNull();

    const ended = await sessions.transitionState(session.id, "ENDED");
    expect(ended.startedAt).not.toBeNull(); // kept
    expect(ended.endedAt).not.toBeNull();
  });

  it("throws InvalidStateTransitionError for ENDED -> LIVE", async () => {
    const { session } = await createSessionForTest("Dead end");
    await sessions.transitionState(session.id, "ENDED");

    await expect(sessions.transitionState(session.id, "LIVE")).rejects.toMatchObject({
      name: "InvalidStateTransitionError",
      from: "ENDED",
      to: "LIVE",
    });
  });

  it("throws NotFoundError for an unknown session", async () => {
    await expect(
      sessions.transitionState("01900000-0000-7000-8000-000000000005", "LIVE"),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("survives concurrent duplicate transitions with exactly one winner", async () => {
    const { session } = await createSessionForTest("Race");

    // Simultaneous identical transitions: the check-and-set UPDATE makes one
    // succeed; losers see the state already changed.
    const results = await Promise.allSettled([
      sessions.transitionState(session.id, "LIVE"),
      sessions.transitionState(session.id, "LIVE"),
      sessions.transitionState(session.id, "LIVE"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);

    const finalSession = await ctx.prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(finalSession.state).toBe("LIVE");
    expect(await ctx.prisma.session.count({ where: { id: session.id, state: "LIVE" } })).toBe(1);
  });

  it("rejects conflicting concurrent transitions cleanly (LIVE vs ENDED race)", async () => {
    const { session } = await createSessionForTest("Conflict race");

    const results = await Promise.allSettled([
      sessions.transitionState(session.id, "LIVE"),
      sessions.transitionState(session.id, "ENDED"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1); // exactly one path is valid from CREATED
    const finalSession = await ctx.prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(["LIVE", "ENDED"]).toContain(finalSession.state);
  });
});
