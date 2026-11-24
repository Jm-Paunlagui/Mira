

/**
 * ============================================================================
 * Transaction.js — Transaction Manager with Sessions & Savepoints
 * ============================================================================
 *
 * WHAT IS A TRANSACTION?
 *   A transaction groups multiple database operations into one "all or nothing"
 *   unit. Either ALL operations succeed (COMMIT), or ALL are rolled back
 *   (ROLLBACK) if any one fails. This prevents your data from ending up
 *   in a half-completed state.
 *
 *   Real-world example: Transferring money from Account A to Account B.
 *   You need TWO operations: subtract from A, add to B.
 *   If subtracting succeeds but adding fails, you'd lose money without
 *   a transaction to roll everything back.
 *
 * WHAT IS A SESSION?
 *   A Session wraps a single database connection inside a transaction.
 *   It gives you the collection() method to work with tables, and
 *   savepoint/rollbackTo methods for partial rollbacks within the
 *   transaction.
 *
 * WHAT IS A SAVEPOINT?
 *   A savepoint is a "bookmark" within a transaction. If something goes
 *   wrong after the savepoint, you can roll back to that point without
 *   undoing everything — just the work done after the savepoint.
 *
 * HOW TO USE:
 *   const txManager = new Transaction(db);
 *   await txManager.withTransaction(async (session) => {
 *     // All operations here share ONE connection and ONE transaction
 *     await session.collection("orders").insertOne({ item: "pen" });
 *     await session.savepoint("after_order");
 *     try {
 *       await session.collection("payments").insertOne({ amount: -999 });
 *     } catch {
 *       await session.rollbackTo("after_order"); // undo only the payment
 *     }
 *   });
 *   // If we get here, everything that wasn't rolled back is COMMITTED.
 *   // If an unhandled error was thrown, EVERYTHING is rolled back.
 * ============================================================================
 */

import type { DbConnection } from "./db";
import { OracleCollection } from "./core/OracleCollection";

/**
 * Validate a savepoint name — must be a safe Oracle identifier.
 * Only allows letters, digits, and underscores to prevent SQL injection.
 */
