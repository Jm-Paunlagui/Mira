/**
 * INTEGRATION — createMira() against the MIRA test schema: pools passed in as
 * a config object, used through collection / schema / transaction, and closed
 * per instance without touching the shared appDb pool.
 *
 * The pools reuse appDb's credentials under their own names (MIRA_V3_*), so
 * each is a separate pool in the same schema.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { createMira, MiraConfigError, OracleCollection, OracleSchema, OracleDCL, Transaction } from "../../src/utils/oracle-mongo-wrapper";
import database from "../../src/config/database";
import config from "../../src/config";
import { rawExec, dropIfExists } from "../helpers/db";

const T = "MIRA_V3_ITEMS";
const app = database.getConnectionConfig("appDb");
const creds = { user: String(app.user), password: String(app.password), connectString: String(app.connectString) };

afterAll(async () => {
  await dropIfExists(T);
});

describe("integration: createMira", () => {
  it("runs CRUD, DDL and a transaction on its own pools; close() closes only them", async () => {
    const mira = createMira({
      pools: { miraV3: { ...creds, poolMin: 0, poolMax: 2, queueMax: 4 }, miraV3Spare: { ...creds, poolMin: 0, poolMax: 1 } },
      defaultPool: "miraV3",
    });
    expect(mira.config.poolNames).toEqual(["miraV3", "miraV3Spare"]);
    expect(mira.closed).toBe(false);
    expect(mira.db()).toBe(mira.db("miraV3"));
    expect(mira.db().connectionName).toBe("miraV3");
    expect(mira.schema()).toBeInstanceOf(OracleSchema);
    expect(mira.dcl()).toBeInstanceOf(OracleDCL);
    expect(mira.transaction()).toBeInstanceOf(Transaction);
    expect(() => mira.db("appDb" as "miraV3")).toThrow('[mira] Unknown pool "appDb". This instance has: miraV3, miraV3Spare');

    await mira.schema().dropTable(T, { ifExists: true });
    await mira.schema().createTable(T, { ID: { type: "NUMBER", primaryKey: true }, NAME: { type: "VARCHAR2(40)" } });
    const items = mira.collection(T);
    expect(items).toBeInstanceOf(OracleCollection);
    await items.insertOne({ ID: 1, NAME: "pen" });
    await mira.transaction().withTransaction(async (s) => {
      await s.collection(T).insertOne({ ID: 2, NAME: "ink" });
    });
    expect(await items.countDocuments()).toBe(2);
    expect(await items.findOne({ ID: 2 })).toEqual({ ID: 2, NAME: "ink" });
    expect(config.isPoolOpen("miraV3")).toBe(true);
    expect(config.isPoolOpen("miraV3Spare")).toBe(false);

    // The db handle's closePool() closes this instance, not every pool in the process.
    await mira.db().closePool();
    await mira.close(); // idempotent
    expect(mira.closed).toBe(true);
    expect(config.isPoolOpen("miraV3")).toBe(false);
    expect(() => database.getConnectionConfig("miraV3")).toThrow(/Unknown connection "miraV3"/);
    expect(() => mira.collection(T)).toThrow("[mira] This Mira instance is closed; create a new one with createMira().");

    // The shared appDb pool is still serving.
    const rows = await rawExec<{ N: number }>(`SELECT COUNT(*) AS N FROM "${T}"`);
    expect(rows.rows?.[0]?.N).toBe(2);
  });

  it("refuses a pool name that is already open in the process", async () => {
    await rawExec("SELECT 1 FROM DUAL"); // appDb is open
    expect(() => createMira({ pools: { appDb: creds } })).toThrow('[mira] Pool "appDb" is already open in this process. Use another name, or close it first.');
    expect(database.getConnectionConfig("appDb")).toBe(app);
  });

  it("two live instances cannot share a name; a failed register rolls back", async () => {
    const first = createMira({ pools: { miraHeld: creds } });
    expect(() => createMira({ pools: { miraFresh: creds, miraHeld: creds }, defaultPool: "miraFresh" })).toThrow(/"miraHeld" is already registered/);
    expect(() => database.getConnectionConfig("miraFresh")).toThrow(/Unknown connection/);
    await first.close();
    const second = createMira({ pools: { miraHeld: creds } });
    await second.close();
  });

  it("invalid config throws MiraConfigError before anything is registered", () => {
    expect(() => createMira({ pools: { miraBadCfg: { ...creds, poolMax: 0 } } })).toThrow(MiraConfigError);
    expect(() => database.getConnectionConfig("miraBadCfg")).toThrow(/Unknown connection/);
  });

  it("close() after a pool that never came up logs and still unregisters", async () => {
    const mira = createMira({ pools: { miraDown: { user: "nobody", password: "x", connectString: "127.0.0.1:1/NOPE", connectTimeout: 1000 } } });
    const failed = mira.db().withConnection(async () => 1).catch((e: Error) => e);
    expect(config.isPoolOpen("miraDown")).toBe(true);
    await mira.close();
    expect(await failed).toBeInstanceOf(Error);
    expect(config.isPoolOpen("miraDown")).toBe(false);
    expect(() => database.getConnectionConfig("miraDown")).toThrow(/Unknown connection/);
  });
});
