/**
 * INTEGRATION — OracleSchema (DDL), OracleDCL (grants) and the performance
 * utilities against the live MIRA schema. Every DDL is verified through the
 * USER_* data dictionary, not by the method's return value.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { OracleDCL, createPerformance } from "../../src";
import { db, schema, coll, createUsers, dropIfExists, rawExec } from "../helpers/db";

const T = "MIRA_IS_T";
const P = "MIRA_IS_PARENT";
const U = "MIRA_IS_USERS";
const perf = createPerformance(db) as {
  explainPlan: (q: unknown) => Promise<Record<string, unknown>[]>;
  analyze: (t: string) => Promise<void>;
  createMaterializedView: (n: string, q: unknown, o?: Record<string, unknown>) => Promise<{ acknowledged: boolean }>;
  refreshMaterializedView: (n: string, m?: string) => Promise<void>;
  dropMaterializedView: (n: string) => Promise<{ acknowledged: boolean }>;
};

const columns = async (t: string) =>
  ((await rawExec<{ COLUMN_NAME: string }>("SELECT COLUMN_NAME FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :t ORDER BY COLUMN_ID", { t })).rows ?? []).map((r) => r.COLUMN_NAME);
const exists = async (type: string, name: string) =>
  Number((await rawExec<{ N: number }>("SELECT COUNT(*) AS N FROM USER_OBJECTS WHERE OBJECT_TYPE = :ty AND OBJECT_NAME = :n", { ty: type, n: name })).rows![0].N) > 0;

beforeAll(async () => {
  await rawExec(`BEGIN EXECUTE IMMEDIATE 'DROP MATERIALIZED VIEW "MIRA_IS_MV"'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
  await rawExec(`BEGIN EXECUTE IMMEDIATE 'DROP SEQUENCE "MIRA_IS_SEQ"'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
  await schema.dropView("MIRA_IS_V", { ifExists: true });
  await dropIfExists(T, `${T}_RENAMED`, P, U);
  await createUsers(U);
});
afterAll(async () => {
  await rawExec(`BEGIN EXECUTE IMMEDIATE 'DROP MATERIALIZED VIEW "MIRA_IS_MV"'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
  await rawExec(`BEGIN EXECUTE IMMEDIATE 'DROP SEQUENCE "MIRA_IS_SEQ"'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
  await schema.dropView("MIRA_IS_V", { ifExists: true });
  await dropIfExists(T, `${T}_RENAMED`, P, U);
});

describe("integration: OracleSchema", () => {
  it("createTable with PK, identity, NOT NULL, DEFAULT, CHECK and FOREIGN KEY", async () => {
    await schema.createTable(P, { ID: { type: "NUMBER", primaryKey: true } });
    await schema.createTable(T, {
      ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
      NAME: { type: "VARCHAR2(50)", notNull: true },
      QTY: { type: "NUMBER", default: "0", check: "QTY >= 0" },
      PARENT_ID: { type: "NUMBER", references: { table: P, column: "ID" } },
    });
    expect(await columns(T)).toEqual(["ID", "NAME", "QTY", "PARENT_ID"]);
    const t = coll(T);
    expect((await t.insertOne({ NAME: "a" })).insertedId).toBe(1);
    expect(await t.findOne({ ID: 1 })).toMatchObject({ QTY: 0 });
    await expect(t.insertOne({ NAME: "neg", QTY: -1 })).rejects.toThrow(/ORA-02290/);
    await expect(t.insertOne({ NAME: "orphan", PARENT_ID: 42 })).rejects.toThrow(/ORA-02291/);
  });

  it("createTable ifNotExists is idempotent; without it ORA-00955 surfaces", async () => {
    await schema.createTable(T, { X: { type: "NUMBER" } }, { ifNotExists: true });
    await expect(schema.createTable(T, { X: { type: "NUMBER" } })).rejects.toThrow(/ORA-00955/);
    await expect(schema.createTable(P, { "it's": { type: "NOT_A_TYPE" } }, { ifNotExists: true })).rejects.toThrow();
  });

  it("alterTable: add / modify / rename / drop column, add / drop constraint, unknown op", async () => {
    await schema.alterTable(T, { addColumn: { PHONE: "VARCHAR2(20)", NOTE: "VARCHAR2(10)" } });
    await schema.alterTable(T, { modifyColumn: { NOTE: "VARCHAR2(100)" } });
    await schema.alterTable(T, { renameColumn: { from: "PHONE", to: "MOBILE" } });
    expect(await columns(T)).toEqual(["ID", "NAME", "QTY", "PARENT_ID", "MOBILE", "NOTE"]);
    await schema.alterTable(T, { dropColumn: "MOBILE" });
    await schema.alterTable(T, { addConstraint: { type: "UNIQUE", columns: ["NAME"], name: "UQ_MIRA_IS_NAME" } });
    await expect(coll(T).insertOne({ NAME: "a" })).rejects.toThrow(/ORA-00001/);
    await schema.alterTable(T, { dropConstraint: "UQ_MIRA_IS_NAME" });
    await schema.alterTable(T, { addConstraint: { type: "UNIQUE", columns: ["NOTE"] } });
    expect(await exists("INDEX", `UNIQUE_${T}_NOTE`)).toBe(true);
    await expect(schema.alterTable(T, {})).rejects.toThrow();
  });

  it("views from a QueryBuilder and from SQL; OR REPLACE / FORCE; invalid input", async () => {
    await schema.createView("MIRA_IS_V", coll(U).find({}).project({ ID: 1, NAME: 1 }));
    expect(await coll("MIRA_IS_V").countDocuments()).toBe(10);
    await schema.createView("MIRA_IS_V", `SELECT "NAME" FROM "${U}" WHERE "STATUS" = 'active'`, { orReplace: true, force: true });
    expect(await coll("MIRA_IS_V").countDocuments()).toBe(6);
    await expect(schema.createView("MIRA_IS_V", 42 as never)).rejects.toThrow();
    await schema.dropView("MIRA_IS_V");
    expect(await exists("VIEW", "MIRA_IS_V")).toBe(false);
    await schema.dropView("MIRA_IS_V", { ifExists: true });
    await expect(schema.dropView("MIRA_IS_V")).rejects.toThrow(/ORA-00942/);
  });

  it("createSequence with every option", async () => {
    await schema.createSequence("MIRA_IS_SEQ", { startWith: 10, incrementBy: 5, minValue: 10, maxValue: 20, cycle: true, cache: 2 });
    const next = async () => (await rawExec<{ V: number }>('SELECT "MIRA_IS_SEQ".NEXTVAL AS V FROM DUAL')).rows![0].V;
    expect([await next(), await next(), await next(), await next()]).toEqual([10, 15, 20, 10]);
    await rawExec('DROP SEQUENCE "MIRA_IS_SEQ"');
    await schema.createSequence("MIRA_IS_SEQ");
    expect(await next()).toBe(1);
  });

  it("truncate, rename, drop (cascade / ifExists)", async () => {
    await schema.truncateTable(T);
    expect(await coll(T).countDocuments()).toBe(0);
    await schema.renameTable(T, `${T}_RENAMED`);
    expect(await exists("TABLE", `${T}_RENAMED`)).toBe(true);
    await expect(schema.dropTable(P)).rejects.toThrow(/ORA-02449/); // referenced by the FK
    await schema.dropTable(P, { cascade: true });
    await schema.dropTable(`${T}_RENAMED`);
    await schema.dropTable(`${T}_RENAMED`, { ifExists: true });
    await expect(schema.dropTable(`${T}_RENAMED`)).rejects.toThrow(/ORA-00942/);
  });
});

describe("integration: OracleDCL", () => {
  const dcl = new OracleDCL(db as never);
  it("grant / revoke on an owned table, verified in USER_TAB_PRIVS_MADE", async () => {
    await dcl.grant(["SELECT"], U, "PUBLIC");
    const made = await rawExec<{ N: number }>("SELECT COUNT(*) AS N FROM USER_TAB_PRIVS_MADE WHERE TABLE_NAME = :t AND GRANTEE = 'PUBLIC'", { t: U });
    expect(Number(made.rows![0].N)).toBe(1);
    await dcl.revoke(["SELECT"], U, "PUBLIC");
    const after = await rawExec<{ N: number }>("SELECT COUNT(*) AS N FROM USER_TAB_PRIVS_MADE WHERE TABLE_NAME = :t AND GRANTEE = 'PUBLIC'", { t: U });
    expect(Number(after.rows![0].N)).toBe(0);
  });

  it("missing table / unknown user → insufficient-privilege message; bad privilege → generic", async () => {
    await expect(dcl.grant(["SELECT"], "MIRA_NO_SUCH_TABLE", "PUBLIC")).rejects.toThrow();
    await expect(dcl.revoke(["SELECT"], U, "MIRA_NO_SUCH_USER")).rejects.toThrow();
    await expect(dcl.grant(["FLY"], U, "PUBLIC")).rejects.toThrow(/OracleDCL\.grant/);
    await expect(dcl.revoke(["FLY"], U, "PUBLIC")).rejects.toThrow(/OracleDCL\.revoke/);
  });
});

describe("integration: performance utilities", () => {
  it("explainPlan from a QueryBuilder (binds) and from SQL", async () => {
    const plan = await perf.explainPlan(coll(U).find({ STATUS: "active" }));
    expect(plan.length).toBeGreaterThan(0);
    expect(JSON.stringify(plan)).toContain(U);
    expect((await perf.explainPlan(`SELECT * FROM "${U}"`)).length).toBeGreaterThan(0);
  });

  it("analyze refreshes optimizer statistics", async () => {
    await coll(U).insertOne({ NAME: "Stat", EMAIL: "s@mira.test" });
    await perf.analyze(U);
    expect(await coll(U).estimatedDocumentCount()).toBe(11);
  });

  it("materialized view lifecycle: create (QB + SQL, orReplace), refresh in each mode, drop", async () => {
    await perf.createMaterializedView("MIRA_IS_MV", coll(U).find({}).project({ ID: 1, NAME: 1 }), { orReplace: true });
    expect(await coll("MIRA_IS_MV").countDocuments()).toBe(11);
    await perf.createMaterializedView("MIRA_IS_MV", `SELECT "STATUS", COUNT(*) AS N FROM "${U}" GROUP BY "STATUS"`, {
      orReplace: true,
      refreshMode: "complete",
      refreshOn: "demand",
      buildMode: "deferred",
    });
    expect(await coll("MIRA_IS_MV").countDocuments()).toBe(0); // BUILD DEFERRED: empty until refreshed
    await perf.refreshMaterializedView("MIRA_IS_MV");
    expect(await coll("MIRA_IS_MV").countDocuments()).toBeGreaterThan(0);
    await perf.refreshMaterializedView("MIRA_IS_MV", "force");
    await perf.refreshMaterializedView("MIRA_IS_MV", "fast");
    expect(await coll("MIRA_IS_MV").countDocuments()).toBeGreaterThan(0);
    expect(await perf.dropMaterializedView("MIRA_IS_MV")).toEqual({ acknowledged: true });
    await expect(perf.dropMaterializedView("MIRA_IS_MV")).rejects.toThrow();
  });
});
