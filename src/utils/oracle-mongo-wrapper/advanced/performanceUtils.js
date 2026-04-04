"use strict";

/**
 * ============================================================================
 * performanceUtils.js — Oracle Performance & Materialized View Utilities
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   Provides tools for analyzing and optimizing Oracle queries:
 *
 *   explainPlan()               — Show the execution plan for a query
 *   analyze()                   — Gather table statistics (DBMS_STATS)
 *   createMaterializedView()    — Create a materialized view from a query
 *   refreshMaterializedView()   — Refresh a materialized view
 *   dropMaterializedView()      — Drop a materialized view
 *
 * USAGE:
 *   const { createPerformance } = require("./performanceUtils");
 *   const perf = createPerformance(db);
 *
 *   // See how Oracle will execute a query
 *   const plan = await perf.explainPlan(users.find({ status: "active" }));
 *
 *   // Gather fresh statistics for the optimizer
 *   await perf.analyze("users");
 *
 *   // Create a materialized view for a complex report
 *   await perf.createMaterializedView("active_users_mv",
 *     users.find({ status: "active" }).project({ id: 1, name: 1 }),
 *     { refreshMode: "fast", refreshOn: "commit" }
 *   );
 *
 * PRIVILEGE HANDLING:
 *   All methods detect Oracle privilege errors (ORA-01031, ORA-00942, etc.)
 *   and throw descriptive error messages explaining what privilege is needed.
 * ============================================================================
 */

const { quoteIdentifier } = require("../utils");
const {
    oracleMongoWrapperMessages: MSG,
} = require("../../../constants/messages");

/**
 * Oracle error codes that indicate missing privileges or inaccessible objects.
 */
const PRIVILEGE_ERROR_CODES = [1031, 942, 1039, 1219, 12003];

/**
 * Wrap an Oracle error with a helpful privilege message.
 * Detects common privilege-related ORA errors and re-throws with
 * a message explaining what privilege the user needs.
 *
 * @param {string} method - Method name for context
 * @param {Error} err - Original Oracle error
 * @param {string} sql - SQL that was attempted
 * @param {string} requiredPrivilege - Description of the required privilege
 */
function _wrapPrivilegeError(method, err, sql, requiredPrivilege) {
    const code = err.errorNum || err.code;
    if (PRIVILEGE_ERROR_CODES.includes(code)) {
        throw new Error(
            MSG.INSUFFICIENT_PRIVILEGES(method, requiredPrivilege, err, sql),
        );
    }
    throw new Error(MSG.wrapError(method, err, sql));
}

/**
 * Create a performance utility instance bound to a database connection.
 *
 * @param {Object} db - db interface from createDb()
 * @returns {Object} Object with: explainPlan(), analyze(),
 *   createMaterializedView(), refreshMaterializedView(), dropMaterializedView()
 *
 * @example
 *   const perf = createPerformance(db);
 *   const plan = await perf.explainPlan(users.find({ active: true }));
 */
