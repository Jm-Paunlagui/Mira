"use strict";

/**
 * ============================================================================
 * utils.js — Shared Helper Functions
 * ============================================================================
 *
 * Think of this file as the "toolbox" that every other file in the library
 * reaches into. It contains small, reusable functions that handle common
 * tasks like:
 *   - Wrapping column/table names in quotes (so Oracle doesn't choke on
 *     reserved words like "ORDER" or "STATUS")
 *   - Converting data types between Oracle and JavaScript
 *   - Building pieces of SQL (ORDER BY, SELECT columns)
 *   - Safely merging bind-variable objects together
 *
 * None of these functions talk to the database directly — they just
 * produce strings or transform data.
 * ============================================================================
 */

const { oracleMongoWrapperMessages: MSG } = require("../../constants/messages");

// ─── quoteIdentifier ────────────────────────────────────────────
/**
 * Wraps a table or column name in double-quotes so Oracle treats it
 * as a literal identifier. This is important because Oracle has many
 * reserved words (like STATUS, ORDER, GROUP) that would cause errors
 * if used unquoted.
 *
 * WHY: Without quoting, `SELECT status FROM users` might be ambiguous.
 *      With quoting, `SELECT "status" FROM "users"` is always safe.
 *
 * @param {string} name - The column or table name (e.g. "status")
 * @returns {string} The quoted name (e.g. '"status"')
 *
 * @example
 *   quoteIdentifier("status")  // → '"status"'
 *   quoteIdentifier("ORDER")   // → '"ORDER"'   (ORDER is a reserved word)
 */
function quoteIdentifier(name) {
    return `"${name}"`;
}

// ─── convertTypes ───────────────────────────────────────────────
/**
 * Oracle sometimes returns numbers as strings (e.g. "42" instead of 42).
 * This function scans every value in a row and converts numeric-looking
 * strings back into actual JavaScript numbers.
 *
 * WHY: If you get { age: "25" } from Oracle, you'd want { age: 25 }
 *      so that `row.age + 1` gives 26, not "251".
 *
 * Non-numeric strings are left unchanged. Null/undefined values pass through.
 *
 * @param {Object} row - A single row object from an Oracle query result
 * @returns {Object} A new object with numeric strings converted to numbers
 *
 * @example
 *   convertTypes({ NAME: "Juan", AGE: "25", SALARY: "50000.50" })
 *   // → { NAME: "Juan", AGE: 25, SALARY: 50000.5 }
 */
function convertTypes(row) {
    if (!row || typeof row !== "object") return row;
    const out = {};
    for (const [key, val] of Object.entries(row)) {
        if (
            typeof val === "string" &&
            val !== "" &&
            !isNaN(val) &&
            val.trim() !== ""
        ) {
            const n = Number(val);
            out[key] = isFinite(n) ? n : val;
        } else {
            out[key] = val;
        }
    }
    return out;
}

// ─── rowToDoc ───────────────────────────────────────────────────
/**
 * Alias for convertTypes(). Converts a raw Oracle row into a clean
 * JavaScript document (object) with proper number types.
 *
 * The name "rowToDoc" makes the intent clearer in code that transforms
 * Oracle result rows into application-level documents.
 *
 * @param {Object} row - A raw Oracle row object
 * @returns {Object} Cleaned document with proper types
 */
function rowToDoc(row) {
    return convertTypes(row);
}

// ─── mergeBinds ─────────────────────────────────────────────────
/**
 * Safely combines two bind-variable objects into one.
 *
 * WHAT ARE BIND VARIABLES?
 *   When we write SQL like: WHERE "name" = :where_name_0
 *   The ":where_name_0" is a placeholder. The actual value is stored
 *   separately in a "binds" object: { where_name_0: "Juan" }
 *   This prevents SQL injection attacks.
 *
 * WHY MERGE?
 *   When building complex queries, the WHERE clause produces one set
 *   of binds and the SET clause produces another. We need to combine
 *   them into a single object before executing the SQL.
 *
 * SAFETY: If both objects have the same key, something went wrong
 * (a bind name collision), so we throw an error instead of silently
 * overwriting.
 *
 * @param {Object} a - First bind object   (e.g. from parseFilter)
 * @param {Object} b - Second bind object  (e.g. from parseUpdate)
 * @returns {Object} Combined bind object with all keys from both
 * @throws {Error} If a key exists in both objects (collision)
 *
 * @example
 *   mergeBinds({ where_name_0: "Juan" }, { upd_status_0: "active" })
 *   // → { where_name_0: "Juan", upd_status_0: "active" }
 */
