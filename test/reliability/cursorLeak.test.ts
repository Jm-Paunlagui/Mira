/**
 * RELIABILITY — no server-side cursor leaks, and a bounded statement cache, across
 * many distinct call shapes.
 *
 * Every pool keeps a client statement cache (`stmtCacheSize`, 50 in POOL_DEFAULTS,
 * src/driver/oracle.ts). A cached statement keeps its cursor open on the server, so a
 * session may legitimately hold up to stmtCacheSize open cursors. Anything beyond that
 * is a cursor Mira (or the driver, on Mira's behalf) never closed: a leak, which ends in
 * ORA-01000 "maximum open cursors exceeded" on a long-lived pooled connection.
 *
 * Measurements are exact because each phase runs on ONE connection (withConnection +
 * collections bound to it, as Transaction.collection() does) and reads that session's
 * own statistics (V$MYSTAT / V$OPEN_CURSOR for its SID). Other suites and agents may hold
 * MIRA sessions at the same time; per-session numbers are not affected by them.
 *
 *   opened cursors current     cursors open right now (client-cached ones included)
 *   session cursor cache count server-side closed-but-cached cursors (session_cached_cursors)
 *   parse count (hard)         statements compiled from scratch (a new SQL text, or a new child)
 *   parse count (total)        every parse call (a client statement-cache hit makes none)
 *   parse count (failures)     parses that failed (ORA-00904 …): never shareable, so each
 *                              resubmission is hard parsed again — by Oracle, not a leak
 *
 * V$OPEN_CURSOR also lists the server's session cursor cache, PL/SQL and dictionary
 * lookup cursors (CURSOR_TYPE '… CACHED'): closed cursors Oracle keeps for reuse, bounded
 * by session_cached_cursors, not by Mira. Of the open ones, CURSOR_TYPE 'OPEN' are the
 * cursors the client opened (Mira's statements, cached or not) and 'OPEN-RECURSIVE' are the
 * server's own (login audit, optimizer statistics lookups: 3 seen). The tight bound is on
 * 'OPEN'; "opened cursors current" (both kinds and more) gets a wider one; all are recorded.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { OracleCollection, onQuery, sql, type DbConnection } from "../../src";
import { POOL_DEFAULTS } from "../../src/driver/oracle";
import { db, schema, coll, dropIfExists, rawExec, recordMetric, appDbInUse } from "../helpers/db";

const T = "MIRA_RL_CL_T";
const IN_T = "MIRA_RL_CL_IN";
const ROWS = 1000;

/**
 * Client cursors (V$OPEN_CURSOR type 'OPEN') a session may hold beyond its statement cache
 * without leaking: the V$OPEN_CURSOR query reading the list (when not already cached), and
 * one cursor evicted from the cache whose close Thin mode sends on the NEXT round trip.
 */
const USER_SLACK = 2;
/**
 * Bound for "opened cursors current", a wider counter than V$OPEN_CURSOR 'OPEN': it also
 * counts the server's recursive cursors (OPEN-RECURSIVE, measured in the same snapshot,
 * 3 seen) and the two statistics statements of the snapshot itself while they run (seen as
 * 1 extra in Thin, 2 in Thick). The client-cursor count is the tight, leak-proving one; this
 * one confirms it from Oracle's own statistic. A per-shape leak in a ~180-text round would
 * exceed either by over 100.
 */
const STATS_STMTS = 2;
const openedBound = (s: Stats) => STMT_CACHE + USER_SLACK + (s.vOpen - s.vUser) + STATS_STMTS;

/**
 * Per-statement view of the shared pool, for the repeat check: one row per child cursor of
 * each of Mira's texts. A second round that binds the same types adds no child cursor; a
 * bind whose type or length class changed between calls would (a new child = a hard parse
 * that Mira caused). Reloads after Oracle aged a cursor out or invalidated it (LOADS,
 * INVALIDATIONS) are the server's doing and are recorded, not asserted: the session-wide
 * "parse count (hard)" counts those too, which made it flaky as a bound (12 once on CI).
 * Matched on SQL_TEXT (the first 1,000 characters, with line breaks and tabs shown as
 * spaces, so the keys are written the same way), read from another session so the measured
 * one is not disturbed.
 */
