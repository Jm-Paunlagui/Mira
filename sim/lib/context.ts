/**
 * Builds the simulation context: points Mira's pools at the simulation's own
 * schema, refuses to run anywhere else, and hands the stages a TRACKED copy of
 * the public API plus an untracked raw-SQL handle for verification.
 *
 * Schema switch: Mira already redirects appDb / appDbBulk to APP_TEST_DB_* when
 * NODE_ENV=development and APP_TEST_DB_USERNAME is set (src/driver/registry.ts).
 * The simulation sets those from MIRA_SIM_DB_* before Mira is first imported,
 * so the library is exercised through its normal configuration path.
 */
import * as tracker from "./tracker";

export type Api = typeof import("../../src");
type Db = ReturnType<Api["createDb"]>;

export interface Ctx {
  api: Api;
  /** The tracked db handle every stage uses. */
  db: Db;
  /** Untracked: runs hand-written SQL to verify what Mira did. Rows as objects. */
  raw: <T = Record<string, unknown>>(sql: string, binds?: Record<string, unknown> | unknown[]) => Promise<T[]>;
  /** Untracked: number of rows in a table, by hand-written SQL. */
  rawCount: (table: string, where?: string, binds?: Record<string, unknown>) => Promise<number>;
  schemaUser: string;
}

export async function buildContext(): Promise<Ctx> {
  const user = (process.env.MIRA_SIM_DB_USERNAME ?? "").trim();
  const password = process.env.MIRA_SIM_DB_PASSWORD ?? "";
  if (!user || !password) {
    throw new Error("MIRA_SIM_DB_USERNAME / MIRA_SIM_DB_PASSWORD are not set. Create the schema with sim/setup-schema.sql and add both to .env.");
  }
  for (const other of [process.env.APP_DB_USERNAME, process.env.APP_TEST_DB_USERNAME]) {
    if (other && other.trim().toUpperCase() === user.toUpperCase()) {
      throw new Error(`Refusing to run: MIRA_SIM_DB_USERNAME (${user}) is also the app or test schema. The simulation drops and rebuilds its SIM_* objects, so it needs a schema of its own.`);
    }
  }

  process.env.NODE_ENV = "development";
  process.env.APP_TEST_DB_USERNAME = user;
  process.env.APP_TEST_DB_PASSWORD = password;
  process.env.DB_TEST_HOST = process.env.MIRA_SIM_DB_HOST ?? "";
  process.env.DB_TEST_PORT = process.env.MIRA_SIM_DB_PORT ?? "";
  process.env.DB_TEST_SID = process.env.MIRA_SIM_DB_SID ?? "";
  if (!process.env.MIRA_LOGS) process.env.ENABLE_CONSOLE_LOGS = "false";

  const mod = (await import("../../src")) as Api;
  const { Session } = await import("../../src/core/Transaction");

  // Untracked handle for verification, created before anything is wrapped.
  const rawDb = mod.createDb("appDb");
  const raw = async <T = Record<string, unknown>>(sql: string, binds: Record<string, unknown> | unknown[] = {}) =>
    (await rawDb.withConnection((c) => c.execute<T>(sql, binds, { outFormat: rawDb.oracledb.OUT_FORMAT_OBJECT, autoCommit: true }))).rows ?? [];
  const rawCount = async (table: string, where = "", binds: Record<string, unknown> = {}) =>
    Number((await raw<{ N: number }>(`SELECT COUNT(*) AS N FROM "${table}" ${where}`, binds))[0].N);

  // Safety: the pools must really be on the simulation schema before anything is dropped.
  const [{ U }] = await raw<{ U: string }>("SELECT USER AS U FROM DUAL");
  if (U !== user.toUpperCase()) throw new Error(`Refusing to run: connected as ${U}, expected ${user.toUpperCase()}.`);

  // The two CTE result classes are not exported; reach them through an instance.
  const probe = new mod.OracleCollection("DUAL", rawDb);
  const CTEResult = Object.getPrototypeOf(mod.withCTE(rawDb, { X: probe.find({}) })).constructor;
  const SeriesResult = Object.getPrototypeOf(mod.series(rawDb, { start: 1, end: 1 })).constructor;
  const RecursiveCTEResult = Object.getPrototypeOf(mod.withRecursiveCTE(rawDb, "X", { anchor: probe.find({}), recursive: { collection: "DUAL", joinOn: {} } })).constructor;

  for (const [label, cls] of [
    ["OracleCollection", mod.OracleCollection],
    ["QueryBuilder", mod.QueryBuilder],
    ["Transaction", mod.Transaction],
    ["Session", Session],
    ["OracleSchema", mod.OracleSchema],
    ["OracleDCL", mod.OracleDCL],
    ["SetResultBuilder", mod.SetResultBuilder],
    ["CTEResult", CTEResult],
    ["RecursiveCTEResult", RecursiveCTEResult],
    ["SeriesResult", SeriesResult],
    ["TypedTable", mod.TypedTable],
    ["ModelCollection", mod.ModelCollection],
  ] as const)
    tracker.trackClass(label, cls as { prototype: object });

  const api: Record<string, unknown> = { ...mod };
  for (const [name, v] of Object.entries(mod)) {
    if (typeof v !== "function" || /^[A-Z]/.test(name)) continue; // classes are tracked by prototype
    if (name === "createDb") api[name] = tracker.trackFn(name, v as never, (d) => tracker.trackObject("db", d as object));
    else if (name === "createPerformance") api[name] = tracker.trackFn(name, v as never, (p) => tracker.trackObject("performance", p as object));
    else if (name === "createMigrator") api[name] = tracker.trackFn(name, v as never, (m) => tracker.trackObject("migrator", m as object));
    else api[name] = tracker.trackFn(name, v as never);
    Object.assign(api[name] as object, v); // keep a function's own properties (sql.ident)
  }
  // Register the db-handle and performance methods up front, so an unused one is reported.
  tracker.trackObject("db", rawDb);
  tracker.trackObject("performance", mod.createPerformance(rawDb) as object);
  tracker.trackObject("migrator", mod.createMigrator(rawDb) as object);

  const tracked = api as unknown as Api;
  return { api: tracked, db: tracked.createDb("appDb"), raw, rawCount, schemaUser: U };
}
