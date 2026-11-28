/**
 * CHAOS — the network between Mira and Oracle fails, through a TCP proxy
 * (test/helpers/chaosProxy.ts), so no database privileges are needed:
 *
 *   - a stalled link (packets stop, sockets stay open): every call, check and
 *     pool open is bounded by the pool's callTimeout / connectTimeout;
 *   - every connection cut at once (a database restart, as the client sees it):
 *     the pool recovers with no app restart and leaks nothing;
 *   - a flapping link: one onChange per transition, and the breaker settles;
 *   - mira.close() while work and a stream are in flight, and over sockets that went dead;
 *   - connections cut at random points inside withTransaction, bulkWrite and
 *     insertMany: all or nothing.
 *
 * Each test has its own Mira instance and pool name on the proxy, so appDb (the
 * suite's own pool) is never put at risk.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createMira, fromEnv, onQuery, MiraDbError, type Mira } from "../../src";
import { oracledb, getPoolStats } from "../../src/driver/oracle";
import { availableParallelism } from "node:os";
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
function viaProxy(extra: Record<string, number> = {}, on: ChaosProxy = proxy): Mira {
  const name = `chaosNet${++seq}`;
  const mira = createMira({
    ...base,
    defaultPool: name,
    pools: { [name]: { ...app, connectString: on.connectString, poolMin: 1, poolMax: 4, connectTimeout: 1500, callTimeout: 1500, ...extra } },
  });
  open.push(mira);
  return mira;
}

/** Resolves to how long `p` took, and whether it rejected, within `cap` ms (else "hung"). */
async function settle(p: Promise<unknown>, cap = 30000): Promise<{ ms: number; outcome: "ok" | "error" | "hung"; message?: string; error?: Error }> {
  const s = performance.now();
  const outcome = await Promise.race([
    p.then(() => ({ outcome: "ok" as const }), (e: Error) => ({ outcome: "error" as const, message: e.message, error: e })),
    sleep(cap).then(() => ({ outcome: "hung" as const })),
  ]);
  return { ms: performance.now() - s, ...outcome };
}

const count = async () => coll(T).countDocuments();

/**
 * Waits for the breaker to close. Each cut leaves a failed check on the record and a success never
 * clears it, so a few cuts in a row can open it: the next call then waits for the recovery
 * (open -> half-open -> closed, one check each, 5 s apart).
 */
async function recovered(mira: Mira, ms = 40_000): Promise<void> {
  for (let waited = 0; waited < ms && !mira.health.isHealthy(); waited += 250) await sleep(250);
  expect(mira.health.isHealthy()).toBe(true);
}

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
  // Let the native work the tests abandoned (background pool closes, zombie drops) end before
  // the process does: with the proxies gone their sockets fail, so it ends within seconds.
  // Exiting while Thick native calls are still running crashed Bun on macOS.
  const busy = async () => Object.values((await getPoolStats()).abandoned).some((n) => n > 0);
  for (let i = 0; i < 100 && (await busy()); i++) await sleep(200);
  expect(await busy()).toBe(false);
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
      // The error says what happened in a form code can branch on: Mira's backstop cut the call (Thin), or the driver's own timeout did (Thick).
      const e = r.error as MiraDbError;
      expect(e).toBeInstanceOf(MiraDbError);
      expect(["connectivity", "timeout"]).toContain(e.kind);
      if (e.kind === "connectivity") expect(e.code).toBe("MIRA_CALL_TIMEOUT");
      expect(e.outcomeUnknown).toBe(false); // a count: nothing was written
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

  it("cold start over a stalled link: callers fail at connectTimeout (MIRA_POOL_OPENING), the pool keeps trying, the breaker opens by its failed attempts, and the pool comes up once the link does", async () => {
    proxy.stall();
    const mira = viaProxy({ poolMin: 0 });
    const s = performance.now();
    try {
      const first = await settle(mira.collection(T).countDocuments(), 30000);
      m("cold start over a stall: caller time-to-error (connectTimeout 1500)", first.ms, "ms");
      expect(first.outcome).toBe("error");
      expect(first.ms).toBeLessThan(1500 + 500); // not the whole creation (4 attempts, ~10 s)
      expect(first.error).toBeInstanceOf(MiraDbError);
      expect(first.error as MiraDbError).toMatchObject({ code: "MIRA_POOL_OPENING", kind: "connectivity" });
      // stats() does not wait for the opening either.
      const t = performance.now();
      const st = (await mira.stats()).pools as Record<string, Record<string, unknown>>;
      expect(performance.now() - t).toBeLessThan(500);
      expect(Object.values(st)[0]).toEqual({ opening: true });
      // The failed attempts alone open the breaker: no check ever waited for the creation.
      for (let i = 0; i < 100 && mira.health.isHealthy(); i++) await sleep(250);
      m("cold start over a stall: breaker open time", performance.now() - s, "ms");
      expect(mira.health.isHealthy()).toBe(false);
      expect(performance.now() - s).toBeLessThan(17_000); // 3 attempts x 5 s + 2 s
      const open = await settle(mira.collection(T).countDocuments());
      expect(open.message).toMatch(/NJS-503/);
    } finally {
      proxy.resume();
      proxy.reset();
    }
    // The link is back: the pool opens (a check does it), the breaker half-opens and closes.
    for (let i = 0; i < 160 && !mira.health.isHealthy(); i++) await sleep(250);
    expect(mira.health.isHealthy()).toBe(true);
    expect(await mira.collection(T).countDocuments()).toBe(0);
  }, 120000);

  it("mira.open() over a stalled link still waits for the whole creation and reports it (Could not create pool)", async () => {
    proxy.stall();
    try {
      const mira = viaProxy({ poolMin: 0 });
      const s = performance.now();
      const results = await Promise.race([mira.open(), sleep(60000).then(() => "hung" as const)]);
      m("mira.open() over a stalled link: time to report", performance.now() - s, "ms");
      expect(results).not.toBe("hung"); // open() reports a failed pool, it does not throw
      const [res] = results as Array<{ success: boolean; error?: string }>;
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Could not create pool/);
    } finally {
      proxy.resume();
      proxy.reset();
    }
  }, 120000);
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

