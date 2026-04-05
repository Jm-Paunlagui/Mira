"use strict";

/**
 * ============================================================================
 * filterParser.js — MongoDB Filter → Oracle WHERE Clause Translator
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   Takes a MongoDB-style filter object and converts it into an Oracle SQL
 *   WHERE clause with safe bind variables.
 *
 * THE BIG PICTURE:
 *   When you write:   { status: "active", age: { $gte: 18 } }
 *   This file produces:
 *     WHERE clause: 'WHERE "status" = :where_status_0 AND "age" >= :where_age_1'
 *     Bind values:  { where_status_0: "active", where_age_1: 18 }
 *
 * WHY BIND VARIABLES?
 *   If we put values directly into the SQL string (WHERE name = 'Juan'),
 *   a malicious user could inject SQL code. Bind variables prevent this
 *   by keeping values SEPARATE from the SQL string. Oracle substitutes
 *   them safely at execution time.
 *
 * SUPPORTED OPERATORS:
 *   ┌─────────────┬──────────────────────────────────────────────────┐
 *   │ Operator    │ What it does                                     │
 *   ├─────────────┼──────────────────────────────────────────────────┤
 *   │ { field: v }│ Equality — WHERE "field" = :val                  │
 *   │ $eq         │ Same as equality                                 │
 *   │ $ne         │ Not equal — WHERE "field" <> :val                │
 *   │ $gt / $gte  │ Greater than / greater-or-equal                  │
 *   │ $lt / $lte  │ Less than / less-or-equal                        │
 *   │ $in         │ Is one of — WHERE "field" IN (:v1, :v2)          │
 *   │ $nin        │ Is NOT one of — WHERE "field" NOT IN (...)       │
 *   │ $between    │ Range — WHERE "field" BETWEEN :min AND :max      │
 *   │ $notBetween │ NOT BETWEEN                                      │
 *   │ $exists     │ IS NOT NULL / IS NULL                            │
 *   │ $regex      │ Pattern match — REGEXP_LIKE("field", :pattern)   │
 *   │ $like       │ SQL LIKE — WHERE "field" LIKE :pattern           │
 *   │ $case       │ CASE WHEN ... THEN ... END                       │
 *   │ $coalesce   │ COALESCE(col1, col2, ...)                        │
 *   │ $nullif     │ NULLIF(col, value)                               │
 *   │ $subquery   │ Correlated subquery comparison                   │
 *   │ $inSelect   │ WHERE "field" IN (SELECT ...)                    │
 *   │ $gtAny, etc │ WHERE "field" > ANY/ALL (SELECT ...)             │
 *   │ $and / $or  │ Logical AND / OR                                 │
 *   │ $nor / $not │ NOR / NOT                                        │
 *   │ $exists     │ EXISTS (SELECT 1 FROM ...)  (top-level)          │
 *   │ $notExists  │ NOT EXISTS (SELECT 1 FROM ...) (top-level)       │
 *   └─────────────┴──────────────────────────────────────────────────┘
 *
 * CONCURRENCY SAFETY:
 *   Each call to parseFilter() creates its OWN counter via _createCounter().
 *   This means two simultaneous queries will never accidentally use the
 *   same bind variable name — even under high traffic.
 * ============================================================================
 */

const { quoteIdentifier } = require("../utils");
const {
    oracleMongoWrapperMessages: MSG,
} = require("../../../constants/messages");

// ─── _createCounter ─────────────────────────────────────────────
/**
 * Creates a fresh, isolated counter for generating unique bind variable names.
 *
 * WHY PER-CALL?
 *   If we used a global counter, two concurrent parseFilter() calls could
 *   generate bind names like :where_name_5 in both queries — collision!
 *   A per-call counter ensures each invocation starts from 0 independently.
 *
 * HOW IT WORKS:
 *   The counter is a closure. Each call to next("where_name") returns:
 *   "where_name_0", "where_name_1", "where_name_2", etc.
 *
 * @returns {{ next: (prefix: string) => string }} Counter object with a next() method
 *
 * @example
 *   const counter = _createCounter();
 *   counter.next("where_age")    // → "where_age_0"
 *   counter.next("where_name")   // → "where_name_1"
 *   counter.next("where_status") // → "where_status_2"
 */
