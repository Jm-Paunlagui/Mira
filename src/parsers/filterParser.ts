

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
 *   │             │ Lists > 1000 auto-split into OR'd groups         │
 *   │             │ (Oracle ORA-01795 cap)                           │
 *   │ $nin        │ Is NOT one of — WHERE "field" NOT IN (...)       │
 *   │             │ Lists > 1000 auto-split into AND'd groups        │
 *   │ $between    │ Range — WHERE "field" BETWEEN :min AND :max      │
 *   │ $notBetween │ NOT BETWEEN                                      │
 *   │ $exists     │ IS NOT NULL / IS NULL                            │
 *   │ $regex      │ Pattern match — REGEXP_LIKE("field", :pattern[, :opts]) │
 *   │ $options    │ Regex flags sibling (e.g. 'i' for case-insensitive)     │
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

import { quoteIdentifier, bindSafe, renameBinds, assertMaxDepth } from "../shared/utils";
import { oracleMongoWrapperMessages as MSG } from "../shared/messages";
import { jsonFieldCondition } from "./jsonPath";

/**
 * Oracle's hard cap on expressions inside a single IN (...) list (ORA-01795).
 * $in / $nin lists longer than this are split into OR-/AND-joined groups of
 * at most this many bind variables — semantically identical, never errors.
 * @constant {number}
 */
const ORACLE_IN_LIST_MAX = 1000;

/**
 * Aggregate functions a correlated $subquery may apply. The name is spliced
 * into SQL, so anything else is refused (an arbitrary "aggregate" string could
 * otherwise rewrite the comparison — CWE-89).
 * @constant {Set<string>}
 */
const SUBQUERY_AGGREGATES = new Set(["SUM", "AVG", "MIN", "MAX", "COUNT"]);

/**
 * Large $in / $nin lists are bound as ONE collection instead of N scalar binds:
 * `col IN (SELECT COLUMN_VALUE FROM TABLE(:b))`. Thousands of OR-ed IN groups
 * make Oracle's parse cost grow super-linearly (20,000 values measured ~50x
 * slower than 2,000) — an easy denial of service. One collection bind keeps the
 * statement text constant, so cost is linear and the cursor is shared.
 * SYS.ODCI*LIST types are granted to PUBLIC. Lists whose element type cannot be
 * mapped (mixed types, strings > 4000 bytes) fall back to grouped IN lists.
 */
