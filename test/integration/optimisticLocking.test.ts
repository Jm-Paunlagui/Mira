/**
 * INTEGRATION — optimistic locking on typed tables (Mira 2.1, roadmap item 8):
 * t.version() is raised by every update; a single-row write whose filter pins the
 * version read earlier, and that finds the row changed since, throws
 * MiraConcurrencyError instead of silently matching nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { defineTable, t, Transaction, MiraConcurrencyError, MiraValidationError } from "../../src";
import { db, dropIfExists, rawExec } from "../helpers/db";

const D = "MIRA_OL_DOCS";
const afterUpdates: number[] = [];
const Docs = defineTable(
  D,
  { ID: t.number(10).primaryKey(), TITLE: t.text(40), VERSION: t.version(), DELETED_AT: t.deletedAt() },
  { hooks: { afterUpdate: (r) => void afterUpdates.push(r.modifiedCount) } },
);
const docs = Docs.on(db);
const version = async (id: number) => (await docs.withDeleted().findOne({ ID: id }))?.VERSION;

beforeAll(async () => {
  await dropIfExists(D);
  await Docs.create(db);
});
afterAll(async () => {
  await dropIfExists(D);
});
beforeEach(async () => {
  afterUpdates.length = 0;
  await rawExec(`DELETE FROM "${D}"`);
  await docs.insertMany([{ ID: 1, TITLE: "a" }, { ID: 2, TITLE: "b" }, { ID: 3, TITLE: "c" }]);
});

describe("optimistic locking: t.version()", () => {
  it("NUMBER(10) DEFAULT 1; every update adds 1, unless the update sets the version itself", async () => {
    expect(Docs.ddl().VERSION).toEqual({ type: "NUMBER(10)", default: 1, notNull: true });
    expect(await version(1)).toBe(1);
    await docs.updateOne({ ID: 1 }, { $set: { TITLE: "a2" } });
    await docs.updateMany({}, { $set: { TITLE: "all" } });
    expect([await version(1), await version(2), await version(3)]).toEqual([3, 2, 2]);
    await docs.updateOne({ ID: 1 }, { $set: { VERSION: 10 } });
    await docs.updateOne({ ID: 2 }, { $inc: { VERSION: 5 } });
    expect([await version(1), await version(2)]).toEqual([10, 7]);
  });

  it("two editors read version 1; the first saves (version 2), the second gets MiraConcurrencyError", async () => {
    const mine = (await docs.findOne({ ID: 1 }))!;
    const theirs = (await docs.findOne({ ID: 1 }))!;
    expect(await docs.updateOne({ ID: theirs.ID, VERSION: theirs.VERSION }, { $set: { TITLE: "theirs" } })).toMatchObject({ matchedCount: 1 });
    const err = await docs.updateOne({ ID: mine.ID, VERSION: mine.VERSION }, { $set: { TITLE: "mine" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MiraConcurrencyError);
    expect([(err as MiraConcurrencyError).message, (err as MiraConcurrencyError).expectedVersion, (err as MiraConcurrencyError).currentVersion, (err as MiraConcurrencyError).table]).toEqual([
      "[MIRA_OL_DOCS] updateOne: the row changed since it was read (version 1 expected, now 2); re-read it and try again.",
      1,
      2,
      D,
    ]);
    expect((await docs.findOne({ ID: 1 }))?.TITLE).toBe("theirs");
    expect(afterUpdates).toEqual([1]); // the stale update ran no afterUpdate hook
    // Re-read and retry: it goes through.
    const fresh = (await docs.findOne({ ID: 1 }))!;
    expect(await docs.updateOne({ ID: 1, VERSION: fresh.VERSION }, { $set: { TITLE: "mine" } })).toMatchObject({ matchedCount: 1 });
  });

  it("no conflict when the row is gone (deleted or never there), when the filter is only the version, or for updateMany", async () => {
    await docs.deleteOne({ ID: 3 });
    expect(await docs.updateOne({ ID: 3, VERSION: 1 }, { $set: { TITLE: "x" } })).toMatchObject({ matchedCount: 0 });
    expect(await docs.updateOne({ ID: 404, VERSION: 1 }, { $set: { TITLE: "x" } })).toMatchObject({ matchedCount: 0 });
    await docs.updateOne({ ID: 1 }, { $set: { TITLE: "v2" } });
    expect(await docs.updateOne({ VERSION: 99 }, { $set: { TITLE: "x" } })).toMatchObject({ matchedCount: 0 });
    expect(await docs.updateMany({ ID: 1, VERSION: 1 }, { $set: { TITLE: "x" } })).toMatchObject({ matchedCount: 0 });
    expect(await docs.updateOne({ ID: 1, VERSION: { $lt: 2 } }, { $set: { TITLE: "x" } })).toMatchObject({ matchedCount: 0 }); // not a pinned value
  });

  it("findOneAndUpdate, replaceOne and findOneAndReplace check too; a replacement never sets the version", async () => {
    const row = (await docs.findOne({ ID: 2 }))!;
    expect(await docs.replaceOne({ ID: 2, VERSION: row.VERSION }, { ...row, TITLE: "replaced" })).toMatchObject({ modifiedCount: 1 });
    expect(await version(2)).toBe(2);
    await expect(docs.replaceOne({ ID: 2, VERSION: row.VERSION }, { ...row, TITLE: "stale" })).rejects.toThrow("[MIRA_OL_DOCS] updateOne: the row changed since it was read (version 1 expected, now 2)");
    await expect(docs.untyped.findOneAndUpdate({ ID: 2, VERSION: 1 }, { $set: { TITLE: "stale" } })).rejects.toBeInstanceOf(MiraConcurrencyError);
    await expect(docs.untyped.findOneAndReplace({ ID: 2, VERSION: 1 }, { TITLE: "stale" })).rejects.toBeInstanceOf(MiraConcurrencyError);
    expect(await docs.untyped.findOneAndUpdate<{ VERSION: number }>({ ID: 2, VERSION: 2 }, { $set: { TITLE: "ok" } }, { returnDocument: "after" })).toMatchObject({ VERSION: 3 });
  });

  it("deleteOne and findOneAndDelete (soft and forced) refuse a stale version", async () => {
    await docs.updateOne({ ID: 1 }, { $set: { TITLE: "v2" } });
    await expect(docs.deleteOne({ ID: 1, VERSION: 1 })).rejects.toThrow("[MIRA_OL_DOCS] deleteOne: the row changed since it was read (version 1 expected, now 2)");
    await expect(docs.deleteOne({ ID: 1, VERSION: 1 }, { force: true })).rejects.toBeInstanceOf(MiraConcurrencyError);
    await expect(docs.untyped.findOneAndDelete({ ID: 1, VERSION: 1 })).rejects.toThrow("[MIRA_OL_DOCS] findOneAndDelete: the row changed");
    expect(await docs.countDocuments({ ID: 1 })).toBe(1);
    expect(await docs.deleteOne({ ID: 1, VERSION: 2 })).toMatchObject({ deletedCount: 1 });
  });

  it("upsert with a pinned version is refused (a stale version would insert a second row)", async () => {
    await expect(docs.updateOne({ ID: 1, VERSION: 1 }, { $set: { TITLE: "x" } }, { upsert: true })).rejects.toThrow(
      "[MIRA_OL_DOCS] upsert with a version in the filter would insert a second row when the version is stale; update without upsert.",
    );
    await expect(docs.untyped.findOneAndUpdate({ ID: 1, VERSION: 1 }, { $set: { TITLE: "x" } }, { upsert: true })).rejects.toThrow("upsert with a version in the filter");
    await docs.updateOne({ ID: 9 }, { $set: { TITLE: "new" } }, { upsert: true });
    expect(await version(9)).toBe(1);
  });

  it("inside a transaction: the check reads on the transaction's connection", async () => {
    await expect(
      new Transaction(db).withTransaction(async (session) => {
        const s = Docs.on(session);
        await s.updateOne({ ID: 1, VERSION: 1 }, { $set: { TITLE: "first" } });
        await s.updateOne({ ID: 1, VERSION: 1 }, { $set: { TITLE: "second" } }); // sees its own version 2
      }),
    ).rejects.toBeInstanceOf(MiraConcurrencyError);
    expect([(await docs.findOne({ ID: 1 }))?.TITLE, await version(1)]).toEqual(["a", 1]); // rolled back
  });

  it("Mira's own errors keep their class through withTransaction (operational: not wrapped as a DB failure)", async () => {
    const Strict = defineTable(D, Docs.columns, { validate: true });
    const inTx = (fn: (s: Parameters<Parameters<Transaction["withTransaction"]>[0]>[0]) => Promise<unknown>) => new Transaction(db).withTransaction(fn);
    const v = await inTx((s) => Strict.on(s).insertOne({ ID: 5, TITLE: 7 } as never)).catch((e: unknown) => e);
    expect([v instanceof MiraValidationError, (v as MiraValidationError).statusCode, (v as MiraValidationError).isOperational]).toEqual([true, 422, true]);
    const c = await inTx((s) => Docs.on(s).updateOne({ ID: 1, VERSION: 0 }, { $set: { TITLE: "x" } })).catch((e: unknown) => e);
    expect([c instanceof MiraConcurrencyError, (c as MiraConcurrencyError).statusCode, (c as MiraConcurrencyError).isOperational]).toEqual([true, 409, true]);
  });

  it("one t.version() per table", () => {
    expect(() => defineTable("X", { A: t.version(), B: t.version() })).toThrow("[defineTable] X: one t.version() column per table, got A, B.");
  });
});