describe("chaos: close() over sockets that went dead", () => {
  // The old sockets die without a reset (a dropped link) while the database is reachable on new ones:
  // pool.close() would wait on them for as long as TCP takes to give up, so close() must abandon it.
  const BOUND_MS = 10_000 + 2 * 1500 + 1000; // drain + 2 x connectTimeout, plus a second of slack

  /** The abandoned-work counters, read through a sibling instance (stats() is process-wide for `abandoned`). */
  let reader: Mira | undefined;
  async function abandonedPools(): Promise<number> {
    reader ??= viaProxy({ poolMin: 0 });
    return (await reader.stats()).abandoned.pools;
  }

  it("close() returns within drain + 2 x connectTimeout, and counts the abandoned close until the sockets end", async () => {
    const mira = viaProxy({ poolMin: 2 });
    expect(await mira.collection(T).countDocuments()).toBe(0); // warm
    proxy.blackholeExisting();
    expect(proxy.blackholed).toBeGreaterThan(0);
    // New connections still flow: the blackhole is only the old sockets.
    const sibling = viaProxy({ poolMin: 0 });
    expect(await sibling.collection(T).countDocuments()).toBe(0);
    const before = await abandonedPools();
    const r = await settle(mira.close(), 25000);
    m("close() over dead sockets (poolMin 2)", r.ms, "ms");
    expect(r.outcome).toBe("ok");
    expect(r.ms).toBeLessThan(BOUND_MS);
    expect(await abandonedPools()).toBeGreaterThan(before);
    // The sockets finally end (what TCP giving up looks like): the abandoned close settles and the ledger drains.
    proxy.reset();
    for (let i = 0; i < 80 && (await abandonedPools()) > before; i++) await sleep(250);
    expect(await abandonedPools()).toBe(before);
  }, 60000);

  it("a two-pool instance closes its pools in parallel: one bound, not two", async () => {
    const [a, b] = [`chaosNet${++seq}`, `chaosNet${++seq}`];
    const pool = { ...app, connectString: proxy.connectString, poolMin: 2, poolMax: 4, connectTimeout: 1500, callTimeout: 1500 };
    const mira = createMira({ ...base, defaultPool: a, pools: { [a]: pool, [b]: pool } });
    open.push(mira);
    await mira.collection(T, a).countDocuments();
    await mira.collection(T, b).countDocuments();
    proxy.blackholeExisting();
    const r = await settle(mira.close(), 40000);
    m("close() over dead sockets (two pools)", r.ms, "ms");
    expect(r.outcome).toBe("ok");
    expect(r.ms).toBeLessThan(BOUND_MS); // sequential would be ~2 x 13 s
    proxy.reset();
  }, 60000);
});

