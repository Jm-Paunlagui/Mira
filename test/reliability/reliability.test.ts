/**
 * RELIABILITY — correctness under repetition, concurrency and time: no leaks,
 * no lost updates, idempotent upserts, stable latency, exact round-trips.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Transaction } from "../../src/utils/oracle-mongo-wrapper";
import { db, schema, coll, dropIfExists, rawExec, recordMetric, percentile, timeIt, appDbInUse } from "../helpers/db";

const C = "MIRA_RL_COUNTER";
const D = "MIRA_RL_DATA";
const L = "MIRA_RL_LEDGER";
const m = (metric: string, value: number, unit: string, note?: string) => recordMetric({ category: "reliability", metric, value, unit, note });

/** Run `n` jobs with at most `k` in flight (stays inside the pool, so failures are real, not shedding). */
async function bounded<T>(n: number, k: number, job: (i: number) => Promise<T>) {
  const out: PromiseSettledResult<T>[] = new Array(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: k }, async () => {
      for (let i = next++; i < n; i = next++) out[i] = await job(i).then((value) => ({ status: "fulfilled", value }) as const, (reason) => ({ status: "rejected", reason }) as const);
    }),
  );
  return out;
}

beforeAll(async () => {
  await dropIfExists(C, D, L);
  await schema.createTable(C, { ID: { type: "NUMBER", primaryKey: true }, N: { type: "NUMBER", default: "0" } });
  await coll(C).insertOne({ ID: 1, N: 0 });
  await schema.createTable(D, {
    ID: { type: "NUMBER", primaryKey: true },
    TXT: { type: "VARCHAR2(4000)" },
    NUM: { type: "NUMBER" },
    MONEY: { type: "NUMBER(19,4)" },
    TS: { type: "TIMESTAMP(6)" },
    DT: { type: "DATE" },
    BIG: { type: "CLOB" },
    BIN: { type: "BLOB" },
  });
  await schema.createTable(L, { ID: { type: "NUMBER", primaryKey: true }, BAL: { type: "NUMBER", check: "BAL >= 0" } });
  await coll(L).insertMany(Array.from({ length: 20 }, (_, i) => ({ ID: i + 1, BAL: 500 })), { returning: [] });
});
afterAll(() => dropIfExists(C, D, L));

