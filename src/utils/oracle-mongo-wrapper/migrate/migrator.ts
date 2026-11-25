/**
 * ============================================================================
 * migrate/migrator.ts — versioned schema migrations (Mira 2.1)
 * ============================================================================
 *
 *   // migrations/20261125_0001_create_orders.ts
 *   import type { MigrationContext } from "@jm-paunlagui/mira";
 *   import { Orders } from "../src/db/tables";
 *   export async function up({ schema, createTable }: MigrationContext) { await createTable(Orders); }
 *   export async function down({ schema }: MigrationContext) { await schema.dropTable("ORDERS"); }
 *
 *   const migrator = createMigrator(db, { dir: "migrations" });
 *   await migrator.up();            // apply every pending migration, in name order
 *   await migrator.down();          // roll back the last one
 *   await migrator.status();        // applied / pending / changed / missing
 *
 * HISTORY. Each applied migration is a row in MIRA_MIGRATIONS (name, checksum,
 * batch, applied at, duration). A migration whose file changed after it was
 * applied ("changed"), or whose file is gone ("missing"), stops up(): the
 * database no longer matches the code that describes it.
 *
 * LOCK. A run holds a row lock (SELECT … FOR UPDATE NOWAIT) on the one row of
 * MIRA_MIGRATIONS_LOCK, on a connection of its own, until it ends. A second
 * deployment migrating at the same time fails at once instead of interleaving.
 * Oracle releases the lock if the process dies. No extra grant is needed.
 *
 * ORACLE DDL IS NOT TRANSACTIONAL. Each DDL statement commits by itself, so a
 * migration that fails halfway cannot be rolled back automatically. Its history
 * row is written only when up() returns, and the error names the migration so
 * the schema can be fixed by hand before running again.
 *
 * DRY RUN. { dryRun: true } runs each migration against a recording connection:
 * nothing reaches the database, and the SQL each migration would execute is
 * returned. Reads inside a migration see no rows in a dry run.
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import type { DbConnection, WrapperDb } from "../db";
import { OracleSchema } from "../schema/OracleSchema";
import { OracleCollection } from "../core/OracleCollection";
import { quoteIdentifier } from "../utils";

/** What up() and down() receive. */
export interface MigrationContext {
  /** The db handle (a recording one in a dry run). */
  db: WrapperDb;
  /** DDL helpers: createTable, alterTable, dropTable, createView, createSequence … */
  schema: OracleSchema;
  /** A collection, e.g. for createIndex() or seed data. */
  collection(tableName: string): OracleCollection;
  /** CREATE TABLE from a defineTable() definition. */
  createTable(table: { create(db: WrapperDb, options?: { ifNotExists?: boolean }): Promise<unknown> }, options?: { ifNotExists?: boolean }): Promise<unknown>;
  /** Run one SQL statement (values always as binds). */
  execute(sql: string, binds?: Record<string, unknown> | unknown[]): Promise<unknown>;
  /** True in a dry run. */
  dryRun: boolean;
}

export interface Migration {
  /** Sorts the migrations: start it with a timestamp, e.g. "20261125_0001_create_orders". */
  name: string;
  up(ctx: MigrationContext): Promise<unknown> | unknown;
  down?(ctx: MigrationContext): Promise<unknown> | unknown;
  /** Defaults to a SHA-256 of the file (or of up/down's source for in-code migrations). */
  checksum?: string;
}

export interface MigratorOptions {
  /** Directory of migration files (.ts, .js, .cjs, .mjs). */
  dir?: string;
  /** Migrations given in code instead of (or as well as) a directory. */
  migrations?: Migration[];
  /** History table name (default MIRA_MIGRATIONS; the lock table adds _LOCK). */
  table?: string;
}

export type MigrationState = "applied" | "pending" | "changed" | "missing";
export interface MigrationStatus { name: string; state: MigrationState; batch: number | null; appliedAt: Date | null }
export interface MigrationRun { name: string; durationMs: number; sql: string[] }

const MIGRATION_FILE = /\.(ts|js|cjs|mjs)$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// isOperational: the adapter passes such errors through withConnection unwrapped,
// so callers see the migrator's own message and properties.
const fail = (why: string): never => {
  throw Object.assign(new Error(`[migrate] ${why}`), { isOperational: true });
};

const sha256 = (text: string | Buffer) => crypto.createHash("sha256").update(text).digest("hex");

/** A db whose connections record SQL instead of running it (dry run). */
function recordingDb(db: WrapperDb, sql: string[]): WrapperDb {
  const conn = {
    execute: async (text: string) => (sql.push(text.trim()), { rows: [], rowsAffected: 0, outBinds: {} }),
    executeMany: async (text: string) => (sql.push(text.trim()), { rowsAffected: 0, outBinds: [] }),
    commit: async () => {},
    rollback: async () => {},
    close: async () => {},
  } as unknown as DbConnection;
  const run = async <T>(cb: (c: DbConnection) => T | Promise<T>) => cb(conn);
  return { ...db, withConnection: run, withTransaction: run } as WrapperDb;
}

