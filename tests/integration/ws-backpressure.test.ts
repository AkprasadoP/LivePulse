import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  TEST_DATABASE_URL,
  resetDatabase,
  startIndependentInstance,
  connectToInstance,
  joinAs,
  registerAndCreateSession,
  bearerHeaders,
  WsTestClient,
  type IndependentInstance,
} from "./helpers.js";

const BUFFER_CAP_BYTES = 8 * 1024 * 1024;
const RSS_GROWTH_CAP_BYTES = 100 * 1024 * 1024;
const SAMPLE_MS = 250;
const ACK_TIMEOUT_MS = 10_000;
// Gentle pacing between creates: shapes offered load (~20 creates/s) so the
// 250 ms sampler observes the storm mid-flight. Pacing is workload shaping,
// NOT a success criterion — completion stays fully event-awaited. Without
// it the sequential storm finishes inside one sample tick and the sampler
// records zero observations (a silent measurement miss, not a pass).
const PACE_MS = 50;
const MIN_SAMPLES = 3;

interface BufferSample {
  t: number;
  buffers: Record<string, number>;
  rss: number;
  heapUsed: number;
}

interface Sampler {
  samples: BufferSample[];
  tripped: string | null;
  stop(): { rssDelta: number; heapDelta: number; maxSlowBuffer: number };
}

/** Poll server-side buffers + process stats. Observation only. */
function startSampler(
  instance: IndependentInstance,
  sessionId: string,
  slowDisplayName: string | null,
): Sampler {
  const layer = instance.app.wsLayer;
  if (layer === null) throw new Error("WS layer missing on test instance");
  const samples: BufferSample[] = [];
  let tripped: string | null = null;
  const rss0 = process.memoryUsage().rss;
  const heap0 = process.memoryUsage().heapUsed;
  let maxSlowBuffer = 0;
  const timer = setInterval(() => {
    const buffers: Record<string, number> = {};
    for (const c of layer.registry.getConnectionsForSession(sessionId)) {
      const name = c.displayName ?? "(unnamed)";
      buffers[name] = c.socket.bufferedAmount;
    }
    const mem = process.memoryUsage();
    samples.push({ t: Date.now(), buffers, rss: mem.rss, heapUsed: mem.heapUsed });
    if (slowDisplayName !== null) {
      const slow = buffers[slowDisplayName] ?? 0;
      if (slow > maxSlowBuffer) maxSlowBuffer = slow;
      if (slow > BUFFER_CAP_BYTES && tripped === null) {
        tripped = `slow-reader buffer ${slow} bytes exceeded ${BUFFER_CAP_BYTES}`;
      }
    }
    if (mem.rss - rss0 > RSS_GROWTH_CAP_BYTES && tripped === null) {
      tripped = `RSS grew ${mem.rss - rss0} bytes within one stage (cap ${RSS_GROWTH_CAP_BYTES})`;
    }
  }, SAMPLE_MS);
  return {
    samples,
    get tripped() {
      return tripped;
    },
    stop() {
      clearInterval(timer);
      const mem = process.memoryUsage();
      return { rssDelta: mem.rss - rss0, heapDelta: mem.heapUsed - heap0, maxSlowBuffer };
    },
  };
}

/** HTTP helper bound to one instance (session/state setup). */
function requestOn(instance: IndependentInstance) {
  return async (
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ statusCode: number; body: any }> => {
    const response = await instance.app.inject({
      method,
      url,
      ...(payload === undefined
        ? {}
        : {
            payload: JSON.stringify(payload),
            headers: { "content-type": "application/json", ...(headers ?? {}) },
          }),
    });
    let body: any = response.body;
    try {
      body = response.json();
    } catch {
      // non-JSON: keep raw string
    }
    return { statusCode: response.statusCode, body };
  };
}

