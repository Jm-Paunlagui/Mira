/**
 * INTEGRATION — QueryBuilder terminals, CTEs, set operations and transactions
 * against the live MIRA schema.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { OracleCollection, QueryBuilder, Transaction, withCTE, withRecursiveCTE } from "../../src";
import { db, coll, createUsers, createOrders, createEmployees, dropIfExists, rawExec, sleep, USERS } from "../helpers/db";

const U = "MIRA_IQ_USERS";
const O = "MIRA_IQ_ORDERS";
const E = "MIRA_IQ_EMP";
const users = coll(U);
const orders = coll(O);
const emp = coll(E);
const tx = new Transaction(db);
let fixtureReadyAt = 0;

beforeAll(async () => {
  await dropIfExists(O, U, E);
  await createUsers(U);
  await createOrders(O, U);
  await createEmployees(E);
  fixtureReadyAt = Date.now();
});
afterAll(() => dropIfExists(O, U, E));

describe("integration: QueryBuilder terminals", () => {
  it("toArray / await / next / hasNext / count", async () => {
    const active = await users.find({ STATUS: "active" }).sort({ NAME: 1 }).toArray<{ NAME: string }>();
    expect(active.map((r) => r.NAME)).toEqual(USERS.filter((u) => u.STATUS === "active").map((u) => u.NAME).sort());
    const awaited = await users.find({ CITY: "Cebu" });
    expect(awaited).toHaveLength(3);
    expect((await users.find({}).sort({ AGE: -1 }).next<{ NAME: string }>())?.NAME).toBe("Tess");
    expect(await users.find({ NAME: "Nobody" }).next()).toBeNull();
    expect(await users.find({ NAME: "Juan" }).hasNext()).toBe(true);
    expect(await users.find({ NAME: "Nobody" }).hasNext()).toBe(false);
    expect(await users.find({ AGE: { $gte: 30 } }).sort({ AGE: 1 }).limit(1).count()).toBe(USERS.filter((u) => u.AGE >= 30).length);
  });

  it("pagination is stable and complete", async () => {
    const pages: string[] = [];
    for (let p = 0; p < 4; p++) pages.push(...(await users.find({}).sort({ NAME: 1 }).skip(p * 3).limit(3).toArray<{ NAME: string }>()).map((r) => r.NAME));
    expect(pages).toEqual(USERS.map((u) => u.NAME).sort());
  });

  it("inclusion and exclusion projection", async () => {
    const inc = await users.find({ NAME: "Juan" }).project({ NAME: 1, AGE: 1 }).toArray();
    expect(Object.keys(inc[0]).sort()).toEqual(["AGE", "NAME"]);
    const exc = await users.find({ NAME: "Juan" }).project({ EMAIL: 0, SCORE: 0 }).toArray();
    expect(exc[0]).not.toHaveProperty("EMAIL");
    expect(exc[0]).toHaveProperty("NAME");
  });

  it("forEach streams every row (exclusion projection applied per row)", async () => {
    const seen: Record<string, unknown>[] = [];
    await users.find({ STATUS: "active" }).project({ EMAIL: 0 }).forEach((r) => seen.push(r as Record<string, unknown>));
    expect(seen).toHaveLength(USERS.filter((u) => u.STATUS === "active").length);
    expect(seen.every((r) => !("EMAIL" in r))).toBe(true);
  });

  it("filter values that are Promises are awaited (nested and in arrays)", async () => {
    const rows = await users.find({ STATUS: { $in: [Promise.resolve("banned"), "trial"] }, AGE: Promise.resolve(52) }).toArray();
    expect(rows).toHaveLength(1);
    expect((await users.find({ $or: [{ NAME: Promise.resolve("Juan") }] }).toArray())).toHaveLength(1);
  });

  it("scalar-subquery projection counts related rows", async () => {
    const rows = await users.find({ NAME: "Juan" }).project({ NAME: 1, ORDER_COUNT: { $subquery: { collection: O, fn: "count", filter: { USER_ID: "$ID" } } } }).toArray<{ ORDER_COUNT: number }>();
    const juan = await users.findOne<{ ID: number }>({ NAME: "Juan" });
    expect(rows[0].ORDER_COUNT).toBe(await orders.countDocuments({ USER_ID: juan?.ID }));
  });

  it("$exists / $notExists / $inSelect subqueries agree with each other", async () => {
    const withOrders = await users.find({ $exists: { collection: O, match: { USER_ID: "$ID" } } }).count();
    const without = await users.find({ $notExists: { collection: O, match: { USER_ID: "$ID" } } }).count();
    expect(withOrders + without).toBe(USERS.length);
    const viaIn = await users.find({ ID: { $inSelect: orders.find({}).project({ USER_ID: 1 }) } }).count();
    expect(viaIn).toBe(withOrders);
    const viaDistinct = await users.find({ ID: { $inSelect: await orders.distinct("USER_ID") } }).count();
    expect(viaDistinct).toBe(withOrders);
  });

  it("correlated $subquery comparison: salary above department average", async () => {
    const rows = await emp.find({ SALARY: { $gt: { $subquery: { collection: E, aggregate: "$avg", field: "SALARY", where: { DEPT: "$outer.DEPT" } } } } }).toArray<{ NAME: string }>();
    expect(rows.map((r) => r.NAME).sort()).toEqual(["CFO", "CTO"]);
  });

  it("$now compares against the DATABASE clock", async () => {
    await users.updateMany({ NAME: "Juan" }, { $currentDate: { UPDATED_AT: { $type: "timestamp" } } });
    expect(await users.countDocuments({ UPDATED_AT: { $gte: { $now: { minus: { minutes: 5 } } }, $lte: { $now: true } } })).toBe(1);
  });

  it("$in with more than 1,000 values (ORA-01795 guard) runs", async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => i + 1);
    expect(await users.countDocuments({ ID: { $in: ids } })).toBe(USERS.length);
    expect(await users.countDocuments({ ID: { $nin: ids } })).toBe(0);
  });

  it("SAMPLE(100) returns every row", async () => {
    expect(await new QueryBuilder(U, {}, db, null, { sample: { percentage: 99.999999, seed: 1 } }).toArray()).toHaveLength(USERS.length);
  });

  it("flashback AS OF SCN / TIMESTAMP reads the past", async () => {
    // Flashback needs the table to be older than the SCN↔time mapping granularity (~3s).
    const wait = 6000 - (Date.now() - fixtureReadyAt);
    if (wait > 0) await sleep(wait);
    const scnRow = await rawExec<{ SCN: number; TS: string }>("SELECT TIMESTAMP_TO_SCN(SYSTIMESTAMP) AS SCN, TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS FROM DUAL");
    const { SCN, TS } = scnRow.rows![0];
    // AS OF TIMESTAMP resolves TS through the SCN↔time map (~3 s granularity), so TS can map
    // to an SCN after an update made right away. Wait, bounded, until TS maps to an SCN
    // behind the current one; a fixed 1.5 s sleep lost this race in full runs.
    const deadline = Date.now() + 15000;
    for (;;) {
      const r = await rawExec<{ BEHIND: number }>(
        "SELECT CASE WHEN TIMESTAMP_TO_SCN(TO_TIMESTAMP(:ts, 'YYYY-MM-DD HH24:MI:SS')) < TIMESTAMP_TO_SCN(SYSTIMESTAMP) THEN 1 ELSE 0 END AS BEHIND FROM DUAL",
        { ts: TS },
      );
      if (Number(r.rows![0].BEHIND) === 1 || Date.now() > deadline) break;
      await sleep(250);
    }
    await sleep(1500);
    await users.updateMany({ NAME: "Ana" }, { $set: { CITY: "Changed" } });
    try {
      const past = await new QueryBuilder(U, { NAME: "Ana" }, db, null, { asOf: { scn: SCN } }).next<{ CITY: string }>();
      expect(past?.CITY).toBe("Manila");
      const pastTs = await new QueryBuilder(U, { NAME: "Ana" }, db, null, { asOf: { timestamp: TS } }).next<{ CITY: string }>();
      expect(pastTs?.CITY).toBe("Manila");
      expect((await users.findOne<{ CITY: string }>({ NAME: "Ana" }))?.CITY).toBe("Changed");
    } finally {
      // Restore the fixture even on failure: later suites count Manila rows.
      await users.updateMany({ NAME: "Ana" }, { $set: { CITY: "Manila" } });
    }
  }, 30000);
});

describe("integration: CTEs and set operations", () => {
  it("withCTE joins two named queries", async () => {
    const rows = (await withCTE(db, {
      ACTIVE_U: users.find({ STATUS: "active" }).project({ ID: 1, NAME: 1 }),
      BIG_O: orders.find({ AMOUNT: { $gte: 1000 } }).project({ USER_ID: 1, AMOUNT: 1 }),
    })
      .from("ACTIVE_U")
      .join({ from: "BIG_O", localField: "ID", foreignField: "USER_ID", joinType: "inner" })
      .sort({ AMOUNT: -1 })
      .limit(3)
      .toArray()) as Record<string, unknown>[];
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.length).toBeGreaterThan(0);
    expect(Number(rows[0].AMOUNT)).toBeGreaterThanOrEqual(Number(rows[rows.length - 1].AMOUNT));
  });

  it("withRecursiveCTE walks the whole org chart with LVL", async () => {
    const rows = (await withRecursiveCTE(db, "ORG", { anchor: emp.find({ MANAGER_ID: null }), recursive: { collection: E, joinOn: { MANAGER_ID: "$ORG.ID" } } })
      .sort({ LVL: 1, NAME: 1 })
      .toArray()) as { NAME: string; LVL: number }[];
    expect(rows.map((r) => [r.NAME, r.LVL])).toEqual([["CEO", 1], ["CFO", 2], ["CTO", 2], ["Acct", 3], ["Dev1", 3], ["Dev2", 3]]);
  });

  it("UNION / UNION ALL / INTERSECT / MINUS give set-correct results", async () => {
    const a = () => users.find({ CITY: "Manila" }).project({ NAME: 1 });
    const b = () => users.find({ STATUS: "active" }).project({ NAME: 1 });
    const names = (rows: unknown[]) => (rows as { NAME: string }[]).map((r) => r.NAME).sort();
    const manila = USERS.filter((u) => u.CITY === "Manila").map((u) => u.NAME);
    const active = USERS.filter((u) => u.STATUS === "active").map((u) => u.NAME);
    expect(names(await OracleCollection.union(a(), b()).toArray())).toEqual([...new Set([...manila, ...active])].sort());
    expect(await OracleCollection.union(a(), b(), { all: true }).toArray()).toHaveLength(manila.length + active.length);
    expect(names(await OracleCollection.intersect(a(), b()))).toEqual(manila.filter((n) => active.includes(n)).sort());
    expect(names(await OracleCollection.minus(b(), a()).sort({ NAME: 1 }).skip(0).limit(100))).toEqual(active.filter((n) => !manila.includes(n)).sort());
  });
});

describe("integration: transactions", () => {
  it("commit on success, rollback on throw", async () => {
    await tx.withTransaction(async (s) => {
      await s.collection(E).insertOne({ ID: 100, NAME: "Committed" });
    });
    expect(await emp.findOne({ ID: 100 })).not.toBeNull();
    await expect(
      tx.withTransaction(async (s) => {
        await s.collection(E).insertOne({ ID: 101, NAME: "RolledBack" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await emp.findOne({ ID: 101 })).toBeNull();
  });

  it("savepoints: partial rollback keeps earlier work", async () => {
    await tx.withTransaction(async (s) => {
      const e = s.collection(E);
      await e.insertOne({ ID: 110, NAME: "Keep" });
      await s.savepoint("SP_1");
      await e.insertOne({ ID: 111, NAME: "Undo" });
      await s.rollbackTo("SP_1");
      await s.releaseSavepoint("SP_1");
    });
    expect(await emp.findOne({ ID: 110 })).not.toBeNull();
    expect(await emp.findOne({ ID: 111 })).toBeNull();
  });

  it("savepoint names are validated (no SQL injection)", async () => {
    await expect(tx.withTransaction((s) => s.savepoint("x; DROP TABLE T"))).rejects.toThrow(/Invalid savepoint name/);
    await expect(tx.withTransaction((s) => s.rollbackTo(42 as never))).rejects.toThrow(/Invalid savepoint name/);
  });

  it("session-bound insertMany / bulkUpdateByKeys / reads join the surrounding transaction", async () => {
    await expect(
      tx.withTransaction(async (s) => {
        const e = s.collection(E);
        await e.insertMany([{ ID: 120, NAME: "a" }, { ID: 121, NAME: "b" }], { returning: [] });
        await e.bulkUpdateByKeys([{ ID: 120, NAME: "A" }], { keys: ["ID"] });
        expect(await e.find({ ID: { $in: [120, 121] } }).count()).toBe(2);
        expect(await e.find({ ID: 120 }).next()).toMatchObject({ NAME: "A" });
        const streamed: unknown[] = [];
        await e.find({ ID: { $in: [120, 121] } }).forEach((r) => streamed.push(r));
        expect(streamed).toHaveLength(2);
        expect(await OracleCollection.union(e.find({ ID: 120 }).project({ ID: 1 }), e.find({ ID: 121 }).project({ ID: 1 })).toArray()).toHaveLength(2);
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    expect(await emp.countDocuments({ ID: { $in: [120, 121] } })).toBe(0);
  });

  it("session.execute runs raw SQL inside the transaction", async () => {
    const r = await tx.withTransaction(async (s) => {
      await s.execute(`LOCK TABLE "${E}" IN EXCLUSIVE MODE NOWAIT`);
      return s.execute<{ N: number }>("SELECT 1 AS N FROM DUAL", {}, { outFormat: db.oracledb.OUT_FORMAT_OBJECT });
    });
    expect(r.rows?.[0].N).toBe(1);
  });

  it("forUpdate inside a transaction locks rows: a second session gets ORA-00054", async () => {
    await tx.withTransaction(async (s) => {
      const locked = await s.collection(E).find({ ID: 1 }).forUpdate("nowait").limit(1).toArray();
      expect(locked).toHaveLength(1);
      await expect(emp.find({ ID: 1 }).forUpdate("nowait").toArray()).rejects.toThrow(/ORA-00054/);
      const skipped = await emp.find({ ID: { $in: [1, 2] } }).forUpdate("skip locked").toArray();
      expect(skipped.map((r) => r.ID)).toEqual([2]);
    });
  });

  it("read-only transaction: consistent snapshot, writes refused", async () => {
    const counts = await tx.withReadOnlyTransaction(async (s) => ({ u: await s.collection(U).countDocuments(), e: await s.collection(E).countDocuments() }));
    expect(counts.u).toBe(USERS.length);
    await expect(tx.withReadOnlyTransaction((s) => s.collection(E).insertOne({ ID: 130 }))).rejects.toThrow(/ORA-01456/);
  });

  it("db.withBatchConnection runs ops on one connection and reports each outcome", async () => {
    const res = await db.withBatchConnection([
      async (c: never) => (await (c as { execute: (s: string) => Promise<{ rows: unknown[] }> }).execute("SELECT SYS_CONTEXT('USERENV','SID') FROM DUAL")).rows,
      "not a function" as never,
      async () => {
        throw new Error("op failed");
      },
    ]);
    expect(res.map((r) => r.success)).toEqual([true, false, false]);
    expect(res[2].error).toBe("op failed");
    await expect(db.withBatchConnection([])).rejects.toThrow(TypeError);
  });
});

describe("integration: IN-list padding returns the same rows", () => {
  it("$in / $nin with padded lists match an unpadded count for every length 1..40", async () => {
    const all = (await users.find({}).project({ ID: 1 }).toArray()).map((r) => (r as { ID: number }).ID);
    for (let n = 1; n <= Math.min(40, all.length + 5); n++) {
      const ids = Array.from({ length: n }, (_, i) => all[i % all.length] ?? -i);
      const expectIn = new Set(ids.filter((x) => all.includes(x))).size;
      expect([n, await users.countDocuments({ ID: { $in: ids } })]).toEqual([n, expectIn]);
      expect([n, await users.countDocuments({ ID: { $nin: ids } })]).toEqual([n, all.length - expectIn]);
    }
  });
});

describe("integration: fixed defects, proven live", () => {
  it("$in / $nin over 1,000 values use one collection bind — numbers, strings, dates", async () => {
    const ids = Array.from({ length: 3000 }, (_, i) => i + 1);
    expect(await users.countDocuments({ ID: { $in: ids } })).toBe(USERS.length);
    expect(await users.countDocuments({ ID: { $nin: ids } })).toBe(0);
    const names = [...USERS.map((u) => u.NAME), ...Array.from({ length: 1500 }, (_, i) => `ghost-${i}`)];
    expect(await users.countDocuments({ NAME: { $in: names } })).toBe(USERS.length);
    expect(await users.countDocuments({ NAME: { $nin: names } })).toBe(0);
    await users.updateMany({}, { $set: { UPDATED_AT: new Date("2026-02-03T04:05:06Z") } });
    const days = Array.from({ length: 1200 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000));
    const viaDates = await users.countDocuments({ UPDATED_AT: { $in: [new Date("2026-02-03T04:05:06Z"), ...days] } });
    expect(viaDates).toBe(USERS.length);
  });

  it("$facet with filters in several facets runs (binds kept and renamed)", async () => {
    const rows = await users.aggregate([{ $facet: { active: [{ $match: { STATUS: "active" } }, { $count: "n" }], cebu: [{ $match: { CITY: "Cebu" } }, { $count: "n" }] } }]);
    const byFacet = Object.fromEntries(rows.map((r) => [r.facet_name, Number(r.N)]));
    expect(byFacet).toEqual({ active: USERS.filter((u) => u.STATUS === "active").length, cebu: USERS.filter((u) => u.CITY === "Cebu").length });
  });

  it("$merge writes pipeline results into a table: insert, then update on re-run", async () => {
    const T = "MIRA_IQ_REGION_TOTALS";
    await dropIfExists(T);
    const { schema } = await import("../helpers/db");
    await schema.createTable(T, { REGION: { type: "VARCHAR2(20)", primaryKey: true }, TOTAL: { type: "NUMBER" } });
    const pipeline = [{ $group: { _id: "$REGION", TOTAL: { $sum: "$AMOUNT" } } }, { $merge: { into: T, on: { REGION: "REGION" }, fields: ["REGION", "TOTAL"] } }];
    await orders.aggregate(pipeline);
    expect(await coll(T).countDocuments()).toBe(4);
    await orders.updateMany({ REGION: "North" }, { $mul: { AMOUNT: 2 } });
    await orders.aggregate(pipeline);
    const north = await coll(T).findOne<{ TOTAL: number }>({ REGION: "North" });
    const expected = (await orders.find({ REGION: "North" }).toArray<{ AMOUNT: string }>()).reduce((s, r) => s + Number(r.AMOUNT), 0);
    expect(Number(north?.TOTAL)).toBe(expected);
    await dropIfExists(T);
  });

  it("$concat literals are values, not identifiers", async () => {
    const rows = await users.aggregate([{ $match: { NAME: "Juan" } }, { $project: { label: { $concat: ["$NAME", " <", "$EMAIL", ">"] } } }]);
    expect(rows[0].LABEL).toBe("Juan <juan@mira.test>");
  });

  it("$lateralJoin with { col: '$outer.X' } correlates to the outer row", async () => {
    const rows = (await users.aggregate([
      { $lateralJoin: { subquery: orders.find({ USER_ID: "$outer.ID" }).project({ USER_ID: 1, AMOUNT: 1 }).sort({ AMOUNT: -1 }).limit(1), as: "TOP" } },
    ])) as { ID: number; USER_ID: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.USER_ID === r.ID)).toBe(true); // before the fix every row matched every order
  });

  it("forEach awaits an async consumer: one row in flight at a time, all rows delivered", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: unknown[] = [];
    await users.find({}).sort({ ID: 1 }).forEach(async (r) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(2);
      seen.push((r as { ID: number }).ID);
      inFlight--;
    });
    expect(seen).toHaveLength(USERS.length);
    expect(maxInFlight).toBe(1);
  });

  it("column names that are not valid bind names work everywhere (bind names are sanitised)", async () => {
    const W = "MIRA_IQ_WEIRD";
    await dropIfExists(W);
    await rawExec(`CREATE TABLE "${W}" ("ID" NUMBER PRIMARY KEY, "A-B" NUMBER, "X Y" VARCHAR2(20), "ñ" VARCHAR2(20))`);
    const w = coll(W);
    const ins = await w.insertOne({ ID: 1, "A-B": 1, "X Y": "a", "ñ": "n" }, { returning: ["A-B", "X Y"] });
    expect(ins.returning).toEqual({ "A-B": "1", "X Y": "a" });
    await w.insertMany([{ ID: 2, "A-B": 2, "X Y": "b", "ñ": "m" }], { returning: ["ID"] });
    expect(await w.countDocuments({ "A-B": { $gte: 1 }, "X Y": { $in: ["a", "b"] } })).toBe(2);
    const upd = await w.updateMany({ "ñ": { $ne: "zzz" } }, { $inc: { "A-B": 10 }, $set: { "X Y": "c" } }, { returning: ["A-B"] });
    expect(upd.returning?.map((r) => Number(r["A-B"])).sort()).toEqual([11, 12]);
    await w.merge({ ID: 3, "A-B": 3, "X Y": "d" }, { localField: "ID", foreignField: "ID" }, { whenNotMatched: "insert" });
    expect(await w.findOne({ ID: 3 })).toMatchObject({ "A-B": 3, "X Y": "d" });
    // "A-B" and "A_B" sanitise to the same text: positional bind names keep them apart
    await w.merge({ ID: 3, "A_B": 0, "A-B": 30 }, { localField: "ID", foreignField: "ID" }, { whenMatched: { $set: { "A-B": 30 } } });
    expect(await w.findOne({ ID: 3 })).toMatchObject({ "A-B": 30 });
    await w.mergeFrom(W, { localField: "ID", foreignField: "ID" }, { whenMatched: { $set: { "X Y": "$src.X Y", "ñ": "merged" } } });
    expect(await w.findOne({ ID: 3 })).toMatchObject({ "X Y": "d", "ñ": "merged" });
    const up = await w.findOneAndUpdate({ ID: 4 }, { $set: { "X Y": "e", "A-B": 4 } }, { upsert: true, returnDocument: "after" });
    expect(up).toMatchObject({ ID: 4, "X Y": "e", "A-B": 4 });
    const one = await w.updateOne({ ID: 4 }, { $set: { "ñ": "o" } }, { returning: ["ñ"] });
    expect(one.returning).toEqual({ "ñ": "o" });
    const del = await w.deleteMany({ ID: { $gte: 3 } }, { returning: ["X Y"] });
    expect(del.returning?.map((r) => r["X Y"]).sort()).toEqual(["d", "e"]);
    const proj = await w.find({ ID: 1 }).project({ "A-B": 1, CNT: { $subquery: { collection: W, fn: "count", filter: { "X Y": "c" } } } }).toArray();
    expect(proj[0]).toMatchObject({ "A-B": 11, CNT: 2 });
    await dropIfExists(W);
  });
});