function context(db: WrapperDb, dryRun: boolean): MigrationContext {
  return {
    db,
    dryRun,
    schema: new OracleSchema(db),
    collection: (name) => new OracleCollection(name, db),
    createTable: (table, options) => table.create(db, options),
    execute: (sql, binds = {}) => db.withConnection((c) => c.execute(sql, binds as never, { autoCommit: true })),
  };
}

/** Load the migrations of a directory: one per file, sorted by file name. */
async function loadDir(dir: string): Promise<Migration[]> {
  if (!fs.existsSync(dir)) fail(`migration directory not found: ${dir}`);
  const files = fs.readdirSync(dir).filter((f) => MIGRATION_FILE.test(f) && !f.endsWith(".d.ts")).sort();
  const out: Migration[] = [];
  for (const file of files) {
    const full = path.resolve(dir, file);
    const mod = (await import(pathToFileURL(full).href)) as Record<string, unknown> & { default?: Record<string, unknown> };
    const src = (typeof mod.up === "function" ? mod : mod.default ?? {}) as Partial<Migration>;
    if (typeof src.up !== "function") fail(`${file} exports no up() function.`);
    out.push({ name: file.replace(MIGRATION_FILE, ""), up: src.up!, down: src.down, checksum: sha256(fs.readFileSync(full)) });
  }
  return out;
}