/** Fresh session moved to LIVE (required for doubt.create). Quiz not needed. */
async function makeLiveSession(
  instance: IndependentInstance,
  tag: string,
): Promise<{ sessionId: string; teacherName: string; accessToken: string }> {
  const {
    sessionId,
    creatorDisplayName: teacherName,
    accessToken,
  } = await registerAndCreateSession(
    instance.app,
    `Backpressure ${tag} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  const request = requestOn(instance);
  const live = await request(
    "POST",
    `/sessions/${sessionId}/state`,
    { state: "LIVE" },
    bearerHeaders(accessToken),
  );
  expect(live.statusCode).toBe(200);
  return { sessionId, teacherName, accessToken };
}

/** Best-effort /metrics counter scrape (corroboration only; null if disabled). */
async function scrapeCounter(
  instance: IndependentInstance,
  metric: string,
): Promise<number | null> {
  const response = await instance.app.inject({ method: "GET", url: "/metrics" });
  if (response.statusCode !== 200) return null;
  const match = new RegExp(`^${metric} (\\d+(?:\\.\\d+)?)$`, "m").exec(response.body);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * Labeled-counter scrape, e.g. `livepulse_redis_publish_total{result="error"}`.
 * Corroboration only; null when metrics are disabled or the series is absent.
 */
async function scrapeLabeledCounter(
  instance: IndependentInstance,
  metric: string,
  labelKey: string,
  labelValue: string,
): Promise<number | null> {
  const response = await instance.app.inject({ method: "GET", url: "/metrics" });
  if (response.statusCode !== 200) return null;
  const match = new RegExp(
    `^${metric}\\{[^}]*${labelKey}="${labelValue}"[^}]*\\} ([\\d.eE+-]+)$`,
    "m",
  ).exec(response.body);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Bound a stage body with an explicit deadline (vitest's testTimeout is the backstop). */
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`deadline exceeded: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Minimal percentile over an ascending-sorted array (test-only). */
function pctOf(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi
    ? sortedAsc[lo]!
    : sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (idx - lo);
}

function doubtSeqOf(message: { payload: unknown }): number {
  const doubt = (message.payload as { doubt?: { enqueueSeq?: unknown } }).doubt;
  if (typeof doubt?.enqueueSeq !== "number") throw new Error("doubt.created without enqueueSeq");
  return doubt.enqueueSeq;
}

/** Exact-length payload: prefix carries run identity, padding fills to `size`. */
function makeContent(runId: string, i: number, size: number): string {
  const prefix = `bp-${runId} doubt ${i} `;
  if (prefix.length >= size) throw new Error(`prefix exceeds payload size ${size}`);
  return prefix + "x".repeat(size - prefix.length);
}

interface LargePayloadRepResult {
  contentChars: number;
  creates: number;
  maxSlowBufferedBytes: number;
  rssDeltaBytes: number;
  heapDeltaBytes: number;
  eventLoopDelayMeanMs: number;
  eventLoopDelayMaxMs: number;
  wsMessagesSentDelta: number | null;
  samples: number;
}

/**
 * One stage-2 run: fresh session, 1 creator + 2 fast observers + 1 frozen
 * reader, N paced creates of exactly `sizeChars`, catch-up after resume.
 * Owns all its clients/samplers and cleans them up even on failure.
 */