function _createCounter() {
    let _count = 0;
    return {
        next(prefix) {
            return `${prefix}_${_count++}`;
        },
    };
}

/**
 * Reset bind counter — no-op.
 *
 * In older versions this reset a global counter. Now that counters are
 * per-call (via _createCounter), there's nothing to reset.
 * Kept for backward compatibility so existing code doesn't break.
 */
function resetBindCounter() {
    // no-op: counters are scoped per parseFilter call
}

/**
 * Maps MongoDB comparison operator names to their SQL equivalents.
 * Used by _parseFieldExpr to translate operators like $gt → ">".
 */
const COMPARISON_OPS = {
    $eq: "=", // Equal
    $ne: "<>", // Not equal
    $gt: ">", // Greater than
    $gte: ">=", // Greater than or equal
    $lt: "<", // Less than
    $lte: "<=", // Less than or equal
};

// ─── _parseFieldExpr ────────────────────────────────────────────
/**
 * Converts a SINGLE field's filter expression into an SQL condition string.
 *
 * This is the workhorse of the filter parser. It handles every supported
 * operator for a single column. It's called once per field in the filter.
 *
 * HOW IT WORKS:
 *   1. If the expression is a plain value (string, number, null),
 *      it creates an equality check: "field" = :bind_name
 *
 *   2. If the expression is an object with $ operators,
 *      it iterates each operator and builds the corresponding SQL:
 *      { $gt: 5, $lt: 10 } → '"age" > :where_age_0 AND "age" < :where_age_1'
 *
 * @param {string} field - The column name (e.g. "status")
 * @param {*} expr - The filter value or operator object
 *   - Plain value:  "active"  → equality check
 *   - Null:         null      → IS NULL
 *   - Operator obj: { $gte: 18 } → comparison
 * @param {Object} binds - The bind variable accumulator (mutated — values added here)
 * @param {string} outerAlias - Table alias for correlated subqueries (usually "t0")
 * @param {Object} counter - Per-call bind counter from _createCounter()
 * @returns {string} A SQL condition fragment (e.g. '"age" >= :where_age_0')
 *
 * @example
 *   // Simple equality
 *   _parseFieldExpr("status", "active", binds, null, counter)
 *   // → '"status" = :where_status_0'  (binds now has { where_status_0: "active" })
 *
 *   // Multiple operators on one field
 *   _parseFieldExpr("age", { $gte: 18, $lt: 65 }, binds, null, counter)
 *   // → '("age" >= :where_age_0 AND "age" < :where_age_1)'
 */