/** Create a migrator. Nothing is read or created until a method is called. */
function createMigrator(db: WrapperDb, options: MigratorOptions = {}) {
  const table = options.table ?? "MIRA_MIGRATIONS";
  const lockTable = `${table}_LOCK`;
  const T = quoteIdentifier(table);
  const L = quoteIdentifier(lockTable);

  /** The migrations, sorted, each with its checksum. */
  async function list(): Promise<Migration[]> {
    const all = [...(options.dir ? await loadDir(options.dir) : []), ...(options.migrations ?? [])];
    const seen = new Set<string>();
    for (const m of all) {
      if (typeof m.name !== "string" || !NAME.test(m.name)) fail(`invalid migration name ${JSON.stringify(m.name)}: use letters, digits, "_", "-" and ".".`);
      if (seen.has(m.name)) fail(`two migrations are named ${m.name}.`);
      seen.add(m.name);
      if (typeof m.up !== "function") fail(`${m.name} has no up() function.`);
    }
    return all
      .map((m) => ({ ...m, checksum: m.checksum ?? sha256(`${m.up.toString()}\n${m.down?.toString() ?? ""}`) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Create the history and lock tables when missing (ORA-00955: already there). */
  async function ensureTables(): Promise<void> {
    const create = async (sql: string) => {
      try {
        await db.withConnection((c) => c.execute(sql));
      } catch (err) {
        if (!/ORA-00955/.test(String((err as Error).message))) throw err;
      }
    };
    await create(`CREATE TABLE ${T} ("NAME" VARCHAR2(200) PRIMARY KEY, "CHECKSUM" VARCHAR2(64) NOT NULL, "BATCH" NUMBER NOT NULL, "APPLIED_AT" TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL, "DURATION_MS" NUMBER)`);
    await create(`CREATE TABLE ${L} ("ID" NUMBER PRIMARY KEY)`);
    await db.withConnection((c) => c.execute(`MERGE INTO ${L} l USING (SELECT 1 AS ID FROM DUAL) s ON (l."ID" = s.ID) WHEN NOT MATCHED THEN INSERT ("ID") VALUES (1)`, {}, { autoCommit: true }));
  }

  async function history(): Promise<Map<string, { CHECKSUM: string; BATCH: number; APPLIED_AT: Date }>> {
    const rows = await db.withConnection(async (c) => (await c.execute<{ NAME: string; CHECKSUM: string; BATCH: number; APPLIED_AT: Date }>(`SELECT "NAME", "CHECKSUM", "BATCH", "APPLIED_AT" FROM ${T}`, {}, { outFormat: db.oracledb.OUT_FORMAT_OBJECT })).rows ?? []);
    return new Map(rows.map((r) => [r.NAME, r]));
  }

  /** Run `work` while holding the migration lock on a connection of its own. */
  async function locked<T>(work: () => Promise<T>): Promise<T> {
    await ensureTables();
    return db.withConnection(async (lockConn) => {
      try {
        await lockConn.execute(`SELECT "ID" FROM ${L} WHERE "ID" = 1 FOR UPDATE NOWAIT`);
      } catch (err) {
        if (/ORA-00054/.test(String((err as Error).message))) fail(`another migration run holds the lock (${lockTable}); try again when it has finished.`);
        throw err;
      }
      try {
        return await work();
      } finally {
        await lockConn.rollback(); // releases the row lock
      }
    });
  }

  async function status(): Promise<MigrationStatus[]> {
    await ensureTables();
    const [migrations, applied] = [await list(), await history()];
    const known = new Set(migrations.map((m) => m.name));
    const out: MigrationStatus[] = migrations.map((m) => {
      const h = applied.get(m.name);
      return { name: m.name, state: !h ? "pending" : h.CHECKSUM === m.checksum ? "applied" : "changed", batch: h?.BATCH ?? null, appliedAt: h?.APPLIED_AT ?? null };
    });
    for (const [name, h] of applied) if (!known.has(name)) out.push({ name, state: "missing", batch: h.BATCH, appliedAt: h.APPLIED_AT });
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Run one migration step: for real, or recording its SQL. */
  async function step(m: Migration, direction: "up" | "down", dryRun: boolean): Promise<MigrationRun> {
    const fn = direction === "up" ? m.up : m.down;
    if (typeof fn !== "function") fail(`${m.name} has no down() function, so it cannot be rolled back.`);
    const sql: string[] = [];
    const t0 = Date.now();
    try {
      await fn!(context(dryRun ? recordingDb(db, sql) : db, dryRun));
    } catch (err) {
      const e = err as Error;
      throw Object.assign(new Error(`[migrate] ${m.name} ${direction}() failed: ${e.message}\nOracle DDL is not transactional: statements before the failure stay applied. Fix the schema by hand, then run again.`), { cause: e, migration: m.name, isOperational: true });
    }
    return { name: m.name, durationMs: Date.now() - t0, sql };
  }

  /**
   * Apply pending migrations in name order (all of them, or up to and including `to`).
   * Refuses while any applied migration is "changed" or "missing".
   */
  async function up(opts: { to?: string; dryRun?: boolean } = {}): Promise<MigrationRun[]> {
    return locked(async () => {
      const states = await status();
      const broken = states.filter((s) => s.state === "changed" || s.state === "missing");
      if (broken.length > 0) fail(`applied migrations no longer match their files: ${broken.map((s) => `${s.name} (${s.state})`).join(", ")}. Restore them, or fix the history in ${table} by hand.`);
      if (opts.to !== undefined && !states.some((s) => s.name === opts.to)) fail(`no migration named ${opts.to}.`);
      const migrations = await list();
      const pending = states.filter((s) => s.state === "pending" && (opts.to === undefined || s.name <= opts.to));
      const batch = Math.max(0, ...states.map((s) => s.batch ?? 0)) + 1;
      const runs: MigrationRun[] = [];
      for (const s of pending) {
        const m = migrations.find((x) => x.name === s.name)!;
        const run = await step(m, "up", opts.dryRun === true);
        if (!opts.dryRun) {
          await db.withConnection((c) => c.execute(`INSERT INTO ${T} ("NAME", "CHECKSUM", "BATCH", "DURATION_MS") VALUES (:n, :c, :b, :d)`, { n: m.name, c: m.checksum!, b: batch, d: run.durationMs }, { autoCommit: true }));
        }
        runs.push(run);
      }
      return runs;
    });
  }

  /**
   * Roll back applied migrations, newest first: `steps` of them (default 1), or every
   * one after `to` (so `to` stays applied; `to: null` rolls back all of them).
   */
  async function down(opts: { steps?: number; to?: string | null; dryRun?: boolean } = {}): Promise<MigrationRun[]> {
    return locked(async () => {
      const states = (await status()).filter((s) => s.state !== "pending");
      if (opts.to !== undefined && opts.to !== null && !states.some((s) => s.name === opts.to)) fail(`no applied migration named ${opts.to}.`);
      const steps = opts.steps ?? 1;
      if (!(Number.isInteger(steps) && steps > 0)) fail(`steps must be a positive integer, got ${String(opts.steps)}.`);
      const newestFirst = [...states].reverse();
      const to = opts.to;
      const targets = to !== undefined ? newestFirst.filter((s) => to === null || s.name > to) : newestFirst.slice(0, steps);
      const missing = targets.find((s) => s.state === "missing");
      if (missing) fail(`${missing.name} is applied but its file is gone: it cannot be rolled back.`);
      const migrations = await list();
      const runs: MigrationRun[] = [];
      for (const s of targets) {
        const m = migrations.find((x) => x.name === s.name)!;
        const run = await step(m, "down", opts.dryRun === true);
        if (!opts.dryRun) await db.withConnection((c) => c.execute(`DELETE FROM ${T} WHERE "NAME" = :n`, { n: m.name }, { autoCommit: true }));
        runs.push(run);
      }
      return runs;
    });
  }

  return { up, down, status, list };
}

/** The file name for a new migration: "<UTC yyyymmddHHMMSS>_<name>.ts". */
function migrationFileName(name: string, now: Date = new Date()): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!slug) fail("give the new migration a name, e.g. create_orders.");
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `${stamp}_${slug}.ts`;
}

/** The body of a new migration file. */
function migrationTemplate(importFrom = "@jm-paunlagui/mira"): string {
  return `import type { MigrationContext } from ${JSON.stringify(importFrom)};

export async function up({ schema, createTable, collection, execute }: MigrationContext) {
  // e.g. await createTable(Orders);   or   await schema.alterTable("ORDERS", { add: { NOTE: { type: "VARCHAR2(400)" } } });
}

export async function down({ schema }: MigrationContext) {
  // undo up(), e.g. await schema.dropTable("ORDERS");
}
`;
}

export { createMigrator, migrationFileName, migrationTemplate };
export type Migrator = ReturnType<typeof createMigrator>;
