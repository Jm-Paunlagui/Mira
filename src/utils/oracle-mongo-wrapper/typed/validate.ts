/**
 * ============================================================================
 * typed/validate.ts — checks derived from a table definition (Mira 2.1)
 * ============================================================================
 *
 * defineTable(name, columns, { validate: true }) checks every insert and update
 * in JavaScript, before any SQL, against what the columns say:
 *
 *   - an unknown column, or a value for a column Oracle generates (identity)
 *   - a required column left out of an insert (not nullable, no DEFAULT)
 *   - null for a column that is not nullable (insert, $set, $unset)
 *   - the value's kind: a number for NUMBER (an integer when the scale is 0),
 *     a decimal string or number for money / decimal, a string for text, a
 *     valid Date for DATE / TIMESTAMP, a Buffer for BLOB / RAW
 *   - the size: integer digits within NUMBER(p, s), and VARCHAR2(n) / CHAR(n)
 *     in bytes (UTF-8, as Oracle stores them) or in characters for "n CHAR"
 *
 * Every problem is collected, so one error lists them all. Paths into JSON
 * columns ("DOC.a") and the JSON documents themselves are not checked here;
 * Oracle's IS JSON check guards those.
 * ============================================================================
 */

import type { ColumnMeta } from "./columns";

type Metas = Readonly<Record<string, { meta: Readonly<ColumnMeta> }>>;

/** One problem: the column and what is wrong with its value. */
export interface ValidationIssue {
  column: string;
  message: string;
}

/** Thrown by a table defined with { validate: true }. `issues` lists every problem found. */
export class MiraValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  constructor(table: string, operation: string, issues: ValidationIssue[]) {
    super(`[${table}] ${operation} is not valid: ${issues.map((i) => `${i.column} ${i.message}`).join("; ")}.`);
    this.name = "MiraValidationError";
    this.issues = Object.freeze(issues.map((i) => Object.freeze({ ...i })));
  }
}

const NUMBER = /^NUMBER(?:\(\s*(\d+)\s*(?:,\s*(-?\d+)\s*)?\))?/i;
const TEXT = /^(?:N?VARCHAR2|N?CHAR)\(\s*(\d+)\s*(BYTE|CHAR)?\s*\)/i;
const CLOB = /^N?CLOB\b/i;
const BINARY = /^(?:BLOB|RAW|LONG RAW)\b/i;
const DATE = /^(?:DATE|TIMESTAMP)\b/i;
const DECIMAL_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/** What is wrong with one non-null value for a column, or null when it fits. */
function checkValue(meta: Readonly<ColumnMeta>, value: unknown): string | null {
  if (meta.json) return null;
  const type = meta.type;
  const num = NUMBER.exec(type);
  if (num) {
    const precision = num[1] === undefined ? undefined : Number(num[1]);
    const scale = num[2] === undefined ? (precision === undefined ? undefined : 0) : Number(num[2]);
    let text: string;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return `must be a finite number, got ${String(value)}`;
      if (scale === 0 && !Number.isInteger(value)) return `must be a whole number, got ${value}`;
      text = String(Math.abs(value));
    } else if (typeof value === "string" && scale !== undefined && scale > 0) {
      if (!DECIMAL_TEXT.test(value.trim())) return `must be a decimal number, got "${value.slice(0, 40)}"`;
      text = value.trim().replace(/^[+-]/, "");
    } else {
      return `must be a number${scale !== undefined && scale > 0 ? " or a decimal string" : ""}, got ${describe(value)}`;
    }
    if (precision !== undefined && scale !== undefined && !/e/i.test(text)) {
      const digits = text.split(".")[0].replace(/^0+/, "").length;
      const allowed = Math.max(precision - scale, 0);
      if (digits > allowed) return `has ${digits} digits before the decimal point; ${type} allows ${allowed}`;
    }
    return null;
  }
  const txt = TEXT.exec(type);
  if (txt) {
    if (typeof value !== "string") return `must be a string, got ${describe(value)}`;
    const limit = Number(txt[1]);
    const chars = txt[2]?.toUpperCase() === "CHAR";
    const size = chars ? [...value].length : Buffer.byteLength(value, "utf8");
    if (size > limit) return `is ${size} ${chars ? "characters" : "bytes"} long; ${type} allows ${limit}`;
    return null;
  }
  if (CLOB.test(type)) return typeof value === "string" ? null : `must be a string, got ${describe(value)}`;
  if (BINARY.test(type)) return Buffer.isBuffer(value) ? null : `must be a Buffer, got ${describe(value)}`;
  if (DATE.test(type)) {
    if (!(value instanceof Date)) return `must be a Date, got ${describe(value)}`;
    return Number.isNaN(value.getTime()) ? "must be a valid Date, got an invalid one" : null;
  }
  return null; // t.raw() types: Oracle checks them
}

