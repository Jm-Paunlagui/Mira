/**
 * INTEGRATION — defects found by the simulation (bun run sim) and by a code
 * review of the wrapper, each reproduced on the live MIRA schema. Every test
 * asserts the CORRECT behaviour; each one failed before its fix.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { OracleCollection, Transaction, createPerformance, withCTE } from "../../src/utils/oracle-mongo-wrapper";
import { db, schema, coll, createUsers, createOrders, createEmployees, dropIfExists, rawExec, USERS } from "../helpers/db";

const U = "MIRA_SD_USERS";
const O = "MIRA_SD_ORDERS";
const E = "MIRA_SD_EMP";
const N = "MIRA_SD_NOID";
const J = "MIRA_SD_JSON";
const Z = "MIRA_SD_TSTZ";
const V = "MIRA_SD_V";
const MV = "MIRA_SD_MV";
const users = coll(U);
const orders = coll(O);
let orderRows: Record<string, unknown>[] = [];
let userIds: number[] = [];

const dropViews = async () => {
  await rawExec(`BEGIN EXECUTE IMMEDIATE 'DROP MATERIALIZED VIEW "${MV}"'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
  await schema.dropView(V, { ifExists: true });
};

beforeAll(async () => {
  await dropViews();
  await dropIfExists(O, U, E, N, J, Z);
  await createUsers(U);
  orderRows = await createOrders(O, U);
  await createEmployees(E);
  userIds = (await users.find({}).sort({ ID: 1 }).project({ ID: 1 }).toArray<{ ID: number }>()).map((r) => r.ID);
  await schema.createTable(N, { A: { type: "NUMBER" }, B: { type: "VARCHAR2(20)" } });
  await schema.createTable(J, { ID: { type: "NUMBER", primaryKey: true }, TAGS: { type: "VARCHAR2(200)", check: "TAGS IS JSON" } });
  await schema.createTable(Z, { ID: { type: "NUMBER", primaryKey: true }, AT: { type: "TIMESTAMP WITH TIME ZONE" } });
});
afterAll(async () => {
  await dropViews();
  await dropIfExists(O, U, E, N, J, Z);
});

/** Runs fn on one pooled connection whose session time zone differs from the database server's, then restores it. */
async function inOtherTimeZone<T>(fn: (conn: never) => Promise<T>): Promise<T> {
  return db.withConnection(async (conn) => {
    const out = { outFormat: db.oracledb.OUT_FORMAT_OBJECT };
    const [{ TZ, H }] = (await conn.execute<{ TZ: string; H: string }>("SELECT SESSIONTIMEZONE AS TZ, TO_CHAR(SYSTIMESTAMP, 'TZH') AS H FROM DUAL", {}, out)).rows!;
    const other = Number(H) === -5 ? "+08:00" : "-05:00";
    await conn.execute(`ALTER SESSION SET TIME_ZONE = '${other}'`);
    try {
      return await fn(conn as never);
    } finally {
      await conn.execute(`ALTER SESSION SET TIME_ZONE = '${TZ}'`);
    }
  });
}