async function runLargePayloadRep(
  solo: IndependentInstance,
  options: { sizeChars: number; creates: number; rep: number; tag: string; namePrefix: string },
): Promise<LargePayloadRepResult> {
  const { sizeChars, creates: N, rep, tag, namePrefix } = options;
  const runId = `${tag}-${rep}-${Date.now().toString(36)}`;
  const slowName = `${namePrefix}Slow`;
  const { sessionId } = await makeLiveSession(solo, tag);
  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();
  const sampler = startSampler(solo, sessionId, slowName);
  const clients: WsTestClient[] = [];
  try {
    const creator = await connectToInstance(solo);
    clients.push(creator);
    await joinAs(creator, sessionId, `${namePrefix}Creator`);
    const observers: WsTestClient[] = [];
    for (let i = 0; i < 2; i += 1) {
      const c = await connectToInstance(solo);
      clients.push(c);
      observers.push(c);
      await joinAs(c, sessionId, `${namePrefix}Fast-${i}`);
    }
    const slow = await connectToInstance(solo);
    clients.push(slow);
    await joinAs(slow, sessionId, slowName);
    for (const c of clients) c.drain();

    slow.freeze();
    const sentBefore = await scrapeCounter(solo, "livepulse_ws_messages_sent_total");

    for (let i = 0; i < N; i += 1) {
      if (sampler.tripped !== null) {
        throw new Error(`safety trip, aborting storm: ${sampler.tripped}`);
      }
      for (const c of [...observers, creator]) {
        expect(c.isOpen, "healthy client disconnected mid-storm").toBe(true);
      }
      const requestId = `bp-${runId}-${i}`;
      const content = makeContent(runId, i, sizeChars);
      expect(content.length, "payload size must be exact").toBe(sizeChars);
      creator.send({ type: "doubt.create", requestId, payload: { content } });
      const ack = await creator.waitFor(
        (m) => m.type === "doubt.created" && m.requestId === requestId,
        ACK_TIMEOUT_MS,
      );
      expect(doubtSeqOf(ack)).toBe(i + 1);
      await new Promise((resolve) => setTimeout(resolve, PACE_MS));
    }

    for (const observer of observers) {
      for (let seq = 1; seq <= N; seq += 1) {
        await observer.waitFor(
          (m) =>
            m.type === "doubt.created" &&
            m.requestId === null &&
            (m.payload as { doubt?: { enqueueSeq?: unknown } }).doubt?.enqueueSeq === seq,
          ACK_TIMEOUT_MS,
        );
      }
    }

    expect(
      sampler.samples.some((s) => slowName in s.buffers),
      "sampler never observed the frozen connection",
    ).toBe(true);
    const slowBuffers = sampler.samples.map((s) => s.buffers[slowName] ?? 0).filter((v) => v > 0);
    const maxBuffered = slowBuffers.length > 0 ? Math.max(...slowBuffers) : 0;

    slow.resume();
    for (let seq = 1; seq <= N; seq += 1) {
      await slow.waitFor(
        (m) =>
          m.type === "doubt.created" &&
          m.requestId === null &&
          (m.payload as { doubt?: { enqueueSeq?: unknown } }).doubt?.enqueueSeq === seq,
        ACK_TIMEOUT_MS,
      );
    }

    for (const c of clients) {
      const leftovers = c.drain();
      expect(
        leftovers.filter((m) => m.type === "error"),
        "unexpected error frames",
      ).toHaveLength(0);
      expect(c.isOpen).toBe(true);
    }
    expect(sampler.tripped).toBeNull();
    expect(sampler.samples.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
    const { rssDelta, heapDelta, maxSlowBuffer } = sampler.stop();
    const sentAfter = await scrapeCounter(solo, "livepulse_ws_messages_sent_total");
    const sentDelta = sentBefore !== null && sentAfter !== null ? sentAfter - sentBefore : null;
    if (sentDelta !== null) {
      expect(sentDelta).toBeGreaterThanOrEqual(N + N * 4);
    }
    const result: LargePayloadRepResult = {
      contentChars: sizeChars,
      creates: N,
      maxSlowBufferedBytes: Math.max(maxBuffered, maxSlowBuffer),
      rssDeltaBytes: rssDelta,
      heapDeltaBytes: heapDelta,
      eventLoopDelayMeanMs: eld.mean / 1e6,
      eventLoopDelayMaxMs: eld.max / 1e6,
      wsMessagesSentDelta: sentDelta,
      samples: sampler.samples.length,
    };
    eld.disable();
    expect(rssDelta).toBeLessThan(RSS_GROWTH_CAP_BYTES);
    expect(result.maxSlowBufferedBytes).toBeLessThanOrEqual(BUFFER_CAP_BYTES);
    return result;
  } finally {
    eld.disable();
    sampler.stop();
    await Promise.allSettled(clients.map((c) => c.close()));
  }
}

describe("WS slow-consumer baseline (backpressure audit, stage 1)", () => {
  let solo: IndependentInstance;
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
    await prisma.$connect();
    // Long heartbeat (existing seam, within schema range) so a frozen socket
    // is not swept mid-stage; distribution disabled keeps this single-instance.
    solo = await startIndependentInstance("ws-backpressure", {
      wsHeartbeatIntervalMs: 300_000,
      distributionEnabled: false,
    });
  });

  afterAll(async () => {
    await solo.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it("calibration: gentle doubt storm with no frozen reader — all broadcasts observed, nobody disconnects", async () => {
    const N = 20;
    const runId = `cal-${Date.now().toString(36)}`;
    const { sessionId } = await makeLiveSession(solo, "cal");
    const eld = monitorEventLoopDelay({ resolution: 10 });
    eld.enable();
    const sampler = startSampler(solo, sessionId, null);
    const clients: WsTestClient[] = [];
    try {
      const creator = await connectToInstance(solo);
      clients.push(creator);
      await joinAs(creator, sessionId, "BpCalCreator");
      const observers: WsTestClient[] = [];
      for (let i = 0; i < 2; i += 1) {
        const c = await connectToInstance(solo);
        clients.push(c);
        observers.push(c);
        await joinAs(c, sessionId, `BpCalFast-${i}`);
      }
      for (const c of clients) c.drain();
      const sentBefore = await scrapeCounter(solo, "livepulse_ws_messages_sent_total");

      // Storm: sequential fresh creates; each private ack is event-awaited.
      const ackAt: number[] = [];
      for (let i = 0; i < N; i += 1) {
        if (sampler.tripped !== null) throw new Error(`safety trip: ${sampler.tripped}`);
        const requestId = `bp-${runId}-${i}`;
        creator.send({
          type: "doubt.create",
          requestId,
          payload: { content: `bp-${runId} doubt ${i}` },
        });
        const ack = await creator.waitFor(
          (m) => m.type === "doubt.created" && m.requestId === requestId,
          ACK_TIMEOUT_MS,
        );
        expect(doubtSeqOf(ack)).toBe(i + 1); // per-session seq from 1, commit order
        ackAt.push(performance.now());
        await new Promise((resolve) => setTimeout(resolve, PACE_MS));
      }

      // Every observer sees every broadcast exactly once, in sequence order.
      // waitFor per seq: deterministic completion, no sleeps.
      for (const observer of observers) {
        for (let seq = 1; seq <= N; seq += 1) {
          await observer.waitFor(
            (m) =>
              m.type === "doubt.created" &&
              m.requestId === null &&
              (m.payload as { doubt?: { enqueueSeq?: unknown } }).doubt?.enqueueSeq === seq,
            ACK_TIMEOUT_MS,
          );
        }
      }
      expect(ackAt).toHaveLength(N);

      // No error frames anywhere; nobody disconnected.
      for (const c of clients) {
        const leftovers = c.drain();
        expect(
          leftovers.filter((m) => m.type === "error"),
          "unexpected error frames",
        ).toHaveLength(0);
        expect(c.isOpen).toBe(true);
      }
      expect(sampler.tripped).toBeNull();
      // The sampler must have observed the storm mid-flight; zero samples
      // would mean the workload outran observation (a measurement miss).
      expect(sampler.samples.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
      const { rssDelta, heapDelta } = sampler.stop();
      const sentAfter = await scrapeCounter(solo, "livepulse_ws_messages_sent_total");
      if (sentBefore !== null && sentAfter !== null) {
        // N private acks + N broadcasts to each of the 3 joined connections.
        expect(sentAfter - sentBefore).toBeGreaterThanOrEqual(N + N * 3);
      }
      const eldMeanMs = eld.mean / 1e6;
      eld.disable();
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          case: "calibration",
          creates: N,
          observers: observers.length,
          rssDeltaBytes: rssDelta,
          heapDeltaBytes: heapDelta,
          eventLoopDelayMeanMs: eldMeanMs,
          wsMessagesSentDelta:
            sentBefore !== null && sentAfter !== null ? sentAfter - sentBefore : null,
          samples: sampler.samples.length,
        }),
      );
      expect(rssDelta).toBeLessThan(RSS_GROWTH_CAP_BYTES);
    } finally {
      eld.disable();
      sampler.stop();
      await Promise.allSettled(clients.map((c) => c.close()));
    }
  });

  it("gentle slow-reader: one frozen client during a small storm — buffers observed, catch-up complete, fast clients unaffected", async () => {
    const N = 40;
    const runId = `slow-${Date.now().toString(36)}`;
    const slowName = "BpSlowReader";
    const { sessionId } = await makeLiveSession(solo, "slow");
    const eld = monitorEventLoopDelay({ resolution: 10 });
    eld.enable();
    const sampler = startSampler(solo, sessionId, slowName);
    const clients: WsTestClient[] = [];
    try {
      const creator = await connectToInstance(solo);
      clients.push(creator);
      await joinAs(creator, sessionId, "BpSlowCreator");
      const observers: WsTestClient[] = [];
      for (let i = 0; i < 2; i += 1) {
        const c = await connectToInstance(solo);
        clients.push(c);
        observers.push(c);
        await joinAs(c, sessionId, `BpSlowFast-${i}`);
      }
      const slow = await connectToInstance(solo);
      clients.push(slow);
      await joinAs(slow, sessionId, slowName);
      for (const c of clients) c.drain();

      slow.freeze(); // stop reading: real TCP backpressure from here on
      const sentBefore = await scrapeCounter(solo, "livepulse_ws_messages_sent_total");

      for (let i = 0; i < N; i += 1) {
        if (sampler.tripped !== null) {
          throw new Error(`safety trip, aborting storm: ${sampler.tripped}`);
        }
        // A frozen-reader disconnect mid-storm is itself a finding: stop, don't plow on.
        for (const c of [...observers, creator]) {
          expect(c.isOpen, "healthy client disconnected mid-storm").toBe(true);
        }
        const requestId = `bp-${runId}-${i}`;
        creator.send({
          type: "doubt.create",
          requestId,
          payload: { content: `bp-${runId} doubt ${i}` },
        });
        const ack = await creator.waitFor(
          (m) => m.type === "doubt.created" && m.requestId === requestId,
          ACK_TIMEOUT_MS,
        );
        expect(doubtSeqOf(ack)).toBe(i + 1);
        await new Promise((resolve) => setTimeout(resolve, PACE_MS));
      }

      // Fast observers each saw every broadcast exactly once, in order.
      for (const observer of observers) {
        for (let seq = 1; seq <= N; seq += 1) {
          await observer.waitFor(
            (m) =>
              m.type === "doubt.created" &&
              m.requestId === null &&
              (m.payload as { doubt?: { enqueueSeq?: unknown } }).doubt?.enqueueSeq === seq,
            ACK_TIMEOUT_MS,
          );
        }
      }

      // The sampler must actually have seen the frozen connection; a missing
      // key would silently report zero as "no accumulation" (a measurement miss).
      expect(
        sampler.samples.some((s) => slowName in s.buffers),
        "sampler never observed the frozen connection",
      ).toBe(true);
      // Server-side buffer for the frozen socket, sampled in-process.
      const slowBuffers = sampler.samples.map((s) => s.buffers[slowName] ?? 0).filter((v) => v > 0);
      const maxBuffered = slowBuffers.length > 0 ? Math.max(...slowBuffers) : 0;

      // End the slow phase with resume + event-awaited catch-up (no sleep).
      slow.resume();
      for (let seq = 1; seq <= N; seq += 1) {
        await slow.waitFor(
          (m) =>
            m.type === "doubt.created" &&
            m.requestId === null &&
            (m.payload as { doubt?: { enqueueSeq?: unknown } }).doubt?.enqueueSeq === seq,
          ACK_TIMEOUT_MS,
        );
      }

      // No error frames; everyone still connected.
      for (const c of clients) {
        const leftovers = c.drain();
        expect(
          leftovers.filter((m) => m.type === "error"),
          "unexpected error frames",
        ).toHaveLength(0);
        expect(c.isOpen).toBe(true);
      }
      expect(sampler.tripped).toBeNull();
      expect(sampler.samples.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
      const { rssDelta, heapDelta, maxSlowBuffer } = sampler.stop();
      const sentAfter = await scrapeCounter(solo, "livepulse_ws_messages_sent_total");
      if (sentBefore !== null && sentAfter !== null) {
        // N acks + N broadcasts to each of the 4 joined connections.
        expect(sentAfter - sentBefore).toBeGreaterThanOrEqual(N + N * 4);
      }
      const eldMeanMs = eld.mean / 1e6;
      const eldMaxMs = eld.max / 1e6;
      eld.disable();
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          case: "slow-reader",
          creates: N,
          observers: observers.length,
          maxSlowBufferedBytesSamples: maxBuffered,
          maxSlowBufferedBytesFinal: maxSlowBuffer,
          rssDeltaBytes: rssDelta,
          heapDeltaBytes: heapDelta,
          eventLoopDelayMeanMs: eldMeanMs,
          eventLoopDelayMaxMs: eldMaxMs,
          wsMessagesSentDelta:
            sentBefore !== null && sentAfter !== null ? sentAfter - sentBefore : null,
          samples: sampler.samples.length,
        }),
      );
      expect(rssDelta).toBeLessThan(RSS_GROWTH_CAP_BYTES);
      expect(maxSlowBuffer).toBeLessThanOrEqual(BUFFER_CAP_BYTES);
    } finally {
      eld.disable();
      sampler.stop();
      await Promise.allSettled(clients.map((c) => c.close()));
    }
  });

  it("stage 2a: large-payload slow-reader (900-char doubts, 30 creates, 2 runs) — buffers observed, catch-up complete", async () => {
    for (const rep of [1, 2]) {
      const result = await runLargePayloadRep(solo, {
        sizeChars: 900,
        creates: 30,
        rep,
        tag: "large900",
        namePrefix: "BpL900R",
      });
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ case: "slow-reader-large", rep, ...result }));
    }
  });

  it("stage 2b: large-payload slow-reader (1000-char doubts, protocol maximum, 30 creates, 2 runs)", async () => {
    for (const rep of [1, 2]) {
      const result = await runLargePayloadRep(solo, {
        sizeChars: 1000,
        creates: 30,
        rep,
        tag: "large1000",
        namePrefix: "BpL1000R",
      });
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ case: "slow-reader-large-max", rep, ...result }));
    }
  });
});