describe("chaos: calls and streams on a connection whose link stops answering (the per-connection guard)", () => {
  const STALL_ERROR = /did not finish within|DPI-1067|NJS-123|NJS-500|ORA-03156|ORA-03113/;

  it("calls started together on one connection are timed one after another: three 1 s calls under callTimeout 1500 all succeed", async () => {
    const mira = viaProxy();
    const r = await settle(
      mira.db().withConnection((c) => Promise.all([1, 2, 3].map(() => c.execute("BEGIN DBMS_SESSION.SLEEP(1); END;")))),
      30000,
    );
    m("3 x SLEEP(1) on one connection, callTimeout 1500", r.ms, "ms");
    expect(r.outcome).toBe("ok"); // the third would have been cut at 2.5 s if every timer started at once
    expect(r.ms).toBeGreaterThan(2900); // they ran one after another
  }, 40000);

  it("an auto-committed write cut on a stalled link says its outcome is unknown; a query cut says it is not", async () => {
    const mira = viaProxy();
    await mira.collection(T).countDocuments();
    proxy.stall();
    try {
      const write = await settle(mira.collection(T).insertOne({ ID: 7001, N: "unknown" }));
      const read = await settle(mira.collection(T).countDocuments());
      m("stalled auto-committed insert time-to-error", write.ms, "ms");
      expect(write.outcome).toBe("error");
      expect((write.error as MiraDbError).outcomeUnknown).toBe(true);
      if ((write.error as MiraDbError).kind === "connectivity") expect((write.error as MiraDbError).code).toBe("MIRA_OUTCOME_UNKNOWN");
      expect(read.outcome).toBe("error");
      expect((read.error as MiraDbError).outcomeUnknown).toBe(false);
    } finally {
      proxy.resume();
      proxy.reset();
    }
    expect(await coll(T).countDocuments({ ID: 7001 })).toBe(0); // the packets never left: nothing was written
  }, 60000);

  it("a stream whose link goes dead ends with an error inside callTimeout + 2.5 s, and the next call works (forEach, for await, raw)", async () => {
    const mira = viaProxy({ poolMin: 2 });
    const rowsOf = () => mira.collection("ALL_OBJECTS").find({});
    const limit = 1500 + 2500;

    let seen = 0;
    const forEach = await settle(rowsOf().forEach(() => { if (++seen === 1) proxy.blackholeExisting(); }), 30000);
    m("forEach over a dead link: time-to-error", forEach.ms, "ms");
    expect(forEach.outcome).toBe("error");
    expect(forEach.message).toMatch(STALL_ERROR);
    expect(forEach.ms).toBeLessThan(limit + 1500); // the first rows were already buffered
    proxy.reset();
    await recovered(mira);
    expect(await mira.collection(T).countDocuments()).toBe(0); // a new socket

    seen = 0;
    const iterate = await settle((async () => { for await (const _ of rowsOf()) if (++seen === 1) proxy.blackholeExisting(); })(), 30000);
    m("for await over a dead link: time-to-error", iterate.ms, "ms");
    expect(iterate.outcome).toBe("error");
    expect(iterate.message).toMatch(STALL_ERROR);
    expect(iterate.ms).toBeLessThan(limit + 1500);
    proxy.reset();
    await recovered(mira);
    expect(await mira.collection(T).countDocuments()).toBe(0);

    seen = 0;
    const raw = await settle(
      mira.db().withConnection((c) => new Promise<void>((resolve, reject) => {
        const stream = c.queryStream("SELECT LEVEL N FROM DUAL CONNECT BY LEVEL <= 2000000");
        stream.on("data", () => { if (++seen === 1) proxy.blackholeExisting(); });
        stream.on("end", resolve);
        stream.on("error", reject);
      })),
      30000,
    );
    m("raw queryStream over a dead link: time-to-error", raw.ms, "ms");
    expect(raw.outcome).toBe("error");
    expect(raw.message).toMatch(STALL_ERROR);
    expect(raw.ms).toBeLessThan(limit + 1500);
    proxy.reset();
    await recovered(mira);
    expect(await mira.collection(T).countDocuments()).toBe(0);
  }, 90000);
});

