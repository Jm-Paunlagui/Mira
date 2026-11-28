/**
 * The SQL-building half of budgets.test.ts, run as its own process: a fresh heap
 * and no coverage instrumentation, so the numbers do not depend on what ran
 * before it in the suite (a large heap made allocation-heavy cases 3× slower).
 *
 *   bun test/performance/buildBench.ts      → prints { calibration, cases } as JSON (µs per call)
 *
 * No database: every call runs on a recording connection that returns canned rows.
 */
import oracledb from "oracledb";
import { OracleCollection, parseFilter, sanitizeFilter, parseUpdate, buildAggregateSQL, setLogger } from "../../src";

setLogger(false);

const ROWS = Array.from({ length: 1000 }, (_, i) => ({ ID: i, NAME: `n${i}`, AMOUNT: i + 0.5, CREATED: new Date(1_700_000_000_000 + i) }));
const fakeConn = {
  execute: async (text: string) => ({ rows: /^SELECT \*/.test(text) ? ROWS : [], rowsAffected: 1, outBinds: {}, metaData: [] }),
  executeMany: async (_t: string, rows: unknown[]) => ({ rowsAffected: rows.length, outBinds: [], batchErrors: [] }),
  commit: async () => {}, rollback: async () => {}, close: async () => {},
};
const fakeDb = {
  oracledb, connectionName: "bench",
  withConnection: async (cb: (c: unknown) => unknown) => cb(fakeConn),
  withTransaction: async (cb: (c: unknown) => unknown) => cb(fakeConn),
  withBatchConnection: async () => [], isHealthy: () => true, getPoolStats: async () => ({}),
} as never;

/** The yardstick: identifier quoting, bind naming, joins and a regex, in plain JS. */
function calibration() {
  const o: Record<string, number> = {};
  for (let i = 0; i < 40; i++) o["COL_" + i] = i;
  let s = "";
  for (const k in o) s += `"${k}" = :w_${k}_${o[k]} AND `;
  return /AND $/.test(s) ? s.replace(/ AND $/, "").split(" AND ").length : 0;
}

/** µs per call: warm up, then the fastest of `rounds` rounds of `n` calls (noise only ever adds time). */
async function microseconds(fn: () => unknown, n: number, rounds = 9) {
  for (let i = 0; i < Math.max(50, n >> 2); i++) await fn();
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    const s = performance.now();
    for (let i = 0; i < n; i++) await fn();
    best = Math.min(best, ((performance.now() - s) * 1000) / n);
  }
  return best;
}

const users = new OracleCollection("USERS", fakeDb);
const filter = { NAME: "Juan", AGE: { $gte: 18, $lt: 65 }, $or: [{ CITY: "Cebu" }, { CITY: { $in: ["Davao", "Iloilo"] } }], STATUS: { $ne: "x" } };
const in1k = { ID: { $in: Array.from({ length: 1000 }, (_, i) => i) } };
const in5k = { ID: { $in: Array.from({ length: 5000 }, (_, i) => i) } };
const pipeline = [
  { $match: filter },
  { $lookup: { from: "ORDERS", localField: "ID", foreignField: "USER_ID", as: "o" } },
  { $unwind: "$o" },
  { $group: { _id: { C: "$CITY", S: "$o.STATUS" }, T: { $sum: "$o.TOTAL" }, M: { $max: "$o.TOTAL" } } },
  { $project: { T: 1, R: { $round: [{ $divide: ["$T", 100] }, 2] } } },
  { $sort: { T: -1 } },
];
const docs = ROWS.map((r) => ({ ...r }));
const CASES: Array<[string, () => unknown, number]> = [
  ["parseFilter (typical)", () => parseFilter(filter), 20000],
  ["parseFilter ($in 1,000)", () => parseFilter(in1k), 1000],
  ["parseFilter ($in 5,000, collection bind)", () => parseFilter(in5k), 1000],
  ["sanitizeFilter (4 fields)", () => sanitizeFilter({ NAME: "Juan", CITY: "Cebu", AGE: 30, STATUS: "a" }), 50000],
  ["parseUpdate (5 operators)", () => parseUpdate({ $set: { NAME: "x", CITY: "y" }, $inc: { AGE: 1 }, $unset: { T: 1 }, $mul: { S: 2 } }), 20000],
  ["buildAggregateSQL (6 stages, $lookup)", () => buildAggregateSQL("USERS", pipeline, {}), 5000],
  ["findOne (build + call)", () => users.findOne({ ID: 1, STATUS: "a" }), 20000],
  ["find().sort().limit().toArray()", () => users.find({ ID: { $gt: 1 } }).sort({ ID: 1 }).limit(1000).toArray(), 10000],
  ["updateOne (build + call)", () => users.updateOne({ ID: 1 }, { $set: { NAME: "x" } }), 20000],
  ["insertMany (1,000 documents)", () => users.insertMany(docs, { returning: [] }), 300],
  ["bulkUpdateByKeys (1,000 rows)", () => users.bulkUpdateByKeys(docs, { keys: ["ID"] }), 300],
];

// Only the named cases when given (the test re-measures one that came out over budget).
const only = process.argv.slice(2);
const out: { calibration: number; cases: Record<string, number> } = { calibration: await microseconds(calibration, 20000), cases: {} };
for (const [name, fn, n] of CASES) if (!only.length || only.includes(name)) out.cases[name] = await microseconds(fn, n);
console.log(JSON.stringify(out));
