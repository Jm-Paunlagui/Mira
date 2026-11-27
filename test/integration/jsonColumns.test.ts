/**
 * INTEGRATION — JSON columns (Mira 2.1) against the live schema: t.json(), paths
 * in filters and updates, $elemMatch, $push / $pull, $jsonTable, include() and
 * the generator. Expected values come from the documents written here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineTable, t, relations, hasMany, generateTableTypes, OracleCollection, type TypedTable } from "../../src";
import { db, coll, dropIfExists, rawExec } from "../helpers/db";
import type { DbConnection } from "../../src/driver/db";

type Doc = { city: string; total: number; vip?: boolean; at?: string; tags: Array<string | number>; items: Array<{ sku: string; qty: number }>; addr?: { zip: number } };
const P = "MIRA_JS_PEOPLE";
const D = "MIRA_JS_DOCS";
const People = defineTable(P, { ID: t.id(), NAME: t.text(20) });
const Docs = defineTable(D, { ID: t.number().primaryKey(), PERSON_ID: t.number().nullable(), DOC: t.json<Doc>(), EXTRA: t.json<unknown>().nullable() });
const PeopleR = relations(People, { docs: hasMany(Docs, { foreignKey: "PERSON_ID" }) });
const docs = Docs.on(db);

const DOCS: Array<{ ID: number; PERSON_ID: number | null; DOC: Doc; EXTRA?: unknown }> = [
  { ID: 1, PERSON_ID: 1, DOC: { city: "Cebu", total: 150, vip: true, at: "2026-05-06T07:08:09.000Z", tags: ["a", "b", 2], items: [{ sku: "X", qty: 2 }, { sku: "Y", qty: 9 }] }, EXTRA: [1, { deep: true }] },
  { ID: 2, PERSON_ID: 1, DOC: { city: "Davao", total: 50, vip: false, tags: [], items: [{ sku: "X", qty: 1 }] }, EXTRA: null },
  { ID: 3, PERSON_ID: null, DOC: { city: "Iloilo", total: 75.5, tags: ["b"], items: [] } },
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-tt-json-"));
const srcIndex = path.resolve(import.meta.dir, "../../src/index.ts").replace(/\\/g, "/");
const ids = async (filter: object) => (await docs.find(filter as never).sort({ ID: 1 }).project({ ID: 1 }).toArray()).map((r) => r.ID);

async function reset() {
  await dropIfExists(D, P);
  await People.create(db);
  await Docs.create(db);
  await People.on(db).insertOne({ NAME: "Ana" });
  await docs.insertMany(DOCS);
}
beforeAll(reset);
afterAll(async () => {
  await dropIfExists(D, P);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("JSON columns: storage and reads", () => {
  it("t.json() is a CLOB with an IS JSON check; the check refuses text that is not JSON", async () => {
    expect(Docs.ddl().DOC).toEqual({ type: "CLOB", notNull: true, check: '"DOC" IS JSON' });
    expect(defineTable("X", { J: t.json().check("LENGTH(J) < 100") }).ddl().J.check).toBe('("J" IS JSON) AND (LENGTH(J) < 100)');
    await expect(rawExec(`INSERT INTO "${D}" ("ID", "DOC") VALUES (9, 'not json')`)).rejects.toThrow(/ORA-02290/);
  });

  it("a typed table writes and reads JS values: find, findOne, next, forEach, await", async () => {
    const all = await docs.find({}).sort({ ID: 1 }).toArray();
    expect(all.map((r) => [r.ID, r.DOC, r.EXTRA])).toEqual(DOCS.map((d) => [d.ID, d.DOC, d.EXTRA ?? null]));
    expect((await docs.findOne({ ID: 1 }))?.DOC.items[1]).toEqual({ sku: "Y", qty: 9 });
    expect((await docs.find({ ID: 3 }).next())?.DOC.total).toBe(75.5);
    const seen: string[] = [];
    await docs.find({}).forEach((r) => void seen.push(r.DOC.city));
    expect(seen.sort()).toEqual(["Cebu", "Davao", "Iloilo"]);
    expect((await docs.find({ ID: 2 }))[0].DOC.vip).toBe(false);
  });

  it("the untyped API is unchanged: JSON columns come back as the stored text", async () => {
    const row = await new OracleCollection(D, db).findOne<{ DOC: string }>({ ID: 2 });
    expect(typeof row?.DOC).toBe("string");
    expect(JSON.parse(row!.DOC)).toEqual(DOCS[1].DOC);
    expect(typeof (await docs.untyped.find({ ID: 2 }).toArray())[0].DOC).toBe("object"); // same collection object, so still decoded
  });

  it("include(): a related row's JSON column arrives as a document", async () => {
    const [ana] = await PeopleR.on(db).find().include("docs", { sort: { ID: 1 } }).toArray();
    expect(ana.docs.map((d) => [d.ID, d.DOC.city, d.EXTRA])).toEqual([[1, "Cebu", [1, { deep: true }]], [2, "Davao", null]]);
  });
});

describe("JSON columns: filters on paths", () => {
  it("equality, numbers, booleans, dates, null, $exists, array index", async () => {
    expect(await ids({ "DOC.city": "Cebu" })).toEqual([1]);
    expect(await ids({ "DOC.total": { $gt: 60 } })).toEqual([1, 3]);
    expect(await ids({ "DOC.total": { $gte: 50, $lt: 100 } })).toEqual([2, 3]);
    expect(await ids({ "DOC.total": { $between: [70, 160] } })).toEqual([1, 3]);
    expect(await ids({ "DOC.city": { $in: ["Davao", "Iloilo"] } })).toEqual([2, 3]);
    expect(await ids({ "DOC.city": { $nin: ["Davao"] } })).toEqual([1, 3]);
    expect(await ids({ "DOC.city": { $ne: "Cebu" } })).toEqual([2, 3]);
    expect(await ids({ "DOC.vip": true })).toEqual([1]);
    expect(await ids({ "DOC.vip": false })).toEqual([2]);
    expect(await ids({ "DOC.vip": null })).toEqual([3]);
    expect(await ids({ "DOC.vip": { $eq: null } })).toEqual([3]);
    expect(await ids({ "DOC.vip": { $ne: null } })).toEqual([1, 2]);
    expect(await ids({ "DOC.at": { $exists: true } })).toEqual([1]);
    expect(await ids({ "DOC.at": { $exists: false } })).toEqual([2, 3]);
    expect(await ids({ "DOC.at": { $lt: new Date("2026-06-01T00:00:00Z") } })).toEqual([1]);
    expect(await ids({ "DOC.items.1.sku": "Y" })).toEqual([1]);
    expect(await ids({ "DOC.city": "Cebu", ID: { $gt: 0 }, $or: [{ "DOC.total": 50 }, { "DOC.vip": true }] })).toEqual([1]);
  });

  it("$elemMatch: element fields, operators, scalars, $in / $nin / $exists, booleans and null", async () => {
    expect(await ids({ "DOC.items": { $elemMatch: { sku: "X", qty: { $gt: 1 } } } })).toEqual([1]);
    expect(await ids({ "DOC.items": { $elemMatch: { sku: "X" } } })).toEqual([1, 2]);
    expect(await ids({ "DOC.items": { $elemMatch: { qty: { $gte: 2, $lte: 9 }, sku: { $in: ["Y", "Z"] } } } })).toEqual([1]);
    expect(await ids({ "DOC.items": { $elemMatch: { sku: { $nin: ["X"] } } } })).toEqual([1]);
    expect(await ids({ "DOC.items": { $elemMatch: { qty: { $exists: true }, sku: { $ne: "Q" } } } })).toEqual([1, 2]);
    expect(await ids({ "DOC.items": { $elemMatch: { missing: { $exists: false } } } })).toEqual([1, 2]);
    expect(await ids({ "DOC.tags": { $elemMatch: { $eq: "b" } } })).toEqual([1, 3]);
    expect(await ids({ "DOC.tags": { $elemMatch: { $gt: 1 } } })).toEqual([1]);
    expect(await ids({ EXTRA: { $elemMatch: { deep: true } } })).toEqual([1]);
    expect(await ids({ EXTRA: { $elemMatch: { deep: null } } })).toEqual([]);
    expect(await ids({ "DOC.items": { $elemMatch: { sku: new Date(0) } } })).toEqual([]);
  });

  it("refuses what a path cannot do", async () => {
    await expect(docs.find({ "DOC.city": { $regex: "C" } } as never).toArray()).rejects.toThrow(/\$regex is not supported on a JSON path/);
    await expect(docs.find({ "DOC.items": { sku: "X" } } as never).toArray()).rejects.toThrow(/compare a path with a scalar value/);
    await expect(docs.find({ "DOC.bad-key": 1 } as never).toArray()).rejects.toThrow(/each part after the column/);
    await expect(docs.find({ ".x": 1 } as never).toArray()).rejects.toThrow(/no column before the first dot/);
    await expect(docs.find({ "DOC.city": { $in: [] } } as never).toArray()).rejects.toThrow(/\$in needs a non-empty list/);
    await expect(docs.find({ "DOC.total": { $between: [1] } } as never).toArray()).rejects.toThrow(/\$between needs \[low, high\]/);
    await expect(docs.find({ "DOC.items": { $elemMatch: {} } } as never).toArray()).rejects.toThrow(/\$elemMatch needs an object/);
    await expect(docs.find({ "DOC.items": { $elemMatch: { a: { b: 1 } } } } as never).toArray()).rejects.toThrow(/needs dotted names/);
    await expect(docs.find({ "DOC.items": { $elemMatch: { "a-b": 1 } } } as never).toArray()).rejects.toThrow(/must be names or indexes/);
    await expect(docs.find({ "DOC.items": { $elemMatch: { sku: { $regex: "X" } } } } as never).toArray()).rejects.toThrow(/\$regex is not supported in \$elemMatch/);
    await expect(docs.find({ "DOC.items": { $elemMatch: { sku: { $in: [] } } } } as never).toArray()).rejects.toThrow(/\$in needs a non-empty list/);
    await expect(docs.find({ "DOC.items": { $elemMatch: { sku: [1] } } } as never).toArray()).rejects.toThrow(/needs dotted names/);
    await expect(docs.find({ "DOC.items": { $elemMatch: { sku: { $eq: {} } } } } as never).toArray()).rejects.toThrow(/compares with strings, numbers/);
  });
});

describe("JSON columns: updates", () => {
  beforeEach(reset);

  it("$set and $unset on paths are one merge patch; missing objects are created", async () => {
    await docs.updateOne({ ID: 1 }, { $set: { "DOC.city": "Bohol", "DOC.addr.zip": 6300, "DOC.at": new Date("2026-01-02T00:00:00Z") }, $unset: { "DOC.vip": 1 } });
    const d = (await docs.findOne({ ID: 1 }))!.DOC;
    expect([d.city, d.addr, d.at, "vip" in d, d.total]).toEqual(["Bohol", { zip: 6300 }, "2026-01-02T00:00:00.000Z", false, 150]);
  });

  it("$push (a value or $each) and $pull (a value or $in) rebuild the array; a missing array is created", async () => {
    await docs.updateOne({ ID: 1 }, { $push: { "DOC.tags": { $each: ["c", { z: 1 }] }, "DOC.new.list": 1 }, $pull: { "DOC.items": "nothing" } });
    await docs.updateMany({ ID: { $in: [1, 3] } }, { $pull: { "DOC.tags": { $in: ["b", 2] } } });
    const rows = await docs.find({}).sort({ ID: 1 }).toArray();
    expect(rows[0].DOC.tags).toEqual(["a", "c", { z: 1 }]);
    expect((rows[0].DOC as Doc & { new: unknown }).new).toEqual({ list: [1] });
    expect(rows[0].DOC.items).toEqual(DOCS[0].DOC.items);
    expect(rows[2].DOC.tags).toEqual([]); // every element pulled: [] stays (not a deleted key)
    await docs.updateOne({ ID: 2 }, { $push: { "DOC.tags": "x".repeat(5000) } });
    expect(((await docs.findOne({ ID: 2 }))!.DOC.tags[0] as string).length).toBe(5000);
  });

  it("a whole-column $set is written as JSON; it also works next to plain columns", async () => {
    await docs.updateOne({ ID: 3 }, { $set: { DOC: { city: "Leyte", total: 1, tags: [], items: [] }, EXTRA: { k: [true] }, PERSON_ID: 1 } });
    const r = await docs.findOne({ ID: 3 });
    expect([r?.DOC.city, r?.EXTRA, r?.PERSON_ID]).toEqual(["Leyte", { k: [true] }, 1]);
    await docs.replaceOne({ ID: 3 }, { ID: 3, DOC: { city: "Samar", total: 2, tags: ["r"], items: [] } });
    expect((await docs.findOne({ ID: 3 }))?.DOC.city).toBe("Samar");
  });

  it("$push / $pull on a JSON column that holds an array (no path)", async () => {
    await rawExec(`UPDATE "${D}" SET "EXTRA" = '[1, "x"]' WHERE "ID" = 2`);
    await docs.updateOne({ ID: 2 }, { $push: { EXTRA: 2 } } as never);
    expect((await docs.findOne({ ID: 2 }))?.EXTRA).toEqual([1, "x", 2]);
    await docs.updateOne({ ID: 2 }, { $pull: { EXTRA: "x" } } as never);
    expect((await docs.findOne({ ID: 2 }))?.EXTRA).toEqual([1, 2]);
    await expect(docs.updateOne({ ID: 2 }, { $push: { "EXTRA.": 3 } } as never)).rejects.toThrow(/each part after the column/);
  });

  it("refuses updates a merge patch cannot express", async () => {
    await expect(docs.updateOne({ ID: 1 }, { $set: { "DOC.city": null } } as never)).rejects.toThrow(/would delete the key.*use \$unset/);
    await expect(docs.updateOne({ ID: 1 }, { $set: { "DOC.items.0.qty": 1 } } as never)).rejects.toThrow(/cannot go through an array index/);
    await expect(docs.updateOne({ ID: 1 }, { $set: { "DOC.a": 1 }, $unset: { "DOC.a": 1 } } as never)).rejects.toThrow(/DOC.a is updated twice/);
    await expect(docs.updateOne({ ID: 1 }, { $set: { "DOC.a": 1, "DOC.a.b": 2 } } as never)).rejects.toThrow(/overlaps another update/);
    await expect(docs.updateOne({ ID: 1 }, { $set: { DOC: { city: "x" } as never, "DOC.total": 1 } } as never)).rejects.toThrow(/set as a whole and by path/);
    await expect(docs.updateOne({ ID: 1 }, { $push: { "DOC.items.0": 1 } } as never)).rejects.toThrow(/need a path of names/);
    await expect(docs.updateOne({ ID: 1 }, { $push: { "DOC.tags": { $each: [] } } } as never)).rejects.toThrow(/\$each\b.*non-empty/);
    await expect(docs.updateOne({ ID: 1 }, { $pull: { "DOC.tags": { $in: [] } } } as never)).rejects.toThrow(/\$in\b.*non-empty/);
    await expect(docs.updateOne({ ID: 1 }, { $pull: { "DOC.items": { sku: "X" } } } as never)).rejects.toThrow(/removes strings, numbers, booleans or null/);
    await expect(docs.updateOne({ ID: 1 }, { $push: { "DOC.tags": 1 }, $pull: { "DOC.tags": 2 } } as never)).rejects.toThrow(/DOC.tags is updated twice/);
  });
});

describe("JSON columns: $jsonTable", () => {
  beforeAll(reset);

  it("one row per array element, with typed columns and ordinality", async () => {
    const rows = await docs.aggregate([
      { $jsonTable: { column: "DOC", path: "items", ordinality: "N", columns: { SKU: "sku", QTY: { path: "qty", type: "NUMBER" } } } },
      { $project: { ID: 1, N: 1, SKU: 1, QTY: 1 } },
      { $sort: { ID: 1, N: 1 } },
    ]);
    expect(rows.map((r) => [r.ID, r.N, r.SKU, r.QTY])).toEqual([[1, 1, "X", 2], [1, 2, "Y", 9], [2, 1, "X", 1]]);
  });

  it("outer keeps rows with no elements; nested arrays, scalars, JSON and DATE columns; then $group", async () => {
    const outer = await docs.aggregate([{ $jsonTable: { column: "DOC", path: "items", outer: true, columns: { SKU: "sku" } } }, { $project: { ID: 1, SKU: 1 } }, { $sort: { ID: 1, SKU: 1 } }]);
    expect(outer.map((r) => [r.ID, r.SKU])).toEqual([[1, "X"], [1, "Y"], [2, "X"], [3, null]]);
    const tags = await docs.aggregate([{ $jsonTable: { column: "DOC", path: "tags", ordinality: "N", columns: { TAG: "$" } } }, { $project: { ID: 1, N: 1, TAG: 1 } }, { $sort: { ID: 1, N: 1 } }]);
    expect(tags.map((r) => [r.ID, r.TAG])).toEqual([[1, "a"], [1, "b"], [1, "2"], [3, "b"]]); // "$" = the element itself
    const scalars = await docs.aggregate([{ $jsonTable: { column: "EXTRA", columns: { V: { path: "deep", type: "VARCHAR2(5)" }, J: { path: "deep", type: "JSON" } } } }, { $match: { V: "true" } }]);
    expect(scalars.map((r) => [r.ID, r.V])).toEqual([[1, "true"]]);
    const dated = await docs.aggregate([{ $jsonTable: { column: "DOC", path: "items", columns: { SKU: "sku" } } }, { $group: { _id: "$SKU", N: { $count: "*" } } }, { $sort: { SKU: 1 } }]);
    expect(dated.map((r) => [r.SKU, Number(r.N)])).toEqual([["X", 2], ["Y", 1]]);
  });

  it("refuses a bad spec", () => {
    const agg = (spec: unknown) => docs.untyped.aggregate([{ $jsonTable: spec }]);
    expect(() => agg({ path: "items", columns: { A: "a" } })).toThrow(/column names the JSON column/);
    expect(() => agg({ column: "DOC", columns: {} })).toThrow(/columns maps each output column/);
    expect(() => agg({ column: "DOC", columns: { A: { path: "" } } })).toThrow(/A: give the path/);
    expect(() => agg({ column: "DOC", columns: { A: { path: "a", type: "VARCHAR2(10)) --" } } })).toThrow(/type must be/);
    expect(() => agg({ column: "DOC", path: "a-b", columns: { A: "a" } })).toThrow(/each part after the column/);
    expect(() => agg({ column: "DOC", columns: { A: "a" }, ordinality: "" })).toThrow(/ordinality names/);
    expect(() => agg(undefined)).toThrow(/column names the JSON column/);
  });
});

describe("JSON columns: generator and native JSON", () => {
  beforeAll(reset);

  it("generate types: CLOB IS JSON → t.json(), and the definition round-trips", async () => {
    const code = await generateTableTypes(db, { tables: [D], importFrom: srcIndex });
    expect(code).toContain("  DOC: t.json(),");
    expect(code).toContain("  EXTRA: t.json().nullable(),");
    const file = path.join(tmp, "json.ts");
    fs.writeFileSync(file, code);
    const mod = (await import(pathToFileURL(file).href)) as Record<string, TypedTable<never>>;
    expect(mod.MiraJsDocs.ddl()).toEqual(Docs.ddl());
  });

  it("t.json({ native: true }): the JSON type in Thin mode; refused up front with a 19.x Thick client or a 19c database", async () => {
    const Native = defineTable("MIRA_JS_NATIVE", { ID: t.number(), DOC: t.json<{ a: number[] }>({ native: true }) });
    expect(Native.ddl().DOC).toEqual({ type: "JSON", notNull: true });
    const client = db.oracledb.oracleClientVersion;
    if (client && client < 2100000000) {
      expect(() => Native.on(db)).toThrow(/use the native JSON type, which needs Thin mode or Oracle Client 21c\+/);
      return;
    }
    const server = await db.withConnection(async (conn: DbConnection) => conn.oracleServerVersion);
    if (server < 2100000000) {
      // Thin mode binds fine; the JSON type itself arrived in 21c, so CREATE TABLE is
      // refused before Oracle answers ORA-00902.
      expect(Native.on(db)).toBeInstanceOf(OracleCollection);
      await expect(Native.create(db)).rejects.toThrow(/MIRA_JS_NATIVE: DOC use the JSON type, which needs Oracle Database 21c or later \(this is 19\./);
      return;
    }
    await dropIfExists(Native.name);
    await Native.create(db);
    try {
      const n = Native.on(db);
      await n.insertMany([{ ID: 1, DOC: { a: [1, 2] } }, { ID: 2, DOC: { a: [] } }]);
      await n.updateOne({ ID: 1 }, { $push: { "DOC.a": 3 } });
      expect((await n.find({ "DOC.a": { $elemMatch: { $gt: 2 } } }).toArray()).map((r) => r.DOC)).toEqual([{ a: [1, 2, 3] }]);
      expect(await generateTableTypes(db, { tables: [Native.name] })).toContain("  DOC: t.json({ native: true }),");
    } finally {
      await dropIfExists(Native.name);
    }
  });
});

void coll;
