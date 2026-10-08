import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createClient } from "redis";
import {
  TEST_DATABASE_URL,
  resetDatabase,
  startIndependentInstance,
  connectToInstance,
  joinAs,
  registerAndCreateSession,
  waitFor,
  waitForAsync,
  waitForPresence,
  WsTestClient,
  type IndependentInstance,
} from "./helpers.js";

/**
 * Phase 7 presence tests (ADR-008).
 *
 * Presence is EPHEMERAL: it is derived from live connections on each instance
 * and propagated as whole-set Redis notices. These tests run against real
 * PostgreSQL, real Redis and real sockets — nothing is mocked, and every
 * timing-sensitive assertion waits on a server frame or a bounded poll rather
 * than sleeping.
 *
 * Coverage map (docs/testing/presence.md):
 *   P1  join announces the participant to itself
 *   P2  a new participant is announced to existing clients
 *   P3  cross-instance presence via Redis notice
 *   P4  graceful leave removes presence everywhere
 *   P5  multi-connection: one close does NOT go offline (metrics-verified)
 *   P6  view-only connections are never presence
 *   P7  same participant bound on two instances stays online after one closes
 *   P8  reconnect receives the current aggregate
 *   P9  Redis unavailable -> local presence still works
 *   P10 a crashed instance (ghost notice) expires after 3 x digest
 *   P11 instance shutdown withdraws local presence promptly
 *   P12 heartbeat sweep removes presence and is counted as such
 *   P13 presence never writes PostgreSQL
 */

const DIGEST_MS = 150;

function requestOn(instance: IndependentInstance) {
  return async (
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: any }> => {
    const response = await instance.app.inject({
      method,
      url,
      ...(payload === undefined
        ? {}
        : { payload: JSON.stringify(payload), headers: { "content-type": "application/json" } }),
    });
    let body: any = response.body;
    try {
      body = response.json();
    } catch {
      // non-JSON body: keep raw string
    }
    return { statusCode: response.statusCode, body };
  };
}