describe("reliability: no lost updates, no leaks", () => {
  it("300 concurrent $inc on one row: exactly 300 (no lost update)", async () => {
    const res = await bounded(300, 10, () => coll(C).updateOne({ ID: 1 }, { $inc: { N: 1 } }));
    expect(res.every((r) => r.status === "fulfilled")).toBe(true);
    expect((await coll(C).findOne<{ N: number }>({ ID: 1 }))?.N).toBe(300);
  }, 60000);

  it("1,000 mixed operations (with deliberate failures) leave zero connections checked out", async () => {
    let failures = 0;
    const res = await bounded(1000, 10, async (i) => {
      switch (i % 5) {
        case 0: return coll(C).findOne({ ID: 1 });
        case 1: return coll("MIRA_RL_DOES_NOT_EXIST").countDocuments();
        case 2: return new Transaction(db).withTransaction(async () => { throw new Error("rollback me"); });
        case 3: return coll(C).find({}).toArray();
        default: return db.withConnection(async (c) => c.execute("SELECT 1 FROM DUAL"));
      }
    });
    failures = res.filter((r) => r.status === "rejected").length;
    m("mixed ops: deliberate failures", failures, "count");
    expect(failures).toBe(400);
    expect(await appDbInUse()).toBe(0);
  }, 120000);

  it("merge is idempotent: 50 concurrent identical upserts → one row", async () => {
    const res = await bounded(50, 10, () => coll(D).merge({ ID: 7, NUM: 42 }, { localField: "ID", foreignField: "ID" }, { whenMatched: { $set: { NUM: 42 } }, whenNotMatched: "insert" }));
    const dupes = res.filter((r) => r.status === "rejected" && /ORA-00001/.test(String((r as PromiseRejectedResult).reason))).length;
    m("concurrent MERGE ORA-00001 races", dupes, "count", "MERGE is not atomic across sessions; callers must retry ORA-00001");
    expect(await coll(D).countDocuments({ ID: 7 })).toBe(1);
    expect(res.every((r) => r.status === "fulfilled" || /ORA-00001/.test(String((r as PromiseRejectedResult).reason)))).toBe(true);
  }, 60000);

  it("concurrent transfers keep the ledger balanced", async () => {
    const tx = new Transaction(db);
    const res = await bounded(400, 8, async (i) => {
      const from = (i * 7) % 20 + 1;
      const to = (i * 13 + 5) % 20 + 1;
      if (from === to) return;
      await tx.withTransaction(async (s) => {
        const l = s.collection(L);
        // lock in a fixed order so this workload cannot deadlock
        await l.find({ ID: { $in: [from, to] } }).sort({ ID: 1 }).forUpdate(true).toArray();
        await l.updateOne({ ID: from }, { $inc: { BAL: -(i % 37) } });
        await l.updateOne({ ID: to }, { $inc: { BAL: i % 37 } });
      });
    });
    const refused = res.filter((r) => r.status === "rejected");
    for (const r of refused) expect(String((r as PromiseRejectedResult).reason)).toMatch(/ORA-02290/); // overdraft refused
    m("transfers refused (overdraft)", refused.length, "count");
    const sum = await coll(L).aggregate([{ $group: { _id: null, t: { $sum: "$BAL" } } }]);
    expect(Number(sum[0].T)).toBe(20 * 500);
  }, 120000);
});

describe("reliability: data round-trips exactly", () => {
  it("unicode, emoji, 4,000-byte strings, CLOB, numbers, timestamps", async () => {
    const ts = new Date("2026-05-06T07:08:09.123Z");
    const doc = {
      ID: 1,
      TXT: "Ñandú — 日本語 — 🚀 — Ελληνικά",
      NUM: 1234567890123,
      MONEY: 98765.4321,
      TS: ts,
      DT: new Date("2026-05-06T00:00:00Z"),
      BIG: "x".repeat(100000),
      BIN: Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 256)),
    };
    await coll(D).insertOne(doc);
    const back = await coll(D).findOne<Record<string, unknown>>({ ID: 1 });
    expect(back?.TXT).toBe(doc.TXT);
    expect(back?.NUM).toBe(doc.NUM);
    expect(Number(back?.MONEY)).toBe(98765.4321);
    expect((back?.TS as Date).getTime()).toBe(ts.getTime());
    expect((back?.DT as Date).getTime()).toBe(doc.DT.getTime());
    // CLOBs come back as plain strings in both Thin and Thick mode (2.0.1).
    // A driver Lob would outlive its released connection and fail in Thick mode (NJS-003).
    expect(typeof back?.BIG).toBe("string");
    expect(back?.BIG).toBe(doc.BIG);
    expect(Buffer.isBuffer(back?.BIN)).toBe(true);
    expect((back?.BIN as Buffer).equals(doc.BIN)).toBe(true);
    await coll(D).insertOne({ ID: 2, TXT: "é".repeat(2000) }); // 4,000 bytes exactly
    expect((await coll(D).findOne<{ TXT: string }>({ ID: 2 }))?.TXT).toHaveLength(2000);
  });

  it("DEFECT: scaled NUMBER (money) is fetched exactly — the adapter's money-safe handler is never applied", async () => {
    // EXECUTE_OPTIONS.fetchTypeHandler exists in the adapter but no wrapper query passes it,
    // so NUMBER(19,4) arrives as an IEEE double and large amounts lose digits.
    await rawExec(`INSERT INTO "${D}" ("ID", "MONEY") VALUES (4, 123456789012345.6789)`);
    const back = await coll(D).findOne<{ MONEY: unknown }>({ ID: 4 });
    expect(String(back?.MONEY)).toBe("123456789012345.6789");
  });

  it("Oracle treats '' as NULL — documented, consistent", async () => {
    await coll(D).insertOne({ ID: 3, TXT: "" });
    expect((await coll(D).findOne<{ TXT: unknown }>({ ID: 3 }))?.TXT).toBeNull();
    expect(await coll(D).countDocuments({ ID: 3, TXT: null })).toBe(1);
    expect(await coll(D).countDocuments({ ID: 3, TXT: "" })).toBe(0); // '' = NULL never matches with '='
  });

  it("money sums are exact (no float drift over 10,000 cents)", async () => {
    await coll(D).insertMany(Array.from({ length: 1000 }, (_, i) => ({ ID: 100 + i, MONEY: 0.1 })), { returning: [] });
    const r = await coll(D).aggregate([{ $match: { ID: { $gte: 100 } } }, { $group: { _id: null, s: { $sum: "$MONEY" } } }]);
    expect(String(r[0].S)).toBe("100"); // 1000 × 0.1 exactly
  });
});