function _validateSavepointName(name: unknown) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(
            `Invalid savepoint name "${name}": must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
        );
    }
}

/**
 * Session — Holds a reference to the raw database connection.
 *
 * You don't create Sessions directly. They are created by Transaction.withTransaction()
 * and passed to your callback function.
 *
 * The Session ensures that every collection you create through it reuses
 * the SAME connection — this is what makes the transaction work. If each
 * collection created its own connection, they'd be independent operations
 * with no transactional guarantee.
 */
class Session {
    declare db: import("./db").WrapperDb;
    declare _conn: DbConnection;
    /**
     * @param {Object} conn - The raw Oracle database connection (from the pool)
     * @param {Object} db  - The db interface (from createDb) for driver constants
     */
    constructor(conn: DbConnection, db: import("./db").WrapperDb) {
        this._conn = conn;
        this.db = db;
    }

    /**
     * Get an OracleCollection that's bound to this session's connection.
     *
     * Any operations you perform on this collection (insert, update, delete)
     * will be part of the current transaction. They won't be committed
     * until the transaction completes successfully.
     *
     * @param {string} tableName - The table to work with (e.g. "users")
     * @returns {OracleCollection} A collection instance sharing this session's connection
     *
     * @example
     *   const users = session.collection("users");
     *   await users.insertOne({ name: "Ana" });
     *   // This INSERT is not committed yet — it's part of the transaction
     */
    collection(tableName: string): OracleCollection {
        return new OracleCollection(tableName, this.db, this._conn);
    }

    /**
     * Run a raw SQL statement on this session's connection, inside the
     * current transaction. Use this for statements that have no collection
     * equivalent — e.g. table locks (LOCK TABLE ... NOWAIT) or sequence
     * reads (SELECT my_seq.NEXTVAL FROM DUAL) — that must share the same
     * transaction as your collection operations.
     *
     * It is a thin passthrough to the underlying oracledb connection's
     * execute(); the result is whatever oracledb returns (rows are in
     * result.rows). Nothing is committed until the transaction completes.
     *
     * @param {string} sql          - The SQL statement to execute
     * @param {object} [binds={}]   - Bind variables
     * @param {object} [opts={}]    - oracledb execute options
     * @returns {Promise<object>} The raw oracledb execute result
     *
     * @example
     *   await session.execute(
     *     'LOCK TABLE "MY_SCHEMA"."MY_TABLE" IN EXCLUSIVE MODE NOWAIT',
     *   );
     *   const r = await session.execute("SELECT MY_SEQ.NEXTVAL FROM DUAL");
     *   const nextId = Number(r.rows[0][0]);
     */
    // The raw driver result; rows default to objects (OUT_FORMAT_OBJECT), pass T for a known shape.
    async execute<T = Record<string, unknown>>(sql: string, binds: import("./db").DbBinds = {}, opts: import("oracledb").ExecuteOptions = {}): Promise<import("oracledb").Result<T>> {
        return this._conn.execute<T>(sql, binds, opts);
    }

    /**
     * Create a savepoint — a "bookmark" you can roll back to later.
     *
     * Savepoints let you undo part of a transaction without losing everything.
     * You can create multiple savepoints within one transaction.
     *
     * @param {string} name - A name for this savepoint (e.g. "after_order")
     *
     * @example
     *   await session.savepoint("step_1_done");
     *   // ... do more work ...
     *   // If something goes wrong:
     *   await session.rollbackTo("step_1_done"); // undo work after step_1
     */
    async savepoint(name: string) {
        _validateSavepointName(name);
        await this._conn.execute(`SAVEPOINT ${name}`);
    }

    /**
     * Roll back everything done AFTER the named savepoint.
     *
     * Work done BEFORE the savepoint is preserved.
     * The transaction itself is still active — you can continue working.
     *
     * @param {string} name - The savepoint name to roll back to
     *
     * @example
     *   await session.collection("orders").insertOne({ item: "pen" });
     *   await session.savepoint("after_order");
     *   await session.collection("payments").insertOne({ amount: -1 }); // oops
     *   await session.rollbackTo("after_order");
     *   // The order INSERT is kept, but the payment INSERT is undone
     */
    async rollbackTo(name: string) {
        _validateSavepointName(name);
        await this._conn.execute(`ROLLBACK TO SAVEPOINT ${name}`);
    }

    /**
     * Release a savepoint (free the bookmarked state).
     *
     * NOTE: Oracle doesn't actually support RELEASE SAVEPOINT, so this
     * is a no-op (does nothing). It exists for API compatibility with
     * MongoDB's session interface.
     *
     * @param {string} _name - The savepoint name (ignored in Oracle)
     */
    async releaseSavepoint(_name: string) {
        // Oracle does not support RELEASE SAVEPOINT — no-op
    }
}

/**
 * Transaction — Manages database transactions.
 *
 * Create one with a db interface, then call withTransaction() to run
 * your operations inside a safe transaction boundary.
 *
 * KEY BEHAVIOR:
 *   - If your callback completes normally → COMMIT (changes saved)
 *   - If your callback throws an error    → ROLLBACK (changes undone)
 *   - You never need to call COMMIT or ROLLBACK manually
 */
class Transaction {
    declare db: import("./db").WrapperDb;
    /**
     * @param {Object} db - The db interface from createDb()
     *
     * @example
     *   const db = createDb("appDb");
     *   const txManager = new Transaction(db);
     */
    constructor(db: import("./db").WrapperDb) {
        this.db = db;
    }

    /**
     * Run a function inside a database transaction.
     *
     * The session object provides:
     *   - session.collection(name) — get a table bound to the transaction
     *   - session.savepoint(name)  — create a rollback point
     *   - session.rollbackTo(name) — undo work after a savepoint
     *
     * @param {Function} fn - async (session) => result
     * @returns {Promise<*>} Whatever your function returns
     *
     * @example
     *   await txManager.withTransaction(async (session) => {
     *     const orders = session.collection("orders");
     *     await orders.insertOne({ product: "laptop", qty: 1 });
     *     const payments = session.collection("payments");
     *     await payments.insertOne({ amount: 999.99 });
     *     // Both inserts COMMIT together when this function returns
     *   });
     */
    async withTransaction<T>(fn: (session: Session) => T | Promise<T>): Promise<T> {
        return this.db.withTransaction(async (conn: DbConnection) => {
            const session = new Session(conn, this.db);
            return fn(session);
        });
    }

    /**
     * Run reads against ONE consistent snapshot: every statement `fn` issues sees the
     * database as of the same SCN, however long the reads take.
     *
     * `SET TRANSACTION READ ONLY` is issued as the first statement on the connection
     * (Oracle rejects it anywhere else, ORA-01453), any write inside fails with
     * ORA-01456, and the transaction is always ended with a rollback so the pooled
     * connection goes back clean. A snapshot older than the undo retention fails with
     * ORA-01555, which the caller decides how to handle.
     *
     * @param {Function} fn - async (session) => result
     * @returns {Promise<*>} Whatever your function returns
     *
     * @example
     *   const counts = await new Transaction(createDb("appDbBulk")).withReadOnlyTransaction(async (session) => ({
     *     a: await session.collection("T_A").countDocuments({}),
     *     b: await session.collection("T_B").countDocuments({}),
     *   }));
     */
    async withReadOnlyTransaction<T>(fn: (session: Session) => T | Promise<T>): Promise<T> {
        return this.db.withConnection(async (conn: DbConnection) => {
            await conn.execute("SET TRANSACTION READ ONLY");
            try {
                return await fn(new Session(conn, this.db));
            } finally {
                // Ends the read-only transaction; nothing was written, so this only releases the snapshot.
                await conn.rollback().catch(() => {});
            }
        });
    }
}

export { Transaction, Session };
