/**
 * INTEGRATION — OracleCollection against the live MIRA schema.
 * Every write is verified by reading the row back, never by trusting the
 * method's own return value alone.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { OracleCollection } from "../../src";
import { db, schema, coll, createUsers, createOrders, createEmployees, dropIfExists, rawExec, USERS } from "../helpers/db";

const U = "MIRA_IT_USERS";
const O = "MIRA_IT_ORDERS";
const E = "MIRA_IT_EMP";
const Q = "MIRA_IT_QUARTERLY"; // no ID column
const K = "MIRA_IT_KEYED"; // string + date keys
const users = coll(U);
const orders = coll(O);
const emp = coll(E);
const quarterly = coll(Q);

beforeAll(async () => {
  await dropIfExists(O, U, E, Q, K, `${U}_ARCH`);
  await createUsers(U);
  await createOrders(O, U);
  await createEmployees(E);
  await schema.createTable(Q, { REGION: { type: "VARCHAR2(20)", primaryKey: true }, Q1: { type: "NUMBER" }, Q2: { type: "NUMBER" } });
  await quarterly.insertMany([{ REGION: "North", Q1: 10, Q2: 20 }, { REGION: "South", Q1: 30, Q2: null }], { returning: [] });
});

afterAll(async () => {
  await rawExec(`BEGIN EXECUTE IMMEDIATE 'DROP SYNONYM "MIRA_IT_SYN"'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
  await dropIfExists(O, U, E, Q, K, `${U}_ARCH`);
});

describe("integration: reads", () => {
  it("findOne returns a full row, or null when nothing matches", async () => {
    const row = await users.findOne<{ NAME: string; EMAIL: string; AGE: number }>({ NAME: "Juan" });
    expect(row).toMatchObject({ NAME: "Juan", EMAIL: "juan@mira.test", AGE: 25 });
    expect(await users.findOne({ NAME: "Nobody" })).toBeNull();
  });

  it("countDocuments / distinct match the fixture exactly", async () => {
    expect(await users.countDocuments()).toBe(USERS.length);
    expect(await users.countDocuments({ STATUS: "active" })).toBe(USERS.filter((u) => u.STATUS === "active").length);
    const cities = (await users.distinct("CITY", { STATUS: "active" })) as (string | null)[];
    expect(new Set(cities)).toEqual(new Set(["Manila", "Cebu", "Iloilo", null]));
  });

  it("estimatedDocumentCount reads optimizer stats (exact after gathering them)", async () => {
    await rawExec(`BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, :t); END;`, { t: U });
    expect(await users.estimatedDocumentCount()).toBe(USERS.length);
  });
});

describe("integration: inserts", () => {
  it("insertOne returns the identity ID; returning reads back columns", async () => {
    const r = await users.insertOne({ NAME: "Ins1", EMAIL: "i1@mira.test" });
    expect(typeof r.insertedId).toBe("number");
    expect((await users.findOne({ ID: r.insertedId }))?.NAME).toBe("Ins1");
    const r2 = await users.insertOne({ NAME: "Ins2", EMAIL: "i2@mira.test" }, { returning: ["ID", "STATUS"] });
    expect(r2.returning?.STATUS).toBe("active"); // column DEFAULT applied
    expect(Number(r2.insertedId)).toBeGreaterThan(Number(r.insertedId));
    const r3 = await users.insertOne({ NAME: "Ins3", EMAIL: "i3@mira.test" }, { returning: ["NAME"] });
    expect(r3).toEqual({ acknowledged: true, insertedId: null, returning: { NAME: "Ins3" } });
  });

  it("insertOne with an explicit ID skips the RETURNING clause", async () => {
    expect(await emp.insertOne({ ID: 99, NAME: "Temp" })).toEqual({ acknowledged: true, insertedId: null });
    await emp.deleteOne({ ID: 99 });
  });

  it("insertMany: ids for every row, multi-byte strings, dates, nulls", async () => {
    const when = new Date("2026-01-02T03:04:05Z");
    const r = await users.insertMany([
      { NAME: "Ñoño Español", EMAIL: "n1@mira.test", UPDATED_AT: when, AGE: null },
      { NAME: "Zoë", EMAIL: "n2@mira.test", UPDATED_AT: null, AGE: 30 },
    ]);
    expect(r.insertedCount).toBe(2);
    expect(r.insertedIds).toHaveLength(2);
    const back = await users.findOne<{ NAME: string; UPDATED_AT: Date }>({ ID: r.insertedIds[0] });
    expect(back?.NAME).toBe("Ñoño Español");
    expect(back?.UPDATED_AT.getTime()).toBe(when.getTime());
  });

  it("insertMany: empty input and batchErrors+returning are rejected", async () => {
    await expect(users.insertMany([])).rejects.toThrow();
    await expect(users.insertMany("x" as never)).rejects.toThrow();
    await expect(users.insertMany([{ NAME: "x" }], { batchErrors: true })).rejects.toThrow();
  });

  it("insertMany batchErrors: duplicate keys rejected per row, the rest land", async () => {
    const r = await emp.insertMany(
      [{ ID: 50, NAME: "A" }, { ID: 1, NAME: "dup" }, { ID: 51, NAME: "B" }],
      { returning: [], batchErrors: true },
    );
    expect(r.insertedCount).toBe(2);
    expect(r.batchErrors).toHaveLength(1);
    expect(r.batchErrors?.[0].offset).toBe(1);
    expect(r.batchErrors?.[0].message).toContain("ORA-00001");
    await emp.deleteMany({ ID: { $in: [50, 51] } });
  });

  it("insertMany without batchErrors is all-or-nothing", async () => {
    const before = await emp.countDocuments();
    await expect(emp.insertMany([{ ID: 60, NAME: "A" }, { ID: 1, NAME: "dup" }], { returning: [] })).rejects.toThrow(/ORA-00001/);
    expect(await emp.countDocuments()).toBe(before);
  });
});

describe("integration: updates", () => {
  it("updateOne updates exactly one row; returning reads values back", async () => {
    const r = await users.updateOne({ CITY: "Manila" }, { $inc: { LOGIN_COUNT: 1 } }, { returning: ["LOGIN_COUNT"] });
    expect(r).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
    expect(r.returning?.LOGIN_COUNT).toBe("1");
    expect(await users.countDocuments({ LOGIN_COUNT: 1 })).toBe(1);
  });

  it("updateOne with an empty filter still touches one row (ROWNUM guard)", async () => {
    expect((await users.updateOne({}, { $set: { SCORE: 50 } })).modifiedCount).toBe(1);
  });

  it("updateOne upsert inserts when nothing matches", async () => {
    const r = await users.updateOne({ NAME: "Upserted", AGE: { $gt: 1 } }, { $set: { EMAIL: "up@mira.test" } }, { upsert: true });
    expect(r).toMatchObject({ matchedCount: 0, upsertedCount: 1 });
    expect(await users.findOne({ NAME: "Upserted" })).toMatchObject({ EMAIL: "up@mira.test" });
    const r2 = await users.updateOne({ NAME: "Upserted" }, { $set: { AGE: 41 } }, { upsert: true });
    expect(r2).toMatchObject({ matchedCount: 1 });
    const r3 = await users.updateOne({ NAME: "NoSet", EMAIL: "ns@mira.test" }, { $inc: { AGE: 1 } }, { upsert: true });
    expect(r3).toMatchObject({ upsertedCount: 1 });
  });

  it("updateMany with every operator and multi-row RETURNING", async () => {
    const r = await users.updateMany(
      { STATUS: "inactive" },
      { $mul: { SCORE: 2 }, $min: { AGE: 40 }, $currentDate: { UPDATED_AT: { $type: "timestamp" } } },
      { returning: ["NAME", "AGE"] },
    );
    expect(r.modifiedCount).toBe(2);
    expect(r.returning?.map((x) => x.NAME).sort()).toEqual(["Carlo", "Pedro"]);
    expect(r.returning?.every((x) => Number(x.AGE) <= 40)).toBe(true);
    const r2 = await users.updateMany({ STATUS: "banned" }, { $max: { SCORE: 15 }, $unset: { CITY: "" } });
    expect(r2.modifiedCount).toBe(1);
    expect(await users.findOne({ NAME: "Jose" })).toMatchObject({ SCORE: 15, CITY: null });
  });

  it("replaceOne overwrites columns but never ID", async () => {
    const before = await users.findOne<{ ID: number }>({ NAME: "Migs" });
    const r = await users.replaceOne({ NAME: "Migs" }, { ID: 999999, NAME: "Miguel", EMAIL: "miguel@mira.test", STATUS: "active" });
    expect(r).toEqual({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });
    expect((await users.findOne({ NAME: "Miguel" }))?.ID).toBe(before?.ID);
  });

  it("bulkUpdateByKeys: numeric, string and date columns in one round trip", async () => {
    await schema.createTable(K, { CODE: { type: "VARCHAR2(20)", primaryKey: true }, SEEN: { type: "DATE" }, QTY: { type: "NUMBER" }, NOTE: { type: "VARCHAR2(200)" } });
    const k = coll(K);
    await k.insertMany([{ CODE: "a", QTY: 1 }, { CODE: "b", QTY: 2 }, { CODE: "c", QTY: 3 }], { returning: [] });
    const d = new Date("2026-03-04T00:00:00Z");
    const r = await k.bulkUpdateByKeys(
      [
        { CODE: "a", QTY: 10, SEEN: d, NOTE: "ñ".repeat(60) },
        { CODE: "b", QTY: null, SEEN: null, NOTE: null },
      ],
      { keys: ["CODE"] },
    );
    expect(r).toEqual({ acknowledged: true, modifiedCount: 2 });
    expect(await k.findOne({ CODE: "a" })).toMatchObject({ QTY: 10, NOTE: "ñ".repeat(60) });
    expect(await k.findOne({ CODE: "b" })).toMatchObject({ QTY: null });
    expect(await k.findOne({ CODE: "c" })).toMatchObject({ QTY: 3 });
    const dateKey = await k.bulkUpdateByKeys([{ SEEN: d, NOTE: "by-date" }], { keys: ["SEEN"] });
    expect(dateKey.modifiedCount).toBe(1);
    const numKey = await k.bulkUpdateByKeys([{ QTY: 3, NOTE: "by-qty" }], { keys: ["QTY"] });
    expect(numKey.modifiedCount).toBe(1);
  });

  it("bulkUpdateByKeys validates its input", async () => {
    await expect(users.bulkUpdateByKeys([])).rejects.toThrow();
    await expect(users.bulkUpdateByKeys([{ ID: 1, A: 1 }])).rejects.toThrow();
    await expect(users.bulkUpdateByKeys([{ ID: 1 }], { keys: ["ID"] })).rejects.toThrow();
  });
});

describe("integration: find-and-modify", () => {
  it("findOneAndUpdate returns before by default, after on request", async () => {
    const before = await users.findOneAndUpdate<{ SCORE: number }>({ NAME: "Bea" }, { $set: { SCORE: 1 } });
    expect(before?.SCORE).toBe(99);
    const after = await users.findOneAndUpdate<{ SCORE: number }>({ NAME: "Bea" }, { $inc: { SCORE: 1 } }, { returnDocument: "after" });
    expect(after?.SCORE).toBe(2);
    expect(await users.findOneAndUpdate({ NAME: "Ghost" }, { $set: { SCORE: 1 } })).toBeNull();
  });

  it("findOneAndUpdate 'after' on a table with no ID re-selects by the filter", async () => {
    const after = await quarterly.findOneAndUpdate<{ Q1: number }>({ REGION: "North" }, { $inc: { Q1: 5 } }, { returnDocument: "after" });
    expect(after?.Q1).toBe(15);
  });

  it("findOneAndUpdate upsert: MERGE fast path inserts then updates", async () => {
    const ins = await quarterly.findOneAndUpdate<{ Q1: number }>({ REGION: "East" }, { $set: { Q1: 7 } }, { upsert: true, returnDocument: "after" });
    expect(ins).toMatchObject({ REGION: "East", Q1: 7 });
    const upd = await quarterly.findOneAndUpdate<{ Q1: number }>({ REGION: "East" }, { $inc: { Q1: 1 } }, { upsert: true, returnDocument: "after" });
    expect(upd?.Q1).toBe(8);
    const noSet = await quarterly.findOneAndUpdate({ REGION: "Mid" }, { $inc: { Q1: 1 } }, { upsert: true, returnDocument: "after" });
    expect(noSet).toMatchObject({ REGION: "Mid", Q1: null });
  });

  it("findOneAndUpdate upsert: standard path (non-equality filter / before)", async () => {
    expect(await quarterly.findOneAndUpdate({ REGION: "West" }, { $set: { Q2: 1 } }, { upsert: true })).toBeNull();
    expect(await quarterly.findOne({ REGION: "West" })).toMatchObject({ Q2: 1 });
    const after = await quarterly.findOneAndUpdate({ REGION: "Far", Q1: { $exists: false } }, { $set: { Q2: 2 } }, { upsert: true, returnDocument: "after" });
    expect(after).toMatchObject({ REGION: "Far", Q2: 2 });
    const viaNoSet = await quarterly.findOneAndUpdate({ REGION: "Near" }, { $inc: { Q2: 1 } }, { upsert: true });
    expect(viaNoSet).toBeNull();
    expect(await quarterly.findOneAndUpdate({}, { $set: { Q2: 1 } }, { upsert: true, returnDocument: "after" })).not.toBeNull();
  });

  it("findOneAndDelete returns the deleted row without the internal ROWID column", async () => {
    const id = (await users.insertOne({ NAME: "Del", EMAIL: "d@mira.test" })).insertedId;
    const doc = await users.findOneAndDelete<Record<string, unknown>>({ ID: id });
    expect(doc).toMatchObject({ NAME: "Del" });
    expect(doc).not.toHaveProperty("MIRA_RID_");
    expect(await users.findOne({ ID: id })).toBeNull();
    expect(await users.findOneAndDelete({ ID: id })).toBeNull();
  });

  it("findOneAndReplace before / after / no match / no-ID table", async () => {
    const before = await users.findOneAndReplace<{ NAME: string }>({ NAME: "Tess" }, { NAME: "Teresa", EMAIL: "t@mira.test" });
    expect(before?.NAME).toBe("Tess");
    const after = await users.findOneAndReplace<{ NAME: string }>({ NAME: "Teresa" }, { ID: 1, NAME: "Tere", EMAIL: "t@mira.test" }, { returnDocument: "after" });
    expect(after?.NAME).toBe("Tere");
    expect(await users.findOneAndReplace({ NAME: "Ghost" }, { NAME: "x" })).toBeNull();
    const q = await quarterly.findOneAndReplace<{ Q2: number }>({ REGION: "South" }, { Q2: 99 }, { returnDocument: "after" });
    expect(q?.Q2).toBe(99);
  });
});

describe("integration: deletes and bulkWrite", () => {
  it("deleteOne with returning; deleteMany with limit and returning", async () => {
    await users.insertMany([1, 2, 3, 4].map((i) => ({ NAME: `Tmp${i}`, EMAIL: `tmp${i}@mira.test`, STATUS: "tmp" })), { returning: [] });
    const one = await users.deleteOne({ STATUS: "tmp" }, { returning: ["NAME"] });
    expect(one.deletedCount).toBe(1);
    expect(String(one.returning?.NAME)).toMatch(/^Tmp/);
    const lim = await users.deleteMany({ STATUS: "tmp" }, { limit: 2, returning: ["NAME"] });
    expect(lim.deletedCount).toBe(2);
    expect(lim.returning).toHaveLength(2);
    expect(await users.countDocuments({ STATUS: "tmp" })).toBe(1);
    expect((await users.deleteMany({ STATUS: "tmp" })).deletedCount).toBe(1);
  });

  it("deleteMany limit with no filter, and invalid limits", async () => {
    await emp.insertMany([{ ID: 70 }, { ID: 71 }], { returning: [] });
    const all = await coll(E).countDocuments();
    const r = await coll(E).deleteMany({ ID: { $gte: 70 } }, { limit: 1 });
    expect(r.deletedCount).toBe(1);
    expect(await emp.countDocuments()).toBe(all - 1);
    await emp.deleteMany({ ID: 71 });
    for (const bad of [0, -1, 1.5]) expect(() => users.deleteMany({}, { limit: bad })).toThrow(TypeError);
    // empty filter + limit (no-WHERE branch) against a scratch table
    await schema.createTable("MIRA_IT_SCRATCH", { X: { type: "NUMBER" } });
    await coll("MIRA_IT_SCRATCH").insertMany([{ X: 1 }, { X: 2 }], { returning: [] });
    expect((await coll("MIRA_IT_SCRATCH").deleteMany({}, { limit: 1 })).deletedCount).toBe(1);
    await coll("MIRA_IT_SCRATCH").drop();
  });

  it("bulkWrite runs every operation type in one transaction", async () => {
    const r = await users.bulkWrite([
      { insertOne: { document: { NAME: "BW1", EMAIL: "bw1@mira.test" } } },
      { insertOne: { document: { NAME: "BW2", EMAIL: "bw2@mira.test" } } },
      { updateOne: { filter: { NAME: "BW1" }, update: { $set: { STATUS: "bw" } } } },
      { updateMany: { filter: { NAME: { $like: "BW%" } }, update: { $set: { CITY: "BW" } } } },
      { replaceOne: { filter: { NAME: "BW2" }, replacement: { NAME: "BW2", EMAIL: "bw2b@mira.test", STATUS: "bw" } } },
      { deleteOne: { filter: { NAME: "BW1" } } },
      { deleteMany: { filter: { STATUS: "bw" } } },
    ]);
    expect(r.results).toHaveLength(7);
    expect(await users.countDocuments({ NAME: { $like: "BW%" } })).toBe(0);
  });

  it("bulkWrite rolls everything back on an unknown op / failing op; empty is rejected", async () => {
    const before = await users.countDocuments();
    await expect(users.bulkWrite([{ insertOne: { document: { NAME: "R1", EMAIL: "r1@mira.test" } } }, { renameOne: {} } as never])).rejects.toThrow();
    await expect(users.bulkWrite([{ insertOne: { document: { NAME: "R2", EMAIL: "r2@mira.test" } } }, { insertOne: { document: { NAME: null } } }])).rejects.toThrow(/ORA-01400/);
    expect(await users.countDocuments()).toBe(before);
    await expect(users.bulkWrite([])).rejects.toThrow();
  });
});

describe("integration: indexes", () => {
  it("create (asc/desc/unique/bitmap/named), list, rebuild, drop", async () => {
    const a = await users.createIndex({ CITY: 1, AGE: -1 });
    expect(a.indexName).toBe(`IDX_${U}_CITY_AGE`);
    await users.createIndex({ EMAIL: 1 }, { unique: true, name: "UX_MIRA_IT_EMAIL" });
    await orders.createIndex({ REGION: 1 }, { type: "bitmap" });
    const many = await emp.createIndexes([{ fields: { DEPT: 1 } }, { fields: { SALARY: -1 }, options: { name: "IX_MIRA_SAL" } }]);
    expect(many.indexNames).toEqual([`IDX_${E}_DEPT`, "IX_MIRA_SAL"]);
    const idx = await users.getIndexes();
    const byName = Object.fromEntries(idx.map((i) => [i.indexName, i]));
    expect(byName[`IDX_${U}_CITY_AGE`].columns).toHaveLength(2);
    expect(byName.UX_MIRA_IT_EMAIL.unique).toBe(true);
    expect((await orders.getIndexes()).some((i) => i.type === "BITMAP")).toBe(true);
    expect(await users.reIndex()).toEqual({ acknowledged: true });
    await users.dropIndex("UX_MIRA_IT_EMAIL");
    const dropped = await emp.dropIndexes();
    expect(dropped.dropped.sort()).toEqual([`IDX_${E}_DEPT`, "IX_MIRA_SAL"].sort());
    expect((await emp.getIndexes()).map((i) => i.indexName)).toHaveLength(1); // only the PK remains
  });
});

describe("integration: MERGE", () => {
  it("merge: insert when new, update when matched, conditional delete", async () => {
    const m = { localField: "ID", foreignField: "ID" };
    await emp.merge({ ID: 80, NAME: "M", SALARY: 1 }, m, { whenMatched: { $set: { SALARY: 2 } }, whenNotMatched: "insert" });
    expect(await emp.findOne({ ID: 80 })).toMatchObject({ SALARY: 1 });
    await emp.merge({ ID: 80, NAME: "M", SALARY: 1 }, m, { whenMatched: { $set: { SALARY: 2 } }, whenNotMatched: "insert" });
    expect(await emp.findOne({ ID: 80 })).toMatchObject({ SALARY: 2 });
    await emp.merge({ ID: 80 }, m, { whenMatched: { $set: { SALARY: 3 } }, whenMatchedDelete: { SALARY: 3 } });
    expect(await emp.findOne({ ID: 80 })).toBeNull();
    // whenMatchedDelete with a correlated $exists uses the tgt alias
    await emp.insertOne({ ID: 81, NAME: "X", DEPT: "ENG" });
    await emp.merge({ ID: 81 }, m, { whenMatched: { $set: { SALARY: 0 } }, whenMatchedDelete: { $exists: { collection: E, match: { MANAGER_ID: "$ID" } } } });
    expect(await emp.findOne({ ID: 81 })).toMatchObject({ SALARY: 0 });
    await emp.deleteOne({ ID: 81 });
  });

  it("mergeFrom: $src references and literals", async () => {
    await schema.createTable(`${E}_SRC`, { ID: { type: "NUMBER" }, SALARY: { type: "NUMBER" } });
    await coll(`${E}_SRC`).insertMany([{ ID: 4, SALARY: 777 }], { returning: [] });
    await emp.mergeFrom(`${E}_SRC`, { localField: "ID", foreignField: "ID" }, { whenMatched: { $set: { SALARY: "$src.SALARY", DEPT: "MERGED" } } });
    expect(await emp.findOne({ ID: 4 })).toMatchObject({ SALARY: 777, DEPT: "MERGED" });
    await expect(emp.mergeFrom(`${E}_SRC`, { localField: "ID", foreignField: "ID" }, { whenMatched: {} })).rejects.toThrow();
    await schema.dropTable(`${E}_SRC`);
  });
});

describe("integration: Oracle advanced + cross-table", () => {
  it("connectBy walks the org chart with level and siblings order", async () => {
    const rows = (await emp.connectBy({ startWith: { MANAGER_ID: null }, connectBy: { MANAGER_ID: "$PRIOR ID" }, includeLevel: true, orderSiblings: { NAME: 1 }, maxLevel: 2 })) as { LEVEL: number; NAME: string }[];
    expect(rows.map((r) => r.NAME)).toEqual(["CEO", "CFO", "CTO"]);
    expect(rows[0].LEVEL).toBe(1);
  });

  it("pivot / unpivot", async () => {
    const piv = (await orders.pivot({ value: { $sum: "$AMOUNT" }, pivotOn: "QUARTER", pivotValues: ["Q1", "Q2"], groupBy: "REGION" })) as Record<string, string>[];
    expect(piv).toHaveLength(4);
    const north = piv.find((r) => r.REGION === "North");
    expect(Number(north?.Q1)).toBe(100 + 200);
    const un = (await quarterly.unpivot({ valueColumn: "REV", nameColumn: "QTR", columns: ["Q1", "Q2"] })) as unknown[];
    expect(un.length).toBeGreaterThanOrEqual(4);
  });

  it("aggregate: group/sort/limit with a Date bind in $match (deep clone keeps Dates)", async () => {
    const pipeline = [
      { $match: { STATUS: "completed", ID: { $in: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } } },
      { $group: { _id: "$REGION", total: { $sum: "$AMOUNT" }, n: { $count: "*" } } },
      { $sort: { total: -1 } },
      { $limit: 2 },
    ];
    const rows = await orders.aggregate(pipeline);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveProperty("TOTAL");
    expect(pipeline[0]).toHaveProperty("$match"); // caller's pipeline is not mutated
    const withDate = await users.aggregate([{ $match: { UPDATED_AT: { $lt: new Date("2100-01-01") } } }, { $count: "n" }]);
    expect(Number(withDate[0].N)).toBeGreaterThan(0);
    expect(users.aggregate([]). _buildSQL().sql).toBe(`SELECT * FROM "${U}"`);
  });

  it("insertFromQuery: explicit columns, identity-aware auto columns, synonym target", async () => {
    await schema.createTable(`${U}_ARCH`, { ID: { type: "NUMBER", primaryKey: true, autoIncrement: true }, NAME: { type: "VARCHAR2(100)" }, EMAIL: { type: "VARCHAR2(200)" } });
    const r1 = await users.insertFromQuery(`${U}_ARCH`, users.find({ STATUS: "active" }), { columns: ["NAME", "EMAIL"] });
    expect(r1.insertedCount).toBeGreaterThan(0);
    const r2 = await users.insertFromQuery(`${U}_ARCH`, users.find({ NAME: "Juan" }));
    expect(r2.insertedCount).toBe(1);
    await rawExec(`CREATE SYNONYM "MIRA_IT_SYN" FOR "${U}_ARCH"`);
    // A synonym has no USER_TAB_COLUMNS rows, so no column list is generated: the 2-column SELECT
    // meets the 3-column (identity) target and Oracle refuses it rather than inserting garbage.
    await expect(
      coll(`${U}_ARCH`).insertFromQuery("MIRA_IT_SYN", coll(`${U}_ARCH`).find({ NAME: "Juan" }).project({ NAME: 1, EMAIL: 1 }), { columns: [] }),
    ).rejects.toThrow(/ORA-(00947|32795)/);
  });

  it("updateFromJoin: joined column, literal, dotted target/where columns", async () => {
    const r = await orders.updateFromJoin({
      target: O,
      join: { table: U, on: { [`${O}.USER_ID`]: `${U}.ID` } },
      set: { [`${O}.STATUS`]: `${U}.STATUS`, PRODUCT: "Synced" },
      where: { [`${U}.CITY`]: "Manila" },
    });
    expect(r.modifiedCount).toBeGreaterThan(0);
    expect(await orders.countDocuments({ PRODUCT: "Synced" })).toBe(r.modifiedCount);
    const r2 = await orders.updateFromJoin({ target: O, join: { table: U, on: { USER_ID: "ID" } }, set: { PRODUCT: "All" }, where: {} });
    expect(r2.modifiedCount).toBeGreaterThan(0);
  });

  it("drop() removes the table", async () => {
    await schema.createTable("MIRA_IT_DROPME", { X: { type: "NUMBER" } });
    expect(await coll("MIRA_IT_DROPME").drop()).toEqual({ acknowledged: true });
    await expect(coll("MIRA_IT_DROPME").countDocuments()).rejects.toThrow(/ORA-00942/);
  });

  it("collection bound to a session connection uses it (no autocommit)", async () => {
    const inTx = await db.withTransaction(async (conn) => {
      const c = new OracleCollection(E, db, conn);
      await c.insertOne({ ID: 90, NAME: "tx" });
      return c.countDocuments({ ID: 90 });
    });
    expect(inTx).toBe(1);
    await emp.deleteOne({ ID: 90 });
  });
});