describe("chaos: a busy pool is not a down pool", () => {
  it("a saturated pool sheds callers with NJS-040 at queueTimeout, and its health checks do not open the breaker", async () => {
    const mira = viaProxy({ poolMin: 2, poolMax: 2, queueMax: 6, queueTimeout: 3000, connectTimeout: 1000, callTimeout: 10000 });
    await mira.collection(T).countDocuments(); // warm
    const changes: boolean[] = [];
    const checks: Array<{ ok: boolean; saturated?: boolean }> = [];
    const stopChange = mira.health.onChange((c) => changes.push(c.healthy));
    const stopCheck = mira.health.onCheck((c) => checks.push(c));
    const holders = [1, 2].map(() => settle(mira.db().withConnection((c) => c.execute("BEGIN DBMS_SESSION.SLEEP(6); END;")), 30000));
    await sleep(300); // both connections are held
    const callers = await Promise.all([
      ...Array.from({ length: 4 }, () => settle(mira.collection(T).countDocuments(), 30000)),
      (async () => { for (let i = 0; i < 3; i++) { mira.health.nudge(); await sleep(700); } return null; })(),
    ]);
    const shed = callers.filter((r): r is NonNullable<typeof r> => r !== null);
    m("saturated pool: caller time-to-NJS-040 (queueTimeout 3000)", Math.max(...shed.map((r) => r.ms)), "ms");
    for (const r of shed) {
      expect(r.outcome).toBe("error");
      expect(r.message).toMatch(/NJS-040/);
      expect(r.message).not.toMatch(/NJS-076/);
      expect(r.ms).toBeLessThan(4500); // not ~3 x queueTimeout
      expect((r.error as MiraDbError).kind).toBe("saturation");
    }
    expect(mira.health.isHealthy()).toBe(true);
    await Promise.all(holders);
    stopChange();
    stopCheck();
    expect(changes).toEqual([]); // the breaker never opened
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(await mira.collection(T).countDocuments()).toBe(0);
  }, 60000);

  it("close() while a check is in flight, then a new instance on the same pool name: healthy, and it serves", async () => {
    const name = "chaosNetReuse";
    const cfg = { ...base, defaultPool: name, pools: { [name]: { ...app, connectString: proxy.connectString, poolMin: 1, poolMax: 4, connectTimeout: 1500, callTimeout: 1500 } } };
    const first = createMira(cfg);
    open.push(first);
    await first.collection(T).countDocuments();
    proxy.stall();
    first.health.nudge();
    await sleep(600); // the check is waiting on the stalled link
    const closing = first.close(); // forgets the pool's health record at once
    proxy.resume();
    await closing;
    const second = createMira(cfg);
    open.push(second);
    expect(await second.collection(T).countDocuments()).toBe(0);
    await sleep(700); // the first instance's check ends now; it must not bring a record back
    expect(second.health.isHealthy()).toBe(true);
    expect(await second.collection(T).countDocuments()).toBe(0);
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
    // Every cut connection went back (dropped), none stays checked out. In Thick mode with a trace
    // handler installed (cutAfter's onQuery is one), node-oracledb 7.0.1's close() failed before
    // releasing a broken connection: one slot lost per cut.
    const pools = (await mira.stats()).pools as Record<string, { connectionsInUse?: number }>;
    expect(Object.values(pools).map((p) => p.connectionsInUse)).toEqual([0]);
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

describe("chaos: abandoned work is capped, and a pool stuck on dead sockets is replaced", () => {
  const poolOf = async (mira: Mira) => Object.values((await mira.stats()).pools as Record<string, Record<string, number>>)[0];

  it("soak over a stalled link: opening steps, sockets and abandoned calls stay bounded; everything drains after the link returns", async () => {
    const SOAK_MS = Number(process.env.MIRA_SOAK_MS ?? 60_000);
    const poolMin = 2;
    const poolMax = 4;
    // Its own proxy: the other tests' instances keep checking and re-opening on the shared one.
    const own = await startChaosProxy();
    const reader = viaProxy({ poolMin: 0 });
    const before = (await reader.stats()).abandoned;
    own.stall();
    const mira = viaProxy({ poolMin, poolMax }, own);
    let maxPools = 0;
    let maxCalls = 0;
    let maxSockets = 0;
    const until = performance.now() + SOAK_MS;
    try {
      while (performance.now() < until) {
        void mira.collection(T).countDocuments().catch(() => {});
        mira.health.nudge();
        const a = (await mira.stats()).abandoned;
        maxPools = Math.max(maxPools, a.pools - before.pools);
        maxCalls = Math.max(maxCalls, a.calls - before.calls);
        maxSockets = Math.max(maxSockets, own.open);
        await sleep(250);
      }
    } finally {
      own.resume();
    }
    m("soak: most abandoned opening steps at once", maxPools, "count", `${SOAK_MS} ms`);
    m("soak: most abandoned calls at once", maxCalls, "count");
    m("soak: most sockets open on the proxy", maxSockets, "count");
    expect(maxPools).toBeLessThanOrEqual(2); // ABANDONED_CREATE_CAP
    // Sockets: a burst of at most poolMax + 2 attempts' worth, then a trickle. Under a stall the proxy never sees a
    // client's close (a paused socket does not read its end-of-stream), so abandoned connect attempts stay counted
    // here: Thin measured one per ~4 s. A retry storm would be ten a second; the bound allows one per 2 s.
    expect(maxSockets).toBeLessThanOrEqual(poolMax + 2 * (poolMin + 1) + 2 + SOAK_MS / 2000);
    expect(maxCalls).toBeLessThanOrEqual(poolMax + 4);
    // The link is back: whatever was abandoned ends, and the ledger returns to where it started.
    for (let i = 0; i < 120; i++) {
      const a = (await reader.stats()).abandoned;
      if (a.pools <= before.pools && a.calls <= before.calls && a.zombies <= before.zombies) break;
      await sleep(250);
    }
    const after = (await reader.stats()).abandoned;
    expect(after.pools).toBeLessThanOrEqual(before.pools);
    expect(after.calls).toBeLessThanOrEqual(before.calls);
    expect(after.zombies).toBeLessThanOrEqual(before.zombies);
    await recovered(mira);
    await own.close();
  }, 240_000);

  it("failover without a reset: every pooled socket goes silent, the dead pool is replaced, and calls work again within 30 s", async () => {
    const own = await startChaosProxy();
    const mira = viaProxy({ poolMin: 4, poolMax: 4 }, own);
    const c = mira.collection(T);
    await Promise.all([1, 2, 3, 4].map(() => c.countDocuments())); // four connections, all through the proxy
    own.blackholeExisting();
    expect(own.blackholed).toBeGreaterThan(0);
    const s = performance.now();
    let served = false;
    const inflight: Array<Promise<unknown>> = [];
    while (!served && performance.now() - s < 30_000) {
      inflight.push(c.countDocuments().catch(() => {}));
      const r = await settle(c.countDocuments(), 5000);
      served = r.outcome === "ok";
      if (!served) await sleep(250);
    }
    const ms = performance.now() - s;
    m("failover without a reset: time to the first successful call", ms, "ms");
    expect(served).toBe(true);
    expect(ms).toBeLessThan(30_000);
    for (let i = 0; i < 80 && !mira.health.isHealthy(); i++) await sleep(250);
    expect(mira.health.isHealthy()).toBe(true);
    const after = await poolOf(mira);
    m("failover without a reset: replacements", after.replacements, "count");
    m("failover without a reset: zombie connections", after.zombieConnections, "count");
    // Thin leaves the cut connections hung (their close queues behind the hung call), so the pool is replaced.
    // Thick interrupts a call it cannot finish and closes that session itself: nothing is left stuck to replace.
    if (!oracledb.oracleClientVersion) expect(after.replacements).toBeGreaterThanOrEqual(1);
    own.reset();
    await Promise.allSettled(inflight);
    await own.close();
  }, 120_000);

  it("Thick only: stalled calls hold worker threads; a pool on another link keeps its answers only while threads remain", async () => {
    const probe = viaProxy({ poolMin: 0 });
    await probe.collection(T).countDocuments(); // the driver is initialised
    if (!oracledb.oracleClientVersion) return; // Thin does not use the worker threads
    const configured = Number(process.env.UV_THREADPOOL_SIZE);
    const threads = Number.isInteger(configured) && configured > 1 ? configured : process.versions.bun ? availableParallelism() : 4;
    const own = await startChaosProxy();
    const stalled = viaProxy({ poolMin: 4, poolMax: 4, callTimeout: 1500 }, own);
    const direct = coll(T);
    await Promise.all([1, 2, 3, 4].map(() => stalled.collection(T).countDocuments()));
    own.blackholeExisting();
    const calls = [1, 2, 3, 4].map(() => settle(stalled.collection(T).countDocuments(), 20000));
    await sleep(300); // the four calls are in the driver now
    const r = await settle(direct.countDocuments(), 20000);
    m(`Thick: a query on another pool while 4 calls are stalled (${threads} worker threads)`, r.ms, "ms");
    // With a thread to spare (4 stalled + this one) it is answered at once; without, it queues behind the stalled calls
    // until the driver frees one (measured: callTimeout + ~1 s).
    if (threads >= 5) {
      expect(r.outcome).toBe("ok");
      expect(r.ms).toBeLessThan(1000);
    } else {
      expect(r.ms).toBeGreaterThan(1000);
    }
    await Promise.all(calls);
    m("Thick: calls Mira abandoned (its backstop fired before the driver's own timeout)", (await probe.stats()).abandoned.calls, "count");
    own.reset();
    await own.close();
  }, 120_000);
});
