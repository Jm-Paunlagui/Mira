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