function describe(value: unknown): string {
  if (value instanceof Date) return "a Date";
  if (Buffer.isBuffer(value)) return "a Buffer";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return `the string "${value.slice(0, 40)}"`;
  return typeof value === "object" ? "an object" : `${typeof value} ${String(value)}`;
}

const generated = (meta: Readonly<ColumnMeta>) => meta.identity;
const required = (meta: Readonly<ColumnMeta>) => !meta.nullable && meta.default === undefined && !meta.identity && !/\bAS IDENTITY\b/i.test(meta.type);

/** Problems with a document for insertOne / insertMany. */
function insertIssues(columns: Metas, doc: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [k, v] of Object.entries(doc)) {
    const c = columns[k];
    if (!c) issues.push({ column: k, message: "is not a column of this table" });
    else if (v === undefined) continue;
    else if (generated(c.meta)) issues.push({ column: k, message: "is generated by Oracle and cannot be set" });
    else if (v === null) {
      if (!c.meta.nullable) issues.push({ column: k, message: "cannot be null" });
    } else {
      const why = checkValue(c.meta, v);
      if (why) issues.push({ column: k, message: why });
    }
  }
  for (const [k, c] of Object.entries(columns)) if (required(c.meta) && doc[k] === undefined) issues.push({ column: k, message: "is required" });
  return issues;
}

/** Problems with an update document ($set, $unset, $inc, $mul, $min, $max). */
function updateIssues(columns: Metas, update: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const known = (k: string) => {
    if (k.includes(".") && columns[k.split(".")[0]]?.meta.json) return null; // a JSON path
    const c = columns[k];
    if (!c) issues.push({ column: k, message: "is not a column of this table" });
    else if (generated(c.meta)) issues.push({ column: k, message: "is generated by Oracle and cannot be set" });
    else return c;
    return null;
  };
  for (const [op, fields] of Object.entries(update)) {
    if (!fields || typeof fields !== "object") continue;
    for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
      if (op === "$push" || op === "$pull" || op === "$rename") continue;
      const c = known(k);
      if (!c) continue;
      if (op === "$unset") {
        if (!c.meta.nullable) issues.push({ column: k, message: "cannot be unset: it is not nullable" });
      } else if (op === "$inc" || op === "$mul") {
        if (typeof v !== "number" || !Number.isFinite(v)) issues.push({ column: k, message: `${op} needs a finite number, got ${describe(v)}` });
      } else if (op === "$set" || op === "$min" || op === "$max") {
        if (v === null) {
          if (!c.meta.nullable) issues.push({ column: k, message: "cannot be null" });
        } else if (v !== undefined) {
          const why = checkValue(c.meta, v);
          if (why) issues.push({ column: k, message: why });
        }
      }
    }
  }
  return issues;
}

function validateInsert(table: string, columns: Metas, doc: Record<string, unknown>): void {
  const issues = insertIssues(columns, doc);
  if (issues.length > 0) throw new MiraValidationError(table, "insert", issues);
}

function validateUpdate(table: string, columns: Metas, update: Record<string, unknown>): void {
  const issues = updateIssues(columns, update);
  if (issues.length > 0) throw new MiraValidationError(table, "update", issues);
}

export { validateInsert, validateUpdate, checkValue };
