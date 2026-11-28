/**
 * CHAOS — the network between Mira and Oracle fails, through a TCP proxy
 * (test/helpers/chaosProxy.ts), so no database privileges are needed:
 *
 *   - a stalled link (packets stop, sockets stay open): every call, check and
 *     pool open is bounded by the pool's callTimeout / connectTimeout;
 *   - every connection cut at once (a database restart, as the client sees it):
 *     the pool recovers with no app restart and leaks nothing;
 *   - a flapping link: one onChange per transition, and the breaker settles;
 *   - mira.close() while work and a stream are in flight;
 *   - connections cut at random points inside withTransaction, bulkWrite and
 *     insertMany: all or nothing.
 *
 * Each test has its own Mira instance and pool name on the proxy, so appDb (the
 * suite's own pool) is never put at risk.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createMira, fromEnv, onQuery, type Mira } from "../../src";
import { startChaosProxy, type ChaosProxy } from "../helpers/chaosProxy";
import { schema, coll, dropIfExists, recordMetric, sleep } from "../helpers/db";

const T = "MIRA_CH_NET";
const m = (metric: string, value: number, unit: string, note?: string) => recordMetric({ category: "chaos", metric, value, unit, note });
const base = fromEnv();
const app = base.pools.appDb;
let proxy: ChaosProxy;
const open: Mira[] = [];
let seq = 0;

/** A Mira instance whose one pool goes through the proxy. */
function viaProxy(extra: Record<string, number> = {}): Mira {
  const name = `chaosNet${++seq}`;
  const mira = createMira({
    ...base,
    defaultPool: name,
    pools: { [name]: { ...app, connectString: proxy.connectString, poolMin: 1, poolMax: 4, connectTimeout: 1500, callTimeout: 1500, ...extra } },
  });
  open.push(mira);
  return mira;
}

/** Resolves to how long `p` took, and whether it rejected, within `cap` ms (else "hung"). */
async function settle(p: Promise<unknown>, cap = 30000): Promise<{ ms: number; outcome: "ok" | "error" | "hung"; message?: string }> {
  const s = performance.now();
  const outcome = await Promise.race([
    p.then(() => ({ outcome: "ok" as const }), (e: Error) => ({ outcome: "error" as const, message: e.message })),
    sleep(cap).then(() => ({ outcome: "hung" as const })),
  ]);
  return { ms: performance.now() - s, ...outcome };
}

const count = async () => coll(T).countDocuments();

beforeAll(async () => {
  proxy = await startChaosProxy();
  await dropIfExists(T);
  await schema.createTable(T, { ID: { type: "NUMBER", primaryKey: true }, N: { type: "VARCHAR2(20)" } });
}, 60000);
afterAll(async () => {
  proxy.resume();
  for (const mira of open) await mira.close().catch(() => {});
  await proxy.close();
  await dropIfExists(T);
}, 60000);

describe("chaos: a stalled network link", () => {
  it("a call on a stalled link fails within its callTimeout and the connection is not reused", async () => {
    const mira = viaProxy();
    expect(await mira.collection(T).countDocuments()).toBe(0);
    proxy.stall();
    try {
      const r = await settle(mira.collection(T).countDocuments());
      m("stalled call time-to-error (callTimeout 1500)", r.ms, "ms");
      expect(r.outcome).toBe("error");
      expect(r.message).toMatch(/did not finish within|DPI-1067|NJS-123|NJS-500/);
      expect(r.ms).toBeLessThan(6000);
    } finally {
      proxy.resume();
    }
    // The pool hands out a working connection next (the hung one was dropped).
    proxy.reset();
    expect(await mira.collection(T).countDocuments()).toBe(0);
  }, 30000);

  it("health checks are bounded too: the breaker opens during a stall, fails fast, and closes on recovery", async () => {
    const mira = viaProxy();
    await mira.collection(T).countDocuments();
    const changes: boolean[] = [];
    const stop = mira.health.onChange((c) => changes.push(c.healthy));
    proxy.stall();
    try {
      const s = performance.now();
      for (let i = 0; i < 40 && mira.health.isHealthy(); i++) {
        mira.health.nudge();
        await sleep(500);
      }
      m("breaker open time during a stall", performance.now() - s, "ms");
      expect(mira.health.isHealthy()).toBe(false);
      const r = await settle(mira.collection(T).countDocuments());
      expect(r.message).toMatch(/NJS-503/);
      expect(r.ms).toBeLessThan(100);
    } finally {
      proxy.resume();
    }
    for (let i = 0; i < 80 && !mira.health.isHealthy(); i++) await sleep(250);
    stop();
    expect(mira.health.isHealthy()).toBe(true);
    expect(changes).toEqual([false, true]);
    expect(await mira.collection(T).countDocuments()).toBe(0);
  }, 60000);

  it("opening a pool over a stalled link fails within its connect timeout and retries (Thick mode too)", async () => {
    proxy.stall();
    try {
      const mira = viaProxy({ poolMin: 0 });
      const r = await settle(mira.collection(T).countDocuments(), 60000);
      m("pool open over a stalled link: time-to-error (4 attempts)", r.ms, "ms");
      expect(r.outcome).toBe("error");
      expect(r.message).toMatch(/Could not create pool/);
      expect(r.ms).toBeLessThan(40000);
    } finally {
      proxy.resume();
    }
  }, 70000);
});