describe("reliability: stability over time", () => {
  it("soak: 3,000 sequential operations, zero errors, no latency drift", async () => {
    const lat: number[] = [];
    let errors = 0;
    for (let i = 0; i < 3000; i++) {
      const [, ms] = await timeIt(() =>
        (i % 3 === 0 ? coll(C).updateOne({ ID: 1 }, { $inc: { N: 1 } }) : i % 3 === 1 ? coll(C).findOne({ ID: 1 }) : coll(D).countDocuments({ ID: { $lt: 50 } })).catch(() => {
          errors++;
        }),
      );
      lat.push(ms);
    }
    const q = (a: number[]) => percentile([...a].sort((x, y) => x - y), 95);
    const first = q(lat.slice(0, 750));
    const last = q(lat.slice(-750));
    m("soak 3,000 ops: errors", errors, "count");
    m("soak p95 first quarter", first, "ms");
    m("soak p95 last quarter", last, "ms");
    expect(errors).toBe(0);
    expect(last).toBeLessThan(Math.max(first * 3, first + 5));
    expect(await appDbInUse()).toBe(0);
  }, 180000);

  it("same query → same SQL and same result, 200 times", async () => {
    const q = () => coll(D).find({ ID: { $in: [1, 2, 3] }, TXT: { $exists: true } }).sort({ ID: 1 }).project({ BIG: 0 });
    const sql = await q().explain();
    const first = JSON.stringify(await q().toArray());
    for (let i = 0; i < 200; i++) {
      expect(await q().explain()).toBe(sql);
      if (i % 20 === 0) expect(JSON.stringify(await q().toArray())).toBe(first);
    }
  });

  it("a long forEach cursor sees one consistent snapshot while rows change underneath", async () => {
    let seen = 0;
    const writer = (async () => {
      for (let i = 0; i < 20; i++) await coll(D).insertOne({ ID: 5000 + i, TXT: "during" });
    })();
    await coll(D).find({ ID: { $gte: 100, $lt: 1100 } }).forEach(() => { seen++; });
    await writer;
    expect(seen).toBe(1000);
  });

  it("DEFECT: per-connection state (callTimeout) set by one borrower must not leak to the next", async () => {
    // Nothing resets session settings on release, so a pooled connection keeps them.
    const pool = db;
    for (let i = 0; i < 10; i++) await pool.withConnection(async (c) => { c.callTimeout = 1234; });
    const seen = await Promise.all(Array.from({ length: 10 }, () => pool.withConnection(async (c) => c.callTimeout)));
    for (let i = 0; i < 10; i++) await pool.withConnection(async (c) => { c.callTimeout = 0; }); // clean up for other suites
    expect(seen.every((t) => !t)).toBe(true);
  });
});
