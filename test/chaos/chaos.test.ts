/**
 * CHAOS — inject failures into a live Oracle and assert the wrapper fails
 * loudly, fast, and recovers: dead hosts, bad credentials, exhausted pools,
 * cancelled and timed-out calls, connections dying mid-use, deadlocks,
 * random mid-transaction crashes, and fuzzed input.
 *
 * Failure pools are added to the connection registry at runtime (chaos_*),
 * so appDb is never put at risk; each test also checks appDb still works.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import config from "../../src/config";
import database from "../../src/driver/registry";
import { Transaction, parseFilter } from "../../src";
import { db, schema, coll, dropIfExists, recordMetric, timeIt, sleep, appDbInUse } from "../helpers/db";

const conns = database.connections as Record<string, Record<string, unknown>>;
const app = conns.appDb;
const A = "MIRA_CH_ACCOUNTS";
const m = (metric: string, value: number, unit: string, note?: string) => recordMetric({ category: "chaos", metric, value, unit, note });
const appDbAlive = async () => expect(await coll(A).countDocuments()).toBeGreaterThan(0);

beforeAll(async () => {
  conns.chaos_badhost = { user: app.user, password: app.password, connectString: "127.0.0.1:1/NOPE", poolMin: 0, poolMax: 2, connectTimeout: 2000 };
  conns.chaos_badcreds = { user: "MIRA_NO_SUCH_USER", password: "wrong", connectString: app.connectString, poolMin: 0, poolMax: 2 };
  conns.chaos_small = { user: app.user, password: app.password, connectString: app.connectString, poolMin: 2, poolMax: 2, queueMax: 2, queueTimeout: 1500 }; // pre-sized: no growth race
  conns.chaos_cb = { user: app.user, password: app.password, connectString: app.connectString, poolMin: 1, poolMax: 2 };
  await dropIfExists(A);
  await schema.createTable(A, { ID: { type: "NUMBER", primaryKey: true }, BALANCE: { type: "NUMBER", check: "BALANCE >= 0" } });
  await coll(A).insertMany(Array.from({ length: 10 }, (_, i) => ({ ID: i + 1, BALANCE: 1000 })), { returning: [] });
});
afterAll(async () => {
  await dropIfExists(A);
  for (const k of Object.keys(conns)) if (k.startsWith("chaos_")) delete conns[k];
});

describe("chaos: database unreachable / misconfigured", () => {
  it("dead host: bounded failure with a clear error; appDb unaffected", async () => {
    const [err, ms] = await timeIt(() => config.withConnection("chaos_badhost", async () => 1).catch((e: Error) => e));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/chaos_badhost/);
    expect((err as Error).message).toMatch(/ECONNREFUSED|NJS-503|NJS-500|NJS-510|ORA-12541|DPI-|refused/i);
    m("dead host time-to-error (4 create attempts + backoff)", ms, "ms");
    expect(ms).toBeLessThan(20000);
    await appDbAlive();
  }, 30000);

  it("dead host: repeated failures open the circuit breaker; callers then fail fast", async () => {
    for (let i = 0; i < 6 && config.isPoolHealthy("chaos_badhost"); i++) {
      config.nudgePoolHealth("chaos_badhost");
      await sleep(400);
    }
    expect(config.isPoolHealthy("chaos_badhost")).toBe(false);
    const [err, ms] = await timeIt(() => config.withConnection("chaos_badhost", async () => 1).catch((e: Error) => e));
    expect((err as Error).message).toMatch(/chaos_badhost/);
    m("open-breaker fail-fast latency", ms, "ms");
    expect(ms).toBeLessThan(50);
  }, 30000);

  it("bad credentials surface ORA-01017 (no lockout of the real account)", async () => {
    const err = await config.withConnection("chaos_badcreds", async () => 1).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/ORA-01017/);
    await appDbAlive();
  }, 30000);
});

describe("chaos: pool exhaustion and slow calls", () => {
  const hold = (secs: number) => config.withConnection("chaos_small", (c: { execute: (s: string) => Promise<unknown> }) => c.execute(`BEGIN DBMS_SESSION.SLEEP(${secs}); END;`));

  it("burst beyond poolMax + queueMax is shed with NJS-076, the rest complete", async () => {
    await config.withConnection("chaos_small", async () => 1);
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => hold(0.4)));
    const ok = res.filter((r) => r.status === "fulfilled").length;
    const shed = res.filter((r) => r.status === "rejected" && /NJS-076/.test(String((r as PromiseRejectedResult).reason)));
    m("burst 8 on pool(2)+queue(2): served", ok, "count");
    m("burst 8 on pool(2)+queue(2): shed NJS-076", shed.length, "count");
    // 2 connections + 2 queue slots serve 4; the rest are shed at once. The pool health
    // monitor's 30 s ping can hold a queue slot at that instant: then 3 are served, 5 shed.
    expect(ok + shed.length).toBe(8);
    expect(ok === 4 || ok === 3).toBe(true);
  }, 30000);

  it("DEFECT: queueTimeout is a hard bound — NJS-040 must surface, not be retried into a longer wait", async () => {
    // _acquireConnection treats NJS-040 (queue timeout = saturation) as transient and retries it,
    // so a queued caller waits up to ~3 × queueTimeout and the retries add load to a saturated pool.
    const started = Date.now();
    const res = await Promise.allSettled(
      Array.from({ length: 4 }, () => hold(2.5).then(() => Date.now() - started, (e: Error) => { throw Object.assign(e, { at: Date.now() - started }); })),
    );
    const rejectedWith = (code: string) => res.filter((r) => r.status === "rejected" && new RegExp(code).test(String((r as PromiseRejectedResult).reason))) as PromiseRejectedResult[];
    const timedOut = rejectedWith("NJS-040");
    const shed = rejectedWith("NJS-076");
    const slowest = Math.max(...res.map((r) => (r.status === "fulfilled" ? r.value : (r.reason as { at: number }).at)));
    m("queued caller worst wait (queueTimeout=1500ms)", slowest, "ms");
    // The bound itself, not exact counts. Two callers get the two connections; the other two
    // queue and time out with NJS-040 near queueTimeout, never ~3x (no retry). The pool health
    // monitor's 30 s ping can be queued at that instant and take a queue slot: then one caller
    // is shed at once with NJS-076 (queue full) instead of queueing — seen 1 run in ~10.
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(timedOut.length + shed.length).toBe(2);
    expect(timedOut.length).toBeGreaterThanOrEqual(1);
    for (const r of timedOut) expect((r.reason as { at: number }).at).toBeLessThan(1500 + 1000);
    for (const r of shed) expect((r.reason as { at: number }).at).toBeLessThan(500);
  }, 30000);

  it("pool recovers after saturation", async () => {
    expect(await config.withConnection("chaos_small", async () => "recovered")).toBe("recovered");
    const stats = (await config.getPoolStats()).pools as Record<string, { connectionsInUse: number }>;
    expect(stats.chaos_small.connectionsInUse).toBe(0);
  }, 30000);

  // NOTE: how fast an in-flight call is interrupted depends on out-of-band break support between
  // driver and server. Through Docker port-forwarding on macOS it lands only when the call ends,
  // so latency is recorded, not asserted; the wrapper's job (error surfaces, connection released) is.
  it("per-call timeout fails a runaway statement with NJS-123; the connection is released", async () => {
    const [err, ms] = await timeIt(() =>
      db.withConnection(async (c) => {
        c.callTimeout = 500;
        try {
          await c.execute("BEGIN DBMS_SESSION.SLEEP(3); END;");
        } finally {
          c.callTimeout = 0; // pooled connections keep this setting — see reliability suite
        }
      }).catch((e: Error) => e),
    );
    expect((err as Error).message).toMatch(/NJS-123|DPI-1067|call timeout/i);
    m("callTimeout(500ms) observed abort latency", ms, "ms", "OOB break unsupported via Docker/macOS → lands at call end");
    expect(await appDbInUse()).toBe(0);
    await appDbAlive();
  }, 30000);

  it("conn.break() cancels an in-flight statement with ORA-01013", async () => {
    const [err, ms] = await timeIt(() =>
      db.withConnection(async (c) => {
        setTimeout(() => void c.break(), 300);
        await c.execute("BEGIN DBMS_SESSION.SLEEP(3); END;");
      }).catch((e: Error) => e),
    );
    expect((err as Error).message).toMatch(/ORA-01013/);
    m("conn.break() observed cancel latency", ms, "ms", "OOB break unsupported via Docker/macOS → lands at call end");
    await appDbAlive();
  }, 30000);

  it("connection dies mid-callback (closed underneath): NJS-003, no leak", async () => {
    const err = await db.withConnection(async (c) => {
      await c.close();
      await c.execute("SELECT 1 FROM DUAL");
    }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/NJS-003|invalid connection/i);
    expect(await appDbInUse()).toBe(0);
    await appDbAlive();
    // 30 s like the rest of this block (it had bun's 5 s default): right after the
    // conn.break() test the pool can still be recovering the cancelled session, and in
    // Thick mode this test then ran just past 5 s (1 run in 3 locally). Alone it takes ~1 ms.
  }, 30000);

  it("an open breaker on a healthy pool fails fast and closes on a successful probe", async () => {
    await config.withConnection("chaos_cb", async () => 1);
    config.__setPoolHealthForTest("chaos_cb", false);
    const [err, ms] = await timeIt(() => config.withConnection("chaos_cb", async () => 1).catch((e: Error) => e));
    expect(err).toBeInstanceOf(Error);
    expect(ms).toBeLessThan(20);
    expect(await config.withConnection("chaos_cb", async () => "probe", { bypassBreaker: true })).toBe("probe");
    config.recordProbeSuccess("chaos_cb");
    expect(await config.withConnection("chaos_cb", async () => "back")).toBe("back");
  });
});

describe("chaos: transactional integrity under failure", () => {
  const total = async () => Number((await coll(A).aggregate([{ $group: { _id: null, t: { $sum: "$BALANCE" } } }]))[0].T);

  it("random crashes mid-transfer never create or destroy money", async () => {
    const tx = new Transaction(db);
    let committed = 0;
    let crashed = 0;
    let deadlocks = 0;
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    // 8 concurrent workers (inside poolMax) so every failure is an injected crash, not load shedding.
    const jobs = Array.from({ length: 120 }, (_, i) => i);
    await Promise.all(
      Array.from({ length: 8 }, async () => {
       for (let j = jobs.shift(); j !== undefined; j = jobs.shift()) {
        const from = 1 + Math.floor(rnd() * 10);
        const to = 1 + ((from + Math.floor(rnd() * 9)) % 10);
        const amt = 1 + Math.floor(rnd() * 50);
        const crash = rnd() < 0.3;
        try {
          await tx.withTransaction(async (s) => {
            await s.collection(A).updateOne({ ID: from }, { $inc: { BALANCE: -amt } });
            if (crash) throw new Error("injected crash after debit");
            await s.collection(A).updateOne({ ID: to }, { $inc: { BALANCE: amt } });
          });
          committed++;
        } catch (e) {
          crashed++;
          // Random lock order between concurrent transfers can deadlock: Oracle picks a
          // victim (ORA-00060) and the wrapper rolls its transaction back — also a valid crash.
          if (/ORA-00060/.test(String(e))) deadlocks++;
          expect(String(e)).toMatch(/injected crash|ORA-02290|ORA-00060/);
        }
       }
      }),
    );
    m("transfers committed", committed, "count");
    m("transfers crashed / rolled back", crashed, "count");
    m("transfers rolled back by deadlock (ORA-00060)", deadlocks, "count");
    expect(committed + crashed).toBe(120);
    expect(await total()).toBe(10000);
    expect(await appDbInUse()).toBe(0);
  }, 60000);

  it("deadlock: Oracle picks exactly one victim (ORA-00060); the other commits", async () => {
    const tx = new Transaction(db);
    const lockThenWait = (first: number, second: number) =>
      tx.withTransaction(async (s) => {
        await s.collection(A).updateOne({ ID: first }, { $inc: { BALANCE: 0 } });
        await sleep(300);
        await s.collection(A).updateOne({ ID: second }, { $inc: { BALANCE: 0 } });
      });
    const [res, ms] = await timeIt(() => Promise.allSettled([lockThenWait(1, 2), lockThenWait(2, 1)]));
    const deadlocked = res.filter((r) => r.status === "rejected" && /ORA-00060/.test(String((r as PromiseRejectedResult).reason)));
    m("deadlock detection + resolution", ms, "ms");
    expect(deadlocked).toHaveLength(1);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await total()).toBe(10000);
  }, 60000);

  it("lock contention with NOWAIT fails immediately instead of hanging", async () => {
    const tx = new Transaction(db);
    await tx.withTransaction(async (s) => {
      await s.collection(A).find({ ID: 3 }).forUpdate(true).toArray();
      const [err, ms] = await timeIt(() => coll(A).find({ ID: 3 }).forUpdate("nowait").toArray().catch((e: Error) => e));
      expect((err as Error).message).toMatch(/ORA-00054/);
      expect(ms).toBeLessThan(1000);
      const [err2, ms2] = await timeIt(() => coll(A).find({ ID: 3 }).forUpdate({ wait: 1 }).toArray().catch((e: Error) => e));
      // 19c: ORA-30006 (resource busy; WAIT timeout expired). 23ai: ORA-00054 + ORA-40097.
      expect((err2 as Error).message).toMatch(/ORA-30006|ORA-00054/);
      expect(ms2).toBeGreaterThanOrEqual(900);
    });
  }, 30000);
});

describe("chaos: hostile and malformed input", () => {
  it("fuzzed filters either compile or throw a plain Error — never crash, never leak a connection", async () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const ops = ["$eq", "$ne", "$gt", "$in", "$nin", "$between", "$regex", "$like", "$exists", "$bogus", "$not", "$or", "$and"];
    const vals = [1, -1, 0, "x", "' OR 1=1 --", null, [], [1, 2], {}, { $gt: 1 }, true, new Date(0), NaN, "𝔘nicode"];
    const gen = (d: number): Record<string, unknown> => {
      const op = pick(ops);
      if (d > 3) return { BALANCE: pick(vals) };
      if (op === "$or" || op === "$and") return { [op]: [gen(d + 1), gen(d + 1)] };
      if (op === "$not") return { $not: gen(d + 1) };
      return { BALANCE: { [op]: pick(vals) } };
    };
    let compiled = 0;
    let refused = 0;
    let dbErrors = 0;
    for (let i = 0; i < 300; i++) {
      const f = gen(0);
      try {
        parseFilter(f);
        compiled++;
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        refused++;
        continue;
      }
      await coll(A).countDocuments(f).catch((e: Error) => {
        expect(e.message).toMatch(/ORA-|NJS-|DPI-/);
        dbErrors++;
      });
    }
    m("fuzz: compiled", compiled, "count");
    m("fuzz: refused by parser", refused, "count");
    m("fuzz: refused by Oracle", dbErrors, "count");
    expect(compiled + refused).toBe(300);
    expect(await appDbInUse()).toBe(0);
    expect(await coll(A).countDocuments()).toBe(10);
  }, 60000);

  it("pathologically deep nesting ($and × 300) is handled", async () => {
    let f: Record<string, unknown> = { ID: 1 };
    for (let i = 0; i < 300; i++) f = { $and: [f] };
    const r = await coll(A).countDocuments(f).catch((e: Error) => e);
    expect(r === 1 || r instanceof Error).toBe(true);
  });

  it("a forEach consumer that throws aborts the stream and releases the connection", async () => {
    let seen = 0;
    await expect(coll(A).find({}).forEach(() => { seen++; throw new Error("consumer bug"); })).rejects.toThrow(/consumer bug/);
    expect(seen).toBe(1);
    expect(await appDbInUse()).toBe(0);
  });

  it("DEFECT: a forEach consumer that REJECTS (async) must fail forEach, not become an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const outcome = await coll(A)
      .find({})
      .forEach(async () => {
        await Promise.resolve();
        throw new Error("async consumer bug");
      })
      .then(() => "resolved", (e: Error) => e.message);
    await sleep(50);
    process.off("unhandledRejection", onUnhandled);
    expect(outcome).toMatch(/async consumer bug/);
    expect(unhandled).toHaveLength(0);
  });
});