function _parseFieldExpr(field, expr, binds, outerAlias, counter) {
    const qField = quoteIdentifier(field);

    // Simple equality: { field: value }
    if (
        expr === null ||
        expr === undefined ||
        typeof expr !== "object" ||
        expr instanceof Date
    ) {
        if (expr === null || expr === undefined) {
            return `${qField} IS NULL`;
        }
        // Handle $outer. correlated reference (for LATERAL JOIN)
        if (typeof expr === "string" && expr.startsWith("$outer.")) {
            const outerCol = expr.slice(7);
            return `${qField} = ${quoteIdentifier(outerCol)}`;
        }
        const bname = counter.next(`where_${field}`);
        binds[bname] = expr;
        return `${qField} = :${bname}`;
    }

    // Operator object: { field: { $gt: 5, $lt: 10 } }
    const conditions = [];

    for (const [op, val] of Object.entries(expr)) {
        if (COMPARISON_OPS[op]) {
            // Check if val is a correlated $subquery object
            if (
                val &&
                typeof val === "object" &&
                !Array.isArray(val) &&
                !(val instanceof Date) &&
                val.$subquery
            ) {
                const subExpr = _buildCorrelatedSubquery(
                    field,
                    val.$subquery,
                    binds,
                    outerAlias,
                    counter,
                );
                conditions.push(`${qField} ${COMPARISON_OPS[op]} ${subExpr}`);
            } else {
                const bname = counter.next(`where_${field}`);
                binds[bname] = val;
                conditions.push(`${qField} ${COMPARISON_OPS[op]} :${bname}`);
            }
        } else if (op === "$in") {
            if (!Array.isArray(val) || val.length === 0) {
                conditions.push("1=0"); // empty IN → always false
            } else {
                const placeholders = val.map((v) => {
                    const bname = counter.next(`where_${field}`);
                    binds[bname] = v;
                    return `:${bname}`;
                });
                conditions.push(`${qField} IN (${placeholders.join(", ")})`);
            }
        } else if (op === "$nin") {
            if (!Array.isArray(val) || val.length === 0) {
                conditions.push("1=1");
            } else {
                const placeholders = val.map((v) => {
                    const bname = counter.next(`where_${field}`);
                    binds[bname] = v;
                    return `:${bname}`;
                });
                conditions.push(
                    `${qField} NOT IN (${placeholders.join(", ")})`,
                );
            }
        } else if (op === "$between") {
            const bmin = counter.next(`where_${field}_min`);
            const bmax = counter.next(`where_${field}_max`);
            binds[bmin] = val[0];
            binds[bmax] = val[1];
            conditions.push(`${qField} BETWEEN :${bmin} AND :${bmax}`);
        } else if (op === "$notBetween") {
            const bmin = counter.next(`where_${field}_min`);
            const bmax = counter.next(`where_${field}_max`);
            binds[bmin] = val[0];
            binds[bmax] = val[1];
            conditions.push(`${qField} NOT BETWEEN :${bmin} AND :${bmax}`);
        } else if (op === "$exists") {
            conditions.push(
                val ? `${qField} IS NOT NULL` : `${qField} IS NULL`,
            );
        } else if (op === "$regex") {
            const bname = counter.next(`where_${field}`);
            binds[bname] = val;
            conditions.push(`REGEXP_LIKE(${qField}, :${bname})`);
        } else if (op === "$like") {
            const bname = counter.next(`where_${field}`);
            binds[bname] = val;
            conditions.push(`${qField} LIKE :${bname}`);
        } else if (op === "$any") {
            const placeholders = val.map((v) => {
                const bname = counter.next(`where_${field}`);
                binds[bname] = v;
                return `:${bname}`;
            });
            conditions.push(`${qField} = ANY(${placeholders.join(", ")})`);
        } else if (op === "$all") {
            const placeholders = val.map((v) => {
                const bname = counter.next(`where_${field}`);
                binds[bname] = v;
                return `:${bname}`;
            });
            conditions.push(`${qField} = ALL(${placeholders.join(", ")})`);
        } else if (op === "$case") {
            // { $case: [{when, then}], $else: v }
            const whenParts = val.map((c) => {
                const { whereClause: wWhen, binds: wBinds } = parseFilter(
                    c.when,
                    null,
                    counter,
                );
                Object.assign(binds, wBinds);
                const bThen = counter.next(`where_${field}_then`);
                binds[bThen] = c.then;
                const condStr = wWhen.replace(/^WHERE\s+/i, "");
                return `WHEN ${condStr} THEN :${bThen}`;
            });
            const elseVal = expr.$else;
            let elseStr = "";
            if (elseVal !== undefined) {
                const bElse = counter.next(`where_${field}_else`);
                binds[bElse] = elseVal;
                elseStr = ` ELSE :${bElse}`;
            }
            conditions.push(`CASE ${whenParts.join(" ")}${elseStr} END`);
        } else if (op === "$else") {
            // Handled inside $case
        } else if (op === "$coalesce") {
            const parts = val.map((v) => {
                if (typeof v === "string" && !v.startsWith("$")) {
                    const bname = counter.next(`where_${field}`);
                    binds[bname] = v;
                    return `:${bname}`;
                }
                // Column reference
                return quoteIdentifier(
                    typeof v === "string" && v.startsWith("$") ? v.slice(1) : v,
                );
            });
            conditions.push(`COALESCE(${parts.join(", ")})`);
        } else if (op === "$nullif") {
            const left = quoteIdentifier(val[0]);
            const bname = counter.next(`where_${field}`);
            binds[bname] = val[1];
            conditions.push(`NULLIF(${left}, :${bname})`);
        } else if (op === "$subquery") {
            // Correlated subquery for WHERE comparisons
            conditions.push(
                _buildCorrelatedSubquery(
                    field,
                    val,
                    binds,
                    outerAlias,
                    counter,
                ),
            );
        } else if (op === "$inSelect") {
            // val can be a QueryBuilder, a resolved Array, or raw SQL string
            if (Array.isArray(val)) {
                // Already resolved (e.g. from await distinct()) — treat like $in
                if (val.length === 0) {
                    conditions.push("1=0");
                } else {
                    const placeholders = val.map((v) => {
                        const bname = counter.next(`where_${field}`);
                        binds[bname] = v;
                        return `:${bname}`;
                    });
                    conditions.push(
                        `${qField} IN (${placeholders.join(", ")})`,
                    );
                }
            } else if (val && val._buildSQL) {
                // QueryBuilder — get its SQL
                const subSql = val._buildSQL();
                const subBinds = val._getBinds ? val._getBinds() : {};
                Object.assign(binds, subBinds);
                conditions.push(`${qField} IN (${subSql.sql || subSql})`);
            } else {
                // SECURITY WARNING: Raw SQL string fallback — caller is responsible
                // for ensuring `val` is safe. This path exists for power-user escape
                // hatches (e.g. hand-written subqueries). Never pass unsanitized
                // user input through this path.
                conditions.push(`${qField} IN (${val})`);
            }
        } else if (
            op === "$gtAny" ||
            op === "$ltAny" ||
            op === "$gteAny" ||
            op === "$lteAny"
        ) {
            const cmpOp = op.replace(/Any/g, "").replace(/\$/g, "");
            const cmpMap = { gt: ">", lt: "<", gte: ">=", lte: "<=" };
            const subCollection = quoteIdentifier(val.collection);
            const subField = quoteIdentifier(val.field);
            conditions.push(
                `${qField} ${cmpMap[cmpOp]} ANY (SELECT ${subField} FROM ${subCollection})`,
            );
        } else if (
            op === "$gtAll" ||
            op === "$ltAll" ||
            op === "$gteAll" ||
            op === "$lteAll"
        ) {
            const cmpOp = op.replace(/All/g, "").replace(/\$/g, "");
            const cmpMap = { gt: ">", lt: "<", gte: ">=", lte: "<=" };
            const subCollection = quoteIdentifier(val.collection);
            const subField = quoteIdentifier(val.field);
            conditions.push(
                `${qField} ${cmpMap[cmpOp]} ALL (SELECT ${subField} FROM ${subCollection})`,
            );
        } else {
            throw new Error(MSG.FILTER_UNSUPPORTED_OPERATOR(op));
        }
    }

    return conditions.length > 1
        ? `(${conditions.join(" AND ")})`
        : conditions[0];
}