/** How V$SQL.SQL_TEXT shows a statement: its first 1,000 characters, line breaks and tabs as spaces. */
const sqlTextKey = (text: string) => text.slice(0, 1000).replace(/[\r\n\t]/g, " ");
type Children = Map<string, { children: number; loads: number; invalidations: number }>;
async function sharedCursors(texts: Set<string>): Promise<Children> {
  const keys = [...new Set([...texts].map(sqlTextKey))];
  const binds = Object.fromEntries(keys.map((t, i) => [`t${i}`, t]));
  const r = await rawExec<{ SQL_TEXT: string; CHILDREN: number; LOADS: number; INV: number }>(
    `SELECT SQL_TEXT, COUNT(*) "CHILDREN", SUM(LOADS) "LOADS", SUM(INVALIDATIONS) "INV" FROM V$SQL
      WHERE PARSING_SCHEMA_NAME = USER AND SQL_TEXT IN (${keys.map((_, i) => `:t${i}`).join(", ")}) GROUP BY SQL_TEXT`,
    binds,
  );
  return new Map((r.rows ?? []).map((x) => [x.SQL_TEXT, { children: Number(x.CHILDREN), loads: Number(x.LOADS), invalidations: Number(x.INV) }]));
}

const m = (metric: string, value: number, unit: string, note?: string) => recordMetric({ category: "reliability", metric, value, unit, note });

type Stats = { open: number; cache: number; hard: number; total: number; failed: number; vUser: number; vOpen: number; vAll: number };

const STATS_SQL = `SELECT s.NAME, m.VALUE FROM V$MYSTAT m JOIN V$STATNAME s ON s.STATISTIC# = m.STATISTIC#
 WHERE s.NAME IN ('opened cursors current','session cursor cache count','parse count (hard)','parse count (total)','parse count (failures)')`;
/**
 * A client cursor is one of type OPEN whose text is a statement. Oracle also opens
 * internal cursors named like `table_1_ff_307_0_0_0` / `table_304_11_…` for a
 * collection bind (TABLE(:b), which Mira uses for $in lists over 1,000 values);
 * they are not in the statement cache and are not Mira's to close, so they are
 * left out. Seen after a full run: 50 cached statements + 8 of these on one session.
 */
const CLIENT_CURSOR = `CURSOR_TYPE = 'OPEN' AND SQL_TEXT NOT LIKE 'table\\_%' ESCAPE '\\'`;
const VOPEN_SQL = `SELECT SUM(CASE WHEN ${CLIENT_CURSOR} THEN 1 ELSE 0 END) "USER_N",
 SUM(CASE WHEN CURSOR_TYPE LIKE 'OPEN%' THEN 1 ELSE 0 END) "OPEN_N", COUNT(*) "ALL_N"
 FROM V$OPEN_CURSOR WHERE SID = SYS_CONTEXT('USERENV','SID')`;

/** This session's cursor and parse statistics, read on the connection being measured. */
async function stats(conn: DbConnection): Promise<Stats> {
  const o = { outFormat: db.oracledb.OUT_FORMAT_OBJECT };
  const r = await conn.execute<{ NAME: string; VALUE: number }>(STATS_SQL, {}, o);
  const v = (await conn.execute<{ USER_N: number; OPEN_N: number; ALL_N: number }>(VOPEN_SQL, {}, o)).rows![0];
  const by = Object.fromEntries((r.rows ?? []).map((x) => [x.NAME, Number(x.VALUE)]));
  return {
    open: by["opened cursors current"],
    cache: by["session cursor cache count"],
    hard: by["parse count (hard)"],
    total: by["parse count (total)"],
    failed: by["parse count (failures)"],
    vUser: Number(v.USER_N ?? 0),
    vOpen: Number(v.OPEN_N ?? 0),
    vAll: Number(v.ALL_N),
  };
}

const show = (label: string, s: Stats) =>
  `${label}: opened=${s.open} sessCache=${s.cache} hard=${s.hard} total=${s.total} failed=${s.failed} vUser=${s.vUser} vOpen=${s.vOpen} vAll=${s.vAll}`;
const log: string[] = [];