describe("chaos: the database restarts under a live pool", () => {
  it("every connection cut at once: the pool recovers without an app restart and leaks nothing", async () => {
    const mira = viaProxy({ poolMin: 3 });
    const c = mira.collection(T);
    await Promise.all([c.countDocuments(), c.countDocuments(), c.countDocuments()]);
    proxy.reset();
    // Calls right after the cut either work (a fresh connection) or fail with a connection error; none hang.
    const after = await Promise.all(Array.from({ length: 6 }, () => settle(c.countDocuments(), 10000)));
    for (const r of after) {
      expect(r.outcome).not.toBe("hung");
      if (r.outcome === "error") expect(r.message).toMatch(/NJS-500|NJS-501|NJS-503|ORA-03113|ORA-03114|ORA-03135|DPI-1080|broken|closed/);
    }
    m("calls failed right after a full connection cut", after.filter((r) => r.outcome === "error").length, "count", "of 6");
    // Within a few seconds every call works again, and nothing is left checked out.
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      ok = (await settle(c.countDocuments(), 5000)).outcome === "ok";
      if (!ok) await sleep(250);
    }
    expect(ok).toBe(true);
    const stats = (await mira.stats()).pools as Record<string, { connectionsInUse: number }>;
    expect(Object.values(stats)[0].connectionsInUse).toBe(0);
  }, 60000);
});

describe("chaos: a flapping link", () => {
  it("up/down/up three times: one onChange per transition, no storm, and the breaker settles healthy", async () => {
    const mira = viaProxy();
    await mira.collection(T).countDocuments();
    const changes: boolean[] = [];
    let checks = 0;
    const stopChange = mira.health.onChange((c) => changes.push(c.healthy));
    const stopCheck = mira.health.onCheck(() => checks++);
    for (let flap = 0; flap < 3; flap++) {
      proxy.stall();
      for (let i = 0; i < 40 && mira.health.isHealthy(); i++) {
        mira.health.nudge();
        await sleep(500);
      }
      proxy.resume();
      for (let i = 0; i < 80 && !mira.health.isHealthy(); i++) await sleep(250);
    }
    stopChange();
    stopCheck();
    m("health checks during 3 flaps", checks, "count");
    expect(changes).toEqual([false, true, false, true, false, true]);
    expect(mira.health.isHealthy()).toBe(true);
    expect(await mira.collection(T).countDocuments()).toBe(0);
  }, 120000);
});

describe("chaos: close() while work is in flight", () => {
  it("close() during a running statement and a running stream: both settle, close() returns, later work is refused", async () => {
    const mira = viaProxy({ callTimeout: 0, poolMin: 2 });
    const db = mira.db();
    const sleeping = settle(db.withConnection((c) => c.execute("BEGIN DBMS_SESSION.SLEEP(1); END;")), 20000);
    let rows = 0;
    const streaming = settle(
      db.withConnection(async (c) => {
        const s = c.queryStream("SELECT LEVEL N FROM DUAL CONNECT BY LEVEL <= 200000");
        await new Promise<void>((res, rej) => { s.on("data", () => { rows++; }); s.on("end", res); s.on("error", rej); });
      }),
      20000,
    );
    for (let i = 0; i < 100 && rows === 0; i++) await sleep(20); // the stream is flowing
    expect(rows).toBeGreaterThan(0);
    const closing = await settle(mira.close(), 20000);
    const [a, b] = await Promise.all([sleeping, streaming]);
    m("close() with work in flight", closing.ms, "ms");
    expect(closing.outcome).toBe("ok");
    expect(a.outcome).not.toBe("hung");
    expect(b.outcome).not.toBe("hung");
    expect(mira.closed).toBe(true);
    // After close(), the instance refuses new work: new handles throw, old handles reject.
    expect(() => mira.collection(T)).toThrow(/closed/i);
    await expect(db.withConnection(async () => 1)).rejects.toThrow(/closed/i);
  }, 60000);
});

describe("chaos: connections cut inside multi-step writes", () => {
  /** Cuts every proxied connection once `after` statements on `table` have run. */
  function cutAfter(after: number, table: string) {
    let n = 0;
    return onQuery((e) => {
      if (e.sql.includes(table) && ++n === after) proxy.reset();
    });
  }

  it("withTransaction: a cut at any step leaves none of the transaction's rows", async () => {
    const mira = viaProxy({ callTimeout: 0 });
    for (const step of [1, 3, 7]) {
      const stop = cutAfter(step, T);
      const r = await settle(
        mira.transaction().withTransaction(async (s) => {
          for (let i = 0; i < 10; i++) await s.collection(T).insertOne({ ID: 1000 + i, N: `tx-${step}` });
        }),
        20000,
      );
      stop();
      expect(r.outcome).toBe("error");
      expect(await count()).toBe(0);
    }
  }, 90000);

  it("bulkWrite and insertMany: a cut mid-batch leaves all or nothing", async () => {
    const mira = viaProxy({ callTimeout: 0 });
    const c = mira.collection(T);
    const stop = cutAfter(2, T);
    const r1 = await settle(
      c.bulkWrite([
        { insertOne: { document: { ID: 1, N: "a" } } },
        { insertOne: { document: { ID: 2, N: "b" } } },
        { insertOne: { document: { ID: 3, N: "c" } } },
        { updateOne: { filter: { ID: 1 }, update: { $set: { N: "a2" } } } },
      ]),
      20000,
    );
    stop();
    expect(r1.outcome).toBe("error");
    expect(await count()).toBe(0);
    // insertMany is one statement: cut while it runs (a large batch), then check it all landed or none did.
    const docs = Array.from({ length: 20000 }, (_, i) => ({ ID: 10_000 + i, N: "bulk" }));
    const pending = settle(c.insertMany(docs, { returning: [] }), 30000);
    await sleep(5);
    proxy.reset();
    const r2 = await pending;
    expect(r2.outcome).not.toBe("hung");
    const n = await count();
    expect([0, 20000]).toContain(n);
    m("insertMany cut mid-batch: rows kept", n, "rows", r2.outcome);
    await coll(T).deleteMany({});
  }, 90000);
});
