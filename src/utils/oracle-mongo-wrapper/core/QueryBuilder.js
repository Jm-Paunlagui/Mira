"use strict";

/**
 * ============================================================================
 * QueryBuilder.js — Lazy, Chainable Query Cursor
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   QueryBuilder is a cursor that you get back when you call .find().
 *   It does NOT run any SQL when created. Instead, it accumulates your
 *   query preferences (sort, limit, skip, projection) through method
 *   chaining, and only builds & executes the SQL when you call a
 *   "terminal" method.
 *
 * WHY LAZY?
 *   It lets you build queries piece by piece:
 *     users.find({ active: true })   // ← No SQL runs here
 *       .sort({ name: 1 })           // ← Still no SQL
 *       .limit(10)                   // ← Still no SQL
 *       .toArray()                   // ← NOW the SQL is built and executed
 *
 *   This gives you maximum flexibility. You can pass the QueryBuilder
 *   around, add conditions in different parts of your code, and only
 *   execute it when you're ready.
 *
 * CHAIN METHODS (customize the query — returns the same QueryBuilder):
 *   .sort({ col: 1|-1 })     → ORDER BY
 *   .limit(n)                → FETCH FIRST n ROWS ONLY
 *   .skip(n)                 → OFFSET n ROWS
 *   .project({ col: 1|0 })   → SELECT specific columns
 *   .forUpdate(mode)         → FOR UPDATE (row locking)
 *
 * TERMINAL METHODS (execute the query — returns data/results):
 *   .toArray()     → Returns all matching rows as an array
 *   .next()        → Returns only the first matching row
 *   .hasNext()     → Returns true/false — does any row match?
 *   .forEach(fn)   → Streams rows one-by-one (O(1) memory — good for huge results)
 *   .count()       → Returns the count of matching rows
 *   .explain()     → Returns the SQL string WITHOUT executing it (debugging)
 *
 * THENABLE:
 *   QueryBuilder has a .then() method, so you can do:
 *     const rows = await users.find({ active: true });
 *   This works without calling .toArray() — the .then() internally
 *   delegates to .toArray().
 *
 * EXAMPLE:
 *   // Full chain
 *   const topUsers = await users.find({ status: "active" })
 *     .sort({ score: -1 })        // Highest scores first
 *     .skip(10)                   // Skip first 10
 *     .limit(5)                   // Take only 5
 *     .project({ name: 1, score: 1 }) // Only these columns
 *     .toArray();
 *
 *   // Stream large results
 *   await users.find({}).forEach(row => {
 *     // Each row streamed one-by-one — even for millions of rows
 *     processRow(row);
 *   });
 *
 *   // Debug: see the generated SQL
 *   const sql = await users.find({ status: "active" }).explain();
 *   console.log(sql); // SELECT * FROM "users" t0 WHERE "status" = :where_status_0
 * ============================================================================
 */

const {
    quoteIdentifier,
    buildOrderBy,
    buildProjection,
    rowToDoc,
} = require("../utils");
const { parseFilter } = require("../parsers/filterParser");
const {
    oracleMongoWrapperMessages: MSG,
} = require("../../../constants/messages");

class QueryBuilder {
    /**
     * Create a new QueryBuilder. Usually called internally by OracleCollection.find().
     *
     * @param {string} tableName - The table to query
     * @param {Object} filter - MongoDB-style filter (e.g. { status: "active" })
     * @param {Object} db - The db interface from createDb()
     * @param {Object} [conn] - Raw connection (if inside a transaction/session)
     * @param {Object} [options] - Initial options: sort, limit, skip, projection, etc.
     */
    constructor(tableName, filter, db, conn = null, options = {}) {
        this.tableName = tableName;
        this.filter = filter || {};
        this.db = db;
        this._conn = conn;
        this._sort = options.sort || null;
        this._limit = options.limit || null;
        this._skip = options.skip || null;
        this._projection = options.projection || null;
        this._forUpdate = options.forUpdate || null;
        this._sample = options.sample || null;
        this._asOf = options.asOf || null;
        this._terminated = false; // Prevents chaining after a terminal method
    }

    /**
     * Guard: prevents adding chain methods after a terminal method was called.
     * Once you call toArray(), count(), etc., the query is "sealed" —
     * you can't add .sort() or .limit() after.
     * @throws {Error} If a terminal method was already called
     */
    _checkTerminated() {
        if (this._terminated) {
            throw new Error(MSG.QUERY_BUILDER_CHAIN_AFTER_TERMINAL);
        }
    }

    // ─── Chain Methods (return the same QueryBuilder for chaining) ───

    /**
     * Set the sort order.
     * @param {Object} sortSpec - e.g. { name: 1, age: -1 } (1=ASC, -1=DESC)
     * @returns {QueryBuilder} this (for chaining)
     */
    sort(sortSpec) {
        this._checkTerminated();
        this._sort = sortSpec;
        return this;
    }

