

/**
 * @fileoverview The db handle: one registered pool, with the methods the query
 * layer uses (withConnection, withTransaction, …). Internal: apps get a
 * handle from `createMira(config).db(pool)`, which also makes its
 * closePool() close that Mira instance rather than every pool.
 *
 * Always borrow through withConnection / withTransaction; never open a raw
 * connection.
 */

import * as config from "./oracle";
import { oracleMongoWrapperMessages as MSG } from "../shared/messages";

/**
 * Builds the handle for a registered pool.
 *
 * @param {string} connectionName - A pool name registered by createMira().
 * @returns The handle:
 *   - withConnection(fn)       borrow a connection, run fn(conn), release it
 *   - withTransaction(fn)      the same, committed on success, rolled back on a throw
 *   - withBatchConnection(fns) several operations on one connection
 *   - getPoolStats()           pool usage numbers
 *   - isHealthy()              this pool's circuit breaker
 *   - oracledb                 the driver module, for constants (OUT_FORMAT_OBJECT, BIND_OUT …)
 */
function createDb(connectionName: string) {
  if (!connectionName || typeof connectionName !== "string") {
    throw new TypeError(MSG.CREATEDB_INVALID_CONNECTION_NAME);
  }

  return {
    /** The pool name this db is bound to */
    connectionName,

    /**
     * Borrow a connection, run your callback, then auto-release.
     *
     * The connection is automatically returned to the pool when your
     * callback finishes (or throws). You never need to call conn.close().
     *
     * @param {Function} callback - async (conn) => result
     * @returns {Promise<*>} Whatever your callback returns
     *
     * @example
     *   const rows = await db.withConnection(async (conn) => {
     *     const result = await conn.execute("SELECT 1 FROM DUAL");
     *     return result.rows;
     *   });
     */
    withConnection: <T>(callback: (conn: DbConnection) => T | Promise<T>): Promise<T> =>
      config.withConnection(connectionName, callback),

    /**
     * Like withConnection, but wraps everything in a transaction.
     *
     * If your callback succeeds → COMMIT (changes are saved)
     * If your callback throws   → ROLLBACK (changes are undone)
     *
     * @param {Function} callback - async (conn) => result
     * @returns {Promise<*>} Whatever your callback returns
     */
    withTransaction: <T>(callback: (conn: DbConnection) => T | Promise<T>): Promise<T> =>
      config.withTransaction(connectionName, callback),

    /**
     * Run multiple operations on a single borrowed connection.
     * Useful for batch work where you don't need a full transaction
     * but want to avoid borrowing/releasing for each operation.
     *
     * @param {Function[]} operations - Array of async (conn) => result
     */
    withBatchConnection: (operations: ((...args: unknown[]) => unknown)[]) =>
      config.withBatchConnection(connectionName, operations),

    /** Get statistics about the connection pool (open, in-use, etc.) */
    getPoolStats: () => config.getPoolStats(),

    /** Returns true if this pool is healthy and accepting connections */
    isHealthy: () => config.isPoolHealthy(connectionName),

    /**
     * The raw oracledb driver module.
     * Needed when you need to reference Oracle-specific type constants like:
     *   - db.oracledb.OUT_FORMAT_OBJECT (return rows as objects, not arrays)
     *   - db.oracledb.BIND_OUT (for output bind variables in RETURNING clauses)
     *   - db.oracledb.NUMBER, db.oracledb.STRING (data type constants)
     */
    oracledb: config.oracledb,
  };
}

/** Bind values as the wrapper builds them from caller filters / documents. */
type DbBinds = Record<string, unknown> | unknown[];

/**
 * The connection a wrapper method (or a model's raw SQL) receives from withConnection /
 * withTransaction: node-oracledb's Connection, with `execute` narrowed to the promise form.
 *
 * - `binds` takes the wrapper's `DbBinds`. Bind values come from callers, and node-oracledb
 *   checks each one's type at execute time (NJS-011 / NJS-044 …), so the static type does not
 *   pretend to know them.
 * - Rows default to `Record<string, unknown>` (every pool uses OUT_FORMAT_OBJECT); pass `T`
 *   for a known row shape, e.g. `conn.execute<{ CNT: number }>(…)`.
 */
type DbConnection = Omit<import("oracledb").Connection, "execute" | "executeMany" | "queryStream"> & {
  execute<T = Record<string, unknown>>(
    sql: string,
    binds?: DbBinds,
    options?: import("oracledb").ExecuteOptions,
  ): Promise<import("oracledb").Result<T>>;
  executeMany<T = Record<string, unknown>>(
    sql: string,
    binds: DbBinds[] | number,
    options?: import("oracledb").ExecuteManyOptions,
  ): Promise<import("oracledb").Results<T>>;
  queryStream<T = Record<string, unknown>>(
    sql: string,
    binds?: DbBinds,
    options?: import("oracledb").QueryStreamOptions,
  ): import("oracledb").QueryStream<T>;
};

export { createDb };
/** The handle the query layer takes: a registered pool's methods. */
type WrapperDb = ReturnType<typeof createDb>;
/** What `mira.db()` returns: the same, plus closePool(), which closes that Mira instance. */
type MiraDb = WrapperDb & { closePool(): Promise<void> };

export type { DbConnection, DbBinds, WrapperDb, MiraDb };
