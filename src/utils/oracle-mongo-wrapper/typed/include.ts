/**
 * ============================================================================
 * typed/include.ts — the SQL and decoding behind find().include() (Mira 2.1)
 * ============================================================================
 *
 * An included relation is one correlated subquery in the parent's SELECT list,
 * so `customers.find().include("orders")` is ONE statement however many rows:
 *
 *   hasMany   (SELECT JSON_ARRAYAGG(JSON_OBJECT(…) ORDER BY … RETURNING CLOB)
 *                FROM "ORDERS" i WHERE i."CUSTOMER_ID" = t0."ID" [AND where]) AS "orders"
 *             with a limit: the child rows are numbered with ROW_NUMBER() in an
 *             inline view and the first n kept (no FETCH FIRST: Oracle mis-handles
 *             a row limit in a correlated LATERAL subquery, see 2.0.1).
 *   belongsTo (SELECT JSON_OBJECT(…) FROM "CUSTOMERS" i WHERE i."ID" = t0."CUSTOMER_ID")
 *   hasOne    (SELECT JSON_OBJECT(…) … ORDER BY … FETCH FIRST 1 ROWS ONLY)
 *
 * The JSON keeps Mira's row types: a scaled NUMBER is written with TO_CHAR (the
 * same exact decimal text a top-level money column gives), dates come back as
 * Date, and binary columns (BLOB, RAW) are left out — JSON has no binary type.
 * ============================================================================
 */

import { quoteIdentifier, sortTerm, renameBinds } from "../utils";
import { parseFilter } from "../parsers/filterParser";
import type { ColumnMeta } from "./columns";

export type RelationKind = "hasMany" | "hasOne" | "belongsTo";

/** A relation as the query builder sees it: plain data, keys already resolved. */
export interface RelationSpec {
  kind: RelationKind;
  /** The related table: its name and its columns' metadata. */
  target: { name: string; columns: Record<string, { meta: Readonly<ColumnMeta> }> };
  /** hasMany / hasOne: the related table's column; belongsTo: this table's column. */
  foreignKey: string;
  /** hasMany / hasOne: this table's column; belongsTo: the related table's column. */
  key: string;
}

export interface IncludeOptions {
  /** Only the related rows matching this filter. */
  where?: Record<string, unknown>;
  /** Order of the related rows (hasMany) or which one is taken (hasOne). */
  sort?: Record<string, unknown>;
  /** hasMany: at most this many related rows per parent row. */
  limit?: number;
}

const BINARY = /^(BLOB|RAW|LONG RAW)\b/i;
const SCALED_NUMBER = /^NUMBER\(\s*\d+\s*,\s*[1-9]\d*\s*\)/i;
const DATE_TYPE = /^(DATE|TIMESTAMP)\b/i;

const fail = (why: string): never => {
  throw new Error(`[include] ${why}`);
};

/** The JSON object for one related row (alias `i`). */
function jsonObject(spec: RelationSpec): string {
  const pairs = Object.entries(spec.target.columns)
    .filter(([, c]) => !BINARY.test(c.meta.type))
    .map(([col, c]) => {
      const ref = `i.${quoteIdentifier(col)}`;
      if (c.meta.json === "text") return `KEY ${quoteLiteral(col)} VALUE ${ref} FORMAT JSON`; // the document itself, not its text
      return `KEY ${quoteLiteral(col)} VALUE ${SCALED_NUMBER.test(c.meta.type) ? `TO_CHAR(${ref})` : ref}`;
    });
  return `JSON_OBJECT(${pairs.join(", ")} NULL ON NULL RETURNING CLOB)`;
}

/** A column name as a SQL string literal (KEY '...'). Quotes are doubled. */
const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The correlated subquery for one included relation.
 * @param parentAlias the parent table's alias in the outer query ("t0")
 * @param bindPrefix keeps this subquery's bind names apart from the outer query's
 */