    /**
     * Limit the number of rows returned.
     * @param {number} n - Maximum number of rows
     * @returns {QueryBuilder} this (for chaining)
     */
    limit(n) {
        this._checkTerminated();
        this._limit = n;
        return this;
    }

    /**
     * Skip the first N rows (for pagination).
     *
     * Oracle equivalent: OFFSET n ROWS
     *
     * @param {number} n - Number of rows to skip
     * @returns {QueryBuilder} this (for chaining)
     *
     * @example
     *   // Page 2 (rows 11-20)
     *   const page2 = await users.find().skip(10).limit(10).toArray();
     */
    skip(n) {
        this._checkTerminated();
        this._skip = n;
        return this;
    }

    /**
     * Select which columns to include or exclude.
     *
     * Include mode: { name: 1, email: 1 }  → SELECT "name", "email"
     * Exclude mode: { password: 0 }         → SELECT * minus "password"
     *
     * Supports subquery projections for computed columns:
     *   { orderCount: { $subquery: { collection: "orders", fn: "count", filter: { user_id: "$id" } } } }
     *
     * @param {Object} projectionSpec - Columns to include (1) or exclude (0)
     * @returns {QueryBuilder} this (for chaining)
     */
    project(projectionSpec) {
        this._checkTerminated();
        this._projection = projectionSpec;
        return this;
    }

    /**
     * Lock the selected rows (SELECT ... FOR UPDATE).
     *
     * Used inside transactions to prevent other sessions from modifying
     * the rows you're reading until you commit/rollback.
     *
     * @param {boolean|string} mode
     *   - true         → FOR UPDATE (wait indefinitely for lock)
     *   - "nowait"     → FOR UPDATE NOWAIT (fail immediately if locked)
     *   - "skip locked" → FOR UPDATE SKIP LOCKED (skip locked rows)
     * @returns {QueryBuilder} this (for chaining)
     */
    forUpdate(mode) {
        this._checkTerminated();
        this._forUpdate = mode === true ? true : mode;
        return this;
    }

    /**
     * Build the SQL query string and bind variables without executing.
     *
     * This is the BRAIN of QueryBuilder. It assembles all the pieces:
     *   1. SELECT columns (from projection or *)
     *   2. FROM table (with optional AS OF / SAMPLE)
     *   3. WHERE clause (from filter via filterParser)
     *   4. ORDER BY (from sort)
     *   5. OFFSET / FETCH FIRST (from skip/limit)
     *   6. FOR UPDATE (from forUpdate)
     *
     * Called internally by terminal methods. Also use .explain() to see
     * the generated SQL without executing.
     *
     * @returns {{ sql: string, binds: Object }} The SQL string and bind variables
     */
    _buildSQL() {
        const { whereClause, binds } = parseFilter(this.filter, "t0");

        // Projection
        const proj = buildProjection(this._projection);
        let selectCols = proj.columns;

        // Handle subquery projections
        if (this._projection && typeof this._projection === "object") {
            const subParts = [];
            const regularParts = [];
            for (const [key, val] of Object.entries(this._projection)) {
                if (typeof val === "object" && val !== null && val.$subquery) {
                    const sub = val.$subquery;
                    const subColl = quoteIdentifier(sub.collection);
                    const fnMap = {
                        count: "COUNT(*)",
                        sum: "SUM",
                        avg: "AVG",
                        min: "MIN",
                        max: "MAX",
                    };
                    const fnExpr = fnMap[sub.fn] || "COUNT(*)";

                    // Build correlated WHERE
                    const subWhere = [];
                    if (sub.filter) {
                        for (const [fk, fv] of Object.entries(sub.filter)) {
                            if (typeof fv === "string" && fv.startsWith("$")) {
                                const outerCol = fv.slice(1);
                                subWhere.push(
                                    `${quoteIdentifier(fk)} = t0.${quoteIdentifier(outerCol)}`,
                                );
                            } else {
                                const bname = `sub_${key}_${fk}_${Object.keys(binds).length}`;
                                binds[bname] = fv;
                                subWhere.push(
                                    `${quoteIdentifier(fk)} = :${bname}`,
                                );
                            }
                        }
                    }
                    const subWhereStr =
                        subWhere.length > 0
                            ? ` WHERE ${subWhere.join(" AND ")}`
                            : "";
                    subParts.push(
                        `(SELECT ${fnExpr} FROM ${subColl}${subWhereStr}) AS ${quoteIdentifier(key)}`,
                    );
                } else if (val === 1) {
                    regularParts.push(`t0.${quoteIdentifier(key)}`);
                }
            }

            if (subParts.length > 0) {
                const allParts = [...regularParts, ...subParts];
                selectCols = allParts.join(", ");
            }
        }

        // Handle exclusion projection
        if (proj.isExclusion && proj.excludedCols.length > 0) {
            // We need to query all columns except the excluded ones
            // This requires knowing all columns — use a dynamic approach
            selectCols = "*";
            // We'll post-process exclusions after query, or use approach below
        }

        // Table reference
        let tableRef = `${quoteIdentifier(this.tableName)} t0`;

        // AS OF (flashback)
        if (this._asOf) {
            if (this._asOf.scn) {
                tableRef = `${quoteIdentifier(this.tableName)} AS OF SCN ${Number(this._asOf.scn)} t0`;
            } else if (this._asOf.timestamp) {
                const bname = `asof_ts_${Object.keys(binds).length}`;
                binds[bname] = this._asOf.timestamp;
                tableRef = `${quoteIdentifier(this.tableName)} AS OF TIMESTAMP TO_TIMESTAMP(:${bname}, 'YYYY-MM-DD HH24:MI:SS') t0`;
            }
        }

        // SAMPLE
        if (this._sample) {
            const pct = Number(this._sample.percentage);
            const seedStr =
                this._sample.seed !== undefined
                    ? ` SEED(${Number(this._sample.seed)})`
                    : "";
            tableRef = `${quoteIdentifier(this.tableName)} SAMPLE(${pct})${seedStr} t0`;
        }

        let sql = `SELECT ${selectCols} FROM ${tableRef}`;

        if (whereClause) sql += ` ${whereClause}`;

        // ORDER BY
        if (this._sort) {
            sql += ` ${buildOrderBy(this._sort)}`;
        }

        // OFFSET
        if (this._skip != null) {
            sql += ` OFFSET ${Number(this._skip)} ROWS`;
        }

        // LIMIT
        if (this._limit != null) {
            sql += ` FETCH FIRST ${Number(this._limit)} ROWS ONLY`;
        }

        // FOR UPDATE
        if (this._forUpdate) {
            if (this._forUpdate === "nowait") {
                sql += " FOR UPDATE NOWAIT";
            } else if (this._forUpdate === "skip locked") {
                sql += " FOR UPDATE SKIP LOCKED";
            } else {
                sql += " FOR UPDATE";
            }
        }

        return { sql, binds };
    }

