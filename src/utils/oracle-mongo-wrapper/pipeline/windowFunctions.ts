

/**
 * ============================================================================
 * windowFunctions.js — $window Expressions → Oracle Analytic SQL
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   Converts $window aggregate expressions into Oracle analytic (window)
 *   function SQL. These are SQL functions that compute values across a
 *   "window" of related rows (e.g., running totals, rankings, lag/lead).
 *
 * SUPPORTED FUNCTIONS:
 *   ROW_NUMBER — sequential row number within partition
 *   RANK       — rank with gaps for ties
 *   DENSE_RANK — rank without gaps
 *   NTILE      — split rows into N equal buckets
 *   LAG        — value from a previous row
 *   LEAD       — value from a following row
 *   FIRST_VALUE / LAST_VALUE — first/last value in window
 *   NTH_VALUE  — Nth value in window
 *   SUM / AVG / COUNT / MIN / MAX — running aggregates
 *
 * HOW IT WORKS:
 *   Each analytic function uses OVER() to define its window:
 *     PARTITION BY — groups rows (like GROUP BY but without collapsing)
 *     ORDER BY     — defines row ordering within the partition
 *     frame        — custom window frame (e.g., ROWS BETWEEN ...)
 *
 * EXAMPLE:
 *   buildWindowExpr({
 *     fn: "RANK",
 *     partitionBy: "department",
 *     orderBy: { salary: -1 }
 *   })
 *   → 'RANK() OVER (PARTITION BY "department" ORDER BY "salary" DESC)'
 * ============================================================================
 */

import { quoteIdentifier } from "../utils";
import { oracleMongoWrapperMessages as MSG } from "../../../constants/messages";

/**
 * Window functions beyond the dedicated cases below that may be emitted as
 * `FN() OVER (...)`. The function name is spliced into SQL, so anything not
 * listed here is refused (CWE-89).
 */
const EXTRA_WINDOW_FUNCTIONS = new Set(["CUME_DIST", "PERCENT_RANK"]);

/** A frame bound: UNBOUNDED PRECEDING|FOLLOWING, CURRENT ROW, or n PRECEDING|FOLLOWING. */
const FRAME_BOUND = String.raw`(?:UNBOUNDED\s+(?:PRECEDING|FOLLOWING)|CURRENT\s+ROW|\d+\s+(?:PRECEDING|FOLLOWING))`;
/** ROWS|RANGE <bound> or ROWS|RANGE BETWEEN <bound> AND <bound> — the only frame text accepted. */
const FRAME_RE = new RegExp(String.raw`^(?:ROWS|RANGE)\s+(?:${FRAME_BOUND}|BETWEEN\s+${FRAME_BOUND}\s+AND\s+${FRAME_BOUND})$`, "i");

/** A count argument (n, offset) that is spliced into SQL: must be a positive integer. */
function _positiveInt(name: string, value: unknown): void {
  if (value !== undefined && !(Number.isInteger(value) && (value as number) > 0)) {
    throw new TypeError(MSG.WINDOW_INVALID_ARGUMENT(name, value));
  }
}

/**
 * Build a window/analytic function expression.
 *
 * @param {Object} spec - Window function specification
 * @param {string} spec.fn - Function name: ROW_NUMBER, RANK, LAG, LEAD, SUM, etc.
 * @param {string} [spec.field] - Column to operate on (not needed for ROW_NUMBER, RANK, etc.)
 * @param {string|string[]} [spec.partitionBy] - Column(s) to partition by
 * @param {Object} [spec.orderBy] - Sort spec: { col: 1|-1 } (1 = ASC, -1 = DESC)
 * @param {number} [spec.offset] - Offset for LAG/LEAD (default: 1)
 * @param {number} [spec.n] - Bucket count for NTILE (default: 4) or row for NTH_VALUE
 * @param {string} [spec.frame] - Custom frame clause (e.g., 'ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING')
 * @returns {string} The complete SQL analytic expression
 */
function buildWindowExpr(spec: { fn: string; field?: string; partitionBy?: string | string[]; orderBy?: Record<string, unknown>; offset?: number; n?: number; frame?: string; }): string {
  const { fn, field, partitionBy, orderBy, offset, n, frame } = spec;
  _positiveInt("n", n);
  _positiveInt("offset", offset);
  if (frame !== undefined && !(typeof frame === "string" && FRAME_RE.test(frame.trim()))) {
    throw new TypeError(MSG.WINDOW_INVALID_FRAME(frame));
  }

  // Build OVER clause
  const overParts: string[] = [];
  if (partitionBy) {
    const partCols = Array.isArray(partitionBy)
      ? partitionBy.map(quoteIdentifier).join(", ")
      : quoteIdentifier(partitionBy);
    overParts.push(`PARTITION BY ${partCols}`);
  }
  if (orderBy) {
    const orderCols = Object.entries(orderBy)
      .map(
        ([col, dir]) =>
          `${quoteIdentifier(col)} ${dir === -1 ? "DESC" : "ASC"}`,
      )
      .join(", ");
    overParts.push(`ORDER BY ${orderCols}`);
  }
  if (frame) {
    overParts.push(frame.trim().replace(/\s+/g, " ").toUpperCase());
  }

  const overClause =
    overParts.length > 0 ? `OVER (${overParts.join(" ")})` : "OVER ()";

  // Build function call
  const fnUpper = String(fn).toUpperCase();
  switch (fnUpper) {
    case "ROW_NUMBER":
      return `ROW_NUMBER() ${overClause}`;
    case "RANK":
      return `RANK() ${overClause}`;
    case "DENSE_RANK":
      return `DENSE_RANK() ${overClause}`;
    case "NTILE":
      return `NTILE(${n || 4}) ${overClause}`;
    case "LAG":
      return `LAG(${quoteIdentifier(field as string)}, ${offset || 1}) ${overClause}`;
    case "LEAD":
      return `LEAD(${quoteIdentifier(field as string)}, ${offset || 1}) ${overClause}`;
    case "FIRST_VALUE":
      return `FIRST_VALUE(${quoteIdentifier(field as string)}) ${overClause}`;
    case "LAST_VALUE":
      return `LAST_VALUE(${quoteIdentifier(field as string)}) ${overClause}`;
    case "NTH_VALUE":
      return `NTH_VALUE(${quoteIdentifier(field as string)}, ${n || 1}) ${overClause}`;
    case "SUM":
      return `SUM(${field === "*" ? "*" : quoteIdentifier(field as string)}) ${overClause}`;
    case "AVG":
      return `AVG(${field === "*" ? "*" : quoteIdentifier(field as string)}) ${overClause}`;
    case "COUNT":
      return `COUNT(${field === "*" ? "*" : quoteIdentifier(field as string)}) ${overClause}`;
    case "MIN":
      return `MIN(${quoteIdentifier(field as string)}) ${overClause}`;
    case "MAX":
      return `MAX(${quoteIdentifier(field as string)}) ${overClause}`;
    default:
      if (!EXTRA_WINDOW_FUNCTIONS.has(fnUpper)) throw new Error(MSG.WINDOW_UNKNOWN_FUNCTION(fn));
      return `${fnUpper}(${field ? quoteIdentifier(field as string) : ""}) ${overClause}`;
  }
}

export { buildWindowExpr };