// ─── _buildCorrelatedSubquery ────────────────────────────────────
/**
 * Builds a correlated scalar subquery for use in WHERE comparisons.
 *
 * A CORRELATED SUBQUERY is a subquery that references a column from
 * the OUTER (main) query. It's re-evaluated for EACH row of the outer query.
 *
 * Example use case:
 *   "Find employees whose salary is above their department's average"
 *   → WHERE "salary" > (SELECT AVG("salary") FROM "employees" WHERE "dept_id" = t0."dept_id")
 *
 * The $outer. prefix is how the library knows a value refers to the outer query:
 *   { dept_id: "$outer.dept_id" } → "dept_id" = t0."dept_id"
 *
 * @param {string} field - The column being compared (for naming bind variables)
 * @param {Object} spec - Subquery specification:
 *   - collection: The table to query
 *   - field: The column to SELECT (optional, default "*")
 *   - aggregate: Aggregate function like "$avg", "$sum" (optional)
 *   - where: Filter conditions (supports $outer. references)
 * @param {Object} binds - Bind variable accumulator (mutated)
 * @param {string} outerAlias - The alias of the outer table (usually "t0")
 * @param {Object} counter - Per-call bind counter
 * @returns {string} SQL subquery string like '(SELECT AVG("salary") FROM "employees" WHERE ...)'
 *
 * @example
 *   _buildCorrelatedSubquery("salary", {
 *     collection: "employees",
 *     aggregate: "$avg",
 *     field: "salary",
 *     where: { dept_id: "$outer.dept_id" }
 *   }, binds, "t0", counter)
 *   // → '(SELECT AVG("salary") FROM "employees" WHERE "dept_id" = t0."dept_id")'
 */