    /**
     * Internal: get just the bind variables (convenience wrapper).
     */
    _getBinds() {
        return this._buildSQL().binds;
    }

    /**
     * Internal: resolve any Promise values in the filter tree.
     *
     * This is needed for cases like:
     *   .find({ status: { $in: someAsyncFunction() } })
     * where a filter value is itself a Promise that needs to be awaited.
     */
    async _resolveFilterPromises() {
        const resolve = async (obj) => {
            if (obj && typeof obj.then === "function") return await obj;
            if (Array.isArray(obj)) return Promise.all(obj.map(resolve));
            if (obj && typeof obj === "object" && !(obj instanceof Date)) {
                const result = {};
                for (const [k, v] of Object.entries(obj)) {
                    result[k] = await resolve(v);
                }
                return result;
            }
            return obj;
        };
        this.filter = await resolve(this.filter);
    }

    /**
     * Make QueryBuilder thenable (implements the Promise protocol).
     *
     * This is why `await users.find({ id: 1 })` works without calling
     * .toArray(). JavaScript's `await` calls .then() on any thenable object,
     * and this method delegates to .toArray().
     */
    then(resolve, reject) {
        return this.toArray().then(resolve, reject);
    }

    /**
     * Internal: actually execute the query against the database.
     *
     * Handles: building SQL, executing, post-processing exclusion projections.
     * Uses the same _execute/_conn pattern as OracleCollection.
     *
     * @returns {Promise<Array>} Array of row objects
     */
    async _execute() {
        await this._resolveFilterPromises();
        const { sql, binds } = this._buildSQL();
        const self = this;

        const fn = async (conn) => {
            try {
                const result = await conn.execute(sql, binds, {
                    outFormat: self.db.oracledb.OUT_FORMAT_OBJECT,
                    autoCommit: !self._conn,
                });
                let rows = result.rows || [];

                // Handle exclusion projection post-processing
                const proj = buildProjection(self._projection);
                if (proj.isExclusion && proj.excludedCols.length > 0) {
                    rows = rows.map((row) => {
                        const doc = { ...row };
                        for (const col of proj.excludedCols) {
                            delete doc[col];
                        }
                        return doc;
                    });
                }

                return rows;
            } catch (err) {
                throw new Error(
                    MSG.wrapError("QueryBuilder._execute", err, sql, binds),
                );
            }
        };

        if (this._conn) {
            return fn(this._conn);
        }
        return this.db.withConnection(fn);
    }