function createPerformance(db) {
    return {
        /**
         * Get the execution plan for a query.
         * @param {QueryBuilder|string} queryBuilderOrSQL
         * @returns {Promise<Array>}
         */
        async explainPlan(queryBuilderOrSQL) {
            return db.withConnection(async (conn) => {
                let sql;
                let binds = {};

                if (typeof queryBuilderOrSQL === "string") {
                    sql = queryBuilderOrSQL;
                } else if (
                    queryBuilderOrSQL &&
                    typeof queryBuilderOrSQL._buildSQL === "function"
                ) {
                    const built = queryBuilderOrSQL._buildSQL();
                    sql = built.sql;
                    binds = built.binds;
                } else {
                    throw new Error(MSG.PERF_EXPLAIN_PLAN_INVALID_INPUT);
                }

                // EXPLAIN PLAN FOR ...
                const explainSql = `EXPLAIN PLAN FOR ${sql}`;
                try {
                    await conn.execute(explainSql, binds, { autoCommit: true });

                    // Retrieve the plan
                    const planResult = await conn.execute(
                        `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', NULL, 'ALL'))`,
                        {},
                        {
                            outFormat: db.oracledb.OUT_FORMAT_OBJECT,
                            autoCommit: true,
                        },
                    );
                    return planResult.rows || [];
                } catch (err) {
                    _wrapPrivilegeError(
                        "performance.explainPlan",
                        err,
                        explainSql,
                        MSG.PRIV_PLAN_TABLE,
                    );
                }
            });
        },

        /**
         * Gather table statistics.
         * @param {string} tableName
         * @returns {Promise<void>}
         */
        async analyze(tableName) {
            return db.withConnection(async (conn) => {
                const sql = `BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, UPPER(:tbl), CASCADE => TRUE); END;`;
                try {
                    await conn.execute(
                        sql,
                        { tbl: tableName },
                        { autoCommit: true },
                    );
                } catch (err) {
                    _wrapPrivilegeError(
                        "performance.analyze",
                        err,
                        sql,
                        MSG.PRIV_DBMS_STATS,
                    );
                }
            });
        },

        /**
         * Create a materialized view.
         * @param {string} name
         * @param {QueryBuilder|string} queryBuilderOrSQL
         * @param {Object} [options] - refreshMode, refreshOn, buildMode, orReplace
         * @returns {Promise<{ acknowledged: boolean }>}
         */
        async createMaterializedView(name, queryBuilderOrSQL, options = {}) {
            return db.withConnection(async (conn) => {
                let selectSql;
                let binds = {};

                if (typeof queryBuilderOrSQL === "string") {
                    selectSql = queryBuilderOrSQL;
                } else if (
                    queryBuilderOrSQL &&
                    typeof queryBuilderOrSQL._buildSQL === "function"
                ) {
                    const built = queryBuilderOrSQL._buildSQL();
                    selectSql = built.sql;
                    binds = built.binds;
                } else {
                    throw new Error(MSG.PERF_CREATE_MVIEW_INVALID_INPUT);
                }

                const {
                    refreshMode = "force",
                    refreshOn = "demand",
                    buildMode = "immediate",
                    orReplace = false,
                } = options;

                const refreshModeClause =
                    {
                        fast: "FAST",
                        complete: "COMPLETE",
                        force: "FORCE",
                    }[refreshMode] || "FORCE";

                const refreshOnClause =
                    {
                        commit: "ON COMMIT",
                        demand: "ON DEMAND",
                    }[refreshOn] || "ON DEMAND";

                const buildModeClause =
                    {
                        immediate: "BUILD IMMEDIATE",
                        deferred: "BUILD DEFERRED",
                    }[buildMode] || "BUILD IMMEDIATE";

                // Oracle does not support CREATE OR REPLACE for materialized views.
                // If orReplace, drop existing MV first (ignore error if not exists).
                if (orReplace) {
                    try {
                        await conn.execute(
                            `DROP MATERIALIZED VIEW ${quoteIdentifier(name)}`,
                            [],
                            { autoCommit: true },
                        );
                    } catch (_) {
                        // Ignore — MV may not exist
                    }
                }

                const sql = `CREATE MATERIALIZED VIEW ${quoteIdentifier(name)} ${buildModeClause} REFRESH ${refreshModeClause} ${refreshOnClause} AS ${selectSql}`;

                try {
                    await conn.execute(sql, binds, { autoCommit: true });
                    return { acknowledged: true };
                } catch (err) {
                    _wrapPrivilegeError(
                        "performance.createMaterializedView",
                        err,
                        sql,
                        MSG.PRIV_CREATE_MVIEW,
                    );
                }
            });
        },

        /**
         * Refresh a materialized view.
         * @param {string} name
         * @param {string} [mode='complete'] - 'fast' | 'complete' | 'force'
         * @returns {Promise<void>}
         */
        async refreshMaterializedView(name, mode = "complete") {
            return db.withConnection(async (conn) => {
                const modeChar =
                    { fast: "F", complete: "C", force: "?" }[mode] || "C";
                const sql = `BEGIN DBMS_MVIEW.REFRESH(:mvName, :mvMode); END;`;
                try {
                    await conn.execute(
                        sql,
                        { mvName: name.toUpperCase(), mvMode: modeChar },
                        { autoCommit: true },
                    );
                } catch (err) {
                    _wrapPrivilegeError(
                        "performance.refreshMaterializedView",
                        err,
                        sql,
                        MSG.PRIV_REFRESH_MVIEW,
                    );
                }
            });
        },

        /**
         * Drop a materialized view.
         * @param {string} name
         * @returns {Promise<{ acknowledged: boolean }>}
         */
        async dropMaterializedView(name) {
            return db.withConnection(async (conn) => {
                const sql = `DROP MATERIALIZED VIEW ${quoteIdentifier(name)}`;
                try {
                    await conn.execute(sql, {}, { autoCommit: true });
                    return { acknowledged: true };
                } catch (err) {
                    _wrapPrivilegeError(
                        "performance.dropMaterializedView",
                        err,
                        sql,
                        MSG.PRIV_DROP_MVIEW,
                    );
                }
            });
        },
    };
}

module.exports = { createPerformance };
