/**
 * UNIT — every error branch in the wrapper, reached with a stub connection
 * (test/helpers/stubs.ts). Each assertion checks that a driver failure is
 * re-thrown wrapped with the method name, never swallowed.
 */
import { describe, it, expect } from "bun:test";
import {
  OracleCollection,
  OracleSchema,
  OracleDCL,
  QueryBuilder,
  withCTE,
  withRecursiveCTE,
  createPerformance,
} from "../../src/utils/oracle-mongo-wrapper";
import { stubConn, stubDb, oraError } from "../helpers/stubs";

const failing = () => {
  const db = stubDb();
  return { db, coll: new OracleCollection("T_X", db as never, db.conn as never) };
};

describe("unit/errors: OracleCollection wraps every driver failure", () => {
  const cases: Array<[string, (c: OracleCollection) => Promise<unknown>]> = [
    ["findOne", (c) => c.findOne({ A: 1 })],
    ["findOneAndUpdate (upsert)", (c) => c.findOneAndUpdate({ A: 1 }, { $set: { B: 2 } }, { upsert: true, returnDocument: "after" })],
    ["findOneAndDelete", (c) => c.findOneAndDelete({ A: 1 })],
    ["countDocuments", (c) => c.countDocuments({ A: 1 })],
    ["estimatedDocumentCount", (c) => c.estimatedDocumentCount()],
    ["distinct", (c) => c.distinct("A")],
    ["insertOne", (c) => c.insertOne({ A: 1 })],
    ["insertMany", (c) => c.insertMany([{ A: 1 }])],
    ["bulkUpdateByKeys", (c) => c.bulkUpdateByKeys([{ K: 1, A: 1 }], { keys: ["K"] })],
    ["updateOne", (c) => c.updateOne({ A: 1 }, { $set: { B: 1 } })],
    ["updateMany", (c) => c.updateMany({ A: 1 }, { $set: { B: 1 } })],
    ["replaceOne", (c) => c.replaceOne({ A: 1 }, { B: 1 })],
    ["deleteOne", (c) => c.deleteOne({ A: 1 })],
    ["deleteMany", (c) => c.deleteMany({ A: 1 })],
    ["drop", (c) => c.drop()],
    ["aggregate", (c) => c.aggregate([{ $match: { A: 1 } }])],
    ["createIndex", (c) => c.createIndex({ A: 1 })],
    ["dropIndex", (c) => c.dropIndex("IDX")],
    ["merge", (c) => c.merge({ ID: 1 }, { localField: "ID", foreignField: "ID" }, { whenNotMatched: "insert" })],
    ["mergeFrom", (c) => c.mergeFrom("SRC", { localField: "ID", foreignField: "ID" })],
    ["connectBy", (c) => c.connectBy({ connectBy: { MGR: "$PRIOR ID" } })],
    ["pivot", (c) => c.pivot({ value: { $sum: "$A" }, pivotOn: "Q", pivotValues: ["Q1"], groupBy: "R" })],
    ["unpivot", (c) => c.unpivot({ valueColumn: "V", nameColumn: "N", columns: ["A"] })],
    ["insertFromQuery", (c) => c.insertFromQuery("T_Y", c.find({}), { columns: ["A"] })],
    ["updateFromJoin", (c) => c.updateFromJoin({ target: "T_X", join: { table: "T_Y", on: { A: "A" } }, set: { B: 1 } })],
  ];
  for (const [name, run] of cases) {
    it(name, async () => {
      const { coll } = failing();
      await expect(run(coll)).rejects.toThrow(/ORA-00942/);
    });
  }

  it("findOneAndUpdate upsert: an INSERT failure after an empty lock is wrapped", async () => {
    const conn = stubConn((sql) => {
      if (sql.startsWith("SELECT")) return { rows: [] };
      throw oraError(1400, "cannot insert NULL");
    });
    const c = new OracleCollection("T_X", stubDb(conn) as never, conn as never);
    await expect(c.findOneAndUpdate({ A: 1 }, { $set: { B: 2 } }, { upsert: true })).rejects.toThrow(/findOneAndUpdate.*ORA-01400/s);
  });

  it("findOneAndUpdate standard path: UPDATE failure is wrapped", async () => {
    const conn = stubConn((sql) => {
      if (sql.startsWith("SELECT")) return { rows: [{ ID: 1 }] };
      throw oraError(1);
    });
    const c = new OracleCollection("T_X", stubDb(conn) as never, conn as never);
    await expect(c.findOneAndUpdate({ ID: 1 }, { $set: { A: 1 } })).rejects.toThrow(/findOneAndUpdate/);
  });

  it("findOneAndDelete: DELETE failure after a successful SELECT is wrapped", async () => {
    const conn = stubConn((sql) => {
      if (sql.startsWith("SELECT")) return { rows: [{ ID: 1, MIRA_RID_: "AAA" }] };
      throw oraError(2292, "child record found");
    });
    const c = new OracleCollection("T_X", stubDb(conn) as never, conn as never);
    await expect(c.findOneAndDelete({ ID: 1 })).rejects.toThrow(/findOneAndDelete/);
  });

  it("findOneAndReplace: UPDATE failure after a successful SELECT is wrapped", async () => {
    const conn = stubConn((sql) => {
      if (sql.startsWith("SELECT")) return { rows: [{ ID: 1 }] };
      throw oraError(1407, "cannot update to NULL");
    });
    const c = new OracleCollection("T_X", stubDb(conn) as never, conn as never);
    await expect(c.findOneAndReplace({ ID: 1 }, { A: null })).rejects.toThrow(/findOneAndReplace/);
  });

  it("dropIndexes / reIndex skip per-index failures and keep going", async () => {
    const conn = stubConn((sql) => {
      if (sql.startsWith("SELECT INDEX_NAME")) return { rows: [{ INDEX_NAME: "I1" }, { INDEX_NAME: "I2" }] };
      if (sql.includes('"I1"')) throw oraError(2429, "index used for enforcement of unique key");
      return { rowsAffected: 0 };
    });
    const c = new OracleCollection("T_X", stubDb(conn) as never, conn as never);
    expect((await c.dropIndexes()).dropped).toEqual(["I2"]);
    expect(await c.reIndex()).toEqual({ acknowledged: true });
  });

  it("result sets with no rows/outBinds fall back to empty values", async () => {
    const conn = stubConn((sql) => (sql.startsWith("SELECT COUNT") ? { rows: [{ CNT: 0 }] } : {}));
    const c = new OracleCollection("T_X", stubDb(conn) as never, conn as never);
    expect(await c.findOne({})).toBeNull();
    expect(await c.estimatedDocumentCount()).toBe(0);
    expect(await c.distinct("A")).toEqual([]);
    expect(await c.aggregate([])).toEqual([]);
    expect(await c.connectBy({ connectBy: { M: "P" } })).toEqual([]);
    expect(await c.pivot({ value: { $sum: "A" }, pivotOn: "Q", pivotValues: ["Q1"], groupBy: "R" })).toEqual([]);
    expect(await c.unpivot({ valueColumn: "V", nameColumn: "N", columns: ["A"] })).toEqual([]);
    expect(await c.getIndexes()).toEqual([]);
    expect(await c.dropIndexes()).toEqual({ acknowledged: true, dropped: [] });
    expect(await c.reIndex()).toEqual({ acknowledged: true });
    expect(await c.updateMany({}, { $set: { A: 1 } })).toEqual({ acknowledged: true, matchedCount: 0, modifiedCount: 0 });
    expect(await c.deleteMany({})).toEqual({ acknowledged: true, deletedCount: 0 });
    expect(await c.updateOne({}, { $set: { A: 1 } })).toMatchObject({ matchedCount: 0, modifiedCount: 0 });
    expect(await c.replaceOne({}, { A: 1 })).toMatchObject({ matchedCount: 0 });
    expect(await c.deleteOne({})).toMatchObject({ deletedCount: 0 });
    expect(await c.insertOne({ ID: 5 })).toEqual({ acknowledged: true, insertedId: null });
    expect(await c.insertMany([{ A: 1 }], { returning: [] })).toMatchObject({ insertedCount: 0, insertedIds: [] });
    expect(await c.bulkUpdateByKeys([{ K: 1, A: 1 }], { keys: ["K"] })).toEqual({ acknowledged: true, modifiedCount: 0 });
    expect(await c.updateFromJoin({ target: "T_X", join: { table: "T_Y", on: { A: "A" } }, set: { B: 1 } })).toMatchObject({ modifiedCount: 0 });
    expect(await c.insertFromQuery("T_Y", c.find({}))).toMatchObject({ insertedCount: 0 });
    expect(await c.findOneAndUpdate({ A: 1 }, { $set: { B: 1 } }, { upsert: true, returnDocument: "after" })).toBeNull();
  });

  it("insertMany batchErrors maps a driver error without a message via String()", async () => {
    const conn = stubConn(() => ({ rowsAffected: 1, batchErrors: [{ offset: 0 }] }));
    const c = new OracleCollection("T_X", stubDb(conn) as never, conn as never);
    const r = await c.insertMany([{ A: 1 }], { returning: [], batchErrors: true });
    expect(r.batchErrors).toEqual([{ offset: 0, message: "[object Object]" }]);
    const conn2 = stubConn(() => ({ rowsAffected: 1 }));
    const c2 = new OracleCollection("T_X", stubDb(conn2) as never, conn2 as never);
    expect((await c2.insertMany([{ A: 1 }], { returning: [], batchErrors: true })).batchErrors).toEqual([]);
  });

  it("RETURNING values that come back as scalars (not arrays) are passed through", async () => {
    const conn = stubConn(() => ({ rowsAffected: 1, outBinds: { out_id: 7, out_NAME: "x", out_ID: 9 } }));
    const c = new OracleCollection("T_X", stubDb(conn) as never, conn as never);
    expect((await c.insertOne({ A: 1 })).insertedId).toBe(7);
    expect((await c.insertOne({ A: 1 }, { returning: ["NAME"] })).returning).toEqual({ NAME: "x" });
    expect((await c.updateOne({ A: 1 }, { $set: { A: 2 } }, { returning: ["NAME"] })).returning).toEqual({ NAME: "x" });
    expect((await c.deleteOne({ A: 1 }, { returning: ["NAME"] })).returning).toEqual({ NAME: "x" });
    const many = await c.updateMany({ A: 1 }, { $set: { A: 2 } }, { returning: ["NAME", "MISSING"] });
    expect(many.returning).toEqual([{ NAME: "x", MISSING: null }]);
    const conn2 = stubConn(() => ({ rowsAffected: 1, outBinds: [{ out_ID: 3 }, { out_ID: [null] }] }));
    const c2 = new OracleCollection("T_X", stubDb(conn2) as never, conn2 as never);
    expect((await c2.insertMany([{ A: 1 }, { A: 2 }])).insertedIds).toEqual([3, null]);
    const conn3 = stubConn(() => ({ rowsAffected: 1, outBinds: { out_ID: { weird: true } } }));
    const c3 = new OracleCollection("T_X", stubDb(conn3) as never, conn3 as never);
    expect((await c3.insertOne({ A: 1 }, { returning: ["ID"] })).insertedId).toBeNull();
  });
});

