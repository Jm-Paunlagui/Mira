/**
 * ============================================================================
 * parsers/jsonPath.ts — JSON columns in filters and updates (Mira 2.1)
 * ============================================================================
 *
 * A filter or update key with a dot is a path into a JSON column, as in MongoDB:
 *
 *   { "DOC.address.city": "Cebu" }               JSON_VALUE("DOC", '$.address.city' RETURNING VARCHAR2(4000)) = :b
 *   { "DOC.total": { $gt: 100 } }                JSON_VALUE("DOC", '$.total' RETURNING NUMBER) > :b
 *   { "DOC.note": { $exists: false } }           NOT JSON_EXISTS("DOC", '$.note')
 *   { "DOC.items": { $elemMatch: { sku: "X", qty: { $gt: 2 } } } }
 *                                                JSON_EXISTS("DOC", '$.items[*]?(@.sku == $p0 && @.qty > $p1)' PASSING …)
 *
 *   { $set: { "DOC.address.city": "Davao" } }    "DOC" = JSON_MERGEPATCH("DOC", '{"address":{"city":"Davao"}}')
 *   { $unset: { "DOC.note": 1 } }                … merge patch {"note": null}
 *   { $push: { "DOC.tags": "new" } }             the array rebuilt with JSON_TABLE + the new value
 *   { $pull: { "DOC.tags": "old" } }             the array rebuilt without the value
 *
 * Only functions Oracle 19c has are used (JSON_TRANSFORM is 21c+), so the same
 * SQL runs on 19c and 23ai, for JSON text (CLOB / VARCHAR2 IS JSON) and for the
 * 23ai JSON type. Every value is a bind; a path is checked segment by segment
 * (identifiers and array indexes only) before it is written into the SQL.
 * ============================================================================
 */

import { quoteIdentifier, bindSafe } from "../utils";
import { oracleMongoWrapperMessages as MSG } from "../../../constants/messages";

type Counter = { next: (prefix: string) => string };
type Binds = Record<string, unknown>;

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INDEX = /^\d+$/;

const fail = (why: string): never => {
  throw new Error(MSG.JSON_PATH_INVALID(why));
};

/** "DOC.address.city" → { column: "DOC", segments: ["address", "city"] }. */
function splitPath(field: string): { column: string; segments: string[] } {
  const [column, ...segments] = field.split(".");
  if (!column) fail(`"${field}" has no column before the first dot`);
  for (const s of segments) if (!KEY.test(s) && !INDEX.test(s)) fail(`"${field}": each part after the column must be a name (letters, digits, _) or an array index`);
  return { column, segments };
}

/** Segments as an SQL/JSON path: ["a", "0", "b"] → "$.a[0].b". Safe: segments are validated. */
function pathText(segments: string[]): string {
  return `$${segments.map((s) => (INDEX.test(s) ? `[${s}]` : `.${s}`)).join("")}`;
}

/** The JSON_VALUE return type that compares like the given value. */
function returning(sample: unknown): string {
  if (typeof sample === "number" || typeof sample === "bigint") return "NUMBER";
  if (sample instanceof Date) return "TIMESTAMP WITH TIME ZONE";
  return "VARCHAR2(4000)";
}

/** A value compared with JSON_VALUE text: booleans as JSON writes them. */
const scalarBind = (v: unknown) => (typeof v === "boolean" ? String(v) : v);

