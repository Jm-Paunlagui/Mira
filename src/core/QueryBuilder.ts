

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

import type { DbConnection } from "../driver/db";
import { quoteIdentifier, bindSafe, buildOrderBy, buildProjection } from "../shared/utils";
import { parseFilter } from "../parsers/filterParser";
import { buildIncludeSQL, decodeIncluded, type IncludeOptions, type RelationSpec } from "../typed/include";
import { oracleMongoWrapperMessages as MSG } from "../shared/messages";

/** A `{ $subquery }` projection value: a correlated scalar subquery column. */
interface ProjectionSubquery {
    collection: string;
    fn?: string;
    /** Column SUM/AVG/MIN/MAX apply to (required for those fns). */
    field?: string;
    filter?: Record<string, unknown>;
}

/** Lock options accepted by {@link QueryBuilder.forUpdate}. */
type ForUpdateOptions = { of?: string[]; wait?: number; nowait?: boolean; skipLocked?: boolean };
type ForUpdateMode = boolean | "nowait" | "skip locked" | ForUpdateOptions;
/** Initial cursor options (what OracleCollection.find() passes through). */
type QueryBuilderOptions = {
    sort?: Record<string, unknown>;
    limit?: number;
    skip?: number;
    projection?: Record<string, unknown>;
    forUpdate?: ForUpdateMode;
    sample?: { percentage: number; seed?: number };
    asOf?: { scn?: number | string; timestamp?: string };
};

/**
 * The FOR UPDATE clause for a lock mode. Throws on an unknown mode so a typo
 * ("no wait") fails loudly instead of silently waiting forever. Column names
 * in `of` are quoted identifiers; `wait` must be a whole number of seconds.
 */
/**
 * Resolves once a node-oracledb query stream has emitted "close" (its result set
 * is closed and the connection is free to go back to the pool). Call it right
 * after queryStream(), before any event can fire.
 */
function streamClosed(stream: { once(event: "close", fn: () => void): unknown; closed?: boolean }): Promise<void> {
    return new Promise<void>((resolve) => {
        if (stream.closed) resolve();
        else stream.once("close", () => resolve());
    });
}

function _forUpdateClause(mode: unknown): string {
    if (mode === true) return " FOR UPDATE";
    if (mode === "nowait") return " FOR UPDATE NOWAIT";
    if (mode === "skip locked") return " FOR UPDATE SKIP LOCKED";
    if (!mode || typeof mode !== "object" || Array.isArray(mode)) {
        throw new TypeError(MSG.FOR_UPDATE_INVALID_MODE(mode));
    }
    const { of, wait, nowait, skipLocked } = mode as ForUpdateOptions;
    const waits = [wait !== undefined, nowait === true, skipLocked === true].filter(Boolean).length;
    const ofOk = of === undefined || (Array.isArray(of) && of.length > 0 && of.every((c) => typeof c === "string" && c !== ""));
    const waitOk = wait === undefined || (Number.isInteger(wait) && wait >= 0);
    if (waits > 1 || !ofOk || !waitOk) throw new TypeError(MSG.FOR_UPDATE_INVALID_MODE(mode));
    let clause = " FOR UPDATE";
    if (of) clause += ` OF ${of.map((c) => `t0.${quoteIdentifier(c)}`).join(", ")}`;
    if (wait !== undefined) clause += ` WAIT ${wait}`;
    else if (nowait) clause += " NOWAIT";
    else if (skipLocked) clause += " SKIP LOCKED";
    return clause;
}

/** Rows for limit/skip: spliced into SQL, so only a non-negative integer is accepted. */
function _rowCount(scope: string, what: string, n: unknown): number {
    if (!Number.isInteger(n) || (n as number) < 0) throw new TypeError(MSG.INVALID_ROW_COUNT(scope, what, n));
    return n as number;
}

