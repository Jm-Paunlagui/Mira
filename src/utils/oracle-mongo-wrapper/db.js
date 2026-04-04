"use strict";

/**
 * ============================================================================
 * db.js — Database Connection Factory
 * ============================================================================
 *
 * This is the ENTRY POINT for all database access in the library.
 *
 * WHAT DOES IT DO?
 *   It creates a "db" object that knows how to borrow database connections
 *   from a pre-configured connection pool and return them when done.
 *   Think of it like checking out a library book — you borrow the connection,
 *   use it, then the library takes it back automatically.
 *
 * WHY DO WE NEED THIS?
 *   Databases limit how many connections can be open at once. A connection
 *   pool manages a set of reusable connections. This factory gives you
 *   a clean interface to use that pool without managing connections manually.
 *
 * HOW TO USE:
 *   const db = createDb("userAccount");
 *   // Now pass `db` to OracleCollection, OracleSchema, Transaction, etc.
 *   // You NEVER need to open or close connections yourself.
 *
 * THE KEY RULE:
 *   Always use db.withConnection() or db.withTransaction() to access
 *   the database. Never create raw connections manually.
 * ============================================================================
 */

const config = require("../../config");
const { oracleMongoWrapperMessages: MSG } = require("../../constants/messages");

/**
 * Creates a db interface bound to a named database connection pool.
 *
 * The connectionName maps to a pool configured in src/config/database.js.
 * The returned object provides methods to safely borrow connections,
 * run transactions, check pool health, etc.
 *
 * @param {string} connectionName - Which database pool to use (e.g. "userAccount")
 *   This name must match a key in your database.js configuration.
 * @returns {Object} The db interface with the following methods:
 *   - withConnection(fn)      — Borrow a connection, run fn(conn), auto-release
 *   - withTransaction(fn)     — Same, but wrapped in BEGIN/COMMIT/ROLLBACK
 *   - withBatchConnection(fns) — Run multiple operations on one connection
 *   - closePool()             — Shut down all connection pools (for app shutdown)
 *   - getPoolStats()          — Get current pool usage numbers
 *   - isHealthy()             — Quick health check on this pool
 *   - oracledb                — Direct access to the oracledb driver (for type constants)
 *
 * @example
 *   const db = createDb("userAccount");
 *   // Use it with OracleCollection:
 *   const users = new OracleCollection("users", db);
 *   // Use it with OracleSchema:
 *   const schema = new OracleSchema(db);
 */
function createDb(connectionName = "userAccount") {
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
        withConnection: (callback) =>
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
        withTransaction: (callback) =>
            config.withTransaction(connectionName, callback),

        /**
         * Run multiple operations on a single borrowed connection.
         * Useful for batch work where you don't need a full transaction
         * but want to avoid borrowing/releasing for each operation.
         *
         * @param {Function[]} operations - Array of async (conn) => result
         */
        withBatchConnection: (operations) =>
            config.withBatchConnection(connectionName, operations),

        /** Gracefully close ALL database pools. Call during app shutdown. */
        closePool: () => config.closeAll(),

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

module.exports = { createDb };