/** Records every SQL text executed while `fn` runs, and the texts that failed at execution. */
async function capture<R>(fn: () => Promise<R>): Promise<[R, Set<string>, Set<string>]> {
  const texts = new Set<string>();
  const failed = new Set<string>();
  const stop = onQuery((e) => {
    texts.add(e.sql);
    if (e.error) failed.add(e.sql);
  });
  try {
    return [await fn(), texts, failed];
  } finally {
    stop();
  }
}

const KEYS = ["STATUS", "AGE", "CITY", "SCORE", "CAT"] as const;
const NUMERIC = new Set(["AGE", "SCORE"]);
const val = (k: string) => (NUMERIC.has(k) ? 40 : k === "CAT" ? "B" : k === "CITY" ? "Cebu" : "active");
const OPTIONAL = ["STATUS", "AGE", "CITY", "SCORE", "CAT", "NOTE"] as const;
/** Column subset number `mask` (1..63) of OPTIONAL, with a value of a fixed type per column. */
const cols = (mask: number) =>
  Object.fromEntries(OPTIONAL.filter((_, b) => mask & (1 << b)).map((c) => [c, c === "NOTE" ? "note" : val(c)]));

/**
 * ~210 calls covering ~177 distinct SQL texts. Bind values have the same types and the
 * same length class in every round (no NULL-vs-number switches, short strings only), so
 * a second round compiles nothing new: a different bind type would legitimately create a
 * new child cursor (a hard parse) and blur the measurement.
 */
function shapes(c: OracleCollection, target: { collection(n: string): OracleCollection }, round: number): Array<() => Promise<unknown>> {
  const out: Array<() => Promise<unknown>> = [];
  // find: 5 keys x 4 operators x 3 sorts = 60 distinct texts; limit / projection vary on top.
  const SORTS = [undefined, { ID: 1 }, { AGE: -1, ID: 1 }];
  let i = 0;
  for (const k of KEYS)
    for (const op of ["$eq", "$ne", "$gt", "$lte"])
      for (const s of SORTS) {
        const n = i++;
        out.push(() => {
          let q = c.find({ [k]: { [op]: val(k) } });
          if (s) q = q.sort(s);
          if (n % 2) q = q.limit(5);
          if (n % 4 === 3) q = q.project({ ID: 1, NAME: 1 });
          return q.toArray();
        });
      }
  // countDocuments: 10 key pairs x 2 operator forms = 20.
  for (let a = 0; a < KEYS.length; a++)
    for (let b = a + 1; b < KEYS.length; b++)
      for (const op of ["$eq", "$gte"]) out.push(() => c.countDocuments({ [KEYS[a]]: val(KEYS[a]), [KEYS[b]]: { [op]: val(KEYS[b]) } }));
  // distinct: 5 fields x (no filter, a filter) = 10.
  for (const k of KEYS) {
    out.push(() => c.distinct(k));
    out.push(() => c.distinct(k, { CAT: "A" }));
  }
  // aggregate: 5 group keys x 4 accumulators = 20.
  const ACC = [{ $sum: "$SCORE" }, { $avg: "$AGE" }, { $max: "$SCORE" }, { $count: "*" }];
  for (const k of KEYS)
    ACC.forEach((acc, j) =>
      out.push(() => c.aggregate([...(j % 2 ? [{ $match: { AGE: { $gt: 20 } } }] : []), { $group: { _id: `$${k}`, v: acc } }, { $sort: { [k]: 1 } }])),
    );
  // insertOne: 20 column sets (IDs unique per round; the rows are deleted below).
  const insId = (n: number) => 100_000 + round * 1000 + n;
  for (let n = 0; n < 20; n++) out.push(() => c.insertOne({ ID: insId(n), NAME: `ins-${n}`, ...cols(n + 1) }));
  // updateOne: 20 $set column sets.
  for (let n = 0; n < 20; n++) out.push(() => c.updateOne({ ID: n + 1 }, { $set: cols(n + 21) }));
  // deleteOne: 5 NAME operators x 2 ID forms = 10.
  let d = 0;
  for (const op of ["$ne", "$gt", "$gte", "$lt", "$lte"])
    for (const form of [0, 1]) {
      const id = insId(d++);
      out.push(() => c.deleteOne({ ID: form ? { $gte: id, $lte: id } : id, NAME: { [op]: "ins-5" } }));
    }
  // $in by ID, lengths 1, 26, …, 976: padded to 1, 32, 64, 128, 256, 512, 1000 → 7 texts.
  for (let len = 1; len <= ROWS; len += 25) out.push(() => c.countDocuments({ ID: { $in: Array.from({ length: len }, (_, j) => j + 1) } }));
  // sql`…`: 5 columns x 2 comparisons = 10.
  for (const k of KEYS) {
    out.push(() => sql`SELECT COUNT(*) "N" FROM ${sql.ident(T)} WHERE ${sql.ident(k)} = ${val(k)}`.rows(target));
    out.push(() => sql`SELECT MAX(ID) "N" FROM ${sql.ident(T)} WHERE ${sql.ident(k)} <> ${val(k)}`.rows(target));
  }
  return out;
}

