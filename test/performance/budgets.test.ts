/**
 * PERFORMANCE BUDGETS — bounds that fail on a 2× regression, on any machine.
 *
 * Absolute milliseconds differ between a laptop and a CI runner, so each budget
 * is a quantity measured against something in the same run:
 *
 *   A. SQL building, no database (buildBench.ts, in its own process): µs per call ÷ µs of a fixed calibration
 *      workload (string building, object walks, a regex — the kind of work the
 *      builders do). The ratio holds across CPUs; the budget is 2× the ratio
 *      recorded in BUILD_BASELINE, so a change that doubles a builder's cost fails.
 *      Each sample is the fastest of several rounds: noise only ever adds time.
 *   B. Statements per call: exact counts from onQuery(). An extra round trip is
 *      a regression no runner speed can hide.
 *   C. Mira against the raw driver running the same SQL: interleaved samples,
 *      ratio of medians. Bounds the overhead Mira adds around a round trip.
 *
 * MIRA_PERF_BUILD_FACTOR (default 2) scales the A budgets; set it only to study
 * a slower runner, never to make a failing change pass.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import { onQuery, type QueryEvent } from "../../src";
import { db, schema, coll, dropIfExists, recordMetric } from "../helpers/db";

const m = (metric: string, value: number, unit: string, note?: string) => recordMetric({ category: "performance", metric, value, unit, note });

// ─── A. SQL building, no database ───────────────────────────────────────────

/** Ratio to the calibration workload, recorded on the 3.1.0 code (macOS arm64, Bun 1.4.5). */
const BUILD_BASELINE: Record<string, number> = {
  "parseFilter (typical)": 0.65,
  "parseFilter ($in 1,000)": 48,
  "parseFilter ($in 5,000, collection bind)": 4.2,
  "sanitizeFilter (4 fields)": 0.1,
  "parseUpdate (5 operators)": 0.36,
  "buildAggregateSQL (6 stages, $lookup)": 2.45,
  "findOne (build + call)": 0.26,
  "find().sort().limit().toArray()": 0.45,
  "updateOne (build + call)": 0.37,
  "insertMany (1,000 documents)": 43,
  "bulkUpdateByKeys (1,000 rows)": 31,
};
const FACTOR = Number(process.env.MIRA_PERF_BUILD_FACTOR ?? 2);