function buildIncludeSQL(spec: RelationSpec, as: string, options: IncludeOptions, parentAlias: string, bindPrefix: string): { sql: string; binds: Record<string, unknown> } {
  const { where, sort, limit } = options;
  if (limit !== undefined && spec.kind !== "hasMany") fail(`${as}: limit applies to hasMany relations only.`);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) fail(`${as}: limit must be a positive integer, got ${String(limit)}.`);
  if (sort !== undefined && spec.kind === "belongsTo") fail(`${as}: a belongsTo relation has one row; sort does not apply.`);
  for (const col of Object.keys(sort ?? {})) if (!(col in spec.target.columns)) fail(`${as}: ${spec.target.name} has no column ${col} to sort on.`);

  const table = quoteIdentifier(spec.target.name);
  const join = `i.${quoteIdentifier(spec.kind === "belongsTo" ? spec.key : spec.foreignKey)} = ${parentAlias}.${quoteIdentifier(spec.kind === "belongsTo" ? spec.foreignKey : spec.key)}`;
  // A soft-deleting related table (t.deletedAt()): its deleted rows are not included.
  const deletedAt = Object.entries(spec.target.columns).find(([, c]) => c.meta.role === "deletedAt")?.[0];
  let whereSql = deletedAt ? ` AND i.${quoteIdentifier(deletedAt)} IS NULL` : "";
  let binds: Record<string, unknown> = {};
  if (where && Object.keys(where).length > 0) {
    const parsed = parseFilter(where, "i");
    const renamed = renameBinds(parsed.whereClause, parsed.binds, bindPrefix);
    whereSql += ` AND (${renamed.sql.replace(/^\s*WHERE\s+/i, "")})`;
    binds = renamed.binds;
  }
  const orderBy = sort && Object.keys(sort).length > 0 ? Object.entries(sort).map(([c, d]) => `i.${sortTerm(c, d)}`).join(", ") : "";

  let sql: string;
  if (spec.kind === "belongsTo") {
    sql = `(SELECT ${jsonObject(spec)} FROM ${table} i WHERE ${join}${whereSql})`;
  } else if (spec.kind === "hasOne") {
    sql = `(SELECT ${jsonObject(spec)} FROM ${table} i WHERE ${join}${whereSql}${orderBy ? ` ORDER BY ${orderBy}` : ""} FETCH FIRST 1 ROWS ONLY)`;
  } else if (limit === undefined) {
    sql = `(SELECT JSON_ARRAYAGG(${jsonObject(spec)}${orderBy ? ` ORDER BY ${orderBy}` : ""} RETURNING CLOB) FROM ${table} i WHERE ${join}${whereSql})`;
  } else {
    // Number the related rows in an inline view, keep the first `limit`. The inner
    // rows are aliased i too, so the filter and the sort read the same columns.
    const rn = quoteIdentifier("MIRA_RN");
    const inner = `SELECT i.*, ROW_NUMBER() OVER (ORDER BY ${orderBy || "i.ROWID"}) AS ${rn} FROM ${table} i WHERE ${join}${whereSql}`;
    sql = `(SELECT JSON_ARRAYAGG(${jsonObject(spec)} ORDER BY i.${rn} RETURNING CLOB) FROM (${inner}) i WHERE i.${rn} <= ${limit})`;
  }
  return { sql: `${sql} AS ${quoteIdentifier(as)}`, binds };
}

/** One related row from JSON: date columns back to Date (no zone in the text = UTC, as Mira reads them). */
function decodeRow(spec: RelationSpec, row: Record<string, unknown>): Record<string, unknown> {
  for (const [col, c] of Object.entries(spec.target.columns)) {
    const v = row[col];
    if (typeof v === "string" && DATE_TYPE.test(c.meta.type)) row[col] = new Date(/(Z|[+-]\d\d:\d\d)$/.test(v) ? v : `${v}Z`);
  }
  return row;
}

/** The included column's value as the caller gets it: an array (hasMany) or an object / null. */
function decodeIncluded(spec: RelationSpec, value: unknown): unknown {
  if (value == null) return spec.kind === "hasMany" ? [] : null;
  const parsed = JSON.parse(String(value)) as unknown;
  return spec.kind === "hasMany" ? (parsed as Record<string, unknown>[]).map((r) => decodeRow(spec, r)) : decodeRow(spec, parsed as Record<string, unknown>);
}

export { buildIncludeSQL, decodeIncluded };
