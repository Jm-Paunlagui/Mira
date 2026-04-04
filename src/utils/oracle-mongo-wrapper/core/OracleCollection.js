"use strict";

/**
 * ============================================================================
 * OracleCollection.js — The Heart of the Library
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   This is the MAIN CLASS of the entire library. It mirrors MongoDB's
 *   Collection API and gives you familiar methods like find(), insertOne(),
 *   updateMany(), deleteOne(), aggregate(), etc. — but executing against
 *   an Oracle database under the hood.
 *
 * HOW TO USE:
 *   const users = new OracleCollection("users", db);
 *   await users.findOne({ id: 1 });                     // Read one row
 *   await users.insertOne({ name: "Ana" });              // Insert a row
 *   await users.updateOne({ id: 1 }, { $set: { age: 25 } }); // Update
 *   await users.deleteOne({ id: 1 });                   // Delete
 *
 * CONNECTION MANAGEMENT:
 *   You never manage connections yourself. Each method internally calls
 *   this._execute(fn), which:
 *     - If inside a transaction → reuses the transaction's connection
 *     - If standalone → borrows a connection from the pool, uses it, returns it
 *
 * COMPLETE METHOD REFERENCE:
 *   Reading data:
 *     find()           → Returns a lazy QueryBuilder (chainable - see QueryBuilder.js)
 *     findOne()        → Get one row matching a filter
 *     findOneAndUpdate() → Find a row, update it, and return the result
 *     findOneAndDelete() → Find a row, delete it, and return the deleted row
 *     findOneAndReplace() → Find a row and replace all its fields
 *     countDocuments() → Count rows matching a filter
 *     estimatedDocumentCount() → Fast count from Oracle metadata (no full scan)
 *     distinct()       → Get unique values of a column
 *
 *   Writing data:
 *     insertOne()      → Insert one row (returns the inserted ID)
 *     insertMany()     → Bulk insert many rows at once
 *     updateOne()      → Update the first row matching a filter
 *     updateMany()     → Update ALL rows matching a filter
 *     replaceOne()     → Replace all fields (except PK) of the first match
 *     deleteOne()      → Delete the first row matching a filter
 *     deleteMany()     → Delete ALL rows matching a filter
 *     bulkWrite()      → Execute multiple operations in a single transaction
 *
 *   Aggregation & analytics:
 *     aggregate()      → MongoDB-style aggregation pipeline (see aggregatePipeline.js)
 *
 *   Indexes:
 *     createIndex()    → Create a database index for faster queries
 *     createIndexes()  → Create multiple indexes at once
 *     dropIndex()      → Remove an index
 *     dropIndexes()    → Remove all non-primary-key indexes
 *     getIndexes()     → List all indexes on the table
 *     reIndex()        → Rebuild all indexes
 *
 *   Oracle MERGE (upsert):
 *     merge()          → Insert or update based on a match condition
 *     mergeFrom()      → Merge from another table
 *
 *   Oracle-specific (advanced):
 *     connectBy()      → Hierarchical (tree) queries
 *     pivot()          → Rotate rows into columns
 *     unpivot()        → Rotate columns into rows
 *     insertFromQuery() → INSERT INTO ... SELECT ...
 *     updateFromJoin()  → Update using values from a joined table
 *
 *   Set operations (static methods):
 *     OracleCollection.union()     → Combine results from two queries
 *     OracleCollection.intersect() → Find common rows between two queries
 *     OracleCollection.minus()     → Find rows in first query but not second
 *
 *   Destructive:
 *     drop()           → DROP TABLE (deletes the entire table!)
 * ============================================================================
 */

const { quoteIdentifier, mergeBinds, rowToDoc } = require("../utils");
const { parseFilter } = require("../parsers/filterParser");
const { parseUpdate } = require("../parsers/updateParser");
const { QueryBuilder } = require("./QueryBuilder");
const {
    oracleMongoWrapperMessages: MSG,
} = require("../../../constants/messages");

class OracleCollection {
    /**
     * Create an OracleCollection instance for a specific table.
     *
     * @param {string} tableName - The Oracle table name (e.g. "users", "orders")
     * @param {Object} db - The db interface from createDb()
     * @param {Object} [_conn] - Raw connection (internal use).
     *   When null → standalone mode (borrows connections from pool).
     *   When set → transaction mode (reuses this connection for all operations).
     *   You normally don't pass this yourself — it's set by Session.collection().
     */
    constructor(tableName, db, _conn = null) {
        this.tableName = tableName;
        this.db = db;
        this._conn = _conn;
    }

    /**
     * Internal: execute a callback with a database connection.
     *
     * This is THE pattern that makes every method work in both standalone
     * mode and inside transactions without any code duplication.
     *
     * - If this._conn is set (inside a transaction/session) → use it directly
     * - If this._conn is null (standalone call) → borrow from the pool, auto-release
     *
     * @param {Function} fn - async (conn) => result
     * @returns {Promise<*>} Whatever fn returns
     */
    async _execute(fn) {
        if (this._conn) return fn(this._conn);
        return this.db.withConnection(fn);
    }

    // ─── Query / Read ─────────────────────────────────────────────

    /**
     * Returns a QueryBuilder (chainable cursor). SQL is NOT executed yet.
     *
     * Chain methods like .sort(), .limit(), .skip(), .project() to refine
     * the query, then call a terminal method to execute:
     *   .toArray()  → returns all matching rows
     *   .next()     → returns the first matching row
     *   .count()    → returns the count of matching rows
     *   .forEach(fn)→ streams rows with O(1) memory
     *
     * @param {Object} filter - MongoDB-style filter (e.g. { status: "active" })
     * @param {Object} [options] - Optional shortcuts:
     *   - sort, limit, skip, projection, forUpdate, sample, asOf
     * @returns {QueryBuilder} Lazy cursor — no SQL until you call a terminal method
     *
     * @example
     *   const rows = await users.find({ status: "active" })
     *     .sort({ name: 1 })     // ORDER BY "name" ASC
     *     .limit(10)             // FETCH FIRST 10 ROWS ONLY
     *     .project({ name: 1 })  // SELECT "name" only
     *     .toArray();            // ← NOW the SQL runs
     */
    find(filter = {}, options = {}) {
        const qb = new QueryBuilder(
            this.tableName,
            filter,
            this.db,
            this._conn,
            options,
        );
        if (options.sort) qb.sort(options.sort);
        if (options.limit != null) qb.limit(options.limit);
        if (options.skip != null) qb.skip(options.skip);
        if (options.projection) qb.project(options.projection);
        if (options.forUpdate) qb.forUpdate(options.forUpdate);
        return qb;
    }