function _collectionBind(values: unknown[]): { type: string; val: unknown[] } | null {
  if (values.every((v) => typeof v === "number" && Number.isFinite(v))) return { type: "SYS.ODCINUMBERLIST", val: values };
  if (values.every((v) => v instanceof Date)) return { type: "SYS.ODCIDATELIST", val: values };
  if (values.every((v) => typeof v === "string" && Buffer.byteLength(v, "utf8") <= 4000)) return { type: "SYS.ODCIVARCHAR2LIST", val: values };
  return null;
}

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
function _createCounter(): { next: (prefix: string) => string; } {
  let _count = 0;
  return {
    next(prefix) {
      return `${bindSafe(prefix)}_${_count++}`;
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
const COMPARISON_OPS: Record<string, string> = {
  $eq: "=", // Equal
  $ne: "<>", // Not equal
  $gt: ">", // Greater than
  $gte: ">=", // Greater than or equal
  $lt: "<", // Less than
  $lte: "<=", // Less than or equal
};

// ─── _parseFieldExpr ────────────────────────────────────────────
/** Units `$now` arithmetic accepts, with the NUMTODSINTERVAL unit each maps to. */
const NOW_UNITS: Readonly<Record<string, string>> = Object.freeze({ days: "DAY", hours: "HOUR", minutes: "MINUTE", seconds: "SECOND" });

/**
 * Server-time operand: `{ $now: true }` is the database's current time;
 * `{ $now: { minus: { days: 7 } } }` (and `plus`, with days / hours / minutes /
 * seconds) shifts it by bound NUMTODSINTERVAL amounts, so the comparison uses the
 * DATABASE clock, never the app's.
 *
 *   { CREATED_AT: { $lt: { $now: { minus: { days: 30 } } } } }
 *   → "CREATED_AT" < CAST(SYSTIMESTAMP AS TIMESTAMP) - NUMTODSINTERVAL(:where_CREATED_AT_now_0, 'DAY')
 *
 * Time zones: by default the value is the database server's wall-clock time as a
 * plain TIMESTAMP, which is what $currentDate (SYSTIMESTAMP / SYSDATE) stores in
 * DATE and TIMESTAMP columns. Comparing such a column with SYSTIMESTAMP itself
 * (a TIMESTAMP WITH TIME ZONE) would make Oracle convert the column using the
 * SESSION time zone, shifting the window by the app-vs-database offset. For a
 * TIMESTAMP WITH TIME ZONE column pass `withTimeZone: true` to compare with
 * SYSTIMESTAMP itself: `{ $now: { minus: { hours: 1 }, withTimeZone: true } }`.
 *
 * Amounts are bound (never interpolated); unknown keys or non-finite / negative
 * amounts throw instead of guessing.
 */
function _nowExpr(field: string, spec: unknown, binds: Record<string, unknown>, counter: Record<string, any>): string {
  const DB_NOW = "CAST(SYSTIMESTAMP AS TIMESTAMP)";
  if (spec === true || (spec && typeof spec === "object" && Object.keys(spec).length === 0)) return DB_NOW;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new TypeError(`$now on "${field}" must be true or { minus | plus: { days, hours, minutes, seconds }, withTimeZone? }`);
  }
  const { withTimeZone, ...shifts } = spec as Record<string, unknown>;
  let sql = withTimeZone === true ? "SYSTIMESTAMP" : DB_NOW;
  for (const [dir, amounts] of Object.entries(shifts)) {
    const sign = dir === "minus" ? "-" : dir === "plus" ? "+" : null;
    if (!sign) throw new TypeError(`$now on "${field}": unknown key "${dir}" (use minus or plus)`);
    if (!amounts || typeof amounts !== "object" || Array.isArray(amounts)) {
      throw new TypeError(`$now.${dir} on "${field}" must be an object of units`);
    }
    for (const [unit, n] of Object.entries(amounts as Record<string, unknown>)) {
      const oracleUnit = NOW_UNITS[unit];
      if (!oracleUnit) throw new TypeError(`$now.${dir} on "${field}": unknown unit "${unit}" (use days, hours, minutes or seconds)`);
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        throw new TypeError(`$now.${dir}.${unit} on "${field}" must be a finite, non-negative number`);
      }
      const bname = counter.next(`where_${field}_now`);
      binds[bname] = n;
      sql += ` ${sign} NUMTODSINTERVAL(:${bname}, '${oracleUnit}')`;
    }
  }
  return sql;
}

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
function _parseFieldExpr(field: string, expr: any, binds: Record<string, unknown>, outerAlias: string | null | undefined, counter: Record<string, any>): string {
  // A dotted key is a path into a JSON column ("DOC.address.city"); $elemMatch
  // matches an element of a JSON array. Both are JSON_VALUE / JSON_EXISTS (jsonPath.ts).
  if (field.includes(".") || (expr !== null && typeof expr === "object" && !Array.isArray(expr) && !(expr instanceof Date) && "$elemMatch" in expr)) {
    return jsonFieldCondition(field, expr, binds, counter as { next: (p: string) => string });
  }
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
    // "$outer.COL" (LATERAL correlation) is bound like any value; $lateralJoin
    // rewrites such binds into a reference to the OUTER source's column.
    const bname = counter.next(`where_${field}`);
    binds[bname] = expr;
    return `${qField} = :${bname}`;
  }

  // Operator object: { field: { $gt: 5, $lt: 10 } }
  const conditions: string[] = [];

  // An operand's shape depends on its operator (Mongo-style DSL), so it stays
  // loosely typed here; each branch below checks what it needs.
  for (const [op, val] of Object.entries(expr as Record<string, any>)) {
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
      } else if ((val === null || val === undefined) && (op === "$eq" || op === "$ne")) {
        // A bound NULL never compares equal (or unequal) to anything: use IS [NOT] NULL.
        conditions.push(`${qField} ${op === "$eq" ? "IS NULL" : "IS NOT NULL"}`);
      } else if (val && typeof val === "object" && !Array.isArray(val) && !(val instanceof Date) && "$now" in val) {
        conditions.push(`${qField} ${COMPARISON_OPS[op]} ${_nowExpr(field, val.$now, binds, counter)}`);
      } else {
        const bname = counter.next(`where_${field}`);
        binds[bname] = val;
        conditions.push(`${qField} ${COMPARISON_OPS[op]} :${bname}`);
      }
    } else if (op === "$in") {
      const coll = Array.isArray(val) && val.length > ORACLE_IN_LIST_MAX ? _collectionBind(val) : null;
      if (!Array.isArray(val) || val.length === 0) {
        conditions.push("1=0"); // empty IN → always false
      } else if (coll) {
        const bname = counter.next(`where_${field}`);
        binds[bname] = coll;
        conditions.push(`${qField} IN (SELECT COLUMN_VALUE FROM TABLE(:${bname}))`);
      } else {
        // Oracle caps an IN list at 1,000 expressions (ORA-01795). Split
        // oversized value lists into OR-joined IN groups of ≤1,000 binds so
        // bulk callers (e.g. 10k-row Excel uploads batching by GID) never hit
        // the cap. Semantics are identical: x IN (a..) OR x IN (b..) ≡ x IN (a..b..).
        const groups: string[] = [];
        for (let i = 0; i < val.length; i += ORACLE_IN_LIST_MAX) {
          const placeholders = val.slice(i, i + ORACLE_IN_LIST_MAX).map((v) => {
            const bname = counter.next(`where_${field}`);
            binds[bname] = v;
            return `:${bname}`;
          });
          groups.push(`${qField} IN (${placeholders.join(", ")})`);
        }
        conditions.push(
          groups.length === 1 ? groups[0] : `(${groups.join(" OR ")})`,
        );
      }
    } else if (op === "$nin") {
      const coll = Array.isArray(val) && val.length > ORACLE_IN_LIST_MAX ? _collectionBind(val) : null;
      if (!Array.isArray(val) || val.length === 0) {
        conditions.push("1=1");
      } else if (coll) {
        const bname = counter.next(`where_${field}`);
        binds[bname] = coll;
        conditions.push(`${qField} NOT IN (SELECT COLUMN_VALUE FROM TABLE(:${bname}))`);
      } else {
        // Same ORA-01795 cap as $in. De Morgan: NOT(x IN a OR x IN b)
        // ≡ x NOT IN a AND x NOT IN b — so groups join with AND.
        const groups: string[] = [];
        for (let i = 0; i < val.length; i += ORACLE_IN_LIST_MAX) {
          const placeholders = val.slice(i, i + ORACLE_IN_LIST_MAX).map((v) => {
            const bname = counter.next(`where_${field}`);
            binds[bname] = v;
            return `:${bname}`;
          });
          groups.push(`${qField} NOT IN (${placeholders.join(", ")})`);
        }
        conditions.push(
          groups.length === 1 ? groups[0] : `(${groups.join(" AND ")})`,
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
      conditions.push(val ? `${qField} IS NOT NULL` : `${qField} IS NULL`);
    } else if (op === "$regex") {
      const bname = counter.next(`where_${field}`);
      binds[bname] = val;
      // Support MongoDB-style $options sibling (e.g. 'i' for case-insensitive)
      const regexOpts = expr.$options;
      if (regexOpts) {
        const bOpts = counter.next(`where_${field}_opts`);
        binds[bOpts] = regexOpts;
        conditions.push(`REGEXP_LIKE(${qField}, :${bname}, :${bOpts})`);
      } else {
        conditions.push(`REGEXP_LIKE(${qField}, :${bname})`);
      }
    } else if (op === "$options") {
      // Handled inside $regex — skip standalone processing
    } else if (op === "$like") {
      const bname = counter.next(`where_${field}`);
      binds[bname] = val;
      conditions.push(`${qField} LIKE :${bname}`);
    } else if (op === "$any") {
      const placeholders = val.map((v: unknown) => {
        const bname = counter.next(`where_${field}`);
        binds[bname] = v;
        return `:${bname}`;
      });
      conditions.push(`${qField} = ANY(${placeholders.join(", ")})`);
    } else if (op === "$all") {
      const placeholders = val.map((v: unknown) => {
        const bname = counter.next(`where_${field}`);
        binds[bname] = v;
        return `:${bname}`;
      });
      conditions.push(`${qField} = ALL(${placeholders.join(", ")})`);
    } else if (op === "$case") {
      // { $case: [{when, then}], $else: v }
      const whenParts = val.map((c: any) => {
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
      // { tier: { $case: … } } means tier = CASE … END (README "Conditional expressions").
      conditions.push(`${qField} = CASE ${whenParts.join(" ")}${elseStr} END`);
    } else if (op === "$else") {
      // Handled inside $case
    } else if (op === "$coalesce") {
      // "$COL" is a column; every other value (string, number, date) is bound.
      const parts = val.map((v: any) => {
        if (typeof v === "string" && v.startsWith("$")) return quoteIdentifier(v.slice(1));
        const bname = counter.next(`where_${field}`);
        binds[bname] = v;
        return `:${bname}`;
      });
      conditions.push(`${qField} = COALESCE(${parts.join(", ")})`);
    } else if (op === "$nullif") {
      const left = quoteIdentifier(val[0]);
      const bname = counter.next(`where_${field}`);
      binds[bname] = val[1];
      conditions.push(`${qField} = NULLIF(${left}, :${bname})`);
    } else if (op === "$subquery") {
      // Correlated subquery for WHERE comparisons
      conditions.push(
        _buildCorrelatedSubquery(field, val, binds, outerAlias, counter),
      );
    } else if (op === "$inSelect") {
      // val can be a QueryBuilder, a resolved Array, or raw SQL string
      if (Array.isArray(val)) {
        // Already resolved (e.g. from await distinct()) — exactly $in, including its
        // empty-list and >1,000-value (ORA-01795) handling.
        conditions.push(_parseFieldExpr(field, { $in: val }, binds, outerAlias, counter));
      } else if (val && val._buildSQL) {
        // QueryBuilder — get its SQL
        // The subquery numbers its binds from 0 like the outer filter; prefix them
        // so a subquery filtering the same column cannot overwrite the outer value.
        const built = val._buildSQL();
        const subSql: string = typeof built === "string" ? built : built.sql;
        const subBinds: Record<string, unknown> = (typeof built === "string" ? undefined : built.binds) ?? (val._getBinds ? val._getBinds() : {});
        const sub = renameBinds(subSql, subBinds, `${counter.next("sq")}_`);
        Object.assign(binds, sub.binds);
        conditions.push(`${qField} IN (${sub.sql})`);
      } else if (val instanceof (require("../core/sql") as typeof import("../core/sql")).SqlStatement) {
        // A hand-written subquery as sql`…`: its values are binds, prefixed like a QueryBuilder's.
        const sub = renameBinds(val.sql, { ...val.binds }, `${counter.next("sq")}_`);
        Object.assign(binds, sub.binds);
        conditions.push(`${qField} IN (${sub.sql})`);
      } else {
        // 2.x–3.0.0 ran a plain string here as raw SQL. A filter built from request
        // input ({ ID: req.query.id } with ?id[$inSelect]=SELECT…) reached it: refused.
        throw new TypeError(MSG.IN_SELECT_INVALID(typeof val === "string" ? "string" : val === null ? "null" : typeof val));
      }
    } else if (
      op === "$gtAny" ||
      op === "$ltAny" ||
      op === "$gteAny" ||
      op === "$lteAny"
    ) {
      const cmpOp = op.replace(/Any/g, "").replace(/\$/g, "");
      const cmpMap: Record<string, string> = { gt: ">", lt: "<", gte: ">=", lte: "<=" };
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
      const cmpMap: Record<string, string> = { gt: ">", lt: "<", gte: ">=", lte: "<=" };
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
function _buildCorrelatedSubquery(field: string, spec: Record<string, any>, binds: Record<string, unknown>, outerAlias: string | null | undefined, counter: Record<string, any>): string {
  const collection = quoteIdentifier(spec.collection);
  const aggFn = spec.aggregate
    ? String(spec.aggregate).replace("$", "").toUpperCase()
    : null;
  if (aggFn !== null && !SUBQUERY_AGGREGATES.has(aggFn)) {
    throw new Error(MSG.AGGREGATE_UNKNOWN_FUNCTION("filterParser.$subquery", spec.aggregate));
  }
  const subField = spec.field ? quoteIdentifier(spec.field) : "*";

  let selectExpr = subField;
  if (aggFn) {
    selectExpr = `${aggFn}(${subField})`;
  }

  let whereStr = "";
  if (spec.where && Object.keys(spec.where).length > 0) {
    const subconditions: string[] = [];
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
function parseFilter(filter: Record<string, any>, tableAlias?: string | null, _counter?: Record<string, any>): { whereClause: string; binds: Record<string, unknown>; } {
  if (
    !filter ||
    typeof filter !== "object" ||
    Object.keys(filter).length === 0
  ) {
    return { whereClause: "", binds: {} };
  }
  if (!_counter) assertMaxDepth(filter, "filterParser");

  // Create counter once at the top-level call; reuse for recursive calls
  const counter = _counter || _createCounter();

  const binds: Record<string, unknown> = {};
  const conditions: string[] = [];

  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and") {
      const parts = value.map((sub: any) => {
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
      const parts = value.map((sub: any) => {
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
      const parts = value.map((sub: any) => {
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
      const matchParts: string[] = [];
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
        matchParts.length > 0 ? ` WHERE ${matchParts.join(" AND ")}` : "";
      conditions.push(`EXISTS (SELECT 1 FROM ${subColl}${matchWhere})`);
    } else if (key === "$notExists") {
      const subColl = quoteIdentifier(value.collection);
      const matchParts: string[] = [];
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
        matchParts.length > 0 ? ` WHERE ${matchParts.join(" AND ")}` : "";
      conditions.push(`NOT EXISTS (SELECT 1 FROM ${subColl}${matchWhere})`);
    } else {
      conditions.push(_parseFieldExpr(key, value, binds, tableAlias, counter));
    }
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { whereClause, binds };
}

/**
 * A filter from untrusted input (a request body or query string), reduced to
 * equality on plain values. Any operator ("$or", { $ne: … }, { $inSelect: … }),
 * nested object or list is refused: an attacker who can send
 * `?name[$ne]=x` or `{ "ID": { "$gtAny": { "collection": "SECRETS", … } } }`
 * would otherwise choose the query's logic. Build operators in code, from
 * values taken out of the input.
 *
 * @example
 *   users.find(sanitizeFilter(req.query))             // { NAME: "Ana", CITY: "Cebu" }
 *   users.find({ ...sanitizeFilter(req.query), AGE: { $gte: 18 } })
 */
function sanitizeFilter(input: unknown): Record<string, string | number | boolean | bigint | Date | null> {
  if (input === undefined || input === null) return {};
  const proto = typeof input === "object" ? Object.getPrototypeOf(input) : undefined;
  if (typeof input !== "object" || Array.isArray(input) || (proto !== Object.prototype && proto !== null)) {
    throw new TypeError(MSG.UNTRUSTED_FILTER("filter", "it must be a plain object"));
  }
  const out: Record<string, string | number | boolean | bigint | Date | null> = {};
  for (const [key, v] of Object.entries(input)) {
    const where = JSON.stringify(key);
    if (key.startsWith("$")) throw new TypeError(MSG.UNTRUSTED_FILTER(where, "operators are not accepted"));
    if (key === "__proto__" || key === "constructor" || key === "prototype") throw new TypeError(MSG.UNTRUSTED_FILTER(where, "this key is not accepted"));
    if (key === "" || key.length > 128) throw new TypeError(MSG.UNTRUSTED_FILTER(where, "a field name must be 1 to 128 characters"));
    if (typeof v === "number" ? Number.isFinite(v) : v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "bigint" || (v instanceof Date && !Number.isNaN(v.getTime()))) {
      out[key] = v as string | number | boolean | bigint | Date | null;
    } else {
      throw new TypeError(MSG.UNTRUSTED_FILTER(where, `a ${Array.isArray(v) ? "list" : v === undefined ? "missing value" : typeof v === "number" ? "non-finite number" : typeof v} is not a plain value`));
    }
  }
  return out;
}

export { parseFilter, resetBindCounter, sanitizeFilter };