/** Runs buildBench.ts in its own process; µs per call for the named cases (all when none). */
function bench(names: string[] = []): { calibration: number; cases: Record<string, number> } {
  const r = Bun.spawnSync(["bun", path.join(__dirname, "buildBench.ts"), ...names], { env: { ...process.env, MIRA_LOGS: "" }, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`buildBench.ts failed: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString().trim().split("\n").pop()!);
}

describe("performance budgets: SQL building (no database)", () => {
  let run: ReturnType<typeof bench>;
  beforeAll(() => {
    run = bench();
    m("build calibration", run.calibration, "µs");
  }, 120000);

  for (const name of Object.keys(BUILD_BASELINE)) {
    it(`${name}: within ${FACTOR}× its recorded cost`, () => {
      const budget = BUILD_BASELINE[name] * FACTOR;
      let ratio = run.cases[name] / run.calibration;
      // A second, fresh measurement only when the first is over: a real regression is over both times.
      if (ratio > budget) {
        const again = bench([name]);
        ratio = Math.min(ratio, again.cases[name] / again.calibration);
      }
      m(`build ${name}`, ratio * run.calibration, "µs", `${ratio.toFixed(2)}× calibration (budget ${budget.toFixed(2)}×)`);
      expect(ratio).toBeLessThan(budget);
    }, 60000);
  }
});

// ─── B and C: against the database ──────────────────────────────────────────

const T = "MIRA_PF_BUDGET";
const rows = coll(T);
const N = 10000;
let off = 1_000_000;
const batch = (n: number) => Array.from({ length: n }, (_, i) => ({ ID: ++off, GRP: i % 50, NAME: `b-${i}`, AMOUNT: i + 0.25, CREATED: new Date(1.7e12 + i * 60000) }));

beforeAll(async () => {
  await dropIfExists(T);
  await schema.createTable(T, {
    ID: { type: "NUMBER", primaryKey: true },
    GRP: { type: "NUMBER" },
    NAME: { type: "VARCHAR2(60)" },
    AMOUNT: { type: "NUMBER(12,2)" },
    CREATED: { type: "DATE" },
  });
  const base = Array.from({ length: N }, (_, i) => ({ ID: i + 1, GRP: i % 50, NAME: `row-${i}`, AMOUNT: (i % 997) + 0.25, CREATED: new Date(1.7e12 + i * 60000) }));
  for (let i = 0; i < N; i += 2000) await rows.insertMany(base.slice(i, i + 2000), { returning: [] });
  await rows.createIndex({ GRP: 1 });
});
afterAll(() => dropIfExists(T));

/** Statements one call sends, ignoring a new pooled session's time-zone setup. */
async function statements(fn: () => Promise<unknown>) {
  const seen: QueryEvent[] = [];
  const stop = onQuery((e) => { if (!/^ALTER SESSION SET TIME_ZONE/.test(e.sql)) seen.push(e); });
  try { await fn(); } finally { stop(); }
  return seen.map((e) => `${e.operation}: ${e.sql.split(/\s+/).slice(0, 2).join(" ")}`);
}

describe("performance budgets: statements per call", () => {
  const cases: Array<[string, () => Promise<unknown>, string[]]> = [
    ["findOne", () => rows.findOne({ ID: 5 }), ["execute: SELECT *"]],
    ["find().sort().limit().toArray()", () => rows.find({ GRP: 3 }).sort({ ID: -1 }).limit(20).toArray(), ["execute: SELECT *"]],
    ["countDocuments", () => rows.countDocuments({ GRP: 3 }), ["execute: SELECT COUNT(*)"]],
    ["countDocuments $in 2,500 (collection bind)", () => rows.countDocuments({ ID: { $in: Array.from({ length: 2500 }, (_, i) => i) } }), ["execute: SELECT COUNT(*)"]],
    ["distinct", () => rows.distinct("GRP"), ["execute: SELECT DISTINCT"]],
    ["aggregate $group", () => rows.aggregate([{ $group: { _id: "$GRP", n: { $count: "*" } } }]), ["execute: SELECT \"GRP\","]],
    ["forEach", () => rows.find({ ID: { $lt: 50 } }).forEach(() => {}), ["execute: SELECT *"]],
    ["insertOne", () => rows.insertOne(batch(1)[0]), ["execute: INSERT INTO"]],
    ["insertMany 2,500 (one shape)", () => rows.insertMany(batch(2500), { returning: [] }), ["executeMany: INSERT INTO"]],
    ["insertMany default, supplied IDs (first call reads the dictionary once)", () => rows.insertMany(batch(500)), ["execute: SELECT c.DATA_TYPE,", "executeMany: INSERT INTO"]],
    ["insertMany default, supplied IDs (cached: no RETURNING round trip cost)", () => rows.insertMany(batch(500)), ["executeMany: INSERT INTO"]],
    ["updateOne", () => rows.updateOne({ ID: 5 }, { $set: { NAME: "u" } }), ["execute: UPDATE \"MIRA_PF_BUDGET\""]],
    ["updateMany", () => rows.updateMany({ GRP: 7 }, { $inc: { AMOUNT: 0 } }), ["execute: UPDATE \"MIRA_PF_BUDGET\""]],
    ["bulkUpdateByKeys 500", () => rows.bulkUpdateByKeys(Array.from({ length: 500 }, (_, i) => ({ ID: i + 1, NAME: `k${i}` })), { keys: ["ID"] }), ["executeMany: UPDATE \"MIRA_PF_BUDGET\""]],
    ["deleteOne", () => rows.deleteOne({ ID: off }), ["execute: DELETE FROM"]],
    ["findOneAndUpdate (SELECT, then UPDATE by ROWID)", () => rows.findOneAndUpdate({ ID: 6 }, { $set: { NAME: "f" } }), ["execute: SELECT t0.*,", "execute: UPDATE \"MIRA_PF_BUDGET\""]],
    ["findOneAndDelete (SELECT, then DELETE by ROWID)", () => rows.findOneAndDelete({ ID: off - 1 }), ["execute: SELECT t0.*,", "execute: DELETE FROM"]],
  ];
  for (const [name, fn, expected] of cases) {
    it(`${name}: ${expected.length} statement${expected.length > 1 ? "s" : ""}`, async () => {
      const got = await statements(fn);
      m(`statements: ${name}`, got.length, "count");
      expect(got).toEqual(expected);
    });
  }
});

describe("performance budgets: overhead over the raw driver (same SQL)", () => {
  const OBJ = { outFormat: db.oracledb.OUT_FORMAT_OBJECT };
  const median = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
  /** Interleaved Mira / raw samples (drift hits both), ratio of the medians. */
  async function overhead(name: string, n: number, bound: number, mira: (i: number) => Promise<unknown>, raw: (i: number) => Promise<unknown>) {
    for (let i = 0; i < 10; i++) { await mira(i); await raw(i); }
    const a: number[] = [], b: number[] = [];
    for (let i = 0; i < n; i++) {
      let s = performance.now(); await mira(i); a.push(performance.now() - s);
      s = performance.now(); await raw(i); b.push(performance.now() - s);
    }
    const ratio = median(a) / median(b);
    m(`overhead ${name}`, ratio, "x", `Mira p50 ${median(a).toFixed(3)} ms, raw p50 ${median(b).toFixed(3)} ms (bound ${bound}×)`);
    expect(ratio).toBeLessThan(bound);
  }
  const point = (i: number) => (i * 37) % N + 1;

  it("findOne by primary key", () => overhead("findOne", 300, 1.5,
    (i) => rows.findOne({ ID: point(i) }),
    (i) => db.withConnection((c) => c.execute(`SELECT * FROM "${T}" t0 WHERE "ID" = :where_ID_0 FETCH FIRST 1 ROW ONLY`, { where_ID_0: point(i) }, OBJ))), 60000);

  it("find + sort + page of 20", () => overhead("find page", 150, 1.5,
    (i) => rows.find({ GRP: i % 50 }).sort({ ID: -1 }).limit(20).toArray(),
    (i) => db.withConnection((c) => c.execute(`SELECT * FROM "${T}" t0 WHERE "GRP" = :where_GRP_0 ORDER BY "ID" DESC FETCH FIRST 20 ROWS ONLY`, { where_GRP_0: i % 50 }, OBJ))), 60000);

  it("toArray of 10,000 rows", () => overhead("toArray 10k", 15, 1.5,
    () => rows.find({}).toArray(),
    () => db.withConnection((c) => c.execute(`SELECT * FROM "${T}" t0`, {}, OBJ))), 60000);

  it("updateOne by primary key", () => overhead("updateOne", 200, 1.5,
    (i) => rows.updateOne({ ID: point(i) }, { $set: { NAME: "o" } }),
    (i) => db.withConnection((c) => c.execute(`UPDATE "${T}" SET "NAME" = :u WHERE "ID" = :k`, { u: "o", k: point(i) }, { autoCommit: true }))), 60000);

  it("insertMany of 1,000 rows, default options (supplied IDs)", () => overhead("insertMany 1k default", 25, 1.5,
    () => rows.insertMany(batch(1000)),
    () => db.withConnection((c) => c.executeMany(
      `INSERT INTO "${T}" ("ID", "GRP", "NAME", "AMOUNT", "CREATED") VALUES (:v0, :v1, :v2, :v3, :v4)`,
      batch(1000).map((d) => [d.ID, d.GRP, d.NAME, d.AMOUNT, d.CREATED]),
      { autoCommit: true },
    ))), 60000);

  it("insertMany of 1,000 rows", () => overhead("insertMany 1k", 25, 1.5,
    () => rows.insertMany(batch(1000), { returning: [] }),
    () => db.withConnection((c) => c.executeMany(
      `INSERT INTO "${T}" ("ID", "GRP", "NAME", "AMOUNT", "CREATED") VALUES (:v0, :v1, :v2, :v3, :v4)`,
      batch(1000).map((d) => [d.ID, d.GRP, d.NAME, d.AMOUNT, d.CREATED]),
      { autoCommit: true },
    ))), 60000);
});