/** Runs `fn` on one pooled connection, with a collection and a sql target bound to it. */
const onOneConnection = <R>(fn: (conn: DbConnection, c: OracleCollection, target: { collection(n: string): OracleCollection }) => Promise<R>) =>
  db.withConnection(async (conn) => {
    try {
      return await fn(conn, new OracleCollection(T, db, conn), { collection: (n: string) => new OracleCollection(n, db, conn) });
    } finally {
      await conn.rollback(); // the session-bound writes are not autocommitted
    }
  });

let STMT_CACHE = 0;

beforeAll(async () => {
  await dropIfExists(T, IN_T);
  const def = {
    ID: { type: "NUMBER", primaryKey: true },
    NAME: { type: "VARCHAR2(40)" },
    STATUS: { type: "VARCHAR2(20)" },
    AGE: { type: "NUMBER" },
    CITY: { type: "VARCHAR2(40)" },
    SCORE: { type: "NUMBER" },
    CAT: { type: "VARCHAR2(5)" },
    NOTE: { type: "VARCHAR2(40)" },
  };
  await schema.createTable(T, def);
  await schema.createTable(IN_T, def);
  const rows = Array.from({ length: ROWS }, (_, j) => ({
    ID: j + 1,
    NAME: `row-${j + 1}`,
    STATUS: ["active", "inactive", "trial"][j % 3],
    AGE: 18 + (j % 50),
    CITY: ["Manila", "Cebu", "Davao", "Iloilo"][j % 4],
    SCORE: j % 100,
    CAT: ["A", "B", "C", "D", "E"][j % 5],
    NOTE: `n${j % 7}`,
  }));
  await coll(T).insertMany(rows, { returning: [] });
  await coll(IN_T).insertMany(rows, { returning: [] });
  // Optimizer statistics up front: without them the first parse of each statement on a
  // new table runs dynamic-sampling queries, recursive statements that are themselves hard
  // parsed and would make "hard parses per new SQL text" unmeasurable.
  for (const t of [T, IN_T]) await rawExec("BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, :t); END;", { t });
  STMT_CACHE = await db.withConnection((conn) => (conn as unknown as { stmtCacheSize: number }).stmtCacheSize);
}, 30_000);

afterAll(async () => {
  console.log(`\n  cursorLeak (${db.oracledb.thin ? "thin" : "thick"}, stmtCacheSize ${STMT_CACHE}):\n    ${log.join("\n    ")}`);
  await dropIfExists(T, IN_T);
});

