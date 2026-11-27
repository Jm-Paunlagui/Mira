/**
 * Builds the simulation context: opens Mira's pool on the simulation's own
 * schema, refuses to run anywhere else, and hands the stages a TRACKED copy of
 * the public API plus an untracked raw-SQL handle for verification.
 *
 * The pool is a createMira() pool named "appDb" on MIRA_SIM_DB_USERNAME /
 * MIRA_SIM_DB_PASSWORD. Its connect string is MIRA_SIM_DB_CONNECT_STRING, else
 * a TNS descriptor from MIRA_SIM_DB_HOST / _PORT / _SID, else the main
 * database's (MIRA_DB_CONNECT_STRING, or MIRA_DB_HOST + MIRA_DB_SERVICE).
 */
import * as tracker from "./tracker";

export type Api = typeof import("../../src");
type Db = import("../../src").MiraDb;

export interface Ctx {
  api: Api;
  /** The tracked db handle every stage uses. */
  db: Db;
  /** Untracked: runs hand-written SQL to verify what Mira did. Rows as objects. */
  raw: <T = Record<string, unknown>>(sql: string, binds?: Record<string, unknown> | unknown[]) => Promise<T[]>;
  /** Untracked: number of rows in a table, by hand-written SQL. */
  rawCount: (table: string, where?: string, binds?: Record<string, unknown>) => Promise<number>;
  schemaUser: string;
  /** Where the simulation schema is, for stages that open their own pools (createMira). */
  conn: { user: string; password: string; connectString: string };
}

export async function buildContext(): Promise<Ctx> {
  const user = (process.env.MIRA_SIM_DB_USERNAME ?? "").trim();
  const password = process.env.MIRA_SIM_DB_PASSWORD ?? "";
  if (!user || !password) {
    throw new Error("MIRA_SIM_DB_USERNAME / MIRA_SIM_DB_PASSWORD are not set. Create the schema with sim/setup-schema.sql and add both to .env.");
  }
  const testUser = process.env.MIRA_DB_USER?.trim();
  if (testUser && testUser.toUpperCase() === user.toUpperCase()) {
    throw new Error(`Refusing to run: MIRA_SIM_DB_USERNAME (${user}) is also the test schema (MIRA_DB_USER). The simulation drops and rebuilds its SIM_* objects, so it needs a schema of its own.`);
  }

  // Quiet unless MIRA_LOGS=1, which sends every Mira log line to the console.
  (await import("../../src/shared/log")).setLogger(process.env.MIRA_LOGS ? console : false);

  const mod = (await import("../../src")) as Api;
  const { Session } = await import("../../src/core/Transaction");

  const e = process.env;
  const val = (k: string) => e[k]?.trim() || "";
  const connectString =
    val("MIRA_SIM_DB_CONNECT_STRING") ||
    (val("MIRA_SIM_DB_HOST") && val("MIRA_SIM_DB_SID") ? mod.buildTNSConnectString(val("MIRA_SIM_DB_HOST"), val("MIRA_SIM_DB_PORT") || "1521", val("MIRA_SIM_DB_SID")) : "") ||
    val("MIRA_DB_CONNECT_STRING") ||
    (val("MIRA_DB_HOST") && val("MIRA_DB_SERVICE") ? `${val("MIRA_DB_HOST")}:${val("MIRA_DB_PORT") || "1521"}/${val("MIRA_DB_SERVICE")}` : "");
  if (!connectString) throw new Error("No connect string: set MIRA_SIM_DB_CONNECT_STRING, MIRA_SIM_DB_HOST + MIRA_SIM_DB_SID, or the main MIRA_DB_* connection.");
  const conn = { user, password, connectString };

  // Untracked: the sim's own instance, and a handle for verification, created before anything is wrapped.
  const mira = mod.createMira({ pools: { appDb: { ...conn, poolMin: 5, poolMax: 20, queueMax: 40, poolTimeout: 30 } } });
  const rawDb = mira.db();
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
    if (name === "createMira") api[name] = tracker.trackFn(name, v as never, (m) => tracker.trackMira(m as object));
    else if (name === "createPerformance") api[name] = tracker.trackFn(name, v as never, (p) => tracker.trackObject("performance", p as object));
    else if (name === "createMigrator") api[name] = tracker.trackFn(name, v as never, (m) => tracker.trackObject("migrator", m as object));
    else api[name] = tracker.trackFn(name, v as never);
    Object.assign(api[name] as object, v); // keep a function's own properties (sql.ident)
  }
  // Register the mira, db-handle and performance methods up front, so an unused one is reported.
  tracker.trackMira(mira);
  tracker.trackObject("db", rawDb);
  tracker.trackObject("performance", mod.createPerformance(rawDb) as object);
  tracker.trackObject("migrator", mod.createMigrator(rawDb) as object);

  const tracked = api as unknown as Api;
  return { api: tracked, db: tracker.trackObject("db", rawDb), raw, rawCount, schemaUser: U, conn };
}
