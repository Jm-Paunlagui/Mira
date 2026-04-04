"use strict";

/**
 * ============================================================================
 * subqueryBuilder.js — Subquery Helpers for Oracle
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   Provides helper functions to build common subquery patterns in SQL:
 *   scalar subqueries, EXISTS checks, correlated subqueries, IN (SELECT),
 *   and ANY/ALL comparisons.
 *
 * SUBQUERY TYPES:
 *   Scalar   — Returns a single value: (SELECT COUNT(*) FROM ...)
 *   EXISTS   — Returns true/false: EXISTS (SELECT 1 FROM ...)
 *   Correlated — References outer query: (SELECT AVG(x) FROM t WHERE t.id = outer.id)
 *   IN/NOT IN — Value in a set: col IN (SELECT id FROM ...)
 *   ANY/ALL  — Compare against all values: col > ANY (SELECT price FROM ...)
 *
 * HOW $ REFERENCES WORK:
 *   - "$column" in filter values refers to the outer query's column
 *   - "$outer.column" in correlated subqueries refers to the outer table
 *
 * EXAMPLE:
 *   buildScalarSubquery({
 *     collection: "orders",
 *     fn: "count",
 *     filter: { userId: "$id" }  // correlate with outer table's id column
 *   })
 *   → '(SELECT COUNT(*) FROM "orders" WHERE "userId" = t0."id")'
 * ============================================================================
 */

const { quoteIdentifier } = require("../utils");
const { parseFilter } = require("../parsers/filterParser");

/**
 * Build a scalar subquery for use in SELECT projections.
 * Returns a single aggregate value (COUNT, SUM, AVG, MIN, MAX).
 *
 * @param {Object} spec - Subquery specification
 * @param {string} spec.collection - Table to query
 * @param {string} [spec.fn='count'] - Aggregate function: 'count', 'sum', 'avg', 'min', 'max'
 * @param {Object} [spec.filter={}] - Filter with $-prefixed refs to outer table
 * @param {string} [spec.field] - Column for SUM/AVG/MIN/MAX
 * @param {string} [outerAlias='t0'] - Alias of the outer table
 * @returns {string} SQL subquery string, e.g. '(SELECT COUNT(*) FROM "orders" WHERE ...)'
 *
 * @example
 *   buildScalarSubquery({ collection: "orders", fn: "sum", field: "total", filter: { userId: "$id" } })
 *   // → '(SELECT SUM("total") FROM "orders" WHERE "userId" = t0."id")'
 */
function buildScalarSubquery(spec, outerAlias = "t0") {
    const { collection, fn, filter = {}, field } = spec;
    const fnUpper = (fn || "count").toUpperCase();

    // Build WHERE clause, replacing $-refs with outer alias
    const whereParts = [];
    for (const [col, val] of Object.entries(filter)) {
        if (typeof val === "string" && val.startsWith("$")) {
            const outerCol = val.substring(1);
            whereParts.push(
                `${quoteIdentifier(col)} = ${outerAlias}.${quoteIdentifier(outerCol)}`,
            );
        }
    }
    const whereClause =
        whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    let aggExpr;
    switch (fnUpper) {
        case "COUNT":
            aggExpr = "COUNT(*)";
            break;
        case "SUM":
            aggExpr = `SUM(${quoteIdentifier(field)})`;
            break;
        case "AVG":
            aggExpr = `AVG(${quoteIdentifier(field)})`;
            break;
        case "MIN":
            aggExpr = `MIN(${quoteIdentifier(field)})`;
            break;
        case "MAX":
            aggExpr = `MAX(${quoteIdentifier(field)})`;
            break;
        default:
            aggExpr = "COUNT(*)";
    }

    return `(SELECT ${aggExpr} FROM ${quoteIdentifier(collection)} ${whereClause})`;
}

/**
 * Build an EXISTS subquery.
 * Returns true if any rows match the correlated condition.
 *
 * @param {Object} spec - Subquery specification
 * @param {string} spec.collection - Table to check
 * @param {Object} spec.match - Conditions with $-refs to outer table
 * @param {string} [outerAlias='t0'] - Alias of the outer table
 * @returns {string} e.g. 'EXISTS (SELECT 1 FROM "orders" WHERE "userId" = t0."id")'
 */