    // ─── Terminal Methods ─────────────────────────────────────────

    /**
     * TERMINAL: Execute the query and return ALL matching rows as an array.
     *
     * This is the most common terminal method. Once called, the QueryBuilder
     * is marked as terminated and cannot be chained further.
     *
     * @returns {Promise<Array<Object>>} Array of row objects
     *
     * @example
     *   const users = await coll.find({ active: true }).sort({ name: 1 }).toArray();
     */
    async toArray() {
        this._terminated = true;
        return this._execute();
    }

    /**
     * TERMINAL: Stream rows one-by-one using Oracle's queryStream.
     *
     * Unlike toArray() which loads ALL rows into memory, forEach() uses
     * a streaming cursor with O(1) memory. Safe for processing millions
     * of rows without running out of memory.
     *
     * @param {Function} fn - Called with each row: (row) => { ... }
     * @returns {Promise<void>} Resolves when all rows have been processed
     *
     * @example
     *   await orders.find({ status: "pending" }).forEach((row) => {
     *     console.log(`Order ${row.id}: $${row.amount}`);
     *   });
     */
    async forEach(fn) {
        this._terminated = true;
        await this._resolveFilterPromises();
        const { sql, binds } = this._buildSQL();
        const self = this;
        const proj = buildProjection(self._projection);

        const run = (conn) =>
            new Promise((resolve, reject) => {
                const stream = conn.queryStream(sql, binds, {
                    outFormat: self.db.oracledb.OUT_FORMAT_OBJECT,
                });
                stream.on("data", (row) => {
                    if (proj.isExclusion && proj.excludedCols.length > 0) {
                        for (const col of proj.excludedCols) delete row[col];
                    }
                    fn(row);
                });
                stream.on("error", (err) => {
                    reject(
                        new Error(
                            MSG.wrapError(
                                "QueryBuilder.forEach",
                                err,
                                sql,
                                binds,
                            ),
                        ),
                    );
                });
                stream.on("end", resolve);
            });

        if (this._conn) {
            return run(this._conn);
        }
        return this.db.withConnection(run);
    }

    /**
     * TERMINAL: Execute and return only the FIRST matching row.
     *
     * Internally sets limit(1), runs the query, then restores the limit.
     *
     * @returns {Promise<Object|null>} The first row, or null if no match
     *
     * @example
     *   const user = await coll.find({ email: "ana@test.com" }).next();
     */
    async next() {
        this._terminated = true;
        const original = this._limit;
        this._limit = 1;
        const rows = await this._execute();
        this._limit = original;
        return rows[0] ?? null;
    }

    /**
     * TERMINAL: Check if ANY row matches the filter.
     *
     * Returns true/false without loading all data. Efficient for existence checks.
     *
     * @returns {Promise<boolean>} true if at least one row matches
     *
     * @example
     *   const exists = await coll.find({ email: "ana@test.com" }).hasNext();
     *   if (!exists) console.log("User not found");
     */
    async hasNext() {
        this._terminated = true;
        const original = this._limit;
        this._limit = 1;
        const rows = await this._execute();
        this._limit = original;
        return rows.length > 0;
    }

    /**
     * TERMINAL: Count matching rows (SELECT COUNT(*)).
     *
     * Ignores sort, limit, and skip — always counts ALL matching rows.
     *
     * @returns {Promise<number>} The count of matching rows
     *
     * @example
     *   const total = await coll.find({ status: "active" }).count();
     */
    async count() {
        this._terminated = true;
        const { whereClause, binds } = parseFilter(this.filter, "t0");
        const sql = `SELECT COUNT(*) AS CNT FROM ${quoteIdentifier(this.tableName)} t0 ${whereClause}`;

        const fn = async (conn) => {
            try {
                const result = await conn.execute(sql, binds, {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                    autoCommit: true,
                });
                return Number(result.rows[0].CNT);
            } catch (err) {
                throw new Error(
                    MSG.wrapError("QueryBuilder.count", err, sql, binds),
                );
            }
        };

        if (this._conn) return fn(this._conn);
        return this.db.withConnection(fn);
    }

    /**
     * TERMINAL: Return the generated SQL string WITHOUT executing it.
     *
     * Use this for debugging — see exactly what SQL the library generates.
     *
     * @returns {Promise<string>} The SQL query string
     *
     * @example
     *   const sql = await coll.find({ status: "active" }).sort({ name: 1 }).explain();
     *   console.log(sql);
     *   // → SELECT * FROM "users" t0 WHERE "status" = :where_status_0 ORDER BY "name" ASC
     */
    async explain() {
        this._terminated = true;
        const { sql } = this._buildSQL();
        return sql;
    }
}

module.exports = { QueryBuilder };
