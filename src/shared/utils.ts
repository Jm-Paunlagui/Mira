

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

import { oracleMongoWrapperMessages as MSG } from "./messages";

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
function quoteIdentifier(name: string): string {
  // Escape embedded double-quotes to prevent identifier injection (CWE-116)
  const sanitized = String(name).replace(/"/g, '""');
  return `"${sanitized}"`;
}

/**
 * Makes a caller-derived string (usually a column name) safe to use INSIDE a
 * bind-variable name. Bind names are not quoted in SQL (`:where_NAME_0`), so a
 * field name such as `NAME" OR "X` would otherwise break out of the
 * placeholder. Anything outside [A-Za-z0-9_] becomes "_"; callers keep names
 * unique with a counter or index suffix.
 */
function bindSafe(name: unknown): string {
  return String(name).replace(/[^A-Za-z0-9_]/g, "_");
}

// ─── convertTypes ───────────────────────────────────────────────
/**
 * ⚠ FENCED — DO NOT APPLY TO MONEY OR RATE VALUES.
 *
 * This helper coerces numeric-looking strings back into JavaScript numbers so
 * that `{ age: "25" }` becomes `{ age: 25 }`. It is EXPORTED FOR API
 * COMPATIBILITY but called nowhere in the codebase — the live read path returns
 * `conn.execute(...).rows` untouched.
 *
 * THE TRAP IT USED TO SET: `Number("50000.50")` is `50000.5`, an IEEE-754
 * double — which silently RE-ROUNDS a value the money-safe `fetchTypeHandler`
 * in `driver/oracle.ts` deliberately handed back as an exact string.
 * A `NUMBER(19,4)` money amount or `NUMBER(19,8)` rate arrives here as a string
 * PRECISELY so `utils/money.js` can parse it without loss; coercing it to a
 * double would undo the whole money layer.
 *
 * THE FENCE: any string containing a decimal point is left AS A STRING. Only
 * pure-integer strings (IDs, counts) are converted. A money/rate value is
 * therefore never rounded here even if a copier does adopt this helper.
 * Preferred long term: delete this and `rowToDoc` (git remembers — lava-flow).
 *
 * @param {Object} row - A single row object from an Oracle query result
 * @returns {Object} A new object with pure-integer strings converted to numbers
 *
 * @example
 *   convertTypes({ NAME: "Juan", AGE: "25", SALARY: "50000.5000" })
 *   // → { NAME: "Juan", AGE: 25, SALARY: "50000.5000" }  (money left as string)
 */
function convertTypes(row: Record<string, unknown>): Record<string, unknown> {
  if (!row || typeof row !== "object") return row;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (
      typeof val === "string" &&
      val !== "" &&
      val.trim() !== "" &&
      // FENCE: only whole-integer strings are safe to coerce. A decimal point,
      // exponent, or sign+fraction is money/rate territory — leave it a string
      // so the money-safe fetch is never undone here.
      /^[+-]?\d+$/.test(val.trim()) &&
      Number.isSafeInteger(Number(val))
    ) {
      out[key] = Number(val);
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
function rowToDoc(row: Record<string, unknown>): Record<string, unknown> {
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
function mergeBinds(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k in merged) {
      throw new Error(MSG.MERGE_BINDS_KEY_COLLISION(k));
    }
    merged[k] = v;
  }
  return merged;
}

// ─── renameBinds ────────────────────────────────────────────────
/**
 * Gives every bind of a sub-statement a prefix, in its SQL and its bind object.
 *
 * Each parseFilter / QueryBuilder numbers its binds from 0 (`where_SCORE_0`), so
 * two independently built queries that filter the same column use the same
 * name. Merging them without renaming lets one value silently overwrite the
 * other: a wrong result with no error. Call this on the inner statement before
 * merging its binds into the outer one.
 *
 * @example
 *   renameBinds('"A" = :where_A_0', { where_A_0: 1 }, "sq0_")
 *   // → { sql: '"A" = :sq0_where_A_0', binds: { sq0_where_A_0: 1 } }
 */
/**
 * One token of SQL text, for the one-pass bind rewriters below: a q-quoted literal
 * (q'[…]', nq'{…}', q'!…!'), a 'string literal', a "quoted identifier", a -- line or
 * block comment, or a bind name (group 2). Literals and comments are skipped, so a
 * placeholder written inside them is left as text and a value is never spliced there.
 */
const SQL_TOKEN_RE =
  /[nN]?[qQ]'(?:\[[\s\S]*?\]|\{[\s\S]*?\}|\([\s\S]*?\)|<[\s\S]*?>|([^\s([{<])[\s\S]*?\1)'|'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\/|:([A-Za-z_][A-Za-z0-9_$#]*)/g;

function renameBinds(sql: string, binds: Record<string, unknown>, prefix: string): { sql: string; binds: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(binds)) out[`${prefix}${k}`] = v;
  // One pass, skipping quoted text, so a renamed placeholder is never renamed again
  // (binds "A" and "p_A" with prefix "p_") and a quoted name or literal is left alone.
  const renamed = sql.replace(SQL_TOKEN_RE, (m, _q?: string, name?: string) =>
    name !== undefined && Object.prototype.hasOwnProperty.call(binds, name) ? `:${prefix}${name}` : m,
  );
  return { sql: renamed, binds: out };
}

// ─── inlineBinds ────────────────────────────────────────────────
/**
 * Writes bind values into SQL as literals, for statements that cannot take
 * binds at all: CREATE VIEW and CREATE MATERIALIZED VIEW are DDL, and Oracle
 * stores the view's text, so a filter value has to become part of it.
 *
 * Only values with an exact, injection-safe literal form are accepted:
 * finite numbers, bigints, strings (single quotes doubled) and null. Anything
 * else (Dates, collection binds for long $in lists, objects) is refused with a
 * TypeError instead of guessing a format; pass the view as SQL text for those.
 */
function inlineBinds(sql: string, binds: Record<string, unknown>, where: string): string {
  const literals = new Map<string, string>();
  for (const [k, v] of Object.entries(binds)) {
    let literal: string;
    if (v === null || v === undefined) literal = "NULL";
    // A negative number is parenthesised: after a "-" in the SQL, "10-:n" with n = -5 would
    // otherwise read "10--5", and "--" starts a comment that drops the rest of the line.
    else if (typeof v === "number" && Number.isFinite(v)) literal = v < 0 || Object.is(v, -0) ? `(${String(v)})` : String(v);
    else if (typeof v === "bigint") literal = v < 0n ? `(${v.toString()})` : v.toString();
    else if (typeof v === "string") literal = `'${v.replace(/'/g, "''")}'`;
    else throw new TypeError(MSG.INLINE_BIND_UNSUPPORTED(where, k, v instanceof Date ? "Date" : typeof v));
    literals.set(k, literal);
  }
  // One pass over the SQL, skipping 'literals' and "identifiers". Replacing bind by
  // bind (2.x–3.0.0) re-scanned literals already inlined: a value containing the text
  // ":where_B_1" pulled the next value into it and broke out of the quotes.
  return sql.replace(SQL_TOKEN_RE, (m, _q?: string, name?: string) =>
    name !== undefined && literals.has(name) ? literals.get(name)! : m,
  );
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
function buildOrderBy(sortSpec: Record<string, unknown> | null | undefined): string {
  if (
    !sortSpec ||
    typeof sortSpec !== "object" ||
    Object.keys(sortSpec).length === 0
  ) {
    return "";
  }
  const parts = Object.entries(sortSpec).map(([col, dir]) => sortTerm(col, dir));
  return `ORDER BY ${parts.join(", ")}`;
}

/**
 * One ORDER BY term. `dir` is 1 (ASC), -1 (DESC), or `{ order?: 1 | -1, nulls?: "first" | "last" }`
 * for NULLS FIRST / LAST. Any other plain value keeps the historical meaning (ASC).
 * `col` is taken as is (callers upper-case it when their stage does).
 */
function sortTerm(col: string, dir: unknown): string {
  if (dir === null || typeof dir !== "object") return `${quoteIdentifier(col)} ${dir === -1 ? "DESC" : "ASC"}`;
  const { order = 1, nulls } = dir as { order?: unknown; nulls?: unknown };
  if (order !== 1 && order !== -1) throw new Error(MSG.SORT_INVALID(col, "order must be 1 or -1"));
  let term = `${quoteIdentifier(col)} ${order === -1 ? "DESC" : "ASC"}`;
  if (nulls !== undefined) {
    const n = typeof nulls === "string" ? nulls.toUpperCase() : "";
    if (n !== "FIRST" && n !== "LAST") throw new Error(MSG.SORT_INVALID(col, 'nulls must be "first" or "last"'));
    term += ` NULLS ${n}`;
  }
  return term;
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
function buildProjection(projection: Record<string, unknown> | null | undefined): { columns: string; isExclusion: boolean; excludedCols: string[]; } {
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

// ─── sqlFragmentProblem ─────────────────────────────────────────
/**
 * Checks a piece of developer-written SQL that Mira writes into a statement as
 * is (a column type, a DEFAULT, a CHECK condition). It must stay one expression:
 * quotes closed, parentheses balanced and never closed below the start, no ","
 * at the top level (which would start another column), no ";" and no comments.
 * Returns why it is refused, or null when it is acceptable.
 */
/** A q at `i` opens q'…' (or national nq'…'): it starts a word, or follows a lone n/N. */
function _startsQuote(text: string, i: number): boolean {
  const word = /[A-Za-z0-9_$#]/;
  const prev = text[i - 1] ?? "";
  if (!word.test(prev)) return true;
  return (prev === "n" || prev === "N") && !word.test(text[i - 2] ?? "");
}

function sqlFragmentProblem(text: unknown): string | null {
  if (typeof text !== "string") return `expected a string, got ${text === null ? "null" : typeof text}`;
  if (text.trim() === "") return "it is empty";
  if (text.includes("\u0000")) return "it contains a NUL character";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return `a ${c === "'" ? "string" : "quoted name"} is not closed`;
      i = end;
      while (text[i + 1] === c) { const next = text.indexOf(c, i + 2); if (next < 0) return "a quote is not closed"; i = next; }
    } else if (c === "(") depth++;
    else if (c === ")") { if (--depth < 0) return 'it closes a ")" it did not open'; }
    else if (c === ";") return 'it contains ";"';
    else if (c === "," && depth === 0) return 'it contains "," outside parentheses';
    else if ((c === "-" && text[i + 1] === "-") || (c === "/" && text[i + 1] === "*")) return "it contains a comment";
    else if ((c === "q" || c === "Q") && text[i + 1] === "'" && _startsQuote(text, i)) return "q-quoted strings are not accepted";
  }
  return depth === 0 ? null : 'a "(" is not closed';
}

// ─── assertMaxDepth ─────────────────────────────────────────────
/** Deepest nesting a filter, update or pipeline may have. Real queries stay far below it. */
const MAX_QUERY_DEPTH = 100;
/** Most objects and arrays one filter, update or pipeline may hold. */
const MAX_QUERY_NODES = 100_000;
/**
 * Refuses a value nested deeper than `max` objects/arrays (or one that refers to
 * itself). Iterative, so a hostile 100 000-level filter is refused with a clear
 * error instead of overflowing the stack inside the recursive parsers.
 */
function assertMaxDepth(value: unknown, where: string, max = MAX_QUERY_DEPTH): void {
  if (!value || typeof value !== "object") return;
  // Two parallel stacks (no tuple per node) and index loops: the walk is on every query.
  const nodes: unknown[] = [value];
  const depths: number[] = [1];
  // Also a cap on objects visited: a value that reuses one sub-object under two keys at
  // every level is shallow but is walked once per path, which doubles per level.
  let visited = 0;
  while (nodes.length > 0) {
    const v = nodes.pop() as object;
    const d = depths.pop()!;
    if (d > max) throw new RangeError(MSG.QUERY_TOO_DEEP(where, max));
    if (++visited > MAX_QUERY_NODES) throw new RangeError(MSG.QUERY_TOO_LARGE(where, MAX_QUERY_NODES));
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const c = v[i];
        if (c !== null && typeof c === "object") { nodes.push(c); depths.push(d + 1); }
      }
      continue;
    }
    // Only plain objects and arrays are query structure; a QueryBuilder, Date or Buffer is a leaf.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) continue;
    for (const k in v) {
      const c = (v as Record<string, unknown>)[k];
      if (c !== null && typeof c === "object") { nodes.push(c); depths.push(d + 1); }
    }
  }
}

export { sqlFragmentProblem, assertMaxDepth, MAX_QUERY_DEPTH, MAX_QUERY_NODES };
export { quoteIdentifier, bindSafe, convertTypes, rowToDoc, mergeBinds, renameBinds, inlineBinds, buildOrderBy, buildProjection, sortTerm };