/** A LIVE session (presence only needs a real session row). */
async function createLiveSession(instance: IndependentInstance): Promise<string> {
  const request = requestOn(instance);
  // Phase 10.7: creation requires an authenticated owner (token subject).
  const { sessionId } = await registerAndCreateSession(
    instance.app,
    `Presence ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  const live = await request("POST", `/sessions/${sessionId}/state`, { state: "LIVE" });
  expect(live.statusCode).toBe(200);
  return sessionId;
}

/** Read one counter series value from an instance's own registry. */
async function counterFor(instance: IndependentInstance, series: string): Promise<number> {
  const metrics = instance.app.metrics;
  if (metrics === null) throw new Error("metrics are disabled on this instance");
  const text = await metrics.render();
  const line = text.split("\n").find((candidate) => candidate.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(series.length + 1));
}

/** Publish a raw distribution envelope (used to fake a crashed peer). */
async function publishRaw(envelope: Record<string, unknown>): Promise<void> {
  const client = createClient({
    url: process.env.LIVEPULSE_TEST_REDIS_URL ?? "redis://localhost:6380",
  });
  await client.connect();
  try {
    await client.publish("livepulse:events", JSON.stringify(envelope));
  } finally {
    await client.quit();
  }
}

describe("Presence (integration, Phase 7)", () => {
  let wsA: IndependentInstance;
  let wsB: IndependentInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
    await prisma.$connect();
    wsA = await startIndependentInstance("ws-pres-a", { presenceDigestIntervalMs: DIGEST_MS });
    wsB = await startIndependentInstance("ws-pres-b", { presenceDigestIntervalMs: DIGEST_MS });
  });

  afterAll(async () => {
    await wsA.close();
    await wsB.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it("P1 — joining announces the participant to the joining connection", async () => {
    const sessionId = await createLiveSession(wsA);
    const student = await connectToInstance(wsA);
    const joined = await joinAs(student, sessionId, "Student-1");

    const participantIds = await waitForPresence(student, sessionId, (ids) =>
      ids.includes(joined.participantId!),
    );
    expect(participantIds).toEqual([joined.participantId]);

    const snapshot = student.drain().filter((m) => m.type === "presence.snapshot");
    // The snapshot arrives AFTER session.joined (documented ordering) and only
    // once: the joining client is not also the target of the change broadcast.
    expect(snapshot).toHaveLength(0);
    expect(joined.role).toBe("STUDENT");

    await student.close();
  });

  it("P2 — a new participant is announced to clients already in the session", async () => {
    const sessionId = await createLiveSession(wsA);
    const first = await connectToInstance(wsA);
    const firstJoined = await joinAs(first, sessionId, "Student-1");
    await waitForPresence(first, sessionId, (ids) => ids.includes(firstJoined.participantId!));

    const second = await connectToInstance(wsA);
    const secondJoined = await joinAs(second, sessionId, "Student-2");

    const seen = await waitForPresence(first, sessionId, (ids) =>
      ids.includes(secondJoined.participantId!),
    );
    expect(seen.sort()).toEqual([firstJoined.participantId!, secondJoined.participantId!].sort());

    await first.close();
    await second.close();
  });

  it("P3 — presence crosses instances: a participant on WS-A is visible on WS-B", async () => {
    const sessionId = await createLiveSession(wsA);
    const onA = await connectToInstance(wsA);
    const joinedA = await joinAs(onA, sessionId, "Student-A");

    const onB = await connectToInstance(wsB);
    const joinedB = await joinAs(onB, sessionId, "Student-B");

    const seenByB = await waitForPresence(onB, sessionId, (ids) =>
      ids.includes(joinedA.participantId!),
    );
    expect(seenByB.sort()).toEqual([joinedA.participantId!, joinedB.participantId!].sort());

    // ...and it converges in the other direction too.
    const seenByA = await waitForPresence(onA, sessionId, (ids) =>
      ids.includes(joinedB.participantId!),
    );
    expect(seenByA.sort()).toEqual([joinedA.participantId!, joinedB.participantId!].sort());

    await onA.close();
    await onB.close();
  });

  it("P4 — leaving removes presence on both instances", async () => {
    const sessionId = await createLiveSession(wsA);
    const stayer = await connectToInstance(wsB);
    const stayerJoined = await joinAs(stayer, sessionId, "Stayer");

    const leaver = await connectToInstance(wsA);
    const leaverJoined = await joinAs(leaver, sessionId, "Leaver");
    await waitForPresence(stayer, sessionId, (ids) => ids.includes(leaverJoined.participantId!));

    await leaver.close();

    const remaining = await waitForPresence(
      stayer,
      sessionId,
      (ids) => !ids.includes(leaverJoined.participantId!),
    );
    expect(remaining).toEqual([stayerJoined.participantId]);

    await stayer.close();
  });

  it("P5 — closing ONE of two connections keeps the participant online (no offline transition)", async () => {
    const sessionId = await createLiveSession(wsA);
    const observer = await connectToInstance(wsB);
    const observerJoined = await joinAs(observer, sessionId, "Observer");

    const phone = await connectToInstance(wsA);
    const phoneJoined = await joinAs(phone, sessionId, "Multi");
    const laptop = await connectToInstance(wsA);
    const laptopJoined = await joinAs(laptop, sessionId, "Multi");
    // Same display name -> same participant row (Phase 3 identity seam).
    expect(laptopJoined.participantId).toBe(phoneJoined.participantId);

    await waitForPresence(observer, sessionId, (ids) => ids.includes(phoneJoined.participantId!));
    const beforeOffline = await counterFor(
      wsA,
      'livepulse_presence_transitions_total{state="offline"}',
    );

    await phone.close();
    // Registry truth: the participant still has the laptop connection locally.
    await waitFor(() => wsA.app.wsLayer!.registry.countForSession(sessionId) === 1);

    // ABSENCE assertion: no observed snapshot may drop the participant while
    // the second connection holds them online, and no offline transition may
    // be recorded. Several digest cycles must elapse first because the failure
    // mode is "a frame/counter appears that should not" — no positive signal
    // can end this early (same documented pattern as Phase 5's no-replay
    // assertions, see docs/testing/presence.md).
    await new Promise((resolve) => setTimeout(resolve, DIGEST_MS * 3 + 50));
    for (const frame of observer.drain().filter((m) => m.type === "presence.snapshot")) {
      const ids = (
        frame.payload as { participants: Array<{ participantId: string }> }
      ).participants.map((participant) => participant.participantId);
      expect(ids).toContain(phoneJoined.participantId);
    }
    expect(await counterFor(wsA, 'livepulse_presence_transitions_total{state="offline"}')).toBe(
      beforeOffline,
    );

    // Only the FINAL connection closing goes offline — and that IS announced.
    await laptop.close();
    await waitForPresence(observer, sessionId, (ids) => !ids.includes(phoneJoined.participantId!));
    await waitForAsync(
      async () =>
        (await counterFor(wsA, 'livepulse_presence_transitions_total{state="offline"}')) ===
        beforeOffline + 1,
      5_000,
    );
    expect(observerJoined.participantId).not.toBeNull();

    await observer.close();
  });

  it("P6 — view-only connections are never presence", async () => {
    const sessionId = await createLiveSession(wsA);
    const viewer = await connectToInstance(wsA);
    const joined = await joinAs(viewer, sessionId); // no participant binding

    expect(joined.participantId).toBeNull();
    const snapshot = await viewer.waitFor(
      (m) => m.type === "presence.snapshot" && m.payload.sessionId === sessionId,
    );
    expect((snapshot.payload as { participants: unknown[] }).participants).toEqual([]);

    // A participant joining afterwards sees ONLY themselves, never the viewer.
    const student = await connectToInstance(wsA);
    const studentJoined = await joinAs(student, sessionId, "Student-1");
    const seen = await waitForPresence(student, sessionId, (ids) =>
      ids.includes(studentJoined.participantId!),
    );
    expect(seen).toEqual([studentJoined.participantId]);

    await viewer.close();
    await student.close();
  });

  it("P7 — the same participant bound on WS-A and WS-B survives losing one instance connection", async () => {
    const sessionId = await createLiveSession(wsA);
    const observer = await connectToInstance(wsB);
    const observerJoined = await joinAs(observer, sessionId, "Observer");

    const onA = await connectToInstance(wsA);
    const joinedA = await joinAs(onA, sessionId, "Dual");
    const onB = await connectToInstance(wsB);
    const joinedB = await joinAs(onB, sessionId, "Dual");
    expect(joinedB.participantId).toBe(joinedA.participantId);

    await onA.close();

    // WS-B still reports the participant (its own local connection holds them
    // online) and never emits an offline transition for them.
    const seen = await waitForPresence(observer, sessionId, (ids) =>
      ids.includes(joinedA.participantId!),
    );
    expect(seen).toContain(joinedA.participantId);
    expect(seen).toContain(observerJoined.participantId);

    await onB.close();
    await observer.close();
  });

  it("P8 — a reconnecting client receives the CURRENT aggregate, not a stale one", async () => {
    const sessionId = await createLiveSession(wsA);
    const residentOnA = await connectToInstance(wsA);
    const residentJoined = await joinAs(residentOnA, sessionId, "Resident-A");

    const reconnecting = await connectToInstance(wsB);
    const first = await joinAs(reconnecting, sessionId, "Roamer");
    await waitForPresence(reconnecting, sessionId, (ids) =>
      ids.includes(residentJoined.participantId!),
    );
    await reconnecting.destroy();

    // A NEW connection (fresh instance, same identity) reconciles from the
    // current aggregate: local truth + the peer's latest contribution.
    const second = await connectToInstance(wsB);
    const rejoined = await joinAs(second, sessionId, "Roamer");
    expect(rejoined.participantId).toBe(first.participantId);

    const seen = await waitForPresence(second, sessionId, (ids) =>
      ids.includes(residentJoined.participantId!),
    );
    expect(seen.sort()).toEqual([residentJoined.participantId, rejoined.participantId!].sort());

    await residentOnA.close();
    await second.close();
  });

  it("P9 — distribution degraded: local presence and durable operations still work", async () => {
    // The degraded shape used since Phase 4: the instance does not take part
    // in cross-instance distribution at all, so no Redis notice can arrive
    // (node-redis retries an unreachable server forever by design, so a hard
    // outage cannot be simulated in-process — see docs/testing/presence.md).
    const isolated = await startIndependentInstance("ws-pres-isolated", {
      distributionEnabled: false,
      presenceDigestIntervalMs: DIGEST_MS,
    });
    try {
      const sessionId = await createLiveSession(isolated);
      const student = await connectToInstance(isolated);
      const joined = await joinAs(student, sessionId, "Student-1");

      const seen = await waitForPresence(student, sessionId, (ids) =>
        ids.includes(joined.participantId!),
      );
      expect(seen).toEqual([joined.participantId]);

      // Local presence removal works with Redis down too.
      await student.close();

      // Durable PostgreSQL work is unaffected (a second participant joins).
      const other = await connectToInstance(isolated);
      const otherJoined = await joinAs(other, sessionId, "Student-2");
      expect(otherJoined.participantId).not.toBeNull();
      await other.close();
    } finally {
      await isolated.close();
    }
  }, 20_000);

  it("P10 — a crashed instance's presence expires after 3 × the digest interval", async () => {
    const sessionId = await createLiveSession(wsB);
    const observer = await connectToInstance(wsB);
    const observerJoined = await joinAs(observer, sessionId, "Observer");

    // A peer that announced a participant and then "died": no more notices
    // will ever come from it, which is exactly what a crashed instance looks
    // like to everyone else. The instance id is never seen again.
    const ghostParticipantId = randomUUID();
    const ghostInstance = `ws-ghost-${randomUUID().slice(0, 8)}`;
    await publishRaw({
      eventId: randomUUID(),
      type: "presence.update",
      sessionId,
      originInstanceId: ghostInstance,
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      payload: {
        sessionId,
        seq: 1,
        participants: [
          { participantId: ghostParticipantId, displayName: "Ghost", role: "STUDENT" },
        ],
      },
    });

    // The notice is applied: the ghost is (briefly) visible.
    const withGhost = await waitForPresence(observer, sessionId, (ids) =>
      ids.includes(ghostParticipantId),
    );
    expect(withGhost).toContain(observerJoined.participantId);

    // ...and after the staleness window (3 × 150 ms) it is dropped without any
    // further message arriving from the dead instance.
    const withoutGhost = await waitForPresence(
      observer,
      sessionId,
      (ids) => !ids.includes(ghostParticipantId),
      5_000,
    );
    expect(withoutGhost).toEqual([observerJoined.participantId]);

    await observer.close();
  }, 20_000);

  it("P11 — graceful instance shutdown withdraws its presence immediately", async () => {
    const sessionId = await createLiveSession(wsA);
    const stayer = await connectToInstance(wsA);
    const stayerJoined = await joinAs(stayer, sessionId, "Stayer");

    const doomed = await startIndependentInstance("ws-pres-doomed", {
      presenceDigestIntervalMs: DIGEST_MS,
    });
    const onDoomed = await connectToInstance(doomed);
    const doomedJoined = await joinAs(onDoomed, sessionId, "Doomed");
    await waitForPresence(stayer, sessionId, (ids) => ids.includes(doomedJoined.participantId!));

    // A shutdown that does NOT wait for the 3 × digest staleness window: the
    // instance withdraws its local set before it stops publishing.
    await doomed.close();

    const remaining = await waitForPresence(
      stayer,
      sessionId,
      (ids) => !ids.includes(doomedJoined.participantId!),
    );
    expect(remaining).toEqual([stayerJoined.participantId]);

    await stayer.close();
  }, 20_000);

  it("P12 — heartbeat termination removes presence and is counted as a heartbeat close", async () => {
    const pulse = await startIndependentInstance("ws-pres-pulse", {
      presenceDigestIntervalMs: DIGEST_MS,
      wsHeartbeatIntervalMs: 1_000,
    });
    try {
      const sessionId = await createLiveSession(pulse);
      const observer = await connectToInstance(pulse);
      const observerJoined = await joinAs(observer, sessionId, "Observer");

      const frozen = await connectToInstance(pulse);
      const frozenJoined = await joinAs(frozen, sessionId, "Frozen");
      await waitForPresence(observer, sessionId, (ids) =>
        ids.includes(frozenJoined.participantId!),
      );

      // Stop reading: the server's pings are never answered, so the existing
      // heartbeat sweep declares this connection dead (no cooperative close).
      frozen.freeze();

      await waitFor(() => pulse.app.wsLayer?.registry.countForSession(sessionId) === 1, 10_000, 50);
      await waitForPresence(
        observer,
        sessionId,
        (ids) => !ids.includes(frozenJoined.participantId!),
      );
      expect(
        await counterFor(pulse, 'livepulse_ws_connections_closed_total{reason="heartbeat"}'),
      ).toBe(1);

      frozen.resume();
      frozen.destroy().catch(() => {});
      await observer.close();
    } finally {
      await pulse.close();
    }
  }, 25_000);

  it("P13 — presence never writes to PostgreSQL", async () => {
    const sessionId = await createLiveSession(wsA);
    const countRows = async (table: string): Promise<number> => {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count FROM ${table}`,
      );
      return Number(rows[0]?.count ?? 0);
    };
    const clients: WsTestClient[] = [];
    for (let index = 0; index < 5; index += 1) {
      const client = await connectToInstance(index % 2 === 0 ? wsA : wsB);
      await joinAs(client, sessionId, `Student-${index}`);
      await waitForPresence(client, sessionId, (ids) => ids.length >= index + 1);
      clients.push(client);
    }

    // Baseline taken AFTER the joins: joining with a participant legitimately
    // writes PostgreSQL (Phase 3 identity seam). What must not write is the
    // presence work itself, so measure across digest cycles + departures.
    const before = {
      users: await countRows("users"),
      participants: await countRows("session_participants"),
    };
    await new Promise((resolve) => setTimeout(resolve, DIGEST_MS * 3));

    for (const client of clients) await client.close();
    // Let both instances process the departures and a digest cycle.
    await waitFor(() => wsA.app.wsLayer!.registry.countForSession(sessionId) === 0, 5_000, 50);
    await waitFor(() => wsB.app.wsLayer!.registry.countForSession(sessionId) === 0, 5_000, 50);

    expect(await countRows("users")).toBe(before.users);
    expect(await countRows("session_participants")).toBe(before.participants);

    // No presence/connection store exists at all in PostgreSQL.
    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = tables.map((row) => row.table_name.toLowerCase());
    for (const forbidden of ["presence", "connection", "heartbeat", "socket"]) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }
  }, 20_000);
});
