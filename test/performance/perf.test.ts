/**
 * PERFORMANCE — throughput and latency of the wrapper against the live MIRA
 * schema. Every number is recorded in MIRA_TEST_METRICS; the assertions are
 * floors that catch regressions (orders of magnitude), not benchmarks — the
 * target is a local Docker Oracle, so absolute values vary by machine.
 *
 * Budgets can be tightened with env vars, e.g. MIRA_PERF_P95_POINT_MS=10.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, schema, coll, dropIfExists, recordMetric, percentile, timeIt, appDbInUse } from "../helpers/db";

const T = "MIRA_PF_ROWS";
const rows = coll(T);
const N = Number(process.env.MIRA_PERF_ROWS ?? 10000);
const budget = (name: string, dflt: number) => Number(process.env[name] ?? dflt);
const m = (metric: string, value: number, unit: string, note?: string) => recordMetric({ category: "performance", metric, value, unit, note });

async function latencies(n: number, fn: (i: number) => Promise<unknown>) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await timeIt(() => fn(i)))[1]);
  return out.sort((a, b) => a - b);
}

beforeAll(async () => {
  await dropIfExists(T, `${T}_LOOP`);
  await schema.createTable(T, {
    ID: { type: "NUMBER", primaryKey: true },
    GRP: { type: "NUMBER" },
    NAME: { type: "VARCHAR2(60)" },
    AMOUNT: { type: "NUMBER(12,2)" },
    CREATED: { type: "DATE" },
  });
  await schema.createTable(`${T}_LOOP`, { ID: { type: "NUMBER", primaryKey: true }, NAME: { type: "VARCHAR2(60)" } });
});
afterAll(() => dropIfExists(T, `${T}_LOOP`));

describe("performance: writes", () => {
  it(`insertMany loads ${N} rows (batches of 1,000) and beats an insertOne loop per row`, async () => {
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    const docs = Array.from({ length: N }, (_, i) => ({ ID: i + 1, GRP: i % 50, NAME: `row-${i}`, AMOUNT: (i % 997) + 0.25, CREATED: new Date(base + i * 60000) }));
    const [, bulkMs] = await timeIt(async () => {
      for (let i = 0; i < docs.length; i += 1000) await rows.insertMany(docs.slice(i, i + 1000), { returning: [] });
    });
    const bulkRate = N / (bulkMs / 1000);
    m("insertMany throughput", bulkRate, "rows/s", `${N} rows in ${bulkMs.toFixed(0)} ms`);

    const loopN = 200;
    const [, loopMs] = await timeIt(async () => {
      for (let i = 0; i < loopN; i++) await coll(`${T}_LOOP`).insertOne({ ID: i, NAME: `l-${i}` });
    });
    const loopRate = loopN / (loopMs / 1000);
    m("insertOne loop throughput", loopRate, "rows/s");
    m("insertMany speed-up vs insertOne", bulkRate / loopRate, "x");

    expect(await rows.countDocuments()).toBe(N);
    expect(bulkRate).toBeGreaterThan(budget("MIRA_PERF_MIN_BULK_RPS", 1000));
    expect(bulkRate / loopRate).toBeGreaterThan(5);
  }, 120000);

  it("bulkUpdateByKeys (one round trip) vs updateOne loop", async () => {
    const upd = Array.from({ length: 5000 }, (_, i) => ({ ID: i + 1, NAME: `upd-${i}` }));
    const [r, bulkMs] = await timeIt(() => rows.bulkUpdateByKeys(upd, { keys: ["ID"] }));
    expect(r.modifiedCount).toBe(5000);
    const bulkRate = 5000 / (bulkMs / 1000);
    const [, loopMs] = await timeIt(async () => {
      for (let i = 0; i < 200; i++) await rows.updateOne({ ID: i + 1 }, { $set: { NAME: `u1-${i}` } });
    });
    const loopRate = 200 / (loopMs / 1000);
    m("bulkUpdateByKeys throughput", bulkRate, "rows/s");
    m("updateOne loop throughput", loopRate, "rows/s");
    expect(bulkRate / loopRate).toBeGreaterThan(5);
  }, 120000);
});

describe("performance: reads", () => {
  it("primary-key point lookup latency (findOne, 300 samples)", async () => {
    const l = await latencies(300, (i) => rows.findOne({ ID: (i * 37) % N + 1 }));
    m("findOne by PK p50", percentile(l, 50), "ms");
    m("findOne by PK p95", percentile(l, 95), "ms");
    m("findOne by PK p99", percentile(l, 99), "ms");
    expect(percentile(l, 95)).toBeLessThan(budget("MIRA_PERF_P95_POINT_MS", 50));
  });

  it("filtered + sorted + paged query latency (indexed)", async () => {
    await rows.createIndex({ GRP: 1, AMOUNT: -1 });
    const l = await latencies(100, (i) => rows.find({ GRP: i % 50, AMOUNT: { $gt: 100 } }).sort({ AMOUNT: -1 }).skip(5).limit(20).toArray());
    m("find+sort+page p50", percentile(l, 50), "ms");
    m("find+sort+page p95", percentile(l, 95), "ms");
    expect(percentile(l, 95)).toBeLessThan(budget("MIRA_PERF_P95_PAGE_MS", 100));
  });

  it("aggregate $group over the whole table", async () => {
    const l = await latencies(20, () => rows.aggregate([{ $group: { _id: "$GRP", total: { $sum: "$AMOUNT" }, n: { $count: "*" } } }, { $sort: { total: -1 } }]));
    m("aggregate $group p95", percentile(l, 95), "ms", `${N} rows → 50 groups`);
    expect(percentile(l, 95)).toBeLessThan(budget("MIRA_PERF_P95_AGG_MS", 500));
  });

  it("$in with 5,000 values (split into ≤1,000-bind groups)", async () => {
    const ids = Array.from({ length: 5000 }, (_, i) => i * 2 + 1);
    const [cnt, ms] = await timeIt(() => rows.countDocuments({ ID: { $in: ids } }));
    expect(cnt).toBe(Math.min(5000, Math.ceil(N / 2)));
    m("$in 5,000 values", ms, "ms");
    expect(ms).toBeLessThan(budget("MIRA_PERF_IN5K_MS", 3000));
  });

  it("forEach streams the full table; toArray for comparison", async () => {
    let n = 0;
    const heap0 = process.memoryUsage().heapUsed;
    const [, streamMs] = await timeIt(() => rows.find({}).forEach(() => { n++; }));
    const heapStream = process.memoryUsage().heapUsed - heap0;
    const [all, arrayMs] = await timeIt(() => rows.find({}).toArray());
    expect(n).toBe(N);
    expect(all).toHaveLength(N);
    m("forEach stream full table", N / (streamMs / 1000), "rows/s");
    m("toArray full table", N / (arrayMs / 1000), "rows/s");
    m("forEach heap growth", heapStream / 1024 / 1024, "MB");
  }, 60000);
});

describe("performance: concurrency and pool", () => {
  it("200 concurrent queries over a 10-connection pool: no errors, pool drains", async () => {
    const [res, ms] = await timeIt(() => Promise.allSettled(Array.from({ length: 200 }, (_, i) => rows.countDocuments({ GRP: i % 50 }))));
    const failed = res.filter((r) => r.status === "rejected");
    m("concurrent queries (200) wall time", ms, "ms");
    m("concurrent throughput", 200 / (ms / 1000), "queries/s");
    m("concurrent failures (NJS-076 shed)", failed.length, "count", "appDb queueMax=40: shedding above poolMax+queueMax is by design");
    // poolMax 10 + queueMax 40 = 50 in flight; the rest may be shed with NJS-076 by design.
    for (const f of failed) expect(String((f as PromiseRejectedResult).reason)).toMatch(/NJS-076|queue/i);
    expect(await appDbInUse()).toBe(0);
  }, 60000);

  it("40 concurrent queries (within poolMax + queueMax) all succeed", async () => {
    const [res, ms] = await timeIt(() => Promise.all(Array.from({ length: 40 }, (_, i) => rows.findOne({ ID: i + 1 }))));
    expect(res.every(Boolean)).toBe(true);
    m("concurrent queries (40) wall time", ms, "ms");
  });

  it("withConnection acquire+release overhead", async () => {
    const l = await latencies(300, () => db.withConnection(async () => 1));
    m("withConnection overhead p50", percentile(l, 50), "ms");
    m("withConnection overhead p95", percentile(l, 95), "ms");
    expect(percentile(l, 95)).toBeLessThan(budget("MIRA_PERF_P95_ACQUIRE_MS", 20));
  });
});