function mergeBinds(a, b) {
    const merged = { ...a };
    for (const [k, v] of Object.entries(b)) {
        if (k in merged) {
            throw new Error(MSG.MERGE_BINDS_KEY_COLLISION(k));
        }
        merged[k] = v;
    }
    return merged;
}

// ─── buildOrderBy ───────────────────────────────────────────────
/**
 * Converts a sort specification object into an SQL ORDER BY clause.
 *
 * HOW IT WORKS:
 *   - Each key in the object is a column name
 *   - The value tells the direction:  1 = ASC (ascending),  -1 = DESC (descending)
 *   - Multiple columns are separated by commas
 *
 * @param {Object} sortSpec - Sort specification, e.g. { name: 1, age: -1 }
 * @returns {string} SQL ORDER BY clause, or empty string if no sort needed
 *
 * @example
 *   buildOrderBy({ name: 1, age: -1 })
 *   // → 'ORDER BY "name" ASC, "age" DESC'
 *
 *   buildOrderBy(null)  // → ""  (no sorting)
 */
function buildOrderBy(sortSpec) {
    if (
        !sortSpec ||
        typeof sortSpec !== "object" ||
        Object.keys(sortSpec).length === 0
    ) {
        return "";
    }
    const parts = Object.entries(sortSpec).map(([col, dir]) => {
        return `${quoteIdentifier(col)} ${dir === -1 ? "DESC" : "ASC"}`;
    });
    return `ORDER BY ${parts.join(", ")}`;
}

// ─── buildProjection ────────────────────────────────────────────
/**
 * Converts a projection specification into a SELECT column list.
 *
 * WHAT IS A PROJECTION?
 *   A projection controls which columns come back in your query results.
 *   Instead of SELECT *, you can pick specific columns.
 *
 * TWO MODES:
 *   1. INCLUSION mode — list the columns you WANT:
 *      { name: 1, email: 1 }  →  SELECT "name", "email" FROM ...
 *
 *   2. EXCLUSION mode — list the columns you DON'T want:
 *      { password: 0, secret: 0 }  →  SELECT * FROM ... (then remove those cols after)
 *
 * WHY TWO MODES?
 *   Inclusion is simpler (just pick what you want). Exclusion is handy when
 *   a table has 20 columns and you only want to hide 2.
 *
 * @param {Object} projection - e.g. { name: 1, email: 1 } or { password: 0 }
 * @returns {{ columns: string, isExclusion: boolean, excludedCols: string[] }}
 *   - columns:      The SQL column list string (e.g. '"name", "email"' or '*')
 *   - isExclusion:  true if we're in exclusion mode
 *   - excludedCols: Array of column names to remove after the query (exclusion mode only)
 *
 * @example
 *   // Inclusion mode:
 *   buildProjection({ name: 1, email: 1 })
 *   // → { columns: '"name", "email"', isExclusion: false, excludedCols: [] }
 *
 *   // Exclusion mode:
 *   buildProjection({ password: 0 })
 *   // → { columns: '*', isExclusion: true, excludedCols: ['password'] }
 *
 *   // No projection (get everything):
 *   buildProjection(null)
 *   // → { columns: '*', isExclusion: false, excludedCols: [] }
 */
function buildProjection(projection) {
    if (
        !projection ||
        typeof projection !== "object" ||
        Object.keys(projection).length === 0
    ) {
        return { columns: "*", isExclusion: false, excludedCols: [] };
    }

    const entries = Object.entries(projection);
    const isExclusion = entries.some(([, v]) => v === 0);

    if (isExclusion) {
        const excludedCols = entries.filter(([, v]) => v === 0).map(([k]) => k);
        return { columns: "*", isExclusion: true, excludedCols };
    }

    // Inclusion mode — only include listed columns
    const cols = entries
        .filter(([, v]) => v === 1 || typeof v === "object")
        .map(([k]) => quoteIdentifier(k));

    return {
        columns: cols.length > 0 ? cols.join(", ") : "*",
        isExclusion: false,
        excludedCols: [],
    };
}

module.exports = {
    quoteIdentifier,
    convertTypes,
    rowToDoc,
    mergeBinds,
    buildOrderBy,
    buildProjection,
};