describe("reliability/cursors: no server-side cursor leaks, a bounded statement cache", () => {
  it("the pool's statement cache is POOL_DEFAULTS.stmtCacheSize (50), the size every bound below is relative to", () => {
    // A pool configured with another size (MIRA_DB_STMT_CACHE_SIZE) fails here, by name, not in a bound below.
    expect(POOL_DEFAULTS.stmtCacheSize).toBe(50);
    expect(STMT_CACHE).toBe(POOL_DEFAULTS.stmtCacheSize);
  });

  it("200 distinct call shapes, twice, on one connection: open cursors stay within the cache and repeats compile nothing", async () => {
    await onOneConnection(async (conn, c, target) => {
      const s0 = await stats(conn);
      const [, texts1] = await capture(async () => {
        for (const run of shapes(c, target, 1)) await run();
      });
      const s1 = await stats(conn);
      const v1 = await sharedCursors(texts1);
      const [, texts2] = await capture(async () => {
        for (const run of shapes(c, target, 2)) await run();
      });
      const s2 = await stats(conn);
      const v2 = await sharedCursors(texts1);
      const both = [...v1.keys()].filter((t) => v2.has(t));
      const newChildren = both.filter((t) => v2.get(t)!.children > v1.get(t)!.children);
      const reloads = both.reduce((a, t) => a + v2.get(t)!.loads - v1.get(t)!.loads, 0);
      const keyCount = new Set([...texts1].map(sqlTextKey)).size; // a few texts differ only by a line break vs a space
      log.push(`shapes V$SQL: ${v1.size}/${keyCount} texts found after round 1, ${v2.size} after round 2; new child cursors ${newChildren.length}; reloads ${reloads}${newChildren.length ? `\n      new children: ${newChildren.map((t) => t.slice(0, 120)).join("\n      ")}` : ""}`);
      log.push(show("shapes before ", s0), show("shapes round 1", s1), show("shapes round 2", s2), `shapes distinct SQL texts: round 1 ${texts1.size}, round 2 ${texts2.size}`);
      const calls = shapes(c, target, 0).length;
      m("cursors: call shapes per round", calls, "count");
      m("cursors: distinct SQL texts per round", texts1.size, "count");
      m("cursors: opened cursors current after round 1", s1.open, "count", `stmtCacheSize ${STMT_CACHE}`);
      m("cursors: opened cursors current after round 2", s2.open, "count");
      m("cursors: V$OPEN_CURSOR (all types) after round 2", s2.vAll, "count", "includes server session cursor cache");
      m("cursors: hard parses round 1", s1.hard - s0.hard, "count");
      m("cursors: hard parses round 2", s2.hard - s1.hard, "count");
      m("cursors: parse calls round 2", s2.total - s1.total, "count", "client statement-cache hits make none");
      m("cursors: new child cursors for Mira's texts in round 2", newChildren.length, "count", "V$SQL");
      m("cursors: reloads of Mira's texts in round 2", reloads, "count", "V$SQL LOADS: aged out or invalidated by the server, not asserted");

      // The workload really exceeds the cache several times over, or it proves nothing.
      expect(texts1.size).toBeGreaterThanOrEqual(3 * STMT_CACHE);
      // Round 2 runs exactly the same statement texts as round 1.
      expect([...texts2].sort()).toEqual([...texts1].sort());
      // After ~177 distinct texts: at most the cache plus slack open, by both counts.
      expect(s1.vUser).toBeLessThanOrEqual(STMT_CACHE + USER_SLACK);
      expect(s1.open).toBeLessThanOrEqual(openedBound(s1));
      // The same sequence again leaves the same cache contents: no growth at all.
      expect(s2.open).toBeLessThanOrEqual(s1.open);
      expect(s2.vUser).toBeLessThanOrEqual(s1.vUser);
      // Repeats compile nothing new for Mira's statements (see sharedCursors): V$SQL finds most
      // of the texts (a few may have been aged out already under memory pressure, so not all
      // are required), and none of them gained a child cursor in round 2.
      expect(v1.size).toBeGreaterThan(keyCount / 2);
      expect(newChildren).toEqual([]);
    });
  }, 30_000);

  it("$in lists of length 1..1000 collapse to at most 11 SQL texts, and compile once per text", async () => {
    // Padding rule (_padInList): a list of n <= 1000 values is bound as the next power of
    // two, capped at 1000 → sizes 1, 2, 4, …, 512, 1000: 11 possible texts, whatever n is.
    const lengths = Array.from({ length: Math.ceil(ROWS / 7) }, (_, k) => 1 + 7 * k);
    const ids = (n: number) => Array.from({ length: n }, (_, j) => j + 1);
    await onOneConnection(async (conn) => {
      // A table of its own: none of these texts exists in the shared pool yet.
      const c = new OracleCollection(IN_T, db, conn);
      const s0 = await stats(conn);
      const [counts, texts] = await capture(async () => {
        const out: number[] = [];
        for (const n of lengths) out.push(await c.countDocuments({ ID: { $in: ids(n) } }));
        return out;
      });
      const s1 = await stats(conn);
      // The same sweep again: every text is now cached on the connection.
      for (const n of lengths) await c.countDocuments({ ID: { $in: ids(n) } });
      const s2 = await stats(conn);
      log.push(show("$in before  ", s0), show("$in sweep 1 ", s1), show("$in sweep 2 ", s2), `$in sweep: ${lengths.length} lengths → ${texts.size} distinct SQL texts`);
      m("cursors: $in sweep lengths", lengths.length, "count", "1..1000 step 7");
      m("cursors: $in sweep distinct SQL texts", texts.size, "count");
      m("cursors: $in sweep hard parses (first pass)", s1.hard - s0.hard, "count");
      m("cursors: $in sweep hard parses (second pass)", s2.hard - s1.hard, "count");

      // Padding must not change the answer (pad values repeat the last element).
      expect(counts).toEqual(lengths);
      // Expected sizes for these lengths, from the rule: 1, 8, 16, 32, …, 512, 1000.
      const sizes = new Set(lengths.map((n) => Math.min(ROWS, 2 ** Math.ceil(Math.log2(n)))));
      expect(texts.size).toBeLessThanOrEqual(11);
      expect(texts.size).toBe(sizes.size);
      // One hard parse per new text, and no more: 143 calls compile only 9 statements.
      // Unpadded lists would compile once per length (143).
      expect(s1.hard - s0.hard).toBeLessThanOrEqual(texts.size);
      expect(s2.hard - s1.hard).toBe(0);
      expect(s1.vUser).toBeLessThanOrEqual(STMT_CACHE + USER_SLACK);
      expect(s2.vUser).toBeLessThanOrEqual(s1.vUser);
      expect(s2.open).toBeLessThanOrEqual(s1.open);
    });
  }, 30_000);

  it("forEach streams (completed and aborted) and failing statements release their cursors", async () => {
    await onOneConnection(async (conn, c) => {
      // Warm every text of this phase once, so the cache holds them before the baseline:
      // the 200 repetitions afterwards then add NO cached cursor, and any growth is a leak.
      const phase = async (reps: number) => {
        const errors: string[] = [];
        for (let i = 0; i < reps; i++) {
          let n = 0;
          await c.find({ CAT: "A" }).sort({ ID: 1 }).forEach(() => void n++);
          expect(n).toBe(ROWS / 5);
          // 1,000 rows: far more than one fetch, so the server cursor is still open when the consumer throws.
          await c
            .find({})
            .sort({ ID: -1 })
            .forEach(() => {
              throw new Error("consumer bug");
            })
            .catch((e: Error) => errors.push(e.message));
          await c
            .find({ AGE: { $gte: 18 } })
            .sort({ ID: 1 })
            .forEach(async () => {
              await Promise.resolve();
              throw new Error("async consumer bug");
            })
            .catch((e: Error) => errors.push(e.message));
          await c.find({ NOPE: 1 }).toArray().catch((e: Error) => errors.push(e.message));
          await c.countDocuments({ NOPE_TOO: { $gt: 1 } }).catch((e: Error) => errors.push(e.message));
          await c.insertOne({ ID: 1 + (i % ROWS), NAME: "dup" }).catch((e: Error) => errors.push(e.message));
        }
        return errors;
      };
      const [, warmTexts] = await capture(() => phase(1));
      const s0 = await stats(conn);
      const v0 = await sharedCursors(warmTexts);
      const [errors, texts, failedTexts] = await capture(() => phase(50));
      const s1 = await stats(conn);
      const v1 = await sharedCursors(warmTexts);
      const grown = [...v0.keys()].filter((t) => v1.has(t) && v1.get(t)!.children > v0.get(t)!.children);
      // Thick mode only: after a statement fails at execution (here the ORA-00001 insert), OCI
      // binds its NUMBER with different flags on the next call (V$SQL_SHARED_CURSOR:
      // BIND_MISMATCH, oacfl2 0x1000010 vs 0x1000000), so Oracle keeps a second child for it.
      // Mira passes the same values both times; that one extra child is the client's. Any other
      // growth (a statement that succeeded, or more than one extra child) is Mira's and fails.
      const failedKeys = new Set([...failedTexts].map(sqlTextKey));
      const clientChild = (t: string) => !db.oracledb.thin && failedKeys.has(t) && v1.get(t)!.children - v0.get(t)!.children === 1;
      const newChildren = grown.filter((t) => !clientChild(t));
      log.push(show("streams/errors before", s0), show("streams/errors after ", s1), `streams/errors: 50 completed + 100 aborted streams, ${errors.length} failed statements, ${texts.size} executed texts`);
      m("cursors: opened cursors current, streams+errors delta", s1.open - s0.open, "count", "150 streams + 150 failures");
      m("cursors: V$OPEN_CURSOR client cursors, streams+errors delta", s1.vUser - s0.vUser, "count");
      m("cursors: hard parses, streams+errors", s1.hard - s0.hard, "count", "session-wide, includes the server's own reloads: recorded, not asserted");
      m("cursors: new child cursors for Mira's texts, streams+errors", newChildren.length, "count", "V$SQL");
      m("cursors: extra child after an execution failure (Thick client), streams+errors", grown.length - newChildren.length, "count", "V$SQL BIND_MISMATCH");
      m("cursors: failed parses, streams+errors", s1.failed - s0.failed, "count", "ORA-00904 x 100");

      // Each consumer failure and each driver error really happened, 50 times each.
      expect(errors.filter((e) => /async consumer bug/.test(e))).toHaveLength(50);
      expect(errors.filter((e) => /consumer bug/.test(e) && !/async/.test(e))).toHaveLength(50);
      expect(errors.filter((e) => /ORA-00904/.test(e))).toHaveLength(100);
      expect(errors.filter((e) => /ORA-00001/.test(e))).toHaveLength(50);
      // Back to the warmed level: a cursor held per aborted stream or failed statement would add up to 250.
      expect(s1.open).toBeLessThanOrEqual(s0.open);
      expect(s1.vUser).toBeLessThanOrEqual(s0.vUser);
      expect(s1.vUser).toBeLessThanOrEqual(STMT_CACHE + USER_SLACK);
      // A statement that fails semantic checks (ORA-00904) never becomes a shared cursor, so
      // Oracle hard parses it on every submission and counts it in "parse count (failures)":
      // exactly the 100 bad-column calls. Apart from those, repeating warmed texts compiles
      // nothing (ORA-00001 fails at execution, after a successful, cached parse): the same
      // texts ran, and none of Mira's shared cursors gained a child (see sharedCursors).
      expect(s1.failed - s0.failed).toBe(100);
      expect([...texts].sort()).toEqual([...warmTexts].sort());
      expect(v0.size).toBeGreaterThan(0);
      expect(newChildren).toEqual([]);
    });
  }, 30_000);

  it("across the pool: every Mira session stays within its statement cache, and no connection is left checked out", async () => {
    const userCursors = async () =>
      (
        await rawExec<{ OPEN_N: number; ALL_N: number }>(
          `SELECT SUM(CASE WHEN ${CLIENT_CURSOR} THEN 1 ELSE 0 END) "OPEN_N", COUNT(*) "ALL_N" FROM V$OPEN_CURSOR WHERE USER_NAME = USER`,
        )
      ).rows![0];
    const before = await userCursors();
    // The same shapes, plus aborted streams and failures, on pooled connections (no session),
    // 8 in flight so several connections take part.
    const pooled = coll(T);
    const jobs: Array<() => Promise<unknown>> = [
      ...shapes(pooled, db as unknown as { collection(n: string): OracleCollection }, 3),
      ...Array.from({ length: 20 }, () => () => pooled.find({}).forEach(() => { throw new Error("consumer bug"); }).catch(() => 0)),
      ...Array.from({ length: 20 }, () => () => pooled.find({ NOPE: 1 }).toArray().catch(() => 0)),
      ...Array.from({ length: 20 }, (_, i) => () => pooled.insertOne({ ID: 1 + i, NAME: "dup" }).catch(() => 0)),
    ];
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => { for (let i = next++; i < jobs.length; i = next++) await jobs[i](); }));
    expect(await appDbInUse()).toBe(0);

    // Collect this pool's sessions: borrow every open connection at once and read its SID.
    const open = ((await db.getPoolStats()).pools.appDb as { connectionsOpen: number }).connectionsOpen;
    let releaseAll!: () => void;
    const hold = new Promise<void>((r) => (releaseAll = r));
    const sids: number[] = [];
    let ready!: () => void;
    const allIn = new Promise<void>((r) => (ready = r));
    // The cursor query below runs on one of the held connections: with every open
    // connection borrowed, a new borrow would have to grow the pool, and a pool already
    // at poolMax (late in a full run) would make it wait for its queueTimeout.
    let probe!: import("../../src").DbConnection;
    const held = Array.from({ length: open }, () =>
      db.withConnection(async (conn) => {
        probe ??= conn;
        const r = await conn.execute<{ SID: string }>(`SELECT SYS_CONTEXT('USERENV','SID') "SID" FROM DUAL`, {}, { outFormat: db.oracledb.OUT_FORMAT_OBJECT });
        sids.push(Number(r.rows![0].SID));
        if (sids.length === open) ready();
        await hold;
      }),
    );
    await allIn;
    const perSid = (
      await probe.execute<{ SID: number; OPEN_N: number; ALL_N: number }>(
        `SELECT SID "SID", SUM(CASE WHEN ${CLIENT_CURSOR} THEN 1 ELSE 0 END) "OPEN_N", COUNT(*) "ALL_N"
           FROM V$OPEN_CURSOR WHERE SID IN (${sids.map((_, i) => `:s${i}`).join(", ")}) GROUP BY SID`,
        Object.fromEntries(sids.map((s, i) => [`s${i}`, s])),
        { outFormat: db.oracledb.OUT_FORMAT_OBJECT },
      ).catch(async (e) => {
        releaseAll();
        await Promise.allSettled(held);
        throw e;
      })
    ).rows!;
    // Over the bound: name the open cursors of the busiest session (read while it is still held).
    const worstRow = perSid.reduce((a, r) => (Number(r.OPEN_N) > Number(a?.OPEN_N ?? -1) ? r : a), perSid[0]);
    let detail = "";
    if (worstRow && Number(worstRow.OPEN_N) > STMT_CACHE + USER_SLACK) {
      const rows = (
        await probe.execute<{ T: string; N: number }>(
          `SELECT SUBSTR(SQL_TEXT, 1, 70) "T", COUNT(*) "N" FROM V$OPEN_CURSOR WHERE SID = :s AND ${CLIENT_CURSOR} GROUP BY SUBSTR(SQL_TEXT, 1, 70) ORDER BY 2 DESC, 1`,
          { s: worstRow.SID },
          { outFormat: db.oracledb.OUT_FORMAT_OBJECT },
        )
      ).rows!;
      detail = rows.map((r) => `${r.N} × ${r.T}`).join("\n");
    }
    releaseAll();
    await Promise.all(held);
    const after = await userCursors();

    const worst = Math.max(0, ...perSid.map((r) => Number(r.OPEN_N)));
    const sum = perSid.reduce((a, r) => a + Number(r.OPEN_N), 0);
    const userDelta = Number(after.OPEN_N) - Number(before.OPEN_N);
    log.push(
      `pool: ${open} open connections (SIDs ${sids.join(",")}); client cursors per session max ${worst}, sum ${sum}; all V$OPEN_CURSOR rows ${perSid.reduce((a, r) => a + Number(r.ALL_N), 0)}`,
      `pool: USER-wide client cursors ${before.OPEN_N} → ${after.OPEN_N} (delta ${userDelta}, includes other suites' sessions)`,
    );
    m("cursors: pool connections open", open, "count");
    m("cursors: pool client cursors, worst session", worst, "count", `bound ${STMT_CACHE + USER_SLACK}`);
    m("cursors: pool client cursors, all Mira sessions", sum, "count", `bound ${open * (STMT_CACHE + USER_SLACK)}`);
    m("cursors: USER-wide client cursor delta", userDelta, "count", "informational: other MIRA sessions share the user");

    // The SID set is this pool's: one distinct session per open connection.
    expect(new Set(sids).size).toBe(open);
    // A per-session bound is the strong form of "≤ stmtCacheSize x connectionsOpen":
    // no single session may exceed its cache, so the pool cannot either.
    if (detail) throw new Error(`session ${worstRow.SID} holds ${worst} open cursors (bound ${STMT_CACHE + USER_SLACK}):\n${detail}`);
    expect(worst).toBeLessThanOrEqual(STMT_CACHE + USER_SLACK);
    expect(sum).toBeLessThanOrEqual(open * (STMT_CACHE + USER_SLACK));
    expect(await appDbInUse()).toBe(0);
  }, 30_000);
});