const COMPARE: Readonly<Record<string, string>> = Object.freeze({ $eq: "=", $ne: "<>", $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" });
const PATH_COMPARE: Readonly<Record<string, string>> = Object.freeze({ $eq: "==", $ne: "!=", $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" });

/** True when a filter value is an operator object ({ $gt: … }) rather than a value. */
const isOperators = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith("$"));

/**
 * A condition on a JSON path (`field` has a dot), or $elemMatch on a column / path.
 * Mirrors the column operators that make sense inside a document.
 */
function jsonFieldCondition(field: string, expr: unknown, binds: Binds, counter: Counter): string {
  const { column, segments } = splitPath(field);
  const col = quoteIdentifier(column);
  const path = pathText(segments);
  const bind = (v: unknown) => {
    const name = counter.next(`json_${bindSafe(field)}`);
    binds[name] = v;
    return `:${name}`;
  };
  const value = (sample: unknown) => `JSON_VALUE(${col}, '${path}' RETURNING ${returning(sample)})`;

  if (expr === null || expr === undefined) return `${value("")} IS NULL`;
  if (!isOperators(expr)) {
    if (typeof expr === "object" && !(expr instanceof Date)) fail(`${field}: compare a path with a scalar value, or use $elemMatch for arrays`);
    return `${value(expr)} = ${bind(scalarBind(expr))}`;
  }

  const parts: string[] = [];
  for (const [op, v] of Object.entries(expr)) {
    if (op in COMPARE) {
      if (v === null) parts.push(`${value("")} IS ${op === "$ne" ? "NOT " : ""}NULL`);
      else parts.push(`${value(v)} ${COMPARE[op]} ${bind(scalarBind(v))}`);
    } else if (op === "$in" || op === "$nin") {
      if (!Array.isArray(v) || v.length === 0) fail(`${field}: ${op} needs a non-empty list`);
      const list = (v as unknown[]).map((x) => bind(scalarBind(x))).join(", ");
      parts.push(`${value((v as unknown[])[0])} ${op === "$nin" ? "NOT " : ""}IN (${list})`);
    } else if (op === "$between") {
      if (!Array.isArray(v) || v.length !== 2) fail(`${field}: $between needs [low, high]`);
      const [lo, hi] = v as unknown[];
      parts.push(`${value(lo)} BETWEEN ${bind(scalarBind(lo))} AND ${bind(scalarBind(hi))}`);
    } else if (op === "$exists") {
      parts.push(`${v ? "" : "NOT "}JSON_EXISTS(${col}, '${path}')`);
    } else if (op === "$elemMatch") {
      parts.push(elemMatch(col, path, field, v, binds, counter));
    } else {
      fail(`${field}: ${op} is not supported on a JSON path (use $eq $ne $gt $gte $lt $lte $in $nin $between $exists $elemMatch)`);
    }
  }
  return parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`;
}

/**
 * $elemMatch: an element of the array at `path` satisfies every condition.
 * Conditions on element fields ({ sku: "X", qty: { $gt: 2 } }) or, for arrays of
 * scalars, operators on the element itself ({ $gte: 5 }). Values go through PASSING.
 */
function elemMatch(col: string, path: string, field: string, cond: unknown, binds: Binds, counter: Counter): string {
  if (cond === null || typeof cond !== "object" || Array.isArray(cond) || Object.keys(cond).length === 0) fail(`${field}: $elemMatch needs an object of conditions`);
  const passing: string[] = [];
  const literal = (v: unknown): string => {
    if (v === null) return "null";
    if (typeof v === "boolean") return String(v);
    if (typeof v !== "number" && typeof v !== "string" && !(v instanceof Date)) fail(`${field}: $elemMatch compares with strings, numbers, booleans, dates or null`);
    const name = counter.next(`json_${bindSafe(field)}`);
    binds[name] = v instanceof Date ? v.toISOString() : v;
    const variable = `p${passing.length}`;
    passing.push(`:${name} AS "${variable}"`);
    return `$${variable}`;
  };
  // A term is a filter condition, or the negation of one ($nin, $exists: false).
  type Term = { text: string; negated: boolean };
  const onTarget = (target: string, spec: unknown): Term[] => {
    if (!isOperators(spec)) {
      if (spec !== null && typeof spec === "object" && !(spec instanceof Date)) fail(`${field}: $elemMatch on a nested object needs dotted names ("a.b": …)`);
      return [{ text: `${target} == ${literal(spec)}`, negated: false }];
    }
    return Object.entries(spec).map(([op, v]) => {
      if (op in PATH_COMPARE) return { text: `${target} ${PATH_COMPARE[op]} ${literal(v)}`, negated: false };
      if (op === "$in" || op === "$nin") {
        if (!Array.isArray(v) || v.length === 0) fail(`${field}: ${op} needs a non-empty list`);
        return { text: `(${(v as unknown[]).map((x) => `${target} == ${literal(x)}`).join(" || ")})`, negated: op === "$nin" };
      }
      if (op === "$exists") return { text: `exists(${target})`, negated: !v };
      return fail(`${field}: ${op} is not supported in $elemMatch (use $eq $ne $gt $gte $lt $lte $in $nin $exists)`);
    });
  };
  const terms: Term[] = [];
  for (const [k, v] of Object.entries(cond as Record<string, unknown>)) {
    if (k.startsWith("$")) {
      terms.push(...onTarget("@", { [k]: v }));
      continue;
    }
    const segs = k.split(".");
    for (const s of segs) if (!KEY.test(s) && !INDEX.test(s)) fail(`${field}: $elemMatch field "${k}" must be names or indexes joined by dots`);
    terms.push(...onTarget(`@${pathText(segs).slice(1)}`, v));
  }
  const pass = passing.length ? ` PASSING ${passing.join(", ")}` : "";
  const positive = terms.filter((x) => !x.negated).map((x) => x.text);
  const negated = terms.filter((x) => x.negated).map((x) => x.text);
  if (negated.length === 0) return `JSON_EXISTS(${col}, '${path}[*]?(${positive.join(" && ")})'${pass})`;
  // 19c never treats a negated filter condition (`!(…)`, `!exists(…)`) as true, so a negation
  // becomes NOT JSON_EXISTS on one element at a time: each element is read wrapped ("[elem]"),
  // and `$[*]` is that element. TO_CLOB stops 19c rewriting JSON_EXISTS over a JSON_TABLE
  // column, which fails with ORA-31013. The same SQL runs on 19c and 23ai.
  const checks = [
    ...(positive.length > 0 ? [`JSON_EXISTS(TO_CLOB(e."E"), '$[*]?(${positive.join(" && ")})'${pass})`] : []),
    ...negated.map((n) => `NOT JSON_EXISTS(TO_CLOB(e."E"), '$[*]?(${n})'${pass})`),
  ];
  return `EXISTS (SELECT 1 FROM JSON_TABLE(${col}, '${path}[*]' COLUMNS ("E" CLOB FORMAT JSON WITH WRAPPER PATH '$')) e WHERE ${checks.join(" AND ")})`;
}

// ─── Updates ────────────────────────────────────────────────────────────────

/** Path updates gathered per column, then turned into one SET item each. */
interface ColumnUpdate {
  patch: Record<string, unknown>;
  arrays: Array<{ segments: string[]; push?: unknown[]; pull?: unknown[] }>;
}

/** Put `value` at `segments` in a nested merge-patch object. */
function setIn(patch: Record<string, unknown>, segments: string[], value: unknown, field: string) {
  let node = patch;
  segments.forEach((s, i) => {
    if (INDEX.test(s)) fail(`${field}: an update path cannot go through an array index (a merge patch replaces whole arrays); use $push / $pull, or $set the array`);
    if (i === segments.length - 1) {
      if (s in node) fail(`${field} is updated twice`);
      node[s] = value;
      return;
    }
    const next = node[s];
    if (next !== undefined && (next === null || typeof next !== "object")) fail(`${field} overlaps another update of the same document`);
    node = (node[s] ??= {}) as Record<string, unknown>;
  });
}

/**
 * Collects $set / $unset / $push / $pull on paths. parseUpdate hands every dotted
 * key (and every $push / $pull) here, then asks for the SET items.
 */
class JsonUpdates {
  private readonly columns = new Map<string, ColumnUpdate>();

  private of(column: string): ColumnUpdate {
    let u = this.columns.get(column);
    if (!u) this.columns.set(column, (u = { patch: {}, arrays: [] }));
    return u;
  }

  has(column: string): boolean {
    return this.columns.has(column);
  }

  set(field: string, value: unknown) {
    if (value === null || value === undefined) fail(`${field}: $set of null on a JSON path would delete the key (merge-patch rules); use $unset to remove it`);
    const { column, segments } = splitPath(field);
    setIn(this.of(column).patch, segments, value instanceof Date ? value.toISOString() : value, field);
  }

  unset(field: string) {
    const { column, segments } = splitPath(field);
    setIn(this.of(column).patch, segments, null, field);
  }

  push(field: string, value: unknown) {
    const { column, segments } = splitPath(field);
    const values = (isOperators(value) && "$each" in value ? value.$each : [value]) as unknown[];
    if (!Array.isArray(values) || values.length === 0) fail(`${field}: $push { $each } needs a non-empty list`);
    this.array(column, segments, field).push = values;
  }

  pull(field: string, value: unknown) {
    const { column, segments } = splitPath(field);
    const values = (isOperators(value) && "$in" in value ? value.$in : [value]) as unknown[];
    if (!Array.isArray(values) || values.length === 0) fail(`${field}: $pull { $in } needs a non-empty list`);
    for (const v of values) if (v !== null && typeof v === "object") fail(`${field}: $pull removes strings, numbers, booleans or null (by value)`);
    this.array(column, segments, field).pull = values;
  }

  private array(column: string, segments: string[], field: string) {
    for (const s of segments) if (INDEX.test(s)) fail(`${field}: $push / $pull need a path of names, not array indexes`);
    const u = this.of(column);
    if (u.arrays.some((a) => a.segments.join(".") === segments.join("."))) fail(`${field} is updated twice`);
    const entry = { segments };
    u.arrays.push(entry);
    return entry as { segments: string[]; push?: unknown[]; pull?: unknown[] };
  }

  /** The SET items: `"DOC" = JSON_MERGEPATCH(…)`, one per column. */
  setItems(binds: Binds, counter: Counter): string[] {
    const items: string[] = [];
    for (const [column, u] of this.columns) {
      const col = quoteIdentifier(column);
      const bind = (v: unknown) => {
        const name = counter.next(`json_${column}`);
        binds[name] = v;
        return `:${name}`;
      };
      // Start from the document as text: merging into the 23ai JSON type directly made 23.26
      // store a binary format (OSON v2) node-oracledb 7 cannot read back (NJS-126).
      let expr = `JSON_SERIALIZE(${col} RETURNING CLOB)`;
      if (Object.keys(u.patch).length > 0) expr = `JSON_MERGEPATCH(${expr}, ${bind(JSON.stringify(u.patch))} RETURNING CLOB)`;
      for (const a of u.arrays) {
        // Rebuild the array from the stored one (the row's value before this UPDATE).
        // Each element as JSON text. 19c returns NULL for a scalar element in a FORMAT JSON column
        // (JSON_ARRAYAGG then drops it), so read it wrapped ("[\"a\"]") and strip the brackets.
        const elements = `JSON_TABLE(${col}, '${pathText(a.segments)}[*]' COLUMNS ("O" FOR ORDINALITY, "W" CLOB FORMAT JSON WITH WRAPPER PATH '$', "S" VARCHAR2(4000) PATH '$')) j`;
        const keep = a.pull ? ` WHERE j."S" IS NULL OR j."S" NOT IN (${a.pull.map((v) => bind(v === null ? null : String(v))).join(", ")})` : "";
        const added = (a.push ?? []).map((v, i) => ` UNION ALL SELECT TO_CLOB(${bind(JSON.stringify(v instanceof Date ? v.toISOString() : v))}), ${1e15 + i} FROM DUAL`).join("");
        const rebuilt = `NVL((SELECT JSON_ARRAYAGG(x."V" FORMAT JSON ORDER BY x."O" RETURNING CLOB) FROM (SELECT SUBSTR(j."W", 2, LENGTH(j."W") - 2) "V", j."O" FROM ${elements}${keep}${added}) x), TO_CLOB('[]'))`;
        // Wrap it in objects up to the column: {"a":{"tags":[…]}} as a merge patch.
        const patch = a.segments.reduceRight((inner, s, i) => `JSON_OBJECT('${s}' VALUE ${inner} FORMAT JSON RETURNING CLOB)`, rebuilt);
        expr = a.segments.length === 0 ? rebuilt : `JSON_MERGEPATCH(${expr}, ${patch} RETURNING CLOB)`;
      }
      items.push(`${col} = ${expr}`);
    }
    return items;
  }
}

export { jsonFieldCondition, splitPath, pathText, JsonUpdates, isOperators };