    /**
     * Find a single document (row) matching the filter.
     *
     * Equivalent to: SELECT * FROM table WHERE ... FETCH FIRST 1 ROW ONLY
     * Returns null if no match is found.
     *
     * @param {Object} filter - Filter to match (e.g. { id: 1 })
     * @param {Object} [options] - Currently unused, reserved for future
     * @returns {Promise<Object|null>} The matching row or null
     *
     * @example
     *   const user = await users.findOne({ id: 42 });
     *   if (user) console.log(user.name);
     */
    async findOne(filter, options = {}) {
        return this._execute(async (conn) => {
            const { whereClause, binds } = parseFilter(filter);
            const sql = `SELECT * FROM ${quoteIdentifier(this.tableName)} ${whereClause} FETCH FIRST 1 ROW ONLY`;
            try {
                const result = await conn.execute(sql, binds, {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                    autoCommit: !this._conn,
                });
                return result.rows[0] ?? null;
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleCollection.findOne", err, sql, binds),
                );
            }
        });
    }

    /**
     * Find one document, update it, and return the before or after version.
     *
     * This is an atomic operation — the find and update happen as one unit.
     * If no document matches and upsert is true, a new document is inserted.
     *
     * @param {Object} filter - Filter to find the document (e.g. { id: 1 })
     * @param {Object} update - Update operators (e.g. { $set: { name: "Ana" } })
     * @param {Object} [options]
     *   - returnDocument: 'before' (default) or 'after' — which version to return
     *   - upsert: true to insert if no match found
     * @returns {Promise<Object|null>} The document (before or after update), or null
     *
     * @example
     *   // Update and get the new version
     *   const updated = await users.findOneAndUpdate(
     *     { id: 1 },
     *     { $set: { status: "premium" } },
     *     { returnDocument: "after" }
     *   );
     */
    async findOneAndUpdate(filter, update, options = {}) {
        return this._execute(async (conn) => {
            const { whereClause, binds: filterBinds } = parseFilter(filter);

            // Find current doc
            const selectSql = `SELECT * FROM ${quoteIdentifier(this.tableName)} ${whereClause} FETCH FIRST 1 ROW ONLY`;
            const found = await conn.execute(selectSql, filterBinds, {
                outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
            });

            const beforeDoc = found.rows[0] ?? null;

            if (!beforeDoc && options.upsert) {
                // Upsert: insert
                const fields = {};
                if (update.$set) Object.assign(fields, update.$set);
                // Also include filter as fields for the insert
                for (const [k, v] of Object.entries(filter)) {
                    if (typeof v !== "object") fields[k] = v;
                }
                const cols = Object.keys(fields);
                const vals = cols.map((_, i) => `:v${i}`);
                const insertBinds = {};
                cols.forEach((c, i) => {
                    insertBinds[`v${i}`] = fields[c];
                });
                const insertSql = `INSERT INTO ${quoteIdentifier(this.tableName)} (${cols.map(quoteIdentifier).join(", ")}) VALUES (${vals.join(", ")})`;
                await conn.execute(insertSql, insertBinds, {
                    autoCommit: !this._conn,
                });

                if (options.returnDocument === "after") {
                    const afterResult = await conn.execute(
                        selectSql,
                        filterBinds,
                        {
                            outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                        },
                    );
                    return afterResult.rows[0] ?? null;
                }
                return null;
            }

            if (!beforeDoc) return null;

            // Build update
            const { setClause, binds: updateBinds } = parseUpdate(update);
            const allBinds = mergeBinds(filterBinds, updateBinds);
            const updateSql = `UPDATE ${quoteIdentifier(this.tableName)} ${setClause} ${whereClause}`;

            try {
                await conn.execute(updateSql, allBinds, {
                    autoCommit: !this._conn,
                });
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.findOneAndUpdate",
                        err,
                        updateSql,
                    ),
                );
            }

            if (options.returnDocument === "after") {
                // Re-select after update — use filter or original ID
                const afterFilter =
                    beforeDoc.ID != null ? { ID: beforeDoc.ID } : filter;
                const { whereClause: afterWhere, binds: afterBinds } =
                    parseFilter(afterFilter);
                const afterSql = `SELECT * FROM ${quoteIdentifier(this.tableName)} ${afterWhere} FETCH FIRST 1 ROW ONLY`;
                const afterResult = await conn.execute(afterSql, afterBinds, {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                });
                return afterResult.rows[0] ?? null;
            }

            return beforeDoc;
        });
    }

    /**
     * Find a document, delete it, and return the deleted document.
     *
     * Useful when you need to know WHAT was deleted. The document is
     * found first, then deleted, and the found document is returned.
     *
     * @param {Object} filter - Filter to find the document (e.g. { id: 1 })
     * @returns {Promise<Object|null>} The deleted document, or null if none found
     *
     * @example
     *   const deleted = await users.findOneAndDelete({ id: 42 });
     *   console.log(`Deleted user: ${deleted.name}`);
     */
    async findOneAndDelete(filter) {
        return this._execute(async (conn) => {
            const { whereClause, binds } = parseFilter(filter);
            const selectSql = `SELECT * FROM ${quoteIdentifier(this.tableName)} ${whereClause} FETCH FIRST 1 ROW ONLY`;

            const found = await conn.execute(selectSql, binds, {
                outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
            });
            const doc = found.rows[0] ?? null;
            if (!doc) return null;

            const deleteSql = `DELETE FROM ${quoteIdentifier(this.tableName)} WHERE ROWID = (SELECT ROWID FROM ${quoteIdentifier(this.tableName)} ${whereClause} AND ROWNUM = 1)`;
            try {
                await conn.execute(deleteSql, binds, {
                    autoCommit: !this._conn,
                });
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.findOneAndDelete",
                        err,
                        deleteSql,
                    ),
                );
            }
            return doc;
        });
    }

    /**
     * Find a document, replace all its fields (except the ID/primary key),
     * and return the before or after version.
     *
     * Unlike updateOne which applies operators ($set, $inc, etc.),
     * replaceOne REPLACES the entire document with the new one.
     *
     * @param {Object} filter - Filter to find the document
     * @param {Object} replacement - The complete new document
     *   (all fields except ID will be overwritten)
     * @param {Object} [options] - returnDocument: 'before' (default) or 'after'
     * @returns {Promise<Object|null>} The document before/after replacement, or null
     *
     * @example
     *   await users.findOneAndReplace(
     *     { id: 1 },
     *     { name: "Ana Maria", email: "ana@new.com", status: "active" },
     *     { returnDocument: "after" }
     *   );
     */
    async findOneAndReplace(filter, replacement, options = {}) {
        return this._execute(async (conn) => {
            const { whereClause, binds: filterBinds } = parseFilter(filter);
            const selectSql = `SELECT * FROM ${quoteIdentifier(this.tableName)} ${whereClause} FETCH FIRST 1 ROW ONLY`;

            const found = await conn.execute(selectSql, filterBinds, {
                outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
            });
            const beforeDoc = found.rows[0] ?? null;
            if (!beforeDoc) return null;

            // Build SET from replacement (exclude ID/primary key)
            const cols = Object.keys(replacement).filter((c) => c !== "ID");
            const setParts = [];
            const replBinds = {};
            cols.forEach((c, i) => {
                const bname = `repl_${i}`;
                replBinds[bname] = replacement[c];
                setParts.push(`${quoteIdentifier(c)} = :${bname}`);
            });

            const allBinds = mergeBinds(filterBinds, replBinds);
            const updateSql = `UPDATE ${quoteIdentifier(this.tableName)} SET ${setParts.join(", ")} ${whereClause}`;

            try {
                await conn.execute(updateSql, allBinds, {
                    autoCommit: !this._conn,
                });
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.findOneAndReplace",
                        err,
                        updateSql,
                    ),
                );
            }

            if (options.returnDocument === "after") {
                const afterFilter =
                    beforeDoc.ID != null ? { ID: beforeDoc.ID } : filter;
                const { whereClause: aw, binds: ab } = parseFilter(afterFilter);
                const afterSql = `SELECT * FROM ${quoteIdentifier(this.tableName)} ${aw} FETCH FIRST 1 ROW ONLY`;
                const afterResult = await conn.execute(afterSql, ab, {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                });
                return afterResult.rows[0] ?? null;
            }
            return beforeDoc;
        });
    }

    /**
     * Count documents matching a filter.
     *
     * Runs SELECT COUNT(*) — scans the actual data. For a faster
     * approximate count, use estimatedDocumentCount() instead.
     *
     * @param {Object} [filter] - Filter criteria (omit or {} for all rows)
     * @returns {Promise<number>} The count of matching rows
     *
     * @example
     *   const total = await users.countDocuments();               // Count all
     *   const active = await users.countDocuments({ status: "active" }); // Filtered
     */
    async countDocuments(filter = {}) {
        return this._execute(async (conn) => {
            const { whereClause, binds } = parseFilter(filter);
            const sql = `SELECT COUNT(*) AS CNT FROM ${quoteIdentifier(this.tableName)} ${whereClause}`;
            try {
                const result = await conn.execute(sql, binds, {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                    autoCommit: !this._conn,
                });
                return Number(result.rows[0].CNT);
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.countDocuments",
                        err,
                        sql,
                        binds,
                    ),
                );
            }
        });
    }

    /**
     * Fast estimated count from Oracle's USER_TABLES metadata.
     *
     * This does NOT scan the table — it reads the last-known row count
     * from Oracle's internal statistics. This is extremely fast but may
     * be slightly stale (until the next ANALYZE/DBMS_STATS run).
     *
     * Good for dashboard counters where precision isn't critical.
     *
     * @returns {Promise<number>} Estimated number of rows
     *
     * @example
     *   const approxCount = await users.estimatedDocumentCount();
     *   console.log(`Approximately ${approxCount} users`);
     */
    async estimatedDocumentCount() {
        return this._execute(async (conn) => {
            const sql = `SELECT NUM_ROWS FROM USER_TABLES WHERE TABLE_NAME = UPPER(:name)`;
            try {
                const result = await conn.execute(
                    sql,
                    { name: this.tableName },
                    {
                        outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                        autoCommit: !this._conn,
                    },
                );
                return Number(result.rows[0]?.NUM_ROWS ?? 0);
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.estimatedDocumentCount",
                        err,
                        sql,
                    ),
                );
            }
        });
    }

    /**
     * Get distinct (unique) values of a specific column.
     *
     * Optionally filter which rows to consider.
     *
     * @param {string} field - Column name (e.g. "status")
     * @param {Object} [filter] - Optional filter to narrow the scope
     * @returns {Promise<Array>} Array of unique values
     *
     * @example
     *   const statuses = await users.distinct("status");
     *   // → ["active", "inactive", "pending"]
     *
     *   const cities = await users.distinct("city", { country: "PH" });
     *   // → ["Manila", "Cebu", "Davao"]
     */
    async distinct(field, filter = {}) {
        return this._execute(async (conn) => {
            const { whereClause, binds } = parseFilter(filter);
            const sql = `SELECT DISTINCT ${quoteIdentifier(field)} FROM ${quoteIdentifier(this.tableName)} ${whereClause}`;
            try {
                const result = await conn.execute(sql, binds, {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                    autoCommit: !this._conn,
                });
                return result.rows.map((r) => r[field]);
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleCollection.distinct", err, sql, binds),
                );
            }
        });
    }

    // ─── Insert Operations ───────────────────────────────────────

    /**
     * Insert a single document (row) into the table.
     *
     * Automatically handles:
     *   - Building the INSERT SQL with bind variables
     *   - RETURNING clause to get back the auto-generated ID
     *   - Custom RETURNING columns via options.returning
     *
     * @param {Object} document - The data to insert (e.g. { name: "Ana", age: 25 })
     * @param {Object} [options]
     *   - returning: Array of column names to return from the INSERT
     *     (e.g. ['ID', 'CREATED_AT'] to get back auto-generated values)
     * @returns {Promise<{ acknowledged: boolean, insertedId: *, returning?: Object }>}
     *   - acknowledged: true if the operation was accepted
     *   - insertedId: The auto-generated ID of the inserted row
     *   - returning: Object with requested RETURNING values (if options.returning was set)
     *
     * @example
     *   const result = await users.insertOne({ name: "Ana", email: "ana@test.com" });
     *   console.log(result.insertedId); // → 42 (auto-generated ID)
     *
     *   // With RETURNING clause:
     *   const result2 = await users.insertOne(
     *     { name: "Ben" },
     *     { returning: ["ID", "CREATED_AT"] }
     *   );
     *   console.log(result2.returning.CREATED_AT); // → 2024-01-15T...
     */
    async insertOne(document, options = {}) {
        return this._execute(async (conn) => {
            const cols = Object.keys(document);
            const bindNames = cols.map((_, i) => `:v${i}`);
            const binds = {};
            cols.forEach((c, i) => {
                binds[`v${i}`] = document[c];
            });

            // RETURNING clause
            let returningSql = "";
            const outBinds = {};
            const returningCols = options.returning || [];
            if (returningCols.length > 0) {
                const retCols = returningCols.map(quoteIdentifier).join(", ");
                const retOuts = returningCols
                    .map((c) => `:out_${c}`)
                    .join(", ");
                returningSql = ` RETURNING ${retCols} INTO ${retOuts}`;
                for (const c of returningCols) {
                    outBinds[`out_${c}`] = { dir: this.db.oracledb.BIND_OUT };
                }
            }

            // Always return ID
            const hasIdCol = cols.some((c) => c.toUpperCase() === "ID");
            if (!hasIdCol && !returningCols.includes("ID")) {
                returningSql = returningSql || ` RETURNING "ID" INTO :out_id`;
                if (!returningSql.includes("out_id")) {
                    // ID already covered
                } else {
                    outBinds.out_id = {
                        dir: this.db.oracledb.BIND_OUT,
                        type: this.db.oracledb.NUMBER,
                    };
                }
            }

            const allBinds = { ...binds, ...outBinds };
            const sql = `INSERT INTO ${quoteIdentifier(this.tableName)} (${cols.map(quoteIdentifier).join(", ")}) VALUES (${bindNames.join(", ")})${returningSql}`;

            try {
                const result = await conn.execute(sql, allBinds, {
                    autoCommit: !this._conn,
                });
                const response = { acknowledged: true, insertedId: null };

                // Extract insertedId
                if (result.outBinds) {
                    if (result.outBinds.out_id) {
                        response.insertedId = Array.isArray(
                            result.outBinds.out_id,
                        )
                            ? result.outBinds.out_id[0]
                            : result.outBinds.out_id;
                    }
                    if (returningCols.length > 0) {
                        response.returning = {};
                        for (const c of returningCols) {
                            const val = result.outBinds[`out_${c}`];
                            response.returning[c] = Array.isArray(val)
                                ? val[0]
                                : val;
                            if (
                                c.toUpperCase() === "ID" &&
                                !response.insertedId
                            ) {
                                response.insertedId = response.returning[c];
                            }
                        }
                    }
                }

                return response;
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.insertOne",
                        err,
                        sql,
                        allBinds,
                    ),
                );
            }
        });
    }

    /**
     * Insert multiple documents atomically using executeMany.
     *
     * All documents are inserted in a SINGLE TRANSACTION — if any one fails,
     * none of them are inserted. Much faster than calling insertOne() in a loop
     * because it uses Oracle's executeMany() for bulk insertion.
     *
     * IMPORTANT: All documents must have the same set of keys (columns).
     * The keys from the FIRST document define the columns for all rows.
     *
     * @param {Array<Object>} documents - Array of documents to insert
     * @returns {Promise<{ acknowledged: boolean, insertedCount: number, insertedIds: Array }>}
     *
     * @example
     *   const result = await users.insertMany([
     *     { name: "Ana", age: 25 },
     *     { name: "Ben", age: 30 },
     *     { name: "Cat", age: 28 },
     *   ]);
     *   console.log(result.insertedCount); // → 3
     *   console.log(result.insertedIds);   // → [1, 2, 3]
     */
    async insertMany(documents) {
        if (!Array.isArray(documents) || documents.length === 0) {
            throw new Error(MSG.INSERT_MANY_EMPTY);
        }

        return this.db.withTransaction(async (conn) => {
            const cols = Object.keys(documents[0]);
            const placeholders = cols.map((_, i) => `:v${i}`).join(", ");
            const returningSql = ` RETURNING "ID" INTO :out_id`;
            const sql = `INSERT INTO ${quoteIdentifier(this.tableName)} (${cols.map(quoteIdentifier).join(", ")}) VALUES (${placeholders})${returningSql}`;

            // Build bind arrays for executeMany
            const bindDefs = {};
            cols.forEach((c, i) => {
                // Scan all documents for a non-null sample to determine the type
                let sampleVal = null;
                for (const doc of documents) {
                    if (doc[c] != null) {
                        sampleVal = doc[c];
                        break;
                    }
                }
                if (typeof sampleVal === "number") {
                    bindDefs[`v${i}`] = { type: this.db.oracledb.NUMBER };
                } else if (sampleVal instanceof Date) {
                    bindDefs[`v${i}`] = { type: this.db.oracledb.DATE };
                } else {
                    const maxLen = Math.max(
                        ...documents.map((d) => {
                            const v = d[c];
                            return v != null ? String(v).length : 1;
                        }),
                        1,
                    );
                    bindDefs[`v${i}`] = {
                        type: this.db.oracledb.STRING,
                        maxSize: Math.max(maxLen * 2, 100),
                    };
                }
            });
            bindDefs.out_id = {
                type: this.db.oracledb.NUMBER,
                dir: this.db.oracledb.BIND_OUT,
            };

            const bindRows = documents.map((doc) => {
                const row = {};
                cols.forEach((c, i) => {
                    row[`v${i}`] = doc[c] ?? null;
                });
                return row;
            });

            try {
                const result = await conn.executeMany(sql, bindRows, {
                    autoCommit: false,
                    bindDefs,
                });

                const insertedIds = result.outBinds
                    ? result.outBinds.map((ob) => ob.out_id?.[0] ?? null)
                    : [];

                return {
                    acknowledged: true,
                    insertedCount: result.rowsAffected,
                    insertedIds,
                };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleCollection.insertMany", err, sql),
                );
            }
        });
    }

    // ─── Update Operations ───────────────────────────────────────

    /**
     * Update the FIRST document matching the filter.
     *
     * Uses Oracle's ROWID subquery to ensure only ONE row is updated,
     * even if multiple rows match the filter.
     *
     * Supports:
     *   - upsert: If no match, insert a new document instead
     *   - returning: Get back specific column values after the update
     *
     * @param {Object} filter - Which row to update (e.g. { id: 1 })
     * @param {Object} update - Update operators (e.g. { $set: { name: "New" } })
     * @param {Object} [options]
     *   - upsert: true to insert if no match found
     *   - returning: Array of column names to return
     * @returns {Promise<{ acknowledged, matchedCount, modifiedCount, returning? }>}
     *
     * @example
     *   await users.updateOne(
     *     { id: 1 },
     *     { $set: { status: "premium" }, $inc: { loginCount: 1 } }
     *   );
     */
    async updateOne(filter, update, options = {}) {
        return this._execute(async (conn) => {
            const { whereClause, binds: filterBinds } = parseFilter(filter);
            const { setClause, binds: updateBinds } = parseUpdate(update);
            const allBinds = mergeBinds(filterBinds, updateBinds);

            // RETURNING
            let returningSql = "";
            const outBinds = {};
            const returningCols = options.returning || [];
            if (returningCols.length > 0) {
                const retCols = returningCols.map(quoteIdentifier).join(", ");
                const retOuts = returningCols
                    .map((c) => `:out_${c}`)
                    .join(", ");
                returningSql = ` RETURNING ${retCols} INTO ${retOuts}`;
                for (const c of returningCols) {
                    outBinds[`out_${c}`] = { dir: this.db.oracledb.BIND_OUT };
                }
            }

            const finalBinds = { ...allBinds, ...outBinds };
            const sql = `UPDATE ${quoteIdentifier(this.tableName)} ${setClause} WHERE ROWID = (SELECT ROWID FROM ${quoteIdentifier(this.tableName)} ${whereClause} AND ROWNUM = 1)${returningSql}`;

            try {
                const result = await conn.execute(sql, finalBinds, {
                    autoCommit: !this._conn,
                });

                if (result.rowsAffected === 0 && options.upsert) {
                    // Upsert: insert
                    const fields = {};
                    if (update.$set) Object.assign(fields, update.$set);
                    for (const [k, v] of Object.entries(filter)) {
                        if (typeof v !== "object") fields[k] = v;
                    }
                    const cols = Object.keys(fields);
                    const vals = cols.map((_, i) => `:v${i}`);
                    const insertBinds = {};
                    cols.forEach((c, i) => {
                        insertBinds[`v${i}`] = fields[c];
                    });
                    const insertSql = `INSERT INTO ${quoteIdentifier(this.tableName)} (${cols.map(quoteIdentifier).join(", ")}) VALUES (${vals.join(", ")})`;
                    await conn.execute(insertSql, insertBinds, {
                        autoCommit: !this._conn,
                    });
                    return {
                        acknowledged: true,
                        matchedCount: 0,
                        modifiedCount: 0,
                        upsertedCount: 1,
                    };
                }

                const response = {
                    acknowledged: true,
                    matchedCount: result.rowsAffected > 0 ? 1 : 0,
                    modifiedCount: result.rowsAffected,
                };
                if (returningCols.length > 0 && result.outBinds) {
                    response.returning = {};
                    for (const c of returningCols) {
                        const val = result.outBinds[`out_${c}`];
                        response.returning[c] = Array.isArray(val)
                            ? val[0]
                            : val;
                    }
                }
                return response;
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.updateOne",
                        err,
                        sql,
                        finalBinds,
                    ),
                );
            }
        });
    }

    /**
     * Update ALL documents matching the filter.
     *
     * Unlike updateOne which updates only the first match,
     * updateMany updates EVERY row that matches the filter.
     *
     * @param {Object} filter - Which rows to update (e.g. { status: "trial" })
     * @param {Object} update - Update operators (e.g. { $set: { status: "expired" } })
     * @param {Object} [options] - returning (array of column names)
     * @returns {Promise<{ acknowledged, matchedCount, modifiedCount }>}
     *
     * @example
     *   // Mark all trial accounts as expired
     *   const result = await users.updateMany(
     *     { status: "trial" },
     *     { $set: { status: "expired" }, $currentDate: { updatedAt: true } }
     *   );
     *   console.log(`Updated ${result.modifiedCount} users`);
     */
    async updateMany(filter, update, options = {}) {
        return this._execute(async (conn) => {
            const { whereClause, binds: filterBinds } = parseFilter(filter);
            const { setClause, binds: updateBinds } = parseUpdate(update);
            const allBinds = mergeBinds(filterBinds, updateBinds);

            const sql = `UPDATE ${quoteIdentifier(this.tableName)} ${setClause} ${whereClause}`;
            try {
                const result = await conn.execute(sql, allBinds, {
                    autoCommit: !this._conn,
                });
                return {
                    acknowledged: true,
                    matchedCount: result.rowsAffected,
                    modifiedCount: result.rowsAffected,
                };
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.updateMany",
                        err,
                        sql,
                        allBinds,
                    ),
                );
            }
        });
    }

    /**
     * Replace a single document entirely (except primary key).
     *
     * Unlike updateOne which uses operators ($set, $inc), replaceOne
     * REPLACES all columns with the values from the replacement object.
     * The ID column is preserved automatically.
     *
     * @param {Object} filter - Which row to replace (e.g. { id: 1 })
     * @param {Object} replacement - Complete new document (ID column is excluded)
     * @param {Object} [options] - Reserved for future use
     * @returns {Promise<{ acknowledged, matchedCount, modifiedCount }>}
     *
     * @example
     *   await users.replaceOne(
     *     { id: 1 },
     *     { name: "New Name", email: "new@test.com", status: "active" }
     *   );
     */
    async replaceOne(filter, replacement, options = {}) {
        return this._execute(async (conn) => {
            const { whereClause, binds: filterBinds } = parseFilter(filter);
            const cols = Object.keys(replacement).filter((c) => c !== "ID");
            const setParts = [];
            const replBinds = {};
            cols.forEach((c, i) => {
                const bname = `repl_${i}`;
                replBinds[bname] = replacement[c];
                setParts.push(`${quoteIdentifier(c)} = :${bname}`);
            });

            const allBinds = mergeBinds(filterBinds, replBinds);
            const sql = `UPDATE ${quoteIdentifier(this.tableName)} SET ${setParts.join(", ")} WHERE ROWID = (SELECT ROWID FROM ${quoteIdentifier(this.tableName)} ${whereClause} AND ROWNUM = 1)`;

            try {
                const result = await conn.execute(sql, allBinds, {
                    autoCommit: !this._conn,
                });
                return {
                    acknowledged: true,
                    matchedCount: result.rowsAffected > 0 ? 1 : 0,
                    modifiedCount: result.rowsAffected,
                };
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.replaceOne",
                        err,
                        sql,
                        allBinds,
                    ),
                );
            }
        });
    }

    /**
     * Execute multiple operations atomically in a single transaction.
     *
     * All operations run in ONE transaction — if any fails, ALL are rolled back.
     * Supports: insertOne, updateOne, updateMany, deleteOne, deleteMany, replaceOne.
     *
     * @param {Array} operations - Array of operation objects
     * @returns {Promise<{ acknowledged, results }>}
     *
     * @example
     *   await users.bulkWrite([
     *     { insertOne: { document: { name: "Ana", age: 25 } } },
     *     { updateOne: { filter: { id: 2 }, update: { $set: { age: 31 } } } },
     *     { deleteOne: { filter: { id: 99 } } },
     *   ]);
     */
    async bulkWrite(operations) {
        if (!Array.isArray(operations) || operations.length === 0) {
            throw new Error(MSG.BULK_WRITE_EMPTY);
        }

        return this.db.withTransaction(async (conn) => {
            const sessionColl = new OracleCollection(
                this.tableName,
                this.db,
                conn,
            );
            const results = [];

            for (const op of operations) {
                if (op.insertOne) {
                    results.push(
                        await sessionColl.insertOne(op.insertOne.document),
                    );
                } else if (op.updateOne) {
                    results.push(
                        await sessionColl.updateOne(
                            op.updateOne.filter,
                            op.updateOne.update,
                            op.updateOne.options,
                        ),
                    );
                } else if (op.updateMany) {
                    results.push(
                        await sessionColl.updateMany(
                            op.updateMany.filter,
                            op.updateMany.update,
                            op.updateMany.options,
                        ),
                    );
                } else if (op.deleteOne) {
                    results.push(
                        await sessionColl.deleteOne(
                            op.deleteOne.filter,
                            op.deleteOne.options,
                        ),
                    );
                } else if (op.deleteMany) {
                    results.push(
                        await sessionColl.deleteMany(op.deleteMany.filter),
                    );
                } else if (op.replaceOne) {
                    results.push(
                        await sessionColl.replaceOne(
                            op.replaceOne.filter,
                            op.replaceOne.replacement,
                            op.replaceOne.options,
                        ),
                    );
                } else {
                    throw new Error(MSG.BULK_WRITE_UNKNOWN_OP(Object.keys(op)));
                }
            }

            return { acknowledged: true, results };
        });
    }

    // ─── Delete Operations ───────────────────────────────────────

    /**
     * Delete the FIRST document matching the filter.
     *
     * Uses ROWID subquery to ensure only ONE row is deleted,
     * even if multiple rows match.
     *
     * @param {Object} filter - Which row to delete (e.g. { id: 1 })
     * @param {Object} [options]
     *   - returning: Array of column names to return from the deleted row
     * @returns {Promise<{ acknowledged, deletedCount, returning? }>}
     *
     * @example
     *   const result = await users.deleteOne({ id: 42 });
     *   console.log(result.deletedCount); // → 1
     *
     *   // With RETURNING to get the deleted data:
     *   const result2 = await users.deleteOne(
     *     { id: 42 },
     *     { returning: ["name", "email"] }
     *   );
     *   console.log(result2.returning.name); // → "Ana"
     */
    async deleteOne(filter, options = {}) {
        return this._execute(async (conn) => {
            const { whereClause, binds } = parseFilter(filter);

            let returningSql = "";
            const outBinds = {};
            const returningCols = options.returning || [];
            if (returningCols.length > 0) {
                const retCols = returningCols.map(quoteIdentifier).join(", ");
                const retOuts = returningCols
                    .map((c) => `:out_${c}`)
                    .join(", ");
                returningSql = ` RETURNING ${retCols} INTO ${retOuts}`;
                for (const c of returningCols) {
                    outBinds[`out_${c}`] = { dir: this.db.oracledb.BIND_OUT };
                }
            }

            const allBinds = { ...binds, ...outBinds };
            const sql = `DELETE FROM ${quoteIdentifier(this.tableName)} WHERE ROWID = (SELECT ROWID FROM ${quoteIdentifier(this.tableName)} ${whereClause} AND ROWNUM = 1)${returningSql}`;

            try {
                const result = await conn.execute(sql, allBinds, {
                    autoCommit: !this._conn,
                });
                const response = {
                    acknowledged: true,
                    deletedCount: result.rowsAffected,
                };
                if (returningCols.length > 0 && result.outBinds) {
                    response.returning = {};
                    for (const c of returningCols) {
                        const val = result.outBinds[`out_${c}`];
                        response.returning[c] = Array.isArray(val)
                            ? val[0]
                            : val;
                    }
                }
                return response;
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.deleteOne",
                        err,
                        sql,
                        allBinds,
                    ),
                );
            }
        });
    }

    /**
     * Delete ALL documents matching the filter.
     *
     * BE CAREFUL: This deletes EVERY row that matches.
     * Use an empty filter {} to delete all rows (like TRUNCATE).
     *
     * @param {Object} filter - Which rows to delete
     * @returns {Promise<{ acknowledged, deletedCount }>}
     *
     * @example
     *   // Delete all inactive users
     *   const result = await users.deleteMany({ status: "inactive" });
     *   console.log(`Deleted ${result.deletedCount} users`);
     */
    async deleteMany(filter) {
        return this._execute(async (conn) => {
            const { whereClause, binds } = parseFilter(filter);
            const sql = `DELETE FROM ${quoteIdentifier(this.tableName)} ${whereClause}`;
            try {
                const result = await conn.execute(sql, binds, {
                    autoCommit: !this._conn,
                });
                return {
                    acknowledged: true,
                    deletedCount: result.rowsAffected,
                };
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.deleteMany",
                        err,
                        sql,
                        binds,
                    ),
                );
            }
        });
    }

    /**
     * Drop this table entirely. WARNING: This is irreversible!
     *
     * Runs: DROP TABLE "tableName" CASCADE CONSTRAINTS
     * This removes the table AND all foreign key constraints pointing to it.
     *
     * @returns {Promise<{ acknowledged }>}
     */
    async drop() {
        return this._execute(async (conn) => {
            const sql = `DROP TABLE ${quoteIdentifier(this.tableName)} CASCADE CONSTRAINTS`;
            try {
                await conn.execute(sql, {}, { autoCommit: !this._conn });
                return { acknowledged: true };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleCollection.drop", err, sql),
                );
            }
        });
    }

    // ─── Aggregation ─────────────────────────────────────────────

    /**
     * Execute a MongoDB-style aggregation pipeline.
     *
     * The pipeline is an array of stages that transform data step by step.
     * Each stage becomes an Oracle CTE (WITH ... AS). See aggregatePipeline.js.
     *
     * Supported stages: $match, $group, $sort, $limit, $skip, $count,
     * $project, $addFields, $lookup, $lateralJoin, $out, $merge,
     * $bucket, $facet, $replaceRoot, $unwind, $having
     *
     * The returned object is a Promise (so you can await it) AND has a
     * _buildSQL() method (so createMaterializedView can extract the SQL).
     *
     * @param {Array} pipeline - Array of stage objects
     * @returns {Promise<Array> & { _buildSQL: Function }}
     *
     * @example
     *   const report = await orders.aggregate([
     *     { $match: { status: "completed" } },
     *     { $group: { _id: "$region", total: { $sum: "$amount" } } },
     *     { $sort: { total: -1 } },
     *     { $limit: 5 },
     *   ]);
     *   // Returns the top 5 regions by total order amount
     */
    aggregate(pipeline) {
        const { buildAggregateSQL } = require("../pipeline/aggregatePipeline");
        const pipelineCopy = JSON.parse(JSON.stringify(pipeline));
        const { sql, binds } = buildAggregateSQL(
            this.tableName,
            pipelineCopy,
            this.db,
        );

        const resultPromise = this._execute(async (conn) => {
            try {
                const result = await conn.execute(sql, binds, {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                    autoCommit: !this._conn,
                });
                return result.rows || [];
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.aggregate",
                        err,
                        sql,
                        binds,
                    ),
                );
            }
        });

        // Augment the promise so createMaterializedView can extract the SQL
        resultPromise._buildSQL = () => ({ sql, binds });
        return resultPromise;
    }

    // ─── Index Operations ────────────────────────────────────────

    /**
     * Create an index on specified fields.
     * @param {Object} fields - { colName: 1 (ASC) | -1 (DESC) }
     * @param {Object} [options] - unique, name, type ('bitmap')
     * @returns {Promise<{ acknowledged, indexName }>}
     */
    async createIndex(fields, options = {}) {
        return this._execute(async (conn) => {
            const cols = Object.entries(fields)
                .map(
                    ([col, dir]) =>
                        `${quoteIdentifier(col)} ${dir === -1 ? "DESC" : "ASC"}`,
                )
                .join(", ");
            const colNames = Object.keys(fields).join("_");
            const indexName =
                options.name || `IDX_${this.tableName}_${colNames}`;
            const unique = options.unique ? "UNIQUE " : "";
            const bitmap = options.type === "bitmap" ? "BITMAP " : "";
            const sql = `CREATE ${unique}${bitmap}INDEX ${quoteIdentifier(indexName)} ON ${quoteIdentifier(this.tableName)} (${cols})`;

            try {
                await conn.execute(sql, {}, { autoCommit: !this._conn });
                return { acknowledged: true, indexName };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleCollection.createIndex", err, sql),
                );
            }
        });
    }

    /**
     * Create multiple indexes.
     * @param {Array} indexSpecs - [{ fields, options }]
     * @returns {Promise<{ acknowledged, indexNames }>}
     */
    async createIndexes(indexSpecs) {
        const indexNames = [];
        for (const spec of indexSpecs) {
            const result = await this.createIndex(
                spec.fields,
                spec.options || spec,
            );
            indexNames.push(result.indexName);
        }
        return { acknowledged: true, indexNames };
    }

    /**
     * Drop a named index.
     * @param {string} indexName
     * @returns {Promise<{ acknowledged }>}
     */
    async dropIndex(indexName) {
        return this._execute(async (conn) => {
            const sql = `DROP INDEX ${quoteIdentifier(indexName)}`;
            try {
                await conn.execute(sql, {}, { autoCommit: !this._conn });
                return { acknowledged: true };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleCollection.dropIndex", err, sql),
                );
            }
        });
    }

    /**
     * Drop all non-primary-key indexes on this table.
     * @returns {Promise<{ acknowledged, dropped }>}
     */
    async dropIndexes() {
        return this._execute(async (conn) => {
            const sql = `SELECT INDEX_NAME FROM USER_INDEXES WHERE TABLE_NAME = UPPER(:tbl) AND INDEX_TYPE <> 'LOB' AND INDEX_NAME NOT IN (SELECT CONSTRAINT_NAME FROM USER_CONSTRAINTS WHERE TABLE_NAME = UPPER(:tbl2) AND CONSTRAINT_TYPE = 'P')`;
            const result = await conn.execute(
                sql,
                { tbl: this.tableName, tbl2: this.tableName },
                {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                },
            );
            const dropped = [];
            for (const row of result.rows) {
                try {
                    await conn.execute(
                        `DROP INDEX ${quoteIdentifier(row.INDEX_NAME)}`,
                        {},
                        { autoCommit: !this._conn },
                    );
                    dropped.push(row.INDEX_NAME);
                } catch (err) {
                    // Skip errors (e.g. system-generated indexes)
                }
            }
            return { acknowledged: true, dropped };
        });
    }

    /**
     * Get all indexes on this table.
     * @returns {Promise<Array<{ indexName, columns, unique, type }>>}
     */
    async getIndexes() {
        return this._execute(async (conn) => {
            const sql = `SELECT i.INDEX_NAME, i.UNIQUENESS, i.INDEX_TYPE, ic.COLUMN_NAME, ic.COLUMN_POSITION FROM USER_INDEXES i JOIN USER_IND_COLUMNS ic ON i.INDEX_NAME = ic.INDEX_NAME WHERE i.TABLE_NAME = UPPER(:tbl) ORDER BY i.INDEX_NAME, ic.COLUMN_POSITION`;
            const result = await conn.execute(
                sql,
                { tbl: this.tableName },
                {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                },
            );

            const indexMap = {};
            for (const row of result.rows) {
                if (!indexMap[row.INDEX_NAME]) {
                    indexMap[row.INDEX_NAME] = {
                        indexName: row.INDEX_NAME,
                        columns: [],
                        unique: row.UNIQUENESS === "UNIQUE",
                        type: row.INDEX_TYPE,
                    };
                }
                indexMap[row.INDEX_NAME].columns.push(row.COLUMN_NAME);
            }
            return Object.values(indexMap);
        });
    }

    /**
     * Rebuild all indexes on this table.
     * @returns {Promise<{ acknowledged }>}
     */
    async reIndex() {
        return this._execute(async (conn) => {
            const sql = `SELECT INDEX_NAME FROM USER_INDEXES WHERE TABLE_NAME = UPPER(:tbl) AND INDEX_TYPE <> 'LOB'`;
            const result = await conn.execute(
                sql,
                { tbl: this.tableName },
                {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                },
            );
            for (const row of result.rows) {
                try {
                    await conn.execute(
                        `ALTER INDEX ${quoteIdentifier(row.INDEX_NAME)} REBUILD`,
                        {},
                        { autoCommit: !this._conn },
                    );
                } catch (err) {
                    // Skip errors
                }
            }
            return { acknowledged: true };
        });
    }

    // ─── MERGE / UPSERT ─────────────────────────────────────────

    /**
     * Oracle MERGE (upsert) statement using DUAL as the source.
     *
     * MERGE is Oracle's way of saying "insert if new, update if exists".
     * This uses a single sourceData object matched against the table.
     *
     * @param {Object} sourceData - Data to merge (e.g. { id: 1, name: "Ana" })
     * @param {Object} matchCondition - How to match rows:
     *   - localField:   Column in the target table (e.g. "id")
     *   - foreignField: Column in the source data (e.g. "id")
     * @param {Object} [options]
     *   - whenMatched: Update operators if row exists (e.g. { $set: { name: "New" } })
     *   - whenNotMatched: "insert" to insert if no match
     *   - whenMatchedDelete: Filter to conditionally delete matched rows
     * @returns {Promise<{ acknowledged }>}
     *
     * @example
     *   await users.merge(
     *     { id: 1, name: "Ana", status: "active" },
     *     { localField: "id", foreignField: "id" },
     *     {
     *       whenMatched: { $set: { name: "Ana", status: "active" } },
     *       whenNotMatched: "insert"
     *     }
     *   );
     */
    async merge(sourceData, matchCondition, options = {}) {
        return this._execute(async (conn) => {
            const cols = Object.keys(sourceData);
            const srcParts = cols.map((c) => {
                const bname = `merge_${c}`;
                return `:${bname} AS ${quoteIdentifier(c)}`;
            });
            const srcBinds = {};
            cols.forEach((c) => {
                srcBinds[`merge_${c}`] = sourceData[c];
            });

            const onClause = `tgt.${quoteIdentifier(matchCondition.localField)} = src.${quoteIdentifier(matchCondition.foreignField)}`;

            let whenMatchedSql = "";
            if (options.whenMatched) {
                const { setClause, binds: upBinds } = parseUpdate(
                    options.whenMatched,
                );
                Object.assign(srcBinds, upBinds);
                // Replace quotes to use tgt. prefix
                whenMatchedSql = `\nWHEN MATCHED THEN UPDATE ${setClause}`;
            }

            let whenMatchedDeleteSql = "";
            if (options.whenMatchedDelete) {
                const { whereClause, binds: delBinds } = parseFilter(
                    options.whenMatchedDelete,
                );
                Object.assign(srcBinds, delBinds);
                const delWhere = whereClause.replace(/^WHERE\s+/i, "");
                whenMatchedDeleteSql = `\n  DELETE ${delWhere ? `WHERE ${delWhere}` : ""}`;
            }

            let whenNotMatchedSql = "";
            if (options.whenNotMatched === "insert") {
                const insertCols = cols.map(quoteIdentifier).join(", ");
                const insertVals = cols
                    .map((c) => `src.${quoteIdentifier(c)}`)
                    .join(", ");
                whenNotMatchedSql = `\nWHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${insertVals})`;
            }

            const sql = `MERGE INTO ${quoteIdentifier(this.tableName)} tgt\nUSING (SELECT ${srcParts.join(", ")} FROM DUAL) src\nON (${onClause})${whenMatchedSql}${whenMatchedDeleteSql}${whenNotMatchedSql}`;

            try {
                await conn.execute(sql, srcBinds, { autoCommit: !this._conn });
                return { acknowledged: true };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleCollection.merge", err, sql, srcBinds),
                );
            }
        });
    }

    /**
     * Merge rows from another TABLE (not a single object like merge()).
     *
     * This is for syncing two tables: "update target from source where they match".
     * Use $src.colName in $set values to reference source table columns.
     *
     * @param {string} sourceTable - Name of the source table
     * @param {Object} matchCondition - { localField, foreignField }
     * @param {Object} [options]
     *   - whenMatched: { $set: { col: "$src.sourceCol" } }
     * @returns {Promise<{ acknowledged }>}
     *
     * @example
     *   await target.mergeFrom("source_table",
     *     { localField: "id", foreignField: "id" },
     *     { whenMatched: { $set: { price: "$src.price", stock: "$src.stock" } } }
     *   );
     */
    async mergeFrom(sourceTable, matchCondition, options = {}) {
        return this._execute(async (conn) => {
            const onClause = `tgt.${quoteIdentifier(matchCondition.localField)} = src.${quoteIdentifier(matchCondition.foreignField)}`;
            const binds = {};

            let whenMatchedSql = "";
            if (options.whenMatched) {
                const { $set } = options.whenMatched;
                if ($set) {
                    const parts = Object.entries($set).map(([col, val]) => {
                        if (
                            typeof val === "string" &&
                            val.startsWith("$src.")
                        ) {
                            return `tgt.${quoteIdentifier(col)} = src.${quoteIdentifier(val.replace("$src.", ""))}`;
                        }
                        const bname = `mergeFrom_${col}`;
                        binds[bname] = val;
                        return `tgt.${quoteIdentifier(col)} = :${bname}`;
                    });
                    whenMatchedSql = `\nWHEN MATCHED THEN UPDATE SET ${parts.join(", ")}`;
                }
            }

            const sql = `MERGE INTO ${quoteIdentifier(this.tableName)} tgt\nUSING ${quoteIdentifier(sourceTable)} src\nON (${onClause})${whenMatchedSql}`;

            try {
                await conn.execute(sql, binds, { autoCommit: !this._conn });
                return { acknowledged: true };
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.mergeFrom",
                        err,
                        sql,
                        binds,
                    ),
                );
            }
        });
    }

    // ─── Oracle Advanced Features ────────────────────────────────

    /**
     * Hierarchical (tree) query using Oracle's CONNECT BY clause.
     *
     * This is for querying tree structures like org charts, category trees,
     * bill-of-materials, etc. Oracle-specific — no MongoDB equivalent.
     *
     * @param {Object} spec
     *   - startWith: Filter for root nodes (e.g. { manager_id: null })
     *   - connectBy: How children link to parents (e.g. { prior: "id", to: "manager_id" })
     *   - orderSiblings: Sort within each level (e.g. { name: 1 })
     *   - maxLevel: Maximum depth to traverse
     *   - includeLevel: true to add a LEVEL pseudo-column
     *   - includePath: true to add a SYS_CONNECT_BY_PATH column
     * @returns {Promise<Array>} Flattened tree rows with optional LEVEL/PATH
     *
     * @example
     *   const tree = await employees.connectBy({
     *     startWith: { manager_id: null },
     *     connectBy: { prior: "id", to: "manager_id" },
     *     includeLevel: true,
     *     maxLevel: 5,
     *   });
     */
    async connectBy(spec) {
        const { buildConnectBy } = require("../advanced/oracleAdvanced");
        const { sql, binds } = buildConnectBy(this.tableName, spec);

        return this._execute(async (conn) => {
            try {
                const result = await conn.execute(sql, binds, {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                    autoCommit: !this._conn,
                });
                return result.rows || [];
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.connectBy",
                        err,
                        sql,
                        binds,
                    ),
                );
            }
        });
    }

    /**
     * PIVOT query — rotate rows into columns.
     *
     * Example: Turn rows like { product: "A", month: "Jan", sales: 100 }
     * into columns like { product: "A", JAN: 100, FEB: 200, MAR: 150 }
     *
     * @param {Object} spec
     *   - value: Aggregate expression (e.g. { $sum: "$sales" })
     *   - pivotOn: Column whose values become columns (e.g. "month")
     *   - pivotValues: Array of values to pivot (e.g. ["Jan", "Feb", "Mar"])
     *   - groupBy: Column(s) to keep as rows (e.g. ["product"])
     * @returns {Promise<Array>} Pivoted rows
     */
    async pivot(spec) {
        const { buildPivot } = require("../advanced/oracleAdvanced");
        const { sql, binds } = buildPivot(this.tableName, spec);

        return this._execute(async (conn) => {
            try {
                const result = await conn.execute(sql, binds, {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                    autoCommit: !this._conn,
                });
                return result.rows || [];
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleCollection.pivot", err, sql, binds),
                );
            }
        });
    }

    /**
     * UNPIVOT query — rotate columns into rows (opposite of pivot).
     *
     * Example: Turn columns like { JAN: 100, FEB: 200 } into rows:
     *   { month: "JAN", sales: 100 }, { month: "FEB", sales: 200 }
     *
     * @param {Object} spec
     *   - valueColumn: Name for the value column in output (e.g. "sales")
     *   - nameColumn: Name for the name column in output (e.g. "month")
     *   - columns: Array of columns to unpivot (e.g. ["JAN", "FEB", "MAR"])
     *   - includeNulls: true to include NULL values (uses INCLUDE NULLS)
     * @returns {Promise<Array>} Unpivoted rows
     */
    async unpivot(spec) {
        const { buildUnpivot } = require("../advanced/oracleAdvanced");
        const { sql, binds } = buildUnpivot(this.tableName, spec);

        return this._execute(async (conn) => {
            try {
                const result = await conn.execute(sql, binds, {
                    outFormat: this.db.oracledb.OUT_FORMAT_OBJECT,
                    autoCommit: !this._conn,
                });
                return result.rows || [];
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleCollection.unpivot", err, sql, binds),
                );
            }
        });
    }

    // ─── Set Operations (static) ─────────────────────────────────

    /**
     * UNION or UNION ALL of two QueryBuilder results.
     *
     * UNION removes duplicates, UNION ALL keeps them (faster).
     *
     * @param {QueryBuilder} qb1 - First query
     * @param {QueryBuilder} qb2 - Second query
     * @param {Object} [options] - { all: true } for UNION ALL
     * @returns {SetResultBuilder} Chainable builder (call .toArray() to execute)
     *
     * @example
     *   const result = await OracleCollection.union(
     *     users.find({ role: "admin" }),
     *     users.find({ role: "superadmin" }),
     *     { all: true }
     *   ).toArray();
     */
    static union(qb1, qb2, options = {}) {
        const { SetResultBuilder } = require("../joins/setOperations");
        return new SetResultBuilder(
            qb1,
            qb2,
            options.all ? "UNION ALL" : "UNION",
        );
    }

    /**
     * INTERSECT of two queries — returns rows that appear in BOTH results.
     *
     * @param {QueryBuilder} qb1 - First query
     * @param {QueryBuilder} qb2 - Second query
     * @returns {SetResultBuilder}
     */
    static intersect(qb1, qb2) {
        const { SetResultBuilder } = require("../joins/setOperations");
        return new SetResultBuilder(qb1, qb2, "INTERSECT");
    }

    /**
     * MINUS of two queries — returns rows in the first query that are NOT in the second.
     *
     * @param {QueryBuilder} qb1 - First query (base)
     * @param {QueryBuilder} qb2 - Second query (to subtract)
     * @returns {SetResultBuilder}
     */
    static minus(qb1, qb2) {
        const { SetResultBuilder } = require("../joins/setOperations");
        return new SetResultBuilder(qb1, qb2, "MINUS");
    }

    // ─── INSERT INTO ... SELECT ──────────────────────────────────

    /**
     * Insert rows from a QueryBuilder's SELECT into another table.
     *
     * Generates: INSERT INTO target (cols) SELECT cols FROM source WHERE ...
     * Automatically excludes identity/auto-generated columns.
     *
     * @param {string} targetTable - Table to insert into
     * @param {QueryBuilder} queryBuilder - The SELECT query providing data
     * @param {Object} [options]
     *   - columns: Explicit list of columns to insert
     * @returns {Promise<{ acknowledged, insertedCount }>}
     *
     * @example
     *   // Copy active users to an archive table
     *   await users.insertFromQuery(
     *     "users_archive",
     *     users.find({ status: "active" })
     *   );
     */
    async insertFromQuery(targetTable, queryBuilder, options = {}) {
        return this._execute(async (conn) => {
            let { sql: selectSql, binds } = queryBuilder._buildSQL();
            let colList = "";

            if (options.columns && options.columns.length > 0) {
                // Explicit columns provided
                colList = `(${options.columns.map(quoteIdentifier).join(", ")})`;
                const colSelectList = options.columns
                    .map(quoteIdentifier)
                    .join(", ");
                selectSql = selectSql.replace(
                    /SELECT\s+.*?\s+FROM/i,
                    `SELECT ${colSelectList} FROM`,
                );
            } else {
                // No columns specified — exclude identity columns to avoid ORA-32795
                const colResult = await conn.execute(
                    `SELECT COLUMN_NAME FROM USER_TAB_COLUMNS WHERE TABLE_NAME = UPPER(:t) AND (IDENTITY_COLUMN IS NULL OR IDENTITY_COLUMN = 'NO') ORDER BY COLUMN_ID`,
                    { t: targetTable },
                    { outFormat: this.db.oracledb.OUT_FORMAT_OBJECT },
                );
                const cols = colResult.rows.map((r) => r.COLUMN_NAME);
                if (cols.length > 0) {
                    colList = `(${cols.map(quoteIdentifier).join(", ")})`;
                    const colSelectList = cols.map(quoteIdentifier).join(", ");
                    selectSql = selectSql.replace(
                        /SELECT\s+.*?\s+FROM/i,
                        `SELECT ${colSelectList} FROM`,
                    );
                }
            }

            const sql = `INSERT INTO ${quoteIdentifier(targetTable)} ${colList} ${selectSql}`;

            try {
                const result = await conn.execute(sql, binds, {
                    autoCommit: !this._conn,
                });
                return {
                    acknowledged: true,
                    insertedCount: result.rowsAffected,
                };
            } catch (err) {
                throw new Error(
                    MSG.wrapError(
                        "OracleCollection.insertFromQuery",
                        err,
                        sql,
                        binds,
                    ),
                );
            }
        });
    }

    // ─── UPDATE ... JOIN ─────────────────────────────────────────

    /**
     * Update a table using values from a joined table.
     *
     * This is Oracle's way of doing "UPDATE ... FROM ... JOIN ...".
     * First tries an inline view approach; if Oracle rejects it
     * (non-key-preserved), falls back to a correlated subquery.
     *
     * @param {Object} spec
     *   - target: Target table name
     *   - join: { table, on: { localField, foreignField }, type? }
     *   - set: { targetCol: "$joined.sourceCol" } or literal values
     *   - where: Optional filter on the joined result
     * @returns {Promise<{ acknowledged, modifiedCount }>}
     *
     * @example
     *   await orders.updateFromJoin({
     *     target: "orders",
     *     join: { table: "products", on: { localField: "product_id", foreignField: "id" } },
     *     set: { price: "$joined.price" },
     *     where: { status: "pending" }
     *   });
     */
    async updateFromJoin(spec) {
        return this._execute(async (conn) => {
            const { target, join: joinSpec, set, where } = spec;
            const joinType = (joinSpec.type || "inner").toUpperCase();

            // Build correlated UPDATE subquery approach (more reliable in Oracle)
            const setParts = [];
            const binds = {};
            let bindIdx = 0;

            for (const [col, val] of Object.entries(set)) {
                const targetCol = col.includes(".") ? col.split(".")[1] : col;
                if (typeof val === "string" && val.includes(".")) {
                    // Column reference from joined table
                    const srcCol = val.split(".")[1];
                    setParts.push(
                        `${quoteIdentifier(targetCol)} = (SELECT ${quoteIdentifier(srcCol)} FROM ${quoteIdentifier(joinSpec.table)} WHERE ${_buildJoinOn(joinSpec.on, target)} AND ROWNUM = 1)`,
                    );
                } else {
                    const bname = `upd_join_${bindIdx++}`;
                    binds[bname] = val;
                    setParts.push(`${quoteIdentifier(targetCol)} = :${bname}`);
                }
            }

            // WHERE — exists in joined table
            let whereExtra = "";
            if (where) {
                const whereParts = [];
                for (const [col, val] of Object.entries(where)) {
                    const cleanCol = col.includes(".")
                        ? col.split(".")[1]
                        : col;
                    const bname = `upd_where_${bindIdx++}`;
                    binds[bname] = val;
                    whereParts.push(`${quoteIdentifier(cleanCol)} = :${bname}`);
                }
                if (whereParts.length > 0) {
                    whereExtra = ` AND ${whereParts.join(" AND ")}`;
                }
            }

            const existsClause = `EXISTS (SELECT 1 FROM ${quoteIdentifier(joinSpec.table)} WHERE ${_buildJoinOn(joinSpec.on, target)}${whereExtra})`;
            const sql = `UPDATE ${quoteIdentifier(target)} SET ${setParts.join(", ")} WHERE ${existsClause}`;

            try {
                const result = await conn.execute(sql, binds, {
                    autoCommit: !this._conn,
                });
                return {
                    acknowledged: true,
                    modifiedCount: result.rowsAffected,
                };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleCollection.updateFromJoin", err, sql),
                );
            }
        });
    }
}

/**
 * Build a JOIN ON clause from an on-spec object.
 * @param {Object} onSpec - e.g. { 'TABLE1.COL': 'TABLE2.COL' }
 * @param {string} targetTable
 * @returns {string}
 */
function _buildJoinOn(onSpec, targetTable) {
    return Object.entries(onSpec)
        .map(([left, right]) => {
            const leftParts = left.split(".");
            const rightParts = right.split(".");
            const leftCol = leftParts.length > 1 ? leftParts[1] : leftParts[0];
            const rightCol =
                rightParts.length > 1 ? rightParts[1] : rightParts[0];
            return `${quoteIdentifier(targetTable)}.${quoteIdentifier(leftCol)} = ${quoteIdentifier(rightCol)}`;
        })
        .join(" AND ");
}

module.exports = { OracleCollection };