interface SplitRepResult {
  contentChars: number;
  creates: number;
  slowBufferedMax: number;
  fastBufferedMax: number;
  ackRttP50Ms: number;
  ackRttMaxMs: number;
  remoteLagP50Ms: number;
  remoteLagMaxMs: number;
  localLagP50Ms: number;
  localLagMaxMs: number;
  rssDeltaBytes: number;
  heapDeltaBytes: number;
  eventLoopDelayMeanMs: number;
  eventLoopDelayMaxMs: number;
  sentDeltaA: number | null;
  sentDeltaB: number | null;
  redisPublishErrorsA: number | null;
  redisReceivedB: number | null;
  redisIgnoredB: number | null;
  samplesB: number;
}

/**
 * One stage-3 run. Generator (creator + A-side control observer) lives on
 * wsGen; the frozen reader + two fast observers live on wsB, which sees
 * broadcasts only through Redis. Owns every client it opens; the caller owns
 * the instances. Fresh session per run; completion is event-awaited with an
 * outer deadline supplied by the caller.
 */
async function runSplitRep(
  wsGen: IndependentInstance,
  wsObs: IndependentInstance,
  options: { creates: number; rep: number; tag: string; namePrefix: string },
): Promise<SplitRepResult> {
  const { creates: N, rep, tag, namePrefix } = options;
  const sizeChars = 1000; // protocol maximum, verified in stage 2
  const runId = `${tag}-${rep}-${Date.now().toString(36)}`;
  const slowName = `${namePrefix}Slow`;
  const fastNames = [`${namePrefix}Fast-0`, `${namePrefix}Fast-1`];
  const controlName = `${namePrefix}Ctl`;
  const { sessionId } = await makeLiveSession(wsGen, tag);
  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();
  const sampler = startSampler(wsObs, sessionId, slowName);
  const clientsA: WsTestClient[] = [];
  const clientsB: WsTestClient[] = [];
  try {
    const creator = await connectToInstance(wsGen);
    clientsA.push(creator);
    await joinAs(creator, sessionId, `${namePrefix}Creator`);
    const control = await connectToInstance(wsGen);
    clientsA.push(control);
    await joinAs(control, sessionId, controlName);
    const observers: WsTestClient[] = [];
    for (const name of fastNames) {
      const c = await connectToInstance(wsObs);
      clientsB.push(c);
      observers.push(c);
      await joinAs(c, sessionId, name);
    }
    const slow = await connectToInstance(wsObs);
    clientsB.push(slow);
    await joinAs(slow, sessionId, slowName);
    for (const c of [...clientsA, ...clientsB]) c.drain();

    const pubErrBefore = await scrapeLabeledCounter(
      wsGen,
      "livepulse_redis_publish_total",
      "result",
      "error",
    );
    const recvBefore = await scrapeCounter(wsObs, "livepulse_redis_events_received_total");
    const ignoredBefore = await scrapeLabeledCounter(
      wsObs,
      "livepulse_redis_events_ignored_total",
      "reason",
      "no_local_subscribers",
    );
    const sentABefore = await scrapeCounter(wsGen, "livepulse_ws_messages_sent_total");
    const sentBBefore = await scrapeCounter(wsObs, "livepulse_ws_messages_sent_total");

    slow.freeze();
    const ackAt: number[] = [];
    const ackRtt: number[] = [];
    for (let i = 0; i < N; i += 1) {
      if (sampler.tripped !== null) {
        throw new Error(`safety trip, aborting storm: ${sampler.tripped}`);
      }
      for (const c of [...clientsA, ...clientsB]) {
        expect(c.isOpen, "healthy client disconnected mid-storm").toBe(true);
      }
      const requestId = `bp-${runId}-${i}`;
      const content = makeContent(runId, i, sizeChars);
      expect(content.length, "payload size must be exact").toBe(sizeChars);
      const tSend = performance.now();
      creator.send({ type: "doubt.create", requestId, payload: { content } });
      const ack = await creator.waitFor(
        (m) => m.type === "doubt.created" && m.requestId === requestId,
        ACK_TIMEOUT_MS,
      );
      expect(doubtSeqOf(ack)).toBe(i + 1);
      ackAt.push(performance.now());
      ackRtt.push(performance.now() - tSend);
      await new Promise((resolve) => setTimeout(resolve, PACE_MS));
    }

    // A-side control first (local path), then B observers (remote path). A
    // missing B-side seq after an A-side ack is a cross-instance gap: attach
    // the Redis counters so the report distinguishes confirmed publish
    // failure from an unattributed delivery gap — cause not established.
    const arriveCtl: number[] = [];
    for (let seq = 1; seq <= N; seq += 1) {
      await control.waitFor(
        (m) =>
          m.type === "doubt.created" &&
          m.requestId === null &&
          (m.payload as { doubt?: { enqueueSeq?: unknown } }).doubt?.enqueueSeq === seq,
        ACK_TIMEOUT_MS,
      );
      arriveCtl.push(performance.now());
    }
    const arriveB: number[][] = [];
    for (const observer of observers) {
      const arrivals: number[] = [];
      for (let seq = 1; seq <= N; seq += 1) {
        try {
          await observer.waitFor(
            (m) =>
              m.type === "doubt.created" &&
              m.requestId === null &&
              (m.payload as { doubt?: { enqueueSeq?: unknown } }).doubt?.enqueueSeq === seq,
            ACK_TIMEOUT_MS,
          );
        } catch (error) {
          const pubErrAfter = await scrapeLabeledCounter(
            wsGen,
            "livepulse_redis_publish_total",
            "result",
            "error",
          );
          const recvAfter = await scrapeCounter(wsObs, "livepulse_redis_events_received_total");
          const ignoredAfter = await scrapeLabeledCounter(
            wsObs,
            "livepulse_redis_events_ignored_total",
            "reason",
            "no_local_subscribers",
          );
          const fmt = (afterValue: number | null, beforeValue: number | null): string =>
            afterValue === null || beforeValue === null ? "n/a" : String(afterValue - beforeValue);
          throw new Error(
            `cross-instance gap at seq ${seq} ` +
              `(publishErrorsA=${fmt(pubErrAfter, pubErrBefore)}, ` +
              `receivedB=${fmt(recvAfter, recvBefore)}, ` +
              `ignoredNoSubB=${fmt(ignoredAfter, ignoredBefore)}): ` +
              `cause not established. Original: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        arrivals.push(performance.now());
      }
      arriveB.push(arrivals);
    }

    // Same sockets throughout: every sample must contain the frozen socket
    // AND both fast observers on B (a shrinking key set would itself signal
    // a disconnect the isOpen checks missed).
    const expectedKeys = [slowName, ...fastNames].sort().join(",");
    for (const s of sampler.samples) {
      const keys = Object.keys(s.buffers).sort().join(",");
      expect(keys, "B-side socket set changed mid-run").toBe(expectedKeys);
    }
    expect(sampler.samples.length).toBeGreaterThanOrEqual(MIN_SAMPLES);
    const slowMax = Math.max(0, ...sampler.samples.map((s) => s.buffers[slowName] ?? 0));
    const fastMax = Math.max(
      0,
      ...sampler.samples.flatMap((s) => fastNames.map((n) => s.buffers[n] ?? 0)),
    );

    slow.resume();
    for (let seq = 1; seq <= N; seq += 1) {
      await slow.waitFor(
        (m) =>
          m.type === "doubt.created" &&
          m.requestId === null &&
          (m.payload as { doubt?: { enqueueSeq?: unknown } }).doubt?.enqueueSeq === seq,
        ACK_TIMEOUT_MS,
      );
    }

    for (const c of [...clientsA, ...clientsB]) {
      const leftovers = c.drain();
      expect(
        leftovers.filter((m) => m.type === "error"),
        "unexpected error frames",
      ).toHaveLength(0);
      expect(c.isOpen).toBe(true);
    }
    expect(sampler.tripped).toBeNull();
    const { rssDelta, heapDelta, maxSlowBuffer } = sampler.stop();
    const sentAAfter = await scrapeCounter(wsGen, "livepulse_ws_messages_sent_total");
    const sentBAfter = await scrapeCounter(wsObs, "livepulse_ws_messages_sent_total");
    const sentDeltaA =
      sentABefore !== null && sentAAfter !== null ? sentAAfter - sentABefore : null;
    const sentDeltaB =
      sentBBefore !== null && sentBAfter !== null ? sentBAfter - sentBBefore : null;
    if (sentDeltaA !== null) {
      // N acks + N broadcasts to each of the 2 A-side connections.
      expect(sentDeltaA).toBeGreaterThanOrEqual(N + N * 2);
    }
    if (sentDeltaB !== null) {
      // N broadcasts to each of the 3 B-side connections.
      expect(sentDeltaB).toBeGreaterThanOrEqual(N * 3);
    }
    const ackSorted = [...ackRtt].sort((a, b) => a - b);
    const remoteLags = arriveB
      .flatMap((arrivals) => arrivals.map((t, i) => t - ackAt[i]!))
      .sort((a, b) => a - b);
    const localLags = arriveCtl.map((t, i) => t - ackAt[i]!).sort((a, b) => a - b);
    const result: SplitRepResult = {
      contentChars: sizeChars,
      creates: N,
      slowBufferedMax: Math.max(slowMax, maxSlowBuffer),
      fastBufferedMax: fastMax,
      ackRttP50Ms: pctOf(ackSorted, 50),
      ackRttMaxMs: ackSorted.length > 0 ? ackSorted[ackSorted.length - 1]! : NaN,
      remoteLagP50Ms: pctOf(remoteLags, 50),
      remoteLagMaxMs: remoteLags.length > 0 ? remoteLags[remoteLags.length - 1]! : NaN,
      localLagP50Ms: pctOf(localLags, 50),
      localLagMaxMs: localLags.length > 0 ? localLags[localLags.length - 1]! : NaN,
      rssDeltaBytes: rssDelta,
      heapDeltaBytes: heapDelta,
      eventLoopDelayMeanMs: eld.mean / 1e6,
      eventLoopDelayMaxMs: eld.max / 1e6,
      sentDeltaA,
      sentDeltaB,
      redisPublishErrorsA:
        pubErrBefore !== null
          ? ((await scrapeLabeledCounter(
              wsGen,
              "livepulse_redis_publish_total",
              "result",
              "error",
            )) ?? NaN) - pubErrBefore
          : null,
      redisReceivedB:
        recvBefore !== null
          ? ((await scrapeCounter(wsObs, "livepulse_redis_events_received_total")) ?? NaN) -
            recvBefore
          : null,
      redisIgnoredB:
        ignoredBefore !== null
          ? ((await scrapeLabeledCounter(
              wsObs,
              "livepulse_redis_events_ignored_total",
              "reason",
              "no_local_subscribers",
            )) ?? NaN) - ignoredBefore
          : null,
      samplesB: sampler.samples.length,
    };
    eld.disable();
    expect(rssDelta).toBeLessThan(RSS_GROWTH_CAP_BYTES);
    expect(result.slowBufferedMax).toBeLessThanOrEqual(BUFFER_CAP_BYTES);
    return result;
  } finally {
    eld.disable();
    sampler.stop();
    await Promise.allSettled([...clientsA, ...clientsB].map((c) => c.close()));
  }
}

/**
 * Boot the split-instance pair for one stage-3 run. Generator keeps the
 * default heartbeat (all its clients stay responsive); the observer gets
 * the long interval so the frozen socket survives. Distribution stays on
 * (default) — cross-instance delivery is the point. Caller closes both.
 */
async function bootSplitPair(): Promise<{
  wsGen: IndependentInstance;
  wsObs: IndependentInstance;
}> {
  const [wsGen, wsObs] = await Promise.all([
    startIndependentInstance("ws-bp-split-gen", { distributionEnabled: true }),
    startIndependentInstance("ws-bp-split-obs", { wsHeartbeatIntervalMs: 300_000 }),
  ]);
  return { wsGen, wsObs };
}

describe("WS slow-consumer split-instance (backpressure audit, stage 3)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it("stage 3: generate on A, frozen reader + fast observers on B (1000-char doubts, 30 creates) — run 1", async () => {
    const { wsGen, wsObs } = await bootSplitPair();
    try {
      const result = await withDeadline(
        runSplitRep(wsGen, wsObs, { creates: 30, rep: 1, tag: "split", namePrefix: "BpSplitR" }),
        18_000,
        "split-instance run 1",
      );
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ case: "split-instance-slow-reader", rep: 1, ...result }));
    } finally {
      await wsGen.close();
      await wsObs.close();
    }
  });

  it("stage 3: generate on A, frozen reader + fast observers on B (1000-char doubts, 30 creates) — run 2", async () => {
    const { wsGen, wsObs } = await bootSplitPair();
    try {
      const result = await withDeadline(
        runSplitRep(wsGen, wsObs, { creates: 30, rep: 2, tag: "split", namePrefix: "BpSplitR" }),
        18_000,
        "split-instance run 2",
      );
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ case: "split-instance-slow-reader", rep: 2, ...result }));
    } finally {
      await wsGen.close();
      await wsObs.close();
    }
  });
});
