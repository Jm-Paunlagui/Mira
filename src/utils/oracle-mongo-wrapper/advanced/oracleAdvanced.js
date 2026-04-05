"use strict";

/**
 * ============================================================================
 * oracleAdvanced.js — Oracle-Only Advanced Features
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   Provides SQL builders for Oracle-specific features that have no MongoDB
 *   equivalent. These are powerful Oracle constructs:
 *
 * CONNECT BY (Hierarchical Queries):
 *   Traverses tree-structured data (org charts, categories, file systems).
 *   Uses Oracle's START WITH ... CONNECT BY PRIOR syntax.
 *   Optionally adds LEVEL, SYS_CONNECT_BY_PATH, and ORDER SIBLINGS BY.
 *
 * PIVOT (Rows → Columns):
 *   Rotates row values into column headers.
 *   Example: Turn region names ("East", "West") into separate columns
 *   with aggregated values in each.
 *
 * UNPIVOT (Columns → Rows):
 *   The reverse of PIVOT — turns column headers into row values.
 *   Example: Turn "Q1", "Q2", "Q3", "Q4" columns into quarter/value rows.
 *
 * NOTE ON PIVOT IN CLAUSE:
 *   Oracle does NOT allow bind variables inside PIVOT IN (...).
 *   Values are sanitized with .replace(/'/g, "''") before interpolation.
 *   This is the only intentional exception to the bind variable rule.
 * ============================================================================
 */

const { quoteIdentifier } = require("../utils");
const { parseFilter } = require("../parsers/filterParser");

/**
 * Build a CONNECT BY hierarchical query.
 *
 * This is Oracle's way of traversing parent-child (tree) relationships.
 * Think: org charts, category trees, file system paths.
 *
 * @param {string} tableName - Table containing the hierarchical data
 * @param {Object} spec - Hierarchical query specification
 * @param {Object} [spec.startWith] - Filter for root nodes (MongoDB filter syntax)
 * @param {Object} spec.connectBy - Parent-child relationship
 *   e.g. { parentId: "$PRIOR id" } means: parent's id = child's parentId
 * @param {Object} [spec.orderSiblings] - Sort siblings: { name: 1 } for ASC
 * @param {number} [spec.maxLevel] - Maximum tree depth to traverse
 * @param {boolean} [spec.includeLevel] - Add LEVEL pseudo-column (depth)
 * @param {boolean} [spec.includePath] - Add SYS_CONNECT_BY_PATH column
 * @returns {{ sql: string, binds: Object }}
 *
 * @example
 *   buildConnectBy("employees", {
 *     startWith: { managerId: null },
 *     connectBy: { managerId: "$PRIOR id" },
 *     includeLevel: true,
 *     maxLevel: 5
 *   })
 */
function buildConnectBy(tableName, spec) {
    const {
        startWith,
        connectBy,
        orderSiblings,
        maxLevel,
        includeLevel,
        includePath,
    } = spec;
    const binds = {};

    // SELECT clause
    const selectParts = [];
    if (includeLevel) selectParts.push("LEVEL");
    if (includePath) {
        selectParts.push(
            `SYS_CONNECT_BY_PATH(${quoteIdentifier(_getNameColumn(spec))}, '/') AS "PATH"`,
        );
    }
    selectParts.push(`${quoteIdentifier(tableName)}.*`);

    // START WITH
    let startWithClause = "";
    if (startWith) {
        const { whereClause: sw, binds: swBinds } = parseFilter(startWith);
        Object.assign(binds, swBinds);
        startWithClause = `START WITH ${sw.replace(/^WHERE\s+/i, "")}`;
    }

    // CONNECT BY
    let connectByClause = "";
    if (connectBy) {
        const parts = [];
        for (const [childCol, priorRef] of Object.entries(connectBy)) {
            if (typeof priorRef === "string" && priorRef.includes("$PRIOR")) {
                const parentCol = priorRef
                    .replace("$PRIOR ", "")
                    .replace("$PRIOR", "");
                parts.push(
                    `PRIOR ${quoteIdentifier(parentCol)} = ${quoteIdentifier(childCol)}`,
                );
            } else {
                parts.push(
                    `${quoteIdentifier(childCol)} = ${quoteIdentifier(priorRef)}`,
                );
            }
        }
        connectByClause = `CONNECT BY NOCYCLE ${parts.join(" AND ")}`;
        if (maxLevel) {
            connectByClause += ` AND LEVEL <= ${Number(maxLevel)}`;
        }
    }

    // ORDER SIBLINGS BY
    let orderSiblingsClause = "";
    if (orderSiblings) {
        const parts = Object.entries(orderSiblings).map(
            ([col, dir]) =>
                `${quoteIdentifier(col)} ${dir === -1 ? "DESC" : "ASC"}`,
        );
        orderSiblingsClause = `ORDER SIBLINGS BY ${parts.join(", ")}`;
    }

    const sql =
        `SELECT ${selectParts.join(", ")} FROM ${quoteIdentifier(tableName)} ${startWithClause} ${connectByClause} ${orderSiblingsClause}`
            .replace(/\s+/g, " ")
            .trim();

    return { sql, binds };
}