class QueryBuilder {
    declare _terminated: boolean;
    declare _asOf: { scn?: number | string; timestamp?: string } | null;
    declare _sample: { percentage: number; seed?: number } | null;
    declare _forUpdate: unknown;
    declare _projection: Record<string, unknown> | null;
    declare _skip: unknown;
    declare _limit: unknown;
    declare _withTies: boolean;
    declare _sort: Record<string, unknown> | null;
    /** after(): the sort-key values of the last row of the previous page (keyset pagination). */
    declare _after: Record<string, unknown> | null;
    declare _conn: import("../driver/db").DbConnection | null;
    /** The relations include() can fetch (from a typed table with relations). */
    declare _relations?: Readonly<Record<string, RelationSpec>>;
    declare _includes: Array<{ name: string; spec: RelationSpec; options: IncludeOptions }>;
    /** t.json() columns of a typed table (see OracleCollection._json). */
    declare _json?: { encode: readonly string[]; decode: readonly string[] };
    declare db: import("../driver/db").WrapperDb;
    declare filter: Record<string, unknown>;
    declare tableName: string;
    /**
     * Create a new QueryBuilder. Usually called internally by OracleCollection.find().
     *
     * @param {string} tableName - The table to query
     * @param {Object} filter - MongoDB-style filter (e.g. { status: "active" })
     * @param {Object} db - The db handle from mira.db()
     * @param {Object} [conn] - Raw connection (if inside a transaction/session)
     * @param {Object} [options] - Initial options: sort, limit, skip, projection, etc.
     */
    constructor(tableName: string, filter: Record<string, unknown>, db: import("../driver/db").WrapperDb, conn: import("../driver/db").DbConnection | null = null, options: QueryBuilderOptions = {}) {
        this.tableName = tableName;
        this.filter = filter || {};
        this.db = db;
        this._conn = conn;
        this._sort = options.sort || null;
        this._limit = options.limit != null ? _rowCount("QueryBuilder", "limit", options.limit) : null;
        this._skip = options.skip != null ? _rowCount("QueryBuilder", "skip", options.skip) : null;
        this._projection = options.projection || null;
        this._forUpdate = options.forUpdate || null;
        this._sample = options.sample || null;
        this._asOf = options.asOf || null;
        this._terminated = false; // Prevents chaining after a terminal method
        this._includes = [];
        this._after = null;
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

    /** This query itself, with 2.0's untyped signatures (see OracleCollection.untyped). */
    get untyped(): QueryBuilder {
        return this;
    }

    // ─── Chain Methods (return the same QueryBuilder for chaining) ───

    /**
     * Fetch a declared relation in the same statement: each row gets the related
     * rows (hasMany: an array) or row (belongsTo / hasOne: an object or null)
     * under the relation's name. Declare relations with relations() on typed tables.
     * @param {string} name - Relation name
     * @param {Object} [options] - { where, sort, limit } on the related rows (limit: hasMany only)
     * @returns {QueryBuilder} this (for chaining)
     */
    include(name: string, options: IncludeOptions = {}): QueryBuilder {
        this._checkTerminated();
        const spec = this._relations?.[name];
        if (!spec) throw new Error(MSG.INCLUDE_UNKNOWN_RELATION(this.tableName, name, Object.keys(this._relations ?? {})));
        if (this._includes.some((i) => i.name === name)) throw new Error(MSG.INCLUDE_TWICE(name));
        this._includes.push({ name, spec, options });
        return this;
    }

    /**
     * Set the sort order.
     * @param {Object} sortSpec - e.g. { name: 1, age: -1 } (1=ASC, -1=DESC)
     * @returns {QueryBuilder} this (for chaining)
     */
    sort(sortSpec: Record<string, unknown>): QueryBuilder {
        this._checkTerminated();
        this._sort = sortSpec;
        return this;
    }

    /**
     * Keyset pagination: continue after the row whose sort-key values are given,
     * in the order of sort(). Give the last row of the previous page (or just its
     * sort keys). Unlike skip(), the database seeks straight to the next page, and
     * rows inserted or deleted meanwhile do not shift it.
     *
     *   const page1 = await orders.find().sort({ TOTAL: -1, ID: 1 }).limit(20).toArray();
     *   const page2 = await orders.find().sort({ TOTAL: -1, ID: 1 }).after(page1.at(-1)).limit(20).toArray();
     *
     * End the sort with a unique column (the primary key) so no two rows tie.
     * The sort keys must not be NULL in the cursor.
     * @param {Object} cursor - The previous page's last row, or its sort-key values
     * @returns {QueryBuilder} this (for chaining)
     */
    after(cursor: Record<string, unknown>): QueryBuilder {
        this._checkTerminated();
        if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) throw new Error(MSG.AFTER_INVALID_CURSOR(JSON.stringify(cursor)));
        this._after = cursor;
        return this;
    }