describe("unit/errors: QueryBuilder", () => {
  it("toArray / count / forEach wrap failures", async () => {
    const db = stubDb();
    const qb = () => new QueryBuilder("T_X", { A: 1 }, db as never, db.conn as never);
    await expect(qb().toArray()).rejects.toThrow(/QueryBuilder\._execute/);
    await expect(qb().count()).rejects.toThrow(/QueryBuilder\.count/);
    await expect(qb().forEach(() => {})).rejects.toThrow(/QueryBuilder\.forEach/);
  });

  it("a session builder with empty results returns []/0", async () => {
    const conn = stubConn(() => ({}));
    const qb = new QueryBuilder("T_X", null as never, stubDb(conn) as never, conn as never);
    expect(await qb.toArray()).toEqual([]);
    expect(await new QueryBuilder("T_X", {}, stubDb(conn) as never, conn as never).count()).toBe(0);
  });
});

describe("unit/errors: OracleSchema / OracleDCL / performance / CTE / set operations", () => {
  const db = stubDb();
  const schema = new OracleSchema(db as never);

  it("schema DDL failures are wrapped", async () => {
    await expect(schema.createTable("T", { A: { type: "NUMBER" } })).rejects.toThrow(/createTable/);
    await expect(schema.alterTable("T", { dropColumn: "A" })).rejects.toThrow(/alterTable/);
    await expect(schema.dropTable("T")).rejects.toThrow(/dropTable/);
    await expect(schema.truncateTable("T")).rejects.toThrow(/truncateTable/);
    await expect(schema.renameTable("T", "U")).rejects.toThrow(/renameTable/);
    await expect(schema.createView("V", "SELECT 1 FROM DUAL")).rejects.toThrow(/createView/);
    await expect(schema.dropView("V")).rejects.toThrow(/dropView/);
    await expect(schema.createSequence("S")).rejects.toThrow(/createSequence/);
    await expect(schema.createSchema("X")).rejects.toThrow(/createSchema/);
  });

  it("DCL: privilege errors get the insufficient-privilege message, others the generic wrap", async () => {
    const privDb = stubDb(stubConn(() => { throw oraError(1031, "insufficient privileges"); }));
    const dcl = new OracleDCL(privDb as never);
    await expect(dcl.grant(["SELECT"], "T", "U")).rejects.toThrow();
    await expect(dcl.revoke(["SELECT"], "T", "U")).rejects.toThrow();
    const otherDb = stubDb(stubConn(() => { throw oraError(990, "missing or invalid privilege"); }));
    const dcl2 = new OracleDCL(otherDb as never);
    await expect(dcl2.grant(["FLY"], "T", "U")).rejects.toThrow(/OracleDCL\.grant/);
    await expect(dcl2.revoke(["FLY"], "T", "U")).rejects.toThrow(/OracleDCL\.revoke/);
  });

  it("performance: privilege vs generic failures and invalid input", async () => {
    const priv = createPerformance(stubDb(stubConn(() => { throw oraError(1031); })) as never) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const gen = createPerformance(stubDb(stubConn(() => { throw oraError(904); })) as never) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const p of [priv, gen]) {
      await expect(p.explainPlan("SELECT 1 FROM DUAL")).rejects.toThrow();
      await expect(p.analyze("T")).rejects.toThrow();
      await expect(p.createMaterializedView("MV", "SELECT 1 FROM DUAL", { orReplace: true })).rejects.toThrow();
      await expect(p.refreshMaterializedView("MV")).rejects.toThrow();
      await expect(p.dropMaterializedView("MV")).rejects.toThrow();
    }
    await expect(gen.explainPlan(42)).rejects.toThrow();
    await expect(gen.createMaterializedView("MV", 42)).rejects.toThrow();
    // A driver error carrying a string code (NJS-xxx) takes the generic branch.
    const njs = createPerformance(stubDb(stubConn(() => { throw Object.assign(new Error("NJS-500"), { code: "NJS-500" }); })) as never) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await expect(njs.analyze("T")).rejects.toThrow(/performance\.analyze/);
  });

  it("performance: explainPlan / createMaterializedView option fallbacks with a working stub", async () => {
    const ok = createPerformance(stubDb(stubConn(() => ({}))) as never) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    expect(await ok.explainPlan("SELECT 1 FROM DUAL")).toEqual([]);
    expect(await ok.createMaterializedView("MV", "SELECT 1 FROM DUAL", { refreshMode: "bogus", refreshOn: "bogus", buildMode: "bogus" } as never)).toEqual({ acknowledged: true });
    await ok.refreshMaterializedView("MV", "bogus");
  });

  it("CTE and recursive CTE toArray wrap failures", async () => {
    const qb = new QueryBuilder("T_X", {}, db as never);
    await expect(withCTE(db as never, { a: qb }).toArray()).rejects.toThrow(/CTEResult/);
    const recConn = stubConn((sql) => {
      if (sql.includes("USER_TAB_COLUMNS")) return {};
      throw oraError(32044, "cycle detected");
    });
    const recDb = stubDb(recConn);
    await expect(
      withRecursiveCTE(recDb as never, "org", { anchor: new QueryBuilder("T_X", {}, recDb as never), recursive: { collection: "T_X", joinOn: { M: "$org.ID" } } }).toArray(),
    ).rejects.toThrow(/RecursiveCTEResult/);
    const emptyDb = stubDb(stubConn(() => ({})));
    expect(await withCTE(emptyDb as never, { a: new QueryBuilder("T_X", {}, emptyDb as never) }).toArray()).toEqual([]);
    expect(
      await withRecursiveCTE(emptyDb as never, "org", { anchor: new QueryBuilder("T_X", {}, emptyDb as never), recursive: { collection: "T_X", joinOn: { M: "$org.ID" } } }).toArray(),
    ).toEqual([]);
  });

  it("set operation toArray wraps failures, and empty results become []", async () => {
    const qb = (d: ReturnType<typeof stubDb>) => new QueryBuilder("T_X", {}, d as never);
    await expect(OracleCollection.union(qb(db), qb(db)).toArray()).rejects.toThrow(/SetResultBuilder/);
    const e = stubDb(stubConn(() => ({})));
    expect(await OracleCollection.minus(qb(e), qb(e)).toArray()).toEqual([]);
  });
});