function _buildCorrelatedSubquery(field, spec, binds, outerAlias, counter) {
    const collection = quoteIdentifier(spec.collection);
    const aggFn = spec.aggregate
        ? spec.aggregate.replace("$", "").toUpperCase()
        : null;
    const subField = spec.field ? quoteIdentifier(spec.field) : "*";

    let selectExpr = subField;
    if (aggFn) {
        selectExpr = `${aggFn}(${subField})`;
    }

    let whereStr = "";
    if (spec.where && Object.keys(spec.where).length > 0) {
        const subconditions = [];
        for (const [k, v] of Object.entries(spec.where)) {
            if (typeof v === "string" && v.startsWith("$outer.")) {
                const outerCol = v.replace("$outer.", "");
                const alias = outerAlias || "t0";
                subconditions.push(
                    `${quoteIdentifier(k)} = ${alias}.${quoteIdentifier(outerCol)}`,
                );
            } else {
                const bname = counter.next(`where_sub_${k}`);
                binds[bname] = v;
                subconditions.push(`${quoteIdentifier(k)} = :${bname}`);
            }
        }
        whereStr = ` WHERE ${subconditions.join(" AND ")}`;
    }

    return `(SELECT ${selectExpr} FROM ${collection}${whereStr})`;
}

// ─── parseFilter (MAIN ENTRY POINT) ─────────────────────────────
/**
 * The main function of this file. Converts a MongoDB-style filter object
 * into an Oracle WHERE clause with bind variables.
 *
 * This is the function you'll call from outside this file. Everything
 * else in this file is a helper that parseFilter delegates to.
 *
 * HOW IT WORKS:
 *   1. Creates a fresh bind counter (for concurrency safety)
 *   2. Iterates each key in the filter object:
 *      - If the key is $and, $or, $nor, $not → handles logical operators
 *      - If the key is $exists, $notExists → handles subquery existence checks
 *      - Otherwise → treats the key as a column name and delegates to _parseFieldExpr
 *   3. Joins all conditions with AND
 *   4. Returns the WHERE clause string + the accumulated bind variables
 *
 * @param {Object} filter - MongoDB-style filter object.
 *   Examples:
 *     { status: "active" }                             → simple equality
 *     { age: { $gte: 18 } }                            → comparison
 *     { $or: [{ city: "Manila" }, { city: "Cebu" }] }  → logical OR
 *     { status: "active", age: { $gte: 18 } }          → multiple conditions (AND)
 *
 * @param {string} [tableAlias] - Table alias for correlated subqueries (e.g. "t0")
 *   You normally don't need to pass this — it's used internally.
 *
 * @param {Object} [_counter] - Internal: shared counter for recursive calls.
 *   Don't pass this yourself — it's created automatically on the first call
 *   and shared across recursive calls ($and, $or, $not, $nor).
 *
 * @returns {{ whereClause: string, binds: Object }}
 *   - whereClause: The SQL WHERE clause (e.g. 'WHERE "status" = :where_status_0')
 *                  Empty string "" if filter is null/empty
 *   - binds: Object mapping bind names to their values
 *            (e.g. { where_status_0: "active" })
 *
 * @example
 *   // Simple filter
 *   parseFilter({ status: "active" })
 *   // → { whereClause: 'WHERE "status" = :where_status_0',
 *   //     binds: { where_status_0: "active" } }
 *
 *   // Complex filter with $or
 *   parseFilter({
 *     status: "active",
 *     $or: [{ age: { $gte: 18 } }, { vip: true }]
 *   })
 *   // → { whereClause: 'WHERE "status" = :where_status_0 AND ("age" >= :where_age_1 OR "vip" = :where_vip_2)',
 *   //     binds: { where_status_0: "active", where_age_1: 18, where_vip_2: true } }
 */