    /** The keyset predicate for after(): (a > :a) OR (a = :a AND b > :b) …, in sort order. */
    _afterClause(binds: Record<string, unknown>): string {
        const cursor = this._after as Record<string, unknown>;
        if (!this._sort || Object.keys(this._sort).length === 0) throw new Error(MSG.AFTER_NEEDS_SORT(this.tableName));
        const keys = Object.keys(this._sort);
        // The cursor may be a whole row: only the sort keys are used, and each must be there.
        for (const k of keys) if (cursor[k] === null || cursor[k] === undefined) throw new Error(MSG.AFTER_NULL_VALUE(k));
        const terms = keys.map((k, i) => {
            const spec = (this._sort as Record<string, unknown>)[k];
            const order = spec && typeof spec === "object" ? ((spec as { order?: unknown }).order ?? 1) : spec;
            const name = `after_${i}`;
            binds[name] = cursor[k];
            const op = Number(order) === -1 ? "<" : ">";
            const equal = keys.slice(0, i).map((p, j) => `t0.${quoteIdentifier(p)} = :after_${j}`);
            return `(${[...equal, `t0.${quoteIdentifier(k)} ${op} :${name}`].join(" AND ")})`;
        });
        return `(${terms.join(" OR ")})`;
    }

    /**
     * Limit the number of rows returned.
     * @param {number} n - Maximum number of rows
     * @param {Object} [options]
     * @param {boolean} [options.withTies] - FETCH FIRST n ROWS WITH TIES: also keep every row
     *   tied with the n-th on the sort keys. Needs a sort().
     * @returns {QueryBuilder} this (for chaining)
     */
    limit(n: number, options: { withTies?: boolean } = {}): QueryBuilder {
        this._checkTerminated();
        this._limit = _rowCount("QueryBuilder.limit", "limit", n);
        this._withTies = options.withTies === true;
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
    skip(n: number): QueryBuilder {
        this._checkTerminated();
        this._skip = _rowCount("QueryBuilder.skip", "skip", n);
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
    project(projectionSpec: Record<string, unknown>): QueryBuilder {
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
     * Combined with .limit()/.skip() (and .next()/.hasNext(), which set
     * limit 1), the page is chosen in a ROWID subquery and the outer query
     * takes the lock: Oracle rejects FETCH FIRST together with FOR UPDATE
     * (ORA-02014). With "skip locked" a page can then return FEWER rows than
     * the limit (locked rows inside the page are skipped, not replaced).
     *
     * @param {boolean|string|Object} mode
     *   - true          → FOR UPDATE (wait indefinitely for lock)
     *   - "nowait"      → FOR UPDATE NOWAIT (fail immediately if locked)
     *   - "skip locked" → FOR UPDATE SKIP LOCKED (skip locked rows)
     *   - { of?: string[], wait?: number, nowait?: boolean, skipLocked?: boolean }
     *       of:   lock only these columns' table (FOR UPDATE OF t0."COL", ...)
     *       wait: seconds to wait before ORA-30006 (FOR UPDATE WAIT n)
     *       at most one of wait / nowait / skipLocked
     * @returns {QueryBuilder} this (for chaining)
     */
    forUpdate(mode: ForUpdateMode): QueryBuilder {
        this._checkTerminated();
        this._forUpdate = mode === false ? null : (_forUpdateClause(mode), mode);
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
    _buildSQL(opts: { pageByRowid?: boolean } = {}): { sql: string; binds: Record<string, unknown>; maxRows?: number } {
        const parsed = parseFilter(this.filter, "t0");
        const binds = parsed.binds;
        let whereClause = parsed.whereClause;
        if (this._after) {
            const keyset = this._afterClause(binds);
            whereClause = whereClause ? `${whereClause} AND ${keyset}` : `WHERE ${keyset}`;
        }

        // Projection
        const proj = buildProjection(this._projection);
        let selectCols = proj.columns;

        // Handle subquery projections
        if (this._projection && typeof this._projection === "object") {
            const subParts: string[] = [];
            const regularParts: string[] = [];
            for (const [key, val] of Object.entries(this._projection)) {
                if (typeof val === "object" && val !== null && "$subquery" in val && val.$subquery) {
                    const sub = val.$subquery as ProjectionSubquery;
                    const subColl = quoteIdentifier(sub.collection);
                    const fnMap = {
                        sum: "SUM",
                        avg: "AVG",
                        min: "MIN",
                        max: "MAX",
                    };
                    const aggFn = fnMap[sub.fn as keyof typeof fnMap];
                    // SUM/AVG/MIN/MAX need a column ("SELECT SUM FROM …" is invalid SQL);
                    // count (and the historical fallback for unknown fns) is COUNT(*).
                    if (aggFn && !sub.field) throw new Error(MSG.SUBQUERY_FIELD_REQUIRED(sub.fn));
                    const fnExpr = aggFn ? `${aggFn}(${quoteIdentifier(sub.field as string)})` : "COUNT(*)";

                    // Build correlated WHERE
                    const subWhere: string[] = [];
                    if (sub.filter) {
                        for (const [fk, fv] of Object.entries(sub.filter)) {
                            if (typeof fv === "string" && fv.startsWith("$")) {
                                const outerCol = fv.slice(1);
                                subWhere.push(
                                    `${quoteIdentifier(fk)} = t0.${quoteIdentifier(outerCol)}`,
                                );
                            } else {
                                const bname = `sub_${bindSafe(key)}_${bindSafe(fk)}_${Object.keys(binds).length}`;
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

        // Included relations: one correlated subquery each, in the select list.
        if (this._includes.length > 0) {
            if (selectCols === "*") selectCols = "t0.*"; // "*" cannot share a select list
            const parts = this._includes.map((inc, i) => {
                const built = buildIncludeSQL(inc.spec, inc.name, inc.options, "t0", `inc${i}_`);
                Object.assign(binds, built.binds);
                return built.sql;
            });
            selectCols = `${selectCols}, ${parts.join(", ")}`;
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

        const orderBy = this._sort ? ` ${buildOrderBy(this._sort)}` : "";
        let paging = "";
        if (this._skip != null) paging += ` OFFSET ${Number(this._skip)} ROWS`;
        if (this._limit != null) {
            // WITH TIES without ORDER BY silently returns exactly n rows: refuse it.
            if (this._withTies && !orderBy) throw new Error(MSG.WITH_TIES_NEEDS_SORT("QueryBuilder.limit"));
            paging += ` FETCH FIRST ${Number(this._limit)} ROWS ${this._withTies ? "WITH TIES" : "ONLY"}`;
        }
        const where = whereClause ? ` ${whereClause}` : "";

        // pageByRowid ($lateralJoin): Oracle returns wrong rows for a LATERAL /
        // APPLY subquery that carries a row limit (FETCH FIRST or ROWNUM) once it
        // decorrelates it — seen on 23.26: 1 outer row kept out of 6. Picking the
        // page's ROWIDs in an IN subquery is not decorrelated that way. SAMPLE is
        // left alone: repeating it would draw two different samples.
        if (!this._forUpdate && opts.pageByRowid && paging && !this._sample) {
            const page = `SELECT t0.ROWID FROM ${tableRef}${where}${orderBy}${paging}`;
            return { sql: `SELECT ${selectCols} FROM ${tableRef} WHERE t0.ROWID IN (${page})${orderBy}`, binds };
        }

        if (!this._forUpdate) {
            return { sql: `SELECT ${selectCols} FROM ${tableRef}${where}${orderBy}${paging}`, binds };
        }

        const lock = _forUpdateClause(this._forUpdate);
        if (!paging) {
            return { sql: `SELECT ${selectCols} FROM ${tableRef}${where}${orderBy}${lock}`, binds };
        }

        // A work queue: SKIP LOCKED with a limit. Picking the page in a subquery
        // would choose rows before the lock skips the busy ones, so a second
        // worker got nothing while free rows were waiting. Instead the cursor
        // locks rows as it fetches them, and _execute stops after `limit`
        // (maxRows, with prefetch sized to match so no extra row is locked).
        const skipLocked = this._forUpdate === "skip locked" || (typeof this._forUpdate === "object" && (this._forUpdate as ForUpdateOptions).skipLocked === true);
        if (skipLocked && this._skip == null && Number(this._limit) > 0) {
            return { sql: `SELECT ${selectCols} FROM ${tableRef}${where}${orderBy}${lock}`, binds, maxRows: Number(this._limit) };
        }

        // Oracle rejects FETCH FIRST / OFFSET together with FOR UPDATE
        // (ORA-02014): pick the page's ROWIDs in a subquery, lock in the outer
        // query. The filter is repeated outside so a row changed between the
        // pick and the lock is re-checked (Oracle re-evaluates the outer
        // predicate on a locked row it had to wait for). A repeated named
        // bind resolves to the one value, so `binds` is unchanged.
        const page = `SELECT t0.ROWID FROM ${tableRef}${where}${orderBy}${paging}`;
        const outerWhere = whereClause ? `${whereClause} AND` : "WHERE";
        const sql = `SELECT ${selectCols} FROM ${tableRef} ${outerWhere} t0.ROWID IN (${page})${orderBy}${lock}`;
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
        const resolve = async (obj: unknown): Promise<unknown> => {
            if (obj && typeof obj === "object" && "then" in obj && typeof obj.then === "function") return await obj;
            if (Array.isArray(obj)) return Promise.all(obj.map(resolve));
            // Only plain objects are filter structure. A Date, Buffer or sql`…` statement is a
            // value: copying it field by field lost its class (a sql`` subquery became a plain
            // object, a Buffer an object of byte fields).
            const proto = obj && typeof obj === "object" ? Object.getPrototypeOf(obj) : undefined;
            if (obj && typeof obj === "object" && (proto === Object.prototype || proto === null)) {
                const result: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(obj)) {
                    result[k] = await resolve(v);
                }
                return result;
            }
            return obj;
        };
        this.filter = (await resolve(this.filter)) as Record<string, unknown>;
    }

    /**
     * Make QueryBuilder thenable (implements the Promise protocol).
     *
     * This is why `await users.find({ id: 1 })` works without calling
     * .toArray(). JavaScript's `await` calls .then() on any thenable object,
     * and this method delegates to .toArray().
     */
    then<R1 = Array<Record<string, unknown>>, R2 = never>(resolve?: ((rows: Array<Record<string, unknown>>) => R1 | PromiseLike<R1>) | null, reject?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): Promise<R1 | R2> {
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
    async _execute(): Promise<Array<any>> {
        await this._resolveFilterPromises();
        const { sql, binds, maxRows } = this._buildSQL();
        // SKIP LOCKED queue reads stop after `maxRows`; prefetch no more than that,
        // since every row the server fetches is locked.
        const rowLimit = maxRows ? { maxRows, fetchArraySize: maxRows, prefetchRows: maxRows } : {};

        const fn = async (conn: DbConnection) => {
            try {
                const result = await conn.execute(sql, binds, {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                    // Never auto-commit a locking read: the commit ends the FOR UPDATE
                    // cursor before every row is fetched (ORA-01002 once rows are
                    // skipped or the result needs a second round trip). A standalone
                    // read's locks end when its connection returns to the pool.
                    autoCommit: !this._conn && !this._forUpdate,
                    ...rowLimit,
                });
                let rows = result.rows || [];

                // Handle exclusion projection post-processing
                const proj = buildProjection(this._projection);
                if (proj.isExclusion && proj.excludedCols.length > 0) {
                    rows = rows.map((row: Record<string, unknown>) => {
                        const doc = { ...row };
                        for (const col of proj.excludedCols) {
                            delete doc[col];
                        }
                        return doc;
                    });
                }
                if (this._includes.length > 0 || this._json) rows = rows.map((row: Record<string, unknown>) => this._decodeRow(row));

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

    /** Included relations and t.json() columns from JSON text into JS values, in place. */
    _decodeRow(row: Record<string, unknown>): Record<string, unknown> {
        for (const inc of this._includes) row[inc.name] = decodeIncluded(inc.spec, row[inc.name]);
        for (const c of this._json?.decode ?? []) if (typeof row[c] === "string") row[c] = JSON.parse(row[c] as string);
        return row;
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
    async toArray<T = Record<string, unknown>>(): Promise<T[]> {
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
    async forEach(fn: ((...args: unknown[]) => unknown)): Promise<void> {
        this._terminated = true;
        await this._resolveFilterPromises();
        const { sql, binds } = this._buildSQL();
        const proj = buildProjection(this._projection);

        // The callback may be async: the stream is paused until its promise
        // settles (backpressure), and a rejection — like a synchronous throw —
        // stops the stream and rejects forEach. Without this, an async
        // consumer's failure became an unhandled rejection and forEach
        // reported success.
        const run = (conn: DbConnection) =>
            new Promise<void>((resolve, reject) => {
                const stream = conn.queryStream(sql, binds, {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                });
                // The connection is handed back when forEach settles, so it must not
                // settle before the stream has closed its result set: node-oracledb
                // closes it between "end" and "close", and a connection released in
                // between is still in native use (Thick + Bun: another caller's error
                // text overwritten with DPI-1039 / NJS-003, and crashes).
                const closed = streamClosed(stream);
                let done = false;
                let pending: Promise<unknown> = Promise.resolve();
                const fail = (err: unknown) => {
                    if (done) return;
                    done = true;
                    stream.destroy();
                    const wrapped = new Error(MSG.wrapError("QueryBuilder.forEach", err, sql, binds));
                    void closed.then(() => reject(wrapped));
                };
                stream.on("data", (row: Record<string, unknown>) => {
                    if (done) return;
                    if (proj.isExclusion && proj.excludedCols.length > 0) {
                        for (const col of proj.excludedCols) delete row[col];
                    }
                    let out: unknown;
                    try {
                        // Included relations are decoded first; a failure there stops the stream like a callback error.
                        out = fn(this._includes.length > 0 || this._json ? this._decodeRow(row) : row);
                    } catch (err) {
                        fail(err);
                        return;
                    }
                    if (out && typeof (out as Promise<unknown>).then === "function") {
                        stream.pause();
                        pending = (out as Promise<unknown>).then(() => {
                            if (!done) stream.resume();
                        }, fail);
                    }
                });
                stream.on("error", fail);
                stream.on("end", () => {
                    void pending.then(() => {
                        if (done) return;
                        done = true;
                        void closed.then(() => resolve());
                    });
                });
            });

        if (this._conn) {
            return run(this._conn);
        }
        return this.db.withConnection(run);
    }

    /**
     * TERMINAL: iterate the rows with `for await`, streamed (O(1) memory) like forEach().
     * One connection is held while iterating and released when the loop ends, breaks
     * or throws; inside a transaction the session's connection is used.
     *
     * @example
     *   for await (const order of orders.find({ STATUS: "open" }).sort({ ID: 1 })) {
     *     if (await ship(order)) break;
     *   }
     */
    async *[Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void, undefined> {
        this._terminated = true;
        await this._resolveFilterPromises();
        const { sql, binds } = this._buildSQL();
        const proj = buildProjection(this._projection);
        const decode = this._includes.length > 0 || !!this._json;
        const rows = async function* (this: QueryBuilder, conn: DbConnection) {
            const stream = conn.queryStream(sql, binds, { outFormat: this.db.oracledb.OUT_FORMAT_OBJECT });
            const closed = streamClosed(stream); // see forEach: the connection waits for "close"
            try {
                for await (const row of stream as AsyncIterable<Record<string, unknown>>) {
                    if (proj.isExclusion) for (const col of proj.excludedCols) delete row[col];
                    yield decode ? this._decodeRow(row) : row;
                }
            } catch (err) {
                throw new Error(MSG.wrapError("QueryBuilder[Symbol.asyncIterator]", err, sql, binds));
            } finally {
                stream.destroy();
                await closed;
            }
        }.bind(this);

        if (this._conn) {
            yield* rows(this._conn);
            return;
        }
        // Hold a pooled connection for the loop's lifetime: withConnection's callback
        // waits until the loop is done, then the connection goes back as usual.
        let release: (() => void) | undefined;
        let borrowed!: Promise<unknown>;
        const conn = await new Promise<DbConnection>((resolve, reject) => {
            borrowed = this.db.withConnection((c: DbConnection) => {
                resolve(c);
                return new Promise<void>((done) => {
                    release = done;
                });
            });
            borrowed.catch(reject);
        });
        try {
            yield* rows(conn);
        } finally {
            release?.();
            await borrowed;
        }
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
    async next<T = Record<string, unknown>>(): Promise<T | null> {
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
     *   if (!exists) console.log("USER not found");
     */
    async hasNext(): Promise<boolean> {
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
    async count(): Promise<number> {
        this._terminated = true;
        const { whereClause, binds } = parseFilter(this.filter, "t0");
        const sql = `SELECT COUNT(*) AS CNT FROM ${quoteIdentifier(this.tableName)} t0 ${whereClause}`;

        const fn = async (conn: DbConnection) => {
            try {
                // Never commit on a session connection: that would end the
                // caller's transaction and release its row locks mid-flight.
                const result = await conn.execute<{ CNT: number }>(sql, binds, {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                    autoCommit: !this._conn,
                });
                // COUNT(*) with no GROUP BY always returns exactly one row.
                return Number(result.rows?.[0]?.CNT ?? 0);
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
    async explain(): Promise<string> {
        this._terminated = true;
        const { sql } = this._buildSQL();
        return sql;
    }
}

export { QueryBuilder };
export type { ForUpdateMode, QueryBuilderOptions };