describe("integration: defects that returned wrong data with no error", () => {
  it("DEFECT: $now compares in database time, whatever the session time zone", async () => {
    await users.updateMany({ NAME: "Juan" }, { $currentDate: { UPDATED_AT: { $type: "timestamp" } } });
    const n = await inOtherTimeZone((conn) => new OracleCollection(U, db, conn).countDocuments({ UPDATED_AT: { $gte: { $now: { minus: { minutes: 5 } } }, $lte: { $now: true } } }));
    expect(n).toBe(1);
  });

  it("DEFECT: $now withTimeZone compares a TIMESTAMP WITH TIME ZONE column correctly", async () => {
    await rawExec(`INSERT INTO "${Z}" ("ID", "AT") VALUES (1, SYSTIMESTAMP)`);
    const n = await inOtherTimeZone((conn) => new OracleCollection(Z, db, conn).countDocuments({ AT: { $gte: { $now: { minus: { minutes: 5 }, withTimeZone: true } }, $lte: { $now: { withTimeZone: true } } } }));
    expect(n).toBe(1);
  });

  it("DEFECT: { $ne: null } is IS NOT NULL and { $eq: null } is IS NULL", async () => {
    expect(await users.countDocuments({ CITY: { $ne: null } })).toBe(USERS.filter((u) => u.CITY !== null).length);
    expect(await users.countDocuments({ CITY: { $eq: null } })).toBe(USERS.filter((u) => u.CITY === null).length);
  });

  it("DEFECT: $inSelect keeps the outer and the subquery's values apart when both filter the same column", async () => {
    const n = await users.countDocuments({ SCORE: { $gte: 80 }, ID: { $inSelect: users.find({ SCORE: { $lte: 90 } }).project({ ID: 1 }) } });
    expect(n).toBe(USERS.filter((u) => u.SCORE >= 80 && u.SCORE <= 90).length);
  });

  it("DEFECT: withCTE keeps each named query's values apart", async () => {
    const rows = await withCTE(db, { A: users.find({ SCORE: { $gte: 80 } }).project({ ID: 1, NAME: 1 }), B: users.find({ SCORE: { $lte: 90 } }).project({ ID: 1 }) })
      .from("A")
      .join({ from: "B", localField: "ID", foreignField: "ID" })
      .toArray();
    expect(rows).toHaveLength(USERS.filter((u) => u.SCORE >= 80 && u.SCORE <= 90).length);
  });

  it("DEFECT: two $match stages on the same column in one pipeline keep their own values", async () => {
    const rows = await users.aggregate([{ $match: { SCORE: { $gte: 80 } } }, { $sort: { SCORE: 1 } }, { $match: { SCORE: { $lte: 90 } } }]);
    expect(rows.map((r) => r.NAME).sort()).toEqual(USERS.filter((u) => u.SCORE >= 80 && u.SCORE <= 90).map((u) => u.NAME).sort());
  });

  it("DEFECT: $lateralJoin's subquery values do not collide with the pipeline's", async () => {
    const rows = await users.aggregate([
      { $match: { STATUS: "active" } },
      { $lateralJoin: { subquery: orders.find({ STATUS: "completed", USER_ID: "$outer.ID" }).project({ USER_ID: 1 }).limit(1), as: "C" } },
    ]);
    const activeIds = new Set(USERS.map((u, i) => (u.STATUS === "active" ? userIds[i] : -1)));
    const expected = [...new Set(orderRows.filter((o) => o.STATUS === "completed" && activeIds.has(Number(o.USER_ID))).map((o) => Number(o.USER_ID)))].sort((a, b) => a - b);
    expect(rows.map((r) => Number(r.ID)).sort((a, b) => a - b)).toEqual(expected);
  });

  it("DEFECT: $lateralJoin with sort + limit keeps every outer row and picks each one's top row (Oracle LATERAL row-limit bug)", async () => {
    const rows = await users.aggregate([
      { $match: { STATUS: "active" } },
      { $lateralJoin: { subquery: orders.find({ STATUS: "completed", USER_ID: "$outer.ID" }).project({ AMOUNT: 1 }).sort({ AMOUNT: -1 }).limit(1), as: "C" } },
    ]);
    const activeIds = new Set(USERS.map((u, i) => (u.STATUS === "active" ? userIds[i] : -1)));
    const top = new Map<number, number>();
    for (const o of orderRows) {
      const id = Number(o.USER_ID);
      if (o.STATUS === "completed" && activeIds.has(id)) top.set(id, Math.max(top.get(id) ?? -Infinity, Number(o.AMOUNT)));
    }
    const got = rows.map((r) => [Number(r.ID), Number(r.AMOUNT)]).sort((a, b) => a[0] - b[0]);
    expect(got).toEqual([...top.entries()].sort((a, b) => a[0] - b[0]));
  });

  it("DEFECT: findOneAndUpdate changes exactly one row when several match", async () => {
    const before = await users.findOneAndUpdate<{ ID: number }>({ STATUS: "inactive" }, { $set: { LOGIN_COUNT: 7 } });
    expect(await users.countDocuments({ LOGIN_COUNT: 7 })).toBe(1);
    expect(await users.countDocuments({ ID: before?.ID, LOGIN_COUNT: 7 })).toBe(1);
  });

  it("DEFECT: findOneAndReplace changes exactly one row when several match", async () => {
    await coll(E).findOneAndReplace({ DEPT: "ENG" }, { NAME: "Replaced", MANAGER_ID: 1, DEPT: "ENG", SALARY: 1 });
    expect(await coll(E).countDocuments({ NAME: "Replaced" })).toBe(1);
  });

  it("DEFECT: findOneAndUpdate / findOneAndReplace 'after' return the changed row on a table with no ID", async () => {
    const n = coll(N);
    await n.insertMany([{ A: 1, B: "x" }, { A: 1, B: "x" }], { returning: [] });
    const after = await n.findOneAndUpdate({ A: 1 }, { $set: { A: 2 } }, { returnDocument: "after" });
    expect(after).toEqual({ A: 2, B: "x" });
    expect(await n.countDocuments({ A: 2 })).toBe(1);
    const repl = await n.findOneAndReplace({ A: 1 }, { A: 3, B: "r" }, { returnDocument: "after" });
    expect(repl).toEqual({ A: 3, B: "r" });
    expect(await n.countDocuments({ A: 1 })).toBe(0);
    await n.deleteMany({});
  });

  it("DEFECT: forUpdate('skip locked') with limit hands the next free row to a second worker, and locks only that row", async () => {
    const L = "MIRA_SD_LOTS";
    await dropIfExists(L);
    await schema.createTable(L, { LOT: { type: "VARCHAR2(5)", primaryKey: true }, EXP: { type: "NUMBER" } });
    await coll(L).insertMany(["A", "B", "C", "D"].map((LOT, i) => ({ LOT, EXP: i })), { returning: [] });
    const tx = new Transaction(db);
    const lots = (rows: unknown[]) => (rows as { LOT: string }[]).map((r) => r.LOT);
    await tx.withTransaction(async (a) => {
      expect(lots(await a.collection(L).find({}).sort({ EXP: 1 }).limit(1).forUpdate("skip locked").toArray())).toEqual(["A"]);
      await tx.withTransaction(async (b) => {
        // Before the fix the page was picked in a FETCH FIRST subquery: it chose A, the lock skipped it, B got nothing.
        expect(lots(await b.collection(L).find({}).sort({ EXP: 1 }).limit(1).forUpdate({ skipLocked: true }).toArray())).toEqual(["B"]);
        // Only B was locked (no prefetched rows): C and D are still free for a third worker.
        expect(lots(await coll(L).find({}).sort({ EXP: 1 }).forUpdate("skip locked").toArray())).toEqual(["C", "D"]);
      });
    });
    expect(await coll(L).find({}).limit(0).forUpdate("skip locked").toArray()).toEqual([]);
    await dropIfExists(L);
  });

  it("DEFECT: a standalone forUpdate('skip locked') read works while another session holds locks", async () => {
    const L = "MIRA_SD_LOTS2";
    await dropIfExists(L);
    await schema.createTable(L, { LOT: { type: "VARCHAR2(5)", primaryKey: true } });
    await coll(L).insertMany(["A", "B", "C", "D"].map((LOT) => ({ LOT })), { returning: [] });
    await new Transaction(db).withTransaction(async (a) => {
      await a.collection(L).find({ LOT: { $in: ["A", "B"] } }).forUpdate(true).toArray();
      // autoCommit on a FOR UPDATE cursor committed before the fetch finished: ORA-01002.
      const free = await coll(L).find({}).sort({ LOT: 1 }).forUpdate("skip locked").toArray<{ LOT: string }>();
      expect(free.map((r) => r.LOT)).toEqual(["C", "D"]);
    });
    await dropIfExists(L);
  });

  it("DEFECT: bulkWrite on a session collection joins the session's transaction", async () => {
    await expect(
      new Transaction(db).withTransaction(async (s) => {
        await s.collection(E).bulkWrite([{ insertOne: { document: { ID: 50, NAME: "bw" } } }]);
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    expect(await coll(E).countDocuments({ ID: 50 })).toBe(0);
    await new Transaction(db).withTransaction((s) => s.collection(E).bulkWrite([{ insertOne: { document: { ID: 51, NAME: "kept" } } }]));
    expect(await coll(E).countDocuments({ ID: 51 })).toBe(1);
  });
});

describe("integration: defects that failed loudly", () => {
  it("DEFECT: createView from a filtered query writes the filter values into the view", async () => {
    await schema.createView(V, users.find({ STATUS: "active", NAME: { $ne: "O'Brien" }, SCORE: { $gte: 70 } }).project({ NAME: 1 }), { orReplace: true });
    expect(Number((await rawExec<{ N: number }>(`SELECT COUNT(*) AS N FROM "${V}"`)).rows![0].N)).toBe(USERS.filter((u) => u.STATUS === "active" && u.SCORE >= 70).length);
    await expect(schema.createView(V, users.find({ UPDATED_AT: new Date() }), { orReplace: true })).rejects.toThrow(/cannot be written into a view/);
  });

  it("DEFECT: createMaterializedView from a filtered query", async () => {
    const perf = createPerformance(db) as { createMaterializedView: (n: string, q: unknown, o?: Record<string, unknown>) => Promise<unknown>; dropMaterializedView: (n: string) => Promise<unknown> };
    await perf.createMaterializedView(MV, users.find({ CITY: "Cebu" }).project({ ID: 1, NAME: 1 }), { orReplace: true });
    expect(Number((await rawExec<{ N: number }>(`SELECT COUNT(*) AS N FROM "${MV}"`)).rows![0].N)).toBe(USERS.filter((u) => u.CITY === "Cebu").length);
    await perf.dropMaterializedView(MV);
  });

  it("DEFECT: insertOne on a table with no ID column inserts the row (alone and in a transaction)", async () => {
    expect(await coll(N).insertOne({ A: 10, B: "solo" })).toEqual({ acknowledged: true, insertedId: null });
    await new Transaction(db).withTransaction((s) => s.collection(N).insertOne({ A: 11, B: "tx" }));
    expect(await coll(N).countDocuments({ A: { $in: [10, 11] } })).toBe(2);
    await expect(coll(N).insertOne({ NOPE: 1 })).rejects.toThrow(/ORA-00904/);
  });

  it("DEFECT: createTable accepts a column with both a default and NOT NULL / PRIMARY KEY", async () => {
    const T = "MIRA_SD_DEFNN";
    await dropIfExists(T);
    // Oracle wants DEFAULT before the constraints; NOT NULL DEFAULT 0 was ORA-00907.
    await schema.createTable(T, { ID: { type: "NUMBER", primaryKey: true, default: 1 }, QTY: { type: "NUMBER", notNull: true, default: 0, check: "QTY >= 0" }, NOTE: { type: "VARCHAR2(10)" } });
    await coll(T).insertMany([{ NOTE: "x" }], { returning: [] });
    expect(await coll(T).findOne({ NOTE: "x" })).toEqual({ ID: 1, QTY: 0, NOTE: "x" });
    await dropIfExists(T);
  });

  it("DEFECT: getIndexes names a descending column", async () => {
    await users.createIndex({ CITY: 1, AGE: -1 }, { name: "IX_MIRA_SD_DESC" });
    const ix = (await users.getIndexes()).find((i) => i.indexName === "IX_MIRA_SD_DESC");
    expect(ix?.columns).toEqual(["CITY", "AGE"]);
    await users.dropIndex("IX_MIRA_SD_DESC");
  });

  it("DEFECT: filter $case compares the column with the CASE result", async () => {
    const n = await users.countDocuments({ STATUS: { $case: [{ when: { SCORE: { $gte: 90 } }, then: "active" }], $else: "inactive" } });
    expect(n).toBe(USERS.filter((u) => u.STATUS === (u.SCORE >= 90 ? "active" : "inactive")).length);
  });

  it("DEFECT: filter $coalesce compares the column with COALESCE(...) and binds number literals", async () => {
    expect(await users.countDocuments({ NAME: { $coalesce: ["$CITY", "Tess"] } })).toBe(1);
    // A number literal is bound (it used to become the identifier "75": ORA-00904). No fixture row has SCORE = AGE.
    expect(await users.countDocuments({ SCORE: { $coalesce: ["$AGE", 75] } })).toBe(0);
  });

  it("DEFECT: filter $nullif compares the column with NULLIF(...)", async () => {
    // SCORE = NULLIF(SCORE, 80): true for every row except a score of 80 (NULLIF gives NULL there).
    expect(await users.countDocuments({ SCORE: { $nullif: ["SCORE", 80] } })).toBe(USERS.filter((u) => u.SCORE !== 80).length);
  });

  it("DEFECT: updateFromJoin treats a string with a dot as a value unless it names the join table", async () => {
    const r = await orders.updateFromJoin({ target: O, join: { table: U, on: { [`${O}.USER_ID`]: `${U}.ID` } }, set: { [`${O}.STATUS`]: "ok.done" }, where: {} });
    expect(await orders.countDocuments({ STATUS: "ok.done" })).toBe(r.modifiedCount);
    expect(r.modifiedCount).toBe(orderRows.length);
    const r2 = await orders.updateFromJoin({ target: O, join: { table: U, on: { USER_ID: "ID" } }, set: { PRODUCT: "$joined.CITY" }, where: { [`${U}.CITY`]: "Cebu" } });
    expect(r2.modifiedCount).toBeGreaterThan(0);
    expect(await orders.countDocuments({ PRODUCT: "Cebu" })).toBe(r2.modifiedCount);
  });

  it("DEFECT: $size counts the elements of a JSON array", async () => {
    await coll(J).insertMany([{ ID: 1, TAGS: '["a","b","c"]' }, { ID: 2, TAGS: "[]" }], { returning: [] });
    const rows = await coll(J).aggregate([{ $project: { ID: 1, N: { $size: "$TAGS" } } }, { $sort: { ID: 1 } }]);
    expect(rows.map((r) => Number(r.N))).toEqual([3, 0]);
  });

  it("DEFECT: $match after $group finds the group's aliases in the case they were written", async () => {
    const rows = await users.aggregate([{ $group: { _id: "$CITY", total: { $sum: "$SCORE" } } }, { $match: { total: { $gt: 150 } } }]);
    const totals = new Map<string | null, number>();
    for (const u of USERS) totals.set(u.CITY, (totals.get(u.CITY) ?? 0) + u.SCORE);
    expect(rows.map((r) => r.CITY).sort()).toEqual([...totals].filter(([, t]) => t > 150).map(([c]) => c).sort());
  });
});

// Found while testing typed tables (2.1): optional columns make documents with
// different keys common, and typed inserts pass Buffers and Dates through insertMany.
describe("integration: insertMany with documents that differ", () => {
  const M = "MIRA_SD_MIXED";
  beforeAll(async () => {
    await dropIfExists(M);
    await schema.createTable(M, {
      ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
      A: { type: "VARCHAR2(20)" },
      B: { type: "VARCHAR2(20)" },
      STATUS: { type: "VARCHAR2(10)", default: "'open'", notNull: true },
      AT: { type: "TIMESTAMP(3)" },
      BIN: { type: "BLOB" },
    });
  });
  afterAll(() => dropIfExists(M));

  it("DEFECT: insertMany keeps the columns only later documents have, and the defaults of omitted ones", async () => {
    const res = await coll(M).insertMany([{ A: "a1" }, { A: "a2", B: "b2" }, { B: "b3", STATUS: "paid" }, { A: "a4" }]);
    const rows = await coll(M).find({}).sort({ ID: 1 }).project({ ID: 1, A: 1, B: 1, STATUS: 1 }).toArray<{ ID: number; A: string | null; B: string | null; STATUS: string }>();
    expect(rows.map((r) => [r.A, r.B, r.STATUS])).toEqual([["a1", null, "open"], ["a2", "b2", "open"], [null, "b3", "paid"], ["a4", null, "open"]]);
    expect(res.insertedCount).toBe(4);
    // insertedIds stay in the caller's order
    expect(res.insertedIds).toEqual(rows.map((r) => r.ID));
  });

  it("DEFECT: insertMany binds a Buffer to a BLOB column, small or large", async () => {
    await rawExec(`DELETE FROM "${M}"`);
    const small = Buffer.from([0, 1, 2, 255]);
    const large = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 256));
    await coll(M).insertMany([{ A: "s", BIN: small }, { A: "l", BIN: large }]);
    const rows = await coll(M).find({}).sort({ A: -1 }).project({ BIN: 1 }).toArray<{ BIN: Buffer }>();
    expect(rows[0].BIN.equals(small)).toBe(true);
    expect(rows[1].BIN.equals(large)).toBe(true);
  });

  it("batchErrors offsets point at the caller's documents across column-set groups", async () => {
    await rawExec(`DELETE FROM "${M}"`);
    const tooLong = "x".repeat(21); // VARCHAR2(20): ORA-12899
    const res = await coll(M).insertMany([{ A: "ok0" }, { A: tooLong }, { A: "ok2", B: "b" }, { A: "ok3", B: tooLong }, { B: "ok4" }], { returning: [], batchErrors: true });
    expect(res.insertedCount).toBe(3);
    expect(res.batchErrors?.map((e) => e.offset)).toEqual([1, 3]);
    expect(res.batchErrors?.every((e) => /ORA-12899/.test(e.message))).toBe(true);
  });

  it("insertMany binds text over 32 KB to a CLOB column", async () => {
    const C2 = "MIRA_SD_CLOBS";
    await dropIfExists(C2);
    await schema.createTable(C2, { ID: { type: "NUMBER" }, DOC: { type: "CLOB" } });
    try {
      const big = "é".repeat(20_000); // 40,000 bytes
      await coll(C2).insertMany([{ ID: 1, DOC: big }, { ID: 2, DOC: "short" }], { returning: [] });
      const rows = await coll(C2).find({}).sort({ ID: 1 }).toArray<{ DOC: string }>();
      expect(rows.map((r) => r.DOC)).toEqual([big, "short"]);
    } finally {
      await dropIfExists(C2);
    }
  });

  it("DEFECT: insertMany takes a column given as a number in one document and a numeric string in another", async () => {
    // Typed money columns accept string | number; one bind type per column came from the
    // first value, so ["10.5", 99] failed with NJS-011.
    const N = "MIRA_SD_NUMS";
    await dropIfExists(N);
    await schema.createTable(N, { K: { type: "NUMBER" }, AMT: { type: "NUMBER(19,4)" } });
    try {
      await coll(N).insertMany([{ K: 1, AMT: "10.5" }, { K: 2, AMT: 99 }, { K: 3, AMT: null }, { K: 4, AMT: "0.0001" }], { returning: [] });
      await coll(N).insertMany([{ K: 5, AMT: 7 }, { K: 6, AMT: "8.25" }], { returning: [] });
      const rows = await coll(N).find({}).sort({ K: 1 }).toArray<{ AMT: string | null }>();
      expect(rows.map((r) => r.AMT)).toEqual(["10.5", "99", null, ".0001", "7", "8.25"]);
    } finally {
      await dropIfExists(N);
    }
  });

  it("insertMany keeps a Date's milliseconds, as insertOne does", async () => {
    await rawExec(`DELETE FROM "${M}"`);
    const at = new Date("2026-05-06T07:08:09.123Z");
    await coll(M).insertMany([{ A: "many", AT: at }]);
    await coll(M).insertOne({ A: "one", AT: at });
    const rows = await coll(M).find({}).sort({ A: 1 }).project({ A: 1, AT: 1 }).toArray<{ A: string; AT: Date }>();
    expect(rows.map((r) => [r.A, r.AT.getTime()])).toEqual([["many", at.getTime()], ["one", at.getTime()]]);
  });
});
