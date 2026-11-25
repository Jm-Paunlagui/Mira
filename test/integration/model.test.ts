/**
 * INTEGRATION — model conveniences on typed tables (Mira 2.1, roadmap item 7):
 *   - t.createdAt() / t.updatedAt(): stamped by Oracle on insert, updatedAt on every update
 *   - t.deletedAt(): soft delete through every wrapped method, withDeleted(), restore(),
 *     { force: true }, include() skipping deleted related rows
 *   - hooks around inserts, updates and deletes, inside a transaction too
 *   - { validate: true }: checked before any SQL
 *   - bulkWrite on a model table runs the wrapped methods
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { defineTable, t, relations, hasMany, belongsTo, Transaction, MiraValidationError, ModelCollection, OracleCollection } from "../../src/utils/oracle-mongo-wrapper";
import { db, dropIfExists, rawExec, sleep } from "../helpers/db";

const N = "MIRA_MD_NOTES";
const A = "MIRA_MD_AUTHORS";
const L = "MIRA_MD_LOG";

const Authors = defineTable(A, { ID: t.number(10).primaryKey(), NAME: t.text(40), DELETED_AT: t.deletedAt() });
const Notes = defineTable(N, {
  ID: t.number(10).primaryKey(),
  AUTHOR_ID: t.number(10),
  TITLE: t.text(40),
  BODY: t.clob().nullable(),
  CREATED_AT: t.createdAt(),
  UPDATED_AT: t.updatedAt(),
  DELETED_AT: t.deletedAt(),
});
const AuthorsR = relations(Authors, { notes: hasMany(Notes, { foreignKey: "AUTHOR_ID" }) });
const NotesR = relations(Notes, { author: belongsTo(Authors, { foreignKey: "AUTHOR_ID" }) });

// A log table the hooks write to, through ctx.collection's connection.
const Log = defineTable(L, { ID: t.id(), WHAT: t.text(200) });

const notes = Notes.on(db);
const q = async <T = Record<string, unknown>>(sql: string) => (await rawExec<T>(sql)).rows ?? [];
const ids = async (q: PromiseLike<Array<{ ID: number }>>) => (await q).map((r) => r.ID).sort((a, b) => a - b);

beforeAll(async () => {
  await dropIfExists(N, A, L);
  await Authors.create(db);
  await Notes.create(db);
  await Log.create(db);
});
afterAll(async () => {
  await dropIfExists(N, A, L);
});
beforeEach(async () => {
  await rawExec(`DELETE FROM "${N}"`);
  await rawExec(`DELETE FROM "${A}"`);
  await rawExec(`DELETE FROM "${L}"`);
  await Authors.on(db).insertMany([{ ID: 1, NAME: "Ana" }, { ID: 2, NAME: "Ben" }]);
  await notes.insertMany([
    { ID: 1, AUTHOR_ID: 1, TITLE: "one" },
    { ID: 2, AUTHOR_ID: 1, TITLE: "two" },
    { ID: 3, AUTHOR_ID: 2, TITLE: "three" },
  ]);
});

describe("model: createdAt / updatedAt", () => {
  it("DDL: TIMESTAMP WITH TIME ZONE, DEFAULT SYSTIMESTAMP, NOT NULL; deletedAt nullable", () => {
    expect(Notes.ddl().CREATED_AT).toEqual({ type: "TIMESTAMP(6) WITH TIME ZONE", default: "SYSTIMESTAMP", notNull: true });
    expect(Notes.ddl().UPDATED_AT).toEqual({ type: "TIMESTAMP(6) WITH TIME ZONE", default: "SYSTIMESTAMP", notNull: true });
    expect(Notes.ddl().DELETED_AT).toEqual({ type: "TIMESTAMP(6) WITH TIME ZONE" });
  });

  it("Oracle stamps both on insert; an update moves updatedAt only; an update that sets it keeps its value", async () => {
    const before = (await notes.findOne({ ID: 1 }))!;
    expect(before.CREATED_AT).toBeInstanceOf(Date);
    expect(Math.abs(before.CREATED_AT.getTime() - Date.now())).toBeLessThan(60_000);
    expect(before.UPDATED_AT.getTime()).toBe(before.CREATED_AT.getTime());
    expect(before.DELETED_AT).toBeNull();
    await sleep(20);
    await notes.updateOne({ ID: 1 }, { $set: { TITLE: "uno" } });
    const after = (await notes.findOne({ ID: 1 }))!;
    expect(after.CREATED_AT.getTime()).toBe(before.CREATED_AT.getTime());
    expect(after.UPDATED_AT.getTime()).toBeGreaterThan(before.UPDATED_AT.getTime());
    const fixed = new Date("2026-01-02T03:04:05.678Z");
    await notes.updateMany({ ID: { $in: [2, 3] } }, { $set: { TITLE: "x", UPDATED_AT: fixed } });
    expect((await notes.find({ ID: { $in: [2, 3] } }).toArray()).map((r) => r.UPDATED_AT.toISOString())).toEqual([fixed.toISOString(), fixed.toISOString()]);
    await notes.updateOne({ ID: 2 }, { $currentDate: { UPDATED_AT: { $type: "timestamp" } } });
    expect((await notes.findOne({ ID: 2 }))!.UPDATED_AT.getTime()).toBeGreaterThan(fixed.getTime());
  });

  it("replaceOne / findOneAndReplace go through $set: updatedAt moves, the primary key is kept", async () => {
    const t0 = (await notes.findOne({ ID: 3 }))!.UPDATED_AT.getTime();
    await sleep(20);
    expect(await notes.replaceOne({ ID: 3 }, { ID: 99, AUTHOR_ID: 2, TITLE: "replaced" })).toEqual({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });
    const r = (await notes.findOne({ ID: 3 }))!;
    expect([r.TITLE, r.UPDATED_AT.getTime() > t0]).toEqual(["replaced", true]);
    const out = await notes.untyped.findOneAndReplace<{ TITLE: string }>({ ID: 3 }, { AUTHOR_ID: 2, TITLE: "again" }, { returnDocument: "after" });
    expect(out?.TITLE).toBe("again");
    await expect(notes.replaceOne({ ID: 3 }, { ID: 3 } as never)).rejects.toThrow("[MIRA_MD_NOTES] a replacement needs at least one column besides the primary key.");
  });
});

describe("model: soft delete", () => {
  it("deleteOne / deleteMany mark rows; reads, counts, distinct and aggregate skip them", async () => {
    expect(await notes.deleteOne({ ID: 1 })).toEqual({ acknowledged: true, deletedCount: 1 });
    expect(await notes.deleteOne({ ID: 1 })).toEqual({ acknowledged: true, deletedCount: 0 }); // already deleted
    const [raw] = await q<{ D: Date | null }>(`SELECT "DELETED_AT" D FROM "${N}" WHERE "ID" = 1`);
    expect(raw.D).toBeInstanceOf(Date);
    expect(await ids(notes.find())).toEqual([2, 3]);
    expect(await notes.findOne({ ID: 1 })).toBeNull();
    expect(await notes.countDocuments()).toBe(2);
    expect(await notes.countDocuments({ AUTHOR_ID: 1 })).toBe(1);
    expect((await notes.distinct("AUTHOR_ID")).sort()).toEqual([1, 2]);
    expect(await notes.aggregate<{ N: number }>([{ $group: { _id: null, N: { $count: "*" } } }])).toEqual([{ N: 2 }]);
    expect(await notes.deleteMany({ AUTHOR_ID: { $in: [1, 2] } }, { returning: ["ID"] })).toMatchObject({ deletedCount: 2 });
    expect(await notes.countDocuments()).toBe(0);
    expect(await q(`SELECT COUNT(*) N FROM "${N}"`)).toEqual([{ N: 3 }]);
  });

  it("updates skip deleted rows; withDeleted() sees and changes them; a filter naming the column is left as it is", async () => {
    await notes.deleteOne({ ID: 2 });
    expect(await notes.updateOne({ ID: 2 }, { $set: { TITLE: "ghost" } })).toMatchObject({ matchedCount: 0 });
    expect(await notes.updateMany({}, { $set: { BODY: "b" } })).toMatchObject({ modifiedCount: 2 });
    expect(await notes.untyped.findOneAndUpdate({ ID: 2 }, { $set: { TITLE: "ghost" } })).toBeNull();
    const all = notes.withDeleted();
    expect(all).toBeInstanceOf(ModelCollection);
    expect(await ids(all.find())).toEqual([1, 2, 3]);
    expect(await all.countDocuments()).toBe(3);
    expect(await all.updateOne({ ID: 2 }, { $set: { TITLE: "seen" } })).toMatchObject({ modifiedCount: 1 });
    expect(await ids(notes.find({ DELETED_AT: { $ne: null } }))).toEqual([2]);
    expect((await all.aggregate<{ N: number }>([{ $count: "N" }]))[0].N).toBe(3);
  });

  it("restore() clears the mark (an update: updatedAt moves); { force: true } deletes for real", async () => {
    await notes.deleteMany({ AUTHOR_ID: 1 });
    const t0 = (await notes.withDeleted().findOne({ ID: 1 }))!.UPDATED_AT.getTime();
    await sleep(20);
    expect(await notes.restore({ ID: 1 })).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
    const back = (await notes.findOne({ ID: 1 }))!;
    expect([back.DELETED_AT, back.UPDATED_AT.getTime() > t0]).toEqual([null, true]);
    expect(await notes.restore()).toMatchObject({ modifiedCount: 1 }); // ID 2, the only one still deleted
    expect(await notes.deleteOne({ ID: 3 }, { force: true })).toEqual({ acknowledged: true, deletedCount: 1 });
    expect(await notes.deleteMany({ AUTHOR_ID: 1 }, { force: true, limit: 1 })).toMatchObject({ deletedCount: 1 });
    expect(await q(`SELECT COUNT(*) N FROM "${N}"`)).toEqual([{ N: 1 }]);
    await expect(notes.deleteMany({}, { limit: 1 })).rejects.toThrow("[MIRA_MD_NOTES] a soft deleteMany has no limit; pass { force: true } to delete rows for real, or narrow the filter.");
  });

  it("findOneAndDelete: soft by default (returns the row as it was), { force: true } deletes", async () => {
    const gone = await notes.untyped.findOneAndDelete<{ ID: number; DELETED_AT: Date | null }>({ ID: 1 });
    expect([gone?.ID, gone?.DELETED_AT]).toEqual([1, null]);
    expect(await notes.untyped.findOneAndDelete({ ID: 1 })).toBeNull();
    expect(await (notes.untyped as ModelCollection).withDeleted().findOneAndDelete({ ID: 1 }, { force: true })).toMatchObject({ ID: 1 });
    expect(await q(`SELECT COUNT(*) N FROM "${N}"`)).toEqual([{ N: 2 }]);
  });

  it("include() leaves out soft-deleted related rows (hasMany and belongsTo)", async () => {
    await notes.deleteOne({ ID: 2 });
    await Authors.on(db).deleteOne({ ID: 2 });
    const authors = await AuthorsR.on(db).withDeleted().find().include("notes", { sort: { ID: 1 } }).sort({ ID: 1 }).toArray();
    expect(authors.map((a) => [a.ID, a.notes.map((n) => n.ID)])).toEqual([[1, [1]], [2, [3]]]);
    const withAuthor = await NotesR.on(db).find().include("author").sort({ ID: 1 }).toArray();
    expect(withAuthor.map((n) => [n.ID, n.author?.NAME ?? null])).toEqual([[1, "Ana"], [3, null]]);
  });

  it("upsert on a soft-deleting table inserts the filter's values; the deleted mark stays NULL", async () => {
    await notes.updateOne({ ID: 7 }, { $set: { AUTHOR_ID: 2, TITLE: "upserted" } }, { upsert: true });
    expect(await notes.findOne({ ID: 7 })).toMatchObject({ TITLE: "upserted", DELETED_AT: null });
  });

  it("withDeleted() / restore() on a table without t.deletedAt() refuse", async () => {
    const plain = defineTable(L, { ID: t.id(), WHAT: t.text(200) }, { validate: true }).on(db) as unknown as ModelCollection;
    expect(() => plain.withDeleted()).toThrow("[MIRA_MD_LOG] withDeleted() needs a t.deletedAt() column.");
    await expect(plain.restore()).rejects.toThrow("[MIRA_MD_LOG] restore() needs a t.deletedAt() column.");
    expect(await plain.deleteMany({})).toMatchObject({ deletedCount: 0 }); // no deletedAt: a real delete
  });
});

describe("model: hooks", () => {
  const calls: string[] = [];
  const Hooked = defineTable(N, Notes.columns, {
    hooks: {
      beforeInsert: (doc) => {
        calls.push(`beforeInsert ${doc.TITLE}`);
        return { ...doc, TITLE: doc.TITLE.toUpperCase() };
      },
      afterInsert: async (doc, insertedId, ctx) => {
        calls.push(`afterInsert ${doc.TITLE} ${String(insertedId)}`);
        expect(ctx.table).toBe(N);
        expect(ctx.self).toBeInstanceOf(ModelCollection);
        await Log.on(ctx).insertOne({ WHAT: `insert ${doc.TITLE}` });
      },
      beforeUpdate: (update, filter) => {
        calls.push(`beforeUpdate ${JSON.stringify(filter)}`);
        if ((update.$set as { TITLE?: string } | undefined)?.TITLE === "forbidden") throw new Error("no forbidden titles");
        if (update.$set?.TITLE) return { ...update, $set: { ...update.$set, BODY: "edited" } };
      },
      afterUpdate: (result, filter, update) => {
        calls.push(`afterUpdate ${result.matchedCount}/${result.modifiedCount} ${Object.keys(update).sort().join(",")}`);
      },
      beforeDelete: (filter) => {
        calls.push(`beforeDelete ${JSON.stringify(filter)}`);
        if ((filter as { ID?: unknown }).ID === 3) throw new Error("note 3 is pinned");
      },
      afterDelete: (result) => {
        calls.push(`afterDelete ${result.deletedCount} ${result.soft ? "soft" : "hard"}`);
      },
    },
  });
  const hooked = Hooked.on(db);
  beforeEach(() => {
    calls.length = 0;
  });

  it("insert hooks: before may change the document; after gets the id (insertOne and insertMany)", async () => {
    await hooked.insertOne({ ID: 10, AUTHOR_ID: 1, TITLE: "ten" });
    await hooked.insertMany([{ ID: 11, AUTHOR_ID: 1, TITLE: "eleven" }, { ID: 12, AUTHOR_ID: 1, TITLE: "twelve" }], { returning: ["ID"] });
    expect(calls).toEqual(["beforeInsert ten", "afterInsert TEN null", "beforeInsert eleven", "beforeInsert twelve", "afterInsert ELEVEN 11", "afterInsert TWELVE 12"]);
    expect(await ids(hooked.find({ TITLE: { $in: ["TEN", "ELEVEN", "TWELVE"] } }))).toEqual([10, 11, 12]);
    expect((await q<{ WHAT: string }>(`SELECT "WHAT" FROM "${L}" ORDER BY "ID"`)).map((r) => r.WHAT)).toEqual(["insert TEN", "insert ELEVEN", "insert TWELVE"]);
  });

  it("update hooks: before may change the update or stop it; after sees the result and the stamped update", async () => {
    await hooked.updateOne({ ID: 1 }, { $set: { TITLE: "new" } });
    expect((await hooked.findOne({ ID: 1 }))?.BODY).toBe("edited");
    await hooked.updateMany({ AUTHOR_ID: 2 }, { $unset: { BODY: 1 } });
    await expect(hooked.updateOne({ ID: 1 }, { $set: { TITLE: "forbidden" } })).rejects.toThrow("no forbidden titles");
    await hooked.untyped.findOneAndUpdate({ ID: 404 }, { $unset: { BODY: 1 } });
    expect(calls).toEqual([
      'beforeUpdate {"ID":1}', "afterUpdate 1/1 $currentDate,$set",
      'beforeUpdate {"AUTHOR_ID":2}', "afterUpdate 1/1 $currentDate,$unset",
      'beforeUpdate {"ID":1}',
      'beforeUpdate {"ID":404}', "afterUpdate 0/0 $currentDate,$unset",
    ]);
  });

  it("delete hooks: soft and forced, and a before-hook that throws stops the delete", async () => {
    await hooked.deleteOne({ ID: 1 });
    await hooked.deleteMany({ ID: 2 }, { force: true });
    await expect(hooked.deleteOne({ ID: 3 })).rejects.toThrow("note 3 is pinned");
    await hooked.untyped.findOneAndDelete({ ID: 404 });
    expect(calls).toEqual(['beforeDelete {"ID":1}', "afterDelete 1 soft", 'beforeDelete {"ID":2}', "afterDelete 1 hard", 'beforeDelete {"ID":3}', 'beforeDelete {"ID":404}', "afterDelete 0 soft"]);
    expect(await hooked.withDeleted().countDocuments()).toBe(2);
  });

  it("inside a transaction the hooks' writes roll back with it", async () => {
    await expect(
      new Transaction(db).withTransaction(async (session) => {
        await Hooked.on(session).insertOne({ ID: 20, AUTHOR_ID: 1, TITLE: "tx" });
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect(await hooked.findOne({ ID: 20 })).toBeNull();
    expect(await q(`SELECT COUNT(*) N FROM "${L}"`)).toEqual([{ N: 0 }]);
  });

  it("bulkWrite on a model table runs the wrapped methods (hooks, updatedAt, soft delete) in one transaction", async () => {
    await hooked.untyped.bulkWrite([
      { insertOne: { document: { ID: 30, AUTHOR_ID: 1, TITLE: "bulk" } } },
      { updateOne: { filter: { ID: 30 }, update: { $set: { TITLE: "bulk2" } } } },
      { deleteOne: { filter: { ID: 30 } } },
    ]);
    expect(calls).toEqual(["beforeInsert bulk", "afterInsert BULK null", 'beforeUpdate {"ID":30}', "afterUpdate 1/1 $currentDate,$set", 'beforeDelete {"ID":30}', "afterDelete 1 soft"]);
    expect(await hooked.withDeleted().findOne({ ID: 30 })).toMatchObject({ TITLE: "bulk2", BODY: "edited" });
    // A plain table's bulkWrite still uses a plain collection.
    await Log.on(db).untyped.bulkWrite([{ insertOne: { document: { WHAT: "plain" } } }]);
    expect(await q(`SELECT COUNT(*) N FROM "${L}" WHERE "WHAT" = 'plain'`)).toEqual([{ N: 1 }]);
  });
});

describe("model: validation", () => {
  const Strict = defineTable(N, Notes.columns, { validate: true });
  const strict = Strict.on(db);

  it("a valid insert and update pass; problems are all listed before any SQL", async () => {
    await strict.insertOne({ ID: 40, AUTHOR_ID: 1, TITLE: "fine", BODY: null });
    await strict.updateOne({ ID: 40 }, { $set: { TITLE: "still fine" }, $inc: { AUTHOR_ID: 1 } });
    const err = await strict.insertOne({ ID: 1.5, TITLE: "x".repeat(41), BODY: 5, NOPE: 1 } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MiraValidationError);
    expect((err as MiraValidationError).issues).toEqual([
      { column: "ID", message: "must be a whole number, got 1.5" },
      { column: "TITLE", message: "is 41 bytes long; VARCHAR2(40) allows 40" },
      { column: "BODY", message: "must be a string, got number 5" },
      { column: "NOPE", message: "is not a column of this table" },
      { column: "AUTHOR_ID", message: "is required" },
    ]);
    await expect(strict.updateMany({}, { $set: { TITLE: null }, $unset: { CREATED_AT: 1 } } as never)).rejects.toThrow(
      "[MIRA_MD_NOTES] update is not valid: TITLE cannot be null; CREATED_AT cannot be unset: it is not nullable.",
    );
    expect(await q(`SELECT COUNT(*) N FROM "${N}" WHERE "ID" = 1.5`)).toEqual([{ N: 0 }]);
  });

  it("hooks run before validation, so a hook can fill a required column", async () => {
    const Filled = defineTable(N, Notes.columns, { validate: true, hooks: { beforeInsert: (doc) => ({ ...doc, AUTHOR_ID: 2 }) } });
    await Filled.on(db).insertOne({ ID: 41, TITLE: "filled" } as never);
    expect((await strict.findOne({ ID: 41 }))?.AUTHOR_ID).toBe(2);
  });
});

describe("model: definition checks", () => {
  it("one createdAt / updatedAt / deletedAt per table; hooks must be known functions", () => {
    expect(() => defineTable("X", { A: t.deletedAt(), B: t.deletedAt() })).toThrow("[defineTable] X: one t.deletedAt() column per table, got A, B.");
    expect(() => defineTable("X", { A: t.text(1) }, { hooks: { beforeSave: () => {} } as never })).toThrow("[defineTable] X: unknown hook beforeSave.");
    expect(() => defineTable("X", { A: t.text(1) }, { hooks: { afterInsert: 1 } as never })).toThrow("[defineTable] X: hook afterInsert must be a function.");
  });

  it("a table without these features keeps the plain collection", () => {
    const plain = Log.on(db);
    expect(plain).toBeInstanceOf(OracleCollection);
    expect(plain).not.toBeInstanceOf(ModelCollection);
  });
});