describe("unit/errors: remaining edges", () => {
  it("read-only transaction ignores a failing final rollback", async () => {
    const { Transaction } = await import("../../src/utils/oracle-mongo-wrapper");
    const conn = stubConn(() => ({ rows: [] }));
    conn.rollback = async () => { throw new Error("ORA-03113"); };
    expect(await new Transaction(stubDb(conn) as never).withReadOnlyTransaction(async () => "ok")).toBe("ok");
  });

  it("createSchema succeeds when the driver accepts it; dropColumn tolerates a non-string name", async () => {
    const ok = new OracleSchema(stubDb(stubConn(() => ({}))) as never);
    expect(await ok.createSchema("MIRA")).toEqual({ acknowledged: true });
    const conn = stubConn(() => ({}));
    await new OracleSchema(stubDb(conn) as never).alterTable("T", { dropColumn: ["A"] as never });
    expect(conn.calls[0].sql).toBe('ALTER TABLE "T" DROP COLUMN "A"');
  });

  it("createTable refuses a JSON-type column on a database older than 21c (19c answers ORA-00902)", async () => {
    const old = Object.assign(stubConn(() => ({})), { oracleServerVersion: 1919000000, oracleServerVersionString: "19.19.0.0.0" });
    await expect(new OracleSchema(stubDb(old) as never).createTable("T", { ID: { type: "NUMBER" }, DOC: { type: "JSON" }, D2: { type: " json " } })).rejects.toThrow(
      "[OracleSchema.createTable] T: DOC, D2 use the JSON type, which needs Oracle Database 21c or later (this is 19.19.0.0.0). Use t.json() without { native: true } (JSON text with an IS JSON check) on 19c.",
    );
    expect(old.calls).toHaveLength(0);
    const recent = Object.assign(stubConn(() => ({})), { oracleServerVersion: 2304000000, oracleServerVersionString: "23.4.0.0.0" });
    await new OracleSchema(stubDb(recent) as never).createTable("T", { DOC: { type: "JSON" } });
    expect(recent.calls[0].sql).toBe('CREATE TABLE "T" ("DOC" JSON)');
  });

  it("updateFromJoin: plain (non-dotted) where columns", async () => {
    const conn = stubConn(() => ({ rowsAffected: 2 }));
    const c = new OracleCollection("T", stubDb(conn) as never, conn as never);
    await c.updateFromJoin({ target: "T", join: { table: "J", on: { A: "B" } }, set: { X: "J.Y" }, where: { STATUS: "ok" } });
    expect(conn.calls[0].sql).toBe('UPDATE "T" SET "X" = (SELECT "Y" FROM "J" WHERE "T"."A" = "B" AND ROWNUM = 1) WHERE EXISTS (SELECT 1 FROM "J" WHERE "T"."A" = "B" AND "STATUS" = :upd_where_0)');
  });

  it("aggregate expressions that are scalars or empty objects pass through", async () => {
    const { buildAggregateSQL } = await import("../../src/utils/oracle-mongo-wrapper");
    expect(buildAggregateSQL("T", [{ $group: { _id: "$R", n: 5 } }], {}).sql).toBe('SELECT "R", 5 AS "N" FROM "T" GROUP BY "R"');
    expect(buildAggregateSQL("T", [{ $project: { e: {} } }], {}).sql).toBe('SELECT [object Object] AS "E" FROM "T"');
  });

  it("db handle exposes pool health and stats", async () => {
    const { createDb } = await import("../../src/utils/oracle-mongo-wrapper");
    const d = createDb("appDb");
    expect(d.isHealthy()).toBe(true);
    expect(await d.getPoolStats()).toHaveProperty("pools");
  });
});

describe("unit: aggregate() keeps QueryBuilders intact through its pipeline copy", () => {
  it("$lateralJoin / $inSelect builders survive the clone (no silent DUAL cross join)", () => {
    const c = new OracleCollection("U", stubDb() as never);
    const o = new OracleCollection("O", stubDb() as never);
    const p = c.aggregate([
      { $match: { ID: { $inSelect: o.find({ S: 1 }).project({ UID: 1 }) }, T: new Date(0), $and: [Object.assign(Object.create(null), { Z: 1 })] } },
      { $lateralJoin: { subquery: o.find({ UID: "$outer.ID" }), as: "TOP" } },
    ]);
    p.catch(() => {});
    const { sql } = p._buildSQL();
    expect(sql).toContain('"ID" IN (SELECT "UID" FROM "O" t0 WHERE "S" = :sq_0_where_S_0)');
    expect(sql).toContain('LATERAL (SELECT * FROM "O" t0 WHERE "UID" = "stage_0"."ID")');
    expect(sql).not.toContain("DUAL");
  });
});