function parseFilter(filter, tableAlias, _counter) {
    if (
        !filter ||
        typeof filter !== "object" ||
        Object.keys(filter).length === 0
    ) {
        return { whereClause: "", binds: {} };
    }

    // Create counter once at the top-level call; reuse for recursive calls
    const counter = _counter || _createCounter();

    const binds = {};
    const conditions = [];

    for (const [key, value] of Object.entries(filter)) {
        if (key === "$and") {
            const parts = value.map((sub) => {
                const { whereClause: wc, binds: wb } = parseFilter(
                    sub,
                    tableAlias,
                    counter,
                );
                Object.assign(binds, wb);
                return wc.replace(/^WHERE\s+/i, "");
            });
            conditions.push(`(${parts.join(" AND ")})`);
        } else if (key === "$or") {
            const parts = value.map((sub) => {
                const { whereClause: wc, binds: wb } = parseFilter(
                    sub,
                    tableAlias,
                    counter,
                );
                Object.assign(binds, wb);
                return wc.replace(/^WHERE\s+/i, "");
            });
            conditions.push(`(${parts.join(" OR ")})`);
        } else if (key === "$nor") {
            const parts = value.map((sub) => {
                const { whereClause: wc, binds: wb } = parseFilter(
                    sub,
                    tableAlias,
                    counter,
                );
                Object.assign(binds, wb);
                return wc.replace(/^WHERE\s+/i, "");
            });
            conditions.push(`NOT (${parts.join(" OR ")})`);
        } else if (key === "$not") {
            const { whereClause: wc, binds: wb } = parseFilter(
                value,
                tableAlias,
                counter,
            );
            Object.assign(binds, wb);
            conditions.push(`NOT (${wc.replace(/^WHERE\s+/i, "")})`);
        } else if (key === "$exists") {
            // EXISTS subquery: { $exists: { collection, match } }
            const subColl = quoteIdentifier(value.collection);
            const matchParts = [];
            for (const [mk, mv] of Object.entries(value.match || {})) {
                if (typeof mv === "string" && mv.startsWith("$")) {
                    const outerCol = mv.slice(1);
                    const alias = tableAlias || "t0";
                    matchParts.push(
                        `${quoteIdentifier(mk)} = ${alias}.${quoteIdentifier(outerCol)}`,
                    );
                } else {
                    const bname = counter.next(`where_exists_${mk}`);
                    binds[bname] = mv;
                    matchParts.push(`${quoteIdentifier(mk)} = :${bname}`);
                }
            }
            const matchWhere =
                matchParts.length > 0
                    ? ` WHERE ${matchParts.join(" AND ")}`
                    : "";
            conditions.push(`EXISTS (SELECT 1 FROM ${subColl}${matchWhere})`);
        } else if (key === "$notExists") {
            const subColl = quoteIdentifier(value.collection);
            const matchParts = [];
            for (const [mk, mv] of Object.entries(value.match || {})) {
                if (typeof mv === "string" && mv.startsWith("$")) {
                    const outerCol = mv.slice(1);
                    const alias = tableAlias || "t0";
                    matchParts.push(
                        `${quoteIdentifier(mk)} = ${alias}.${quoteIdentifier(outerCol)}`,
                    );
                } else {
                    const bname = counter.next(`where_notexists_${mk}`);
                    binds[bname] = mv;
                    matchParts.push(`${quoteIdentifier(mk)} = :${bname}`);
                }
            }
            const matchWhere =
                matchParts.length > 0
                    ? ` WHERE ${matchParts.join(" AND ")}`
                    : "";
            conditions.push(
                `NOT EXISTS (SELECT 1 FROM ${subColl}${matchWhere})`,
            );
        } else {
            conditions.push(
                _parseFieldExpr(key, value, binds, tableAlias, counter),
            );
        }
    }

    const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return { whereClause, binds };
}

module.exports = { parseFilter, resetBindCounter };