function buildExistsSubquery(spec, outerAlias = "t0") {
    const { collection, match } = spec;
    const whereParts = [];
    for (const [col, val] of Object.entries(match)) {
        if (typeof val === "string" && val.startsWith("$")) {
            const outerCol = val.substring(1);
            whereParts.push(
                `${quoteIdentifier(col)} = ${outerAlias}.${quoteIdentifier(outerCol)}`,
            );
        }
    }
    const whereClause =
        whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
    return `EXISTS (SELECT 1 FROM ${quoteIdentifier(collection)} ${whereClause})`;
}

/**
 * Build a NOT EXISTS subquery.
 * Returns true if NO rows match the condition.
 *
 * @param {Object} spec - Same as buildExistsSubquery
 * @param {string} [outerAlias='t0']
 * @returns {string} e.g. 'NOT EXISTS (SELECT 1 FROM "orders" WHERE ...)'
 */
function buildNotExistsSubquery(spec, outerAlias = "t0") {
    const inner = buildExistsSubquery(spec, outerAlias);
    return `NOT ${inner}`;
}

/**
 * Build a correlated subquery for comparison operators.
 * Uses $outer. references to correlate with the outer query.
 *
 * @param {Object} spec - Subquery specification
 * @param {string} spec.collection - Table to subquery
 * @param {string} spec.field - Column to aggregate
 * @param {string} [spec.aggregate='$avg'] - Aggregate function (e.g. '$avg', '$sum')
 * @param {Object} [spec.where={}] - Conditions using $outer. refs
 * @param {string} [outerAlias='t0']
 * @returns {string} e.g. '(SELECT AVG("salary") FROM "employees" WHERE "dept" = t0."dept")'
 */
function buildCorrelatedSubquery(spec, outerAlias = "t0") {
    const { collection, field, aggregate, where = {} } = spec;
    const aggFn = (aggregate || "$avg").replace("$", "").toUpperCase();
    const aggExpr = `${aggFn}(${quoteIdentifier(field)})`;

    const whereParts = [];
    for (const [col, val] of Object.entries(where)) {
        if (typeof val === "string" && val.startsWith("$outer.")) {
            const outerCol = val.replace("$outer.", "");
            whereParts.push(
                `${quoteIdentifier(col)} = ${outerAlias}.${quoteIdentifier(outerCol)}`,
            );
        }
    }
    const whereClause =
        whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    return `(SELECT ${aggExpr} FROM ${quoteIdentifier(collection)} ${whereClause})`;
}

/**
 * Build an IN (SELECT ...) subquery from a QueryBuilder.
 * Wraps the QueryBuilder's SQL in "IN (...)".
 *
 * @param {QueryBuilder} queryBuilder - A configured QueryBuilder (not yet executed)
 * @returns {string} e.g. 'IN (SELECT "id" FROM "users" WHERE ...)'
 */
function buildInSelectSubquery(queryBuilder) {
    const { sql } = queryBuilder._buildSQL();
    return `IN (${sql})`;
}

/**
 * Build an ANY or ALL subquery.
 * Used for comparisons like: salary > ANY (SELECT salary FROM ...)
 *
 * @param {Object} spec - { collection, field }
 * @param {string} [comparison='ANY'] - 'ANY' or 'ALL'
 * @returns {string} e.g. 'ANY (SELECT "salary" FROM "employees")'
 */
function buildAnyAllSubquery(spec, comparison = "ANY") {
    const { collection, field } = spec;
    return `${comparison} (SELECT ${quoteIdentifier(field)} FROM ${quoteIdentifier(collection)})`;
}

module.exports = {
    buildScalarSubquery,
    buildExistsSubquery,
    buildNotExistsSubquery,
    buildCorrelatedSubquery,
    buildInSelectSubquery,
    buildAnyAllSubquery,
};
