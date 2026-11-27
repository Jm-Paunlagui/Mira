/**
 * Shared test helpers: one db handle for every suite, fixture tables in the
 * MIRA test schema, and a metrics recorder the root hooks persist.
 *
 * Every table a suite creates is prefixed MIRA_ + a suite tag (MIRA_IT_, MIRA_PF_ …)
 * and is dropped in that suite's after() hook. Only MIRA_TEST_RESULTS and
 * MIRA_TEST_METRICS outlive a run — they hold the run history.
 *
 * Identifiers are passed upper-case: the wrapper quotes them verbatim, so a
 * lower-case name would create a case-sensitive object.
 */
import { createDb, OracleCollection, OracleSchema } from "../../src";

export const db = createDb("appDb");
export const schema = new OracleSchema(db);
export const coll = (name: string) => new OracleCollection(name, db);

/** Stable id for this mocha process, written with every persisted row. */
export const RUN_ID = process.env.MIRA_RUN_ID ?? `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}_${process.pid}`;

export async function dropIfExists(...tables: string[]) {
  for (const t of tables) await schema.dropTable(t, { ifExists: true, cascade: true });
}

export async function rawExec<T = Record<string, unknown>>(sql: string, binds: Record<string, unknown> | unknown[] = {}) {
  return db.withConnection((c) => c.execute<T>(sql, binds, { outFormat: db.oracledb.OUT_FORMAT_OBJECT, autoCommit: true }));
}

/** Users fixture — 10 rows with known values so every assertion is exact. */
export const USERS = [
  { NAME: "Juan", EMAIL: "juan@mira.test", STATUS: "active", AGE: 25, CITY: "Manila", SCORE: 80 },
  { NAME: "Maria", EMAIL: "maria@mira.test", STATUS: "active", AGE: 31, CITY: "Cebu", SCORE: 92 },
  { NAME: "Pedro", EMAIL: "pedro@mira.test", STATUS: "inactive", AGE: 45, CITY: "Davao", SCORE: 55 },
  { NAME: "Ana", EMAIL: "ana@mira.test", STATUS: "active", AGE: 19, CITY: "Manila", SCORE: 71 },
  { NAME: "Jose", EMAIL: "jose@mira.test", STATUS: "banned", AGE: 52, CITY: "Cebu", SCORE: 10 },
  { NAME: "Liza", EMAIL: "liza@mira.test", STATUS: "active", AGE: 28, CITY: "Manila", SCORE: 88 },
  { NAME: "Carlo", EMAIL: "carlo@mira.test", STATUS: "inactive", AGE: 37, CITY: "Davao", SCORE: 64 },
  { NAME: "Bea", EMAIL: "bea@mira.test", STATUS: "active", AGE: 22, CITY: "Iloilo", SCORE: 99 },
  { NAME: "Migs", EMAIL: "migs@mira.test", STATUS: "trial", AGE: 17, CITY: "Cebu", SCORE: 40 },
  { NAME: "Tess", EMAIL: "tess@mira.test", STATUS: "active", AGE: 60, CITY: null, SCORE: 75 },
];

export async function createUsers(table: string) {
  await dropIfExists(table);
  await schema.createTable(table, {
    ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
    NAME: { type: "VARCHAR2(100)", notNull: true },
    EMAIL: { type: "VARCHAR2(200)", notNull: true },
    STATUS: { type: "VARCHAR2(20)", default: "'active'" },
    AGE: { type: "NUMBER(3)" },
    CITY: { type: "VARCHAR2(50)" },
    SCORE: { type: "NUMBER" },
    LOGIN_COUNT: { type: "NUMBER", default: "0" },
    UPDATED_AT: { type: "TIMESTAMP" },
  });
  await coll(table).insertMany(USERS);
}