/**
 * Build a PIVOT query (rows → columns).
 *
 * Takes values from one column and turns them into separate columns,
 * with an aggregate function applied to each.
 *
 * @param {string} tableName - Source table
 * @param {Object} spec - PIVOT specification
 * @param {Object} spec.value - Aggregate to apply, e.g. { $sum: "$amount" }
 * @param {string} spec.pivotOn - Column whose values become new column headers
 * @param {string[]} spec.pivotValues - The specific values to pivot on
 * @param {string} spec.groupBy - Column to group by (kept as rows)
 * @returns {{ sql: string, binds: Object }}
 *
 * @example
 *   buildPivot("sales", {
 *     value: { $sum: "$amount" },
 *     pivotOn: "region",
 *     pivotValues: ["East", "West", "North"],
 *     groupBy: "year"
 *   })
 *   // Each year gets a row, each region becomes a column with SUM(amount)
 */
function buildPivot(tableName, spec) {
    const { value, pivotOn, pivotValues, groupBy } = spec;
    const binds = {};

    // Determine aggregate function and field
    const [aggOp, aggField] = Object.entries(value)[0];
    const aggFn = aggOp.replace("$", "").toUpperCase();
    const field = aggField.startsWith("$") ? aggField.substring(1) : aggField;

    // Build inner SELECT — only the columns needed for pivot
    const innerCols = [groupBy, pivotOn, field]
        .filter(Boolean)
        .map(quoteIdentifier)
        .join(", ");

    // Build pivot IN clause — sanitize values (PIVOT IN cannot use bind variables)
    const pivotIn = pivotValues
        .map((v) => {
            const safe = String(v).replace(/'/g, "''");
            return `'${safe}' AS ${quoteIdentifier(v)}`;
        })
        .join(", ");

    const sql = `SELECT * FROM (SELECT ${innerCols} FROM ${quoteIdentifier(tableName)}) PIVOT (${aggFn}(${quoteIdentifier(field)}) FOR ${quoteIdentifier(pivotOn)} IN (${pivotIn}))`;

    return { sql, binds };
}

/**
 * Build an UNPIVOT query (columns → rows).
 *
 * The reverse of PIVOT — takes multiple columns and turns them into
 * rows with a name column and a value column.
 *
 * @param {string} tableName - Source table
 * @param {Object} spec - UNPIVOT specification
 * @param {string} spec.valueColumn - Name for the new value column
 * @param {string} spec.nameColumn - Name for the new name/label column
 * @param {string[]} spec.columns - Column names to unpivot
 * @param {boolean} [spec.includeNulls=false] - Include rows where value is NULL
 * @returns {{ sql: string, binds: Object }}
 *
 * @example
 *   buildUnpivot("quarterly_sales", {
 *     valueColumn: "revenue",
 *     nameColumn: "quarter",
 *     columns: ["Q1", "Q2", "Q3", "Q4"]
 *   })
 *   // Each Q1/Q2/Q3/Q4 column becomes a row: { quarter: "Q1", revenue: 1000 }
 */
function buildUnpivot(tableName, spec) {
    const { valueColumn, nameColumn, columns, includeNulls = false } = spec;
    const nullHandling = includeNulls ? "INCLUDE NULLS" : "EXCLUDE NULLS";
    const colList = columns.map(quoteIdentifier).join(", ");

    const sql = `SELECT * FROM ${quoteIdentifier(tableName)} UNPIVOT ${nullHandling} (${quoteIdentifier(valueColumn)} FOR ${quoteIdentifier(nameColumn)} IN (${colList}))`;

    return { sql, binds: {} };
}

/**
 * Try to determine a name column from spec for SYS_CONNECT_BY_PATH.
 */
function _getNameColumn(spec) {
    if (spec.connectBy) {
        const keys = Object.keys(spec.connectBy);
        // Use a heuristic: first key that looks like 'name'
        const nameCol = keys.find((k) => k.toLowerCase().includes("name"));
        if (nameCol) return nameCol;
    }
    return "NAME";
}

module.exports = { buildConnectBy, buildPivot, buildUnpivot };