/** Orders fixture: 4 regions x 4 quarters x 2 products, deterministic amounts. */
export async function createOrders(table: string, usersTable: string) {
  await dropIfExists(table);
  await schema.createTable(table, {
    ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
    USER_ID: { type: "NUMBER", references: { table: usersTable, column: "ID" } },
    REGION: { type: "VARCHAR2(20)" },
    PRODUCT: { type: "VARCHAR2(20)" },
    QUARTER: { type: "VARCHAR2(2)" },
    AMOUNT: { type: "NUMBER(12,2)" },
    STATUS: { type: "VARCHAR2(20)" },
  });
  const users = await coll(usersTable).find({}).sort({ ID: 1 }).project({ ID: 1 }).toArray();
  const rows: Record<string, unknown>[] = [];
  let i = 0;
  for (const region of ["North", "South", "East", "West"])
    for (const q of ["Q1", "Q2", "Q3", "Q4"])
      for (const product of ["Laptop", "Phone"]) {
        rows.push({
          USER_ID: users[i % users.length].ID,
          REGION: region,
          PRODUCT: product,
          QUARTER: q,
          AMOUNT: 100 * (i + 1),
          STATUS: i % 3 === 0 ? "pending" : "completed",
        });
        i++;
      }
  await coll(table).insertMany(rows, { returning: [] });
  return rows;
}

/** Employees fixture: 3-level org chart. */
export async function createEmployees(table: string) {
  await dropIfExists(table);
  await schema.createTable(table, {
    ID: { type: "NUMBER", primaryKey: true },
    NAME: { type: "VARCHAR2(50)" },
    MANAGER_ID: { type: "NUMBER" },
    DEPT: { type: "VARCHAR2(20)" },
    SALARY: { type: "NUMBER" },
  });
  await coll(table).insertMany(
    [
      { ID: 1, NAME: "CEO", MANAGER_ID: null, DEPT: "EXEC", SALARY: 500 },
      { ID: 2, NAME: "CTO", MANAGER_ID: 1, DEPT: "ENG", SALARY: 300 },
      { ID: 3, NAME: "CFO", MANAGER_ID: 1, DEPT: "FIN", SALARY: 290 },
      { ID: 4, NAME: "Dev1", MANAGER_ID: 2, DEPT: "ENG", SALARY: 120 },
      { ID: 5, NAME: "Dev2", MANAGER_ID: 2, DEPT: "ENG", SALARY: 130 },
      { ID: 6, NAME: "Acct", MANAGER_ID: 3, DEPT: "FIN", SALARY: 100 },
    ],
    { returning: [] },
  );
}

/** Run-history tables. Created on demand, never dropped by the suite. */
export async function ensureHistoryTables() {
  await schema.createTable(
    "MIRA_TEST_RESULTS",
    {
      ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
      RUN_ID: { type: "VARCHAR2(40)", notNull: true },
      CATEGORY: { type: "VARCHAR2(20)" },
      SUITE: { type: "VARCHAR2(300)" },
      TITLE: { type: "VARCHAR2(400)" },
      STATE: { type: "VARCHAR2(10)" },
      DURATION_MS: { type: "NUMBER" },
      ERROR: { type: "VARCHAR2(2000)" },
      CREATED_AT: { type: "TIMESTAMP", default: "SYSTIMESTAMP" },
    },
    { ifNotExists: true },
  );
  await schema.createTable(
    "MIRA_TEST_METRICS",
    {
      ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
      RUN_ID: { type: "VARCHAR2(40)", notNull: true },
      CATEGORY: { type: "VARCHAR2(20)" },
      METRIC: { type: "VARCHAR2(200)" },
      VALUE: { type: "NUMBER" },
      UNIT: { type: "VARCHAR2(20)" },
      NOTE: { type: "VARCHAR2(400)" },
      CREATED_AT: { type: "TIMESTAMP", default: "SYSTIMESTAMP" },
    },
    { ifNotExists: true },
  );
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export type Metric = { category: string; metric: string; value: number; unit: string; note?: string };
export const metrics: Metric[] = [];
export function recordMetric(m: Metric) {
  metrics.push(m);
}

export function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export async function timeIt<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const r = await fn();
  return [r, performance.now() - t0];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Connections checked out of appDb once the pool settles. The pool health monitor
 * borrows one connection for a ping every 30 s, so a single reading can catch that
 * probe in flight (seen on CI). A leaked connection never comes back, so the count
 * is re-read for up to 2 s and the lowest value is returned: a leak still shows.
 */
export async function appDbInUse(): Promise<number> {
  let lowest = Infinity;
  for (const deadline = Date.now() + 2000; ; ) {
    const stats = await db.getPoolStats();
    const p = stats.pools.appDb as { connectionsInUse?: number } | undefined;
    lowest = Math.min(lowest, p?.connectionsInUse ?? 0);
    if (lowest === 0 || Date.now() >= deadline) return lowest;
    await sleep(50);
  }
}
