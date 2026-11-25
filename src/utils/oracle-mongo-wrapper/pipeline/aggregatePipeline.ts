

/**
 * ============================================================================
 * aggregatePipeline.js — MongoDB Aggregation Pipeline → Oracle SQL
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   Translates a MongoDB-style aggregation pipeline (an array of stages)
 *   into Oracle SQL using CTE chaining (WITH ... AS).
 *
 * HOW IT WORKS:
 *   Each pipeline stage becomes one CTE. The output of one stage feeds
 *   into the next, like a conveyor belt:
 *
 *   pipeline: [$match, $group, $sort, $limit]
 *       ↓
 *   WITH "stage_0" AS (SELECT * FROM "orders" WHERE ...),
 *        "stage_1" AS (SELECT region, SUM(amount) FROM "stage_0" GROUP BY region),
 *        "stage_2" AS (SELECT * FROM "stage_1" ORDER BY ...)
 *   SELECT * FROM "stage_2" FETCH FIRST 5 ROWS ONLY
 *
 * SUPPORTED STAGES:
 *   $match       → WHERE clause (filter rows)
 *   $group       → GROUP BY with aggregate functions (SUM, AVG, COUNT, etc.)
 *   $sort        → ORDER BY
 *   $limit       → FETCH FIRST N ROWS ONLY
 *   $skip        → OFFSET N ROWS
 *   $count       → SELECT COUNT(*) AS name
 *   $project     → Select/transform specific columns
 *   $addFields   → Add computed columns while keeping existing ones
 *   $lookup      → JOIN another table
 *   $lateralJoin → LATERAL join (correlated subquery as a join)
 *   $out         → INSERT into another table
 *   $merge       → MERGE INTO another table
 *   $bucket      → Group values into ranges (CASE WHEN)
 *   $facet       → Run multiple pipelines in parallel and combine results
 *   $replaceRoot → Change the document root
 *   $unwind      → (Basic support — passthrough for Oracle)
 *   $having      → (Pseudo-stage — attached to preceding $group)
 *
 * SUPPORTED AGGREGATE EXPRESSIONS (inside $group, $project, $addFields):
 *   $sum, $avg, $min, $max, $count, $first, $last
 *   $countDistinct, $median, $stdDevPop, $stdDevSamp, $percentile (2.1)
 *   $push, $addToSet (JSON arrays, returned as JS arrays), $listAgg (one string) (2.1)
 *   $add, $subtract, $mul, $divide (arithmetic)
 *   $concat, $toUpper, $toLower, $substr (string operations)
 *   $cond (conditional: CASE WHEN ... THEN ... ELSE ... END)
 *   $ifNull (COALESCE - use first non-null value)
 *   $dateToString (TO_CHAR with format)
 *   $window (analytic/window functions — see windowFunctions.js)
 *   $size (JSON_ARRAY_LENGTH)
 *
 * SPECIAL BEHAVIOR - $having:
 *   $having is NOT a real pipeline stage. A pre-scan detects it and attaches
 *   it to the preceding $group's _having property. This is because Oracle
 *   requires HAVING to be in the same query as GROUP BY.
 *
 * KEY FUNCTIONS:
 *   buildAggregateSQL()  → Main entry: pipeline[] → { sql, binds }
 *   _buildGroup()        → GROUP BY with aggregates + HAVING
 *   _buildAggExpr()      → Translates any aggregate expression → SQL
 *   _fieldRef()          → Convert "$column" → quoted column reference
 *   _fieldRefOrBind()    → Like _fieldRef but binds literal values
 *   _buildCondExpr()     → Build CASE WHEN conditions
 *   _buildProjectCols()  → Build SELECT columns for $project
 *   _buildAddFieldsCols() → Build extra columns for $addFields
 *   _buildLateralSub()   → Build LATERAL subquery
 *   _buildMergeStatement() → Wrap the pipeline in MERGE INTO for $merge
 *   _buildBucket()       → Build CASE-based grouping for $bucket
 *   _buildSortString()   → Build ORDER BY string
 * ============================================================================
 */

import { quoteIdentifier, renameBinds, sortTerm } from "../utils";
import { parseFilter } from "../parsers/filterParser";
import { splitPath, pathText } from "../parsers/jsonPath";
import { oracleMongoWrapperMessages as MSG } from "../../../constants/messages";

/** Column types a $jsonTable column may declare (written into the SQL, so checked). */
const JSON_TABLE_TYPE = /^(NUMBER(\(\d+(\s*,\s*\d+)?\))?|VARCHAR2\(\d+( CHAR)?\)|DATE|TIMESTAMP(\(\d\))?( WITH TIME ZONE)?|CLOB|JSON)$/i;

/**
 * Create a per-call counter for unique bind variable names.
 * Each buildAggregateSQL() call gets its own counter so parallel
 * calls never produce colliding bind names.
 *
 * @returns {{ next: (prefix: string) => string }}
 */
/** Bind-name generator shared by one pipeline build. */
type Counter = { next: (prefix: string) => string };
/**
 * An operand of the Mongo-style pipeline DSL ($group specs, $cond trees, $project
 * values, ...). Its shape depends on the operator and is checked by the builder
 * that reads it, so it stays `any` here (TypeScript rule 1: genuinely untyped).
 */
type DslSpec = any;

function _createCounter(): Counter {
  let c = 0;
  return {
    next(prefix) {
      return `${prefix}_${c++}`;
    },
  };
}

/**
 * Main entry point: convert an aggregation pipeline into Oracle SQL.
 *
 * @param {string} tableName - The base table name
 * @param {Array} pipeline - Array of stage objects (e.g. [{ $match: {...} }, ...])
 * @param {Object} db - db interface from createDb() (needed for oracledb constants)
 * @returns {{ sql: string, binds: Object, arrays?: Object }} The SQL, its bind variables and, when
 *   $push / $addToSet / $percentile (list of p) produce JSON arrays, those output
 *   columns ("array", or "set" to de-duplicate) for aggregate() to parse.
 *
 * @example
 *   const { sql, binds } = buildAggregateSQL("orders", [
 *     { $match: { status: "completed" } },
 *     { $group: { _id: "$region", total: { $sum: "$amount" } } },
 *   ], db);
 */
function buildAggregateSQL(tableName: string, pipeline: Array<any>, db: Record<string, unknown>, aliasPrefix = "", hoist?: Array<{ alias: string; sql: string }>, base?: Array<{ alias: string; sql: string; cols?: string[]; suffix?: string }>): { sql: string; binds: Record<string, unknown>; arrays?: Record<string, "array" | "set"> } {
  const counter = _createCounter();
  const ctes: Array<{ alias: string; sql: string }> = [];
  const allBinds: Record<string, unknown> = {};
  let prevSource = quoteIdentifier(tableName);
  let stageIdx = 0;
  let outTable: string | null = null;
  let mergeSpec: DslSpec = null;
  let hasMerge = false;
  // The most recent $sort: a following { $limit: { withTies } } repeats its ORDER BY.
  let lastSort: { idx: number; orderBy: string } | null = null;
  // Output columns holding a JSON array from $push / $addToSet / $percentile with a list of p.
  const arrays: Record<string, "array" | "set"> = {};

  // Pre-scan for $having — attach to preceding $group
  for (let i = 0; i < pipeline.length; i++) {
    if (pipeline[i].$having && i > 0 && pipeline[i - 1].$group) {
      pipeline[i - 1]._having = pipeline[i].$having;
      pipeline.splice(i, 1);
      i--;
    }
  }

  // Merge adjacent $match stages into a single $match with $and.
  // Fewer CTEs means the optimizer sees one WHERE clause instead of
  // chained single-predicate CTEs.
  for (let i = 0; i < pipeline.length - 1; i++) {
    if (pipeline[i].$match && pipeline[i + 1].$match) {
      pipeline[i] = {
        $match: { $and: [pipeline[i].$match, pipeline[i + 1].$match] },
      };
      pipeline.splice(i + 1, 1);
      i--;
    }
  }

  // Upper-case aliases the stages so far have produced ($group, $project …),
  // so a later $match can name them in the case the caller wrote them.
  const aliases = new Set<string>();

  // A stage built by its own parseFilter / QueryBuilder numbers its binds from 0,
  // so it can reuse a name an earlier stage already bound (two $match stages on
  // one column, a $lateralJoin subquery). Renaming on collision keeps each value.
  const addStageBinds = (sql: string, binds: Record<string, unknown>, prefix: string) => {
    const clash = Object.keys(binds).some((k) => k in allBinds);
    const out = clash ? renameBinds(sql, binds, prefix) : { sql, binds };
    Object.assign(allBinds, out.binds);
    return out.sql;
  };

  // A nested pipeline ($facet branch, $lookup.pipeline) cannot be a WITH inside this
  // statement's WITH (Oracle: ORA-32034). Its steps are hoisted into this WITH list,
  // named apart with a prefix, and only its final SELECT is used in place; its binds
  // are renamed if they clash with names already bound.
  const nested = (from: string, stages: unknown[], prefix: string, bindPrefix: string): string => {
    const inner: Array<{ alias: string; sql: string }> = [];
    const sub = buildAggregateSQL(from, stages as Array<any>, db, prefix, inner);
    const clash = Object.keys(sub.binds).some((k) => k in allBinds);
    const fix = (sql: string) => (clash ? renameBinds(sql, sub.binds, bindPrefix).sql : sql);
    for (const c of inner) ctes.push({ alias: c.alias, sql: fix(c.sql) });
    Object.assign(allBinds, clash ? renameBinds("", sub.binds, bindPrefix).binds : sub.binds);
    return fix(sub.sql);
  };

  for (const stage of pipeline) {
    const stageAlias = `${aliasPrefix}stage_${stageIdx}`;
    const key = Object.keys(stage).filter((k) => k !== "_having")[0];

    switch (key) {
      case "$match": {
        const { whereClause, binds } = parseFilter(_alignToAliases(stage.$match, aliases));
        const where = addStageBinds(whereClause, binds, `m${stageIdx}_`);
        ctes.push({
          alias: stageAlias,
          sql: `SELECT * FROM ${prevSource} ${where}`,
        });
        break;
      }

      case "$group": {
        const { sql, binds } = _buildGroup(
          stage.$group,
          prevSource,
          stage._having,
          counter,
        );
        Object.assign(allBinds, binds);
        ctes.push({ alias: stageAlias, sql });
        // Accumulators that return a JSON array: aggregate() parses these columns.
        for (const [k, acc] of Object.entries(stage.$group as Record<string, DslSpec>)) {
          if (k === "_id" || !acc || typeof acc !== "object") continue;
          const op = Object.keys(acc)[0];
          if (op in ARRAY_ACCUMULATORS) arrays[k.toUpperCase()] = ARRAY_ACCUMULATORS[op];
          else if (op === "$percentile" && Array.isArray(acc.$percentile?.p)) arrays[k.toUpperCase()] = "array";
          else delete arrays[k.toUpperCase()];
        }
        const id = stage.$group._id;
        for (const k of Object.keys(stage.$group)) if (k !== "_id") aliases.add(k.toUpperCase());
        if (id && typeof id === "object" && !id.$rollup && !id.$cube && !id.$groupingSets) for (const k of Object.keys(id)) aliases.add(k.toUpperCase());
        break;
      }

      case "$sort": {
        const orderBy = _buildSortString(stage.$sort);
        ctes.push({
          alias: stageAlias,
          sql: `SELECT * FROM ${prevSource} ORDER BY ${orderBy}`,
        });
        lastSort = { idx: stageIdx, orderBy };
        break;
      }

      case "$limit": {
        // $limit: n, or { n, withTies }. WITH TIES needs the ORDER BY in the same
        // SELECT (without it Oracle silently returns exactly n rows), so it repeats
        // the $sort directly before it — the rows it reads have that sort's columns.
        const spec = stage.$limit !== null && typeof stage.$limit === "object" ? stage.$limit : { n: stage.$limit };
        const n = spec.n;
        if (!(Number.isInteger(n) && n >= 0)) throw new TypeError(MSG.INVALID_ROW_COUNT("aggregatePipeline", "$limit", n));
        let sql = `SELECT * FROM ${prevSource} FETCH FIRST ${n} ROWS ONLY`;
        if (spec.withTies === true) {
          if (!lastSort || lastSort.idx !== stageIdx - 1) throw new Error(MSG.WITH_TIES_AFTER_SORT);
          sql = `SELECT * FROM ${prevSource} ORDER BY ${lastSort.orderBy} FETCH FIRST ${n} ROWS WITH TIES`;
        }
        ctes.push({ alias: stageAlias, sql });
        break;
      }

      case "$skip": {
        ctes.push({
          alias: stageAlias,
          sql: `SELECT * FROM ${prevSource} OFFSET ${Number(stage.$skip)} ROWS`,
        });
        break;
      }

      case "$count": {
        ctes.push({
          alias: stageAlias,
          sql: `SELECT COUNT(*) AS ${quoteIdentifier(stage.$count.toUpperCase())} FROM ${prevSource}`,
        });
        aliases.add(stage.$count.toUpperCase());
        break;
      }

      case "$project": {
        const { cols: projCols, binds: projBinds } = _buildProjectCols(
          stage.$project,
          counter,
        );
        Object.assign(allBinds, projBinds);
        ctes.push({
          alias: stageAlias,
          sql: `SELECT ${projCols} FROM ${prevSource}`,
        });
        _addComputedAliases(stage.$project, aliases);
        break;
      }

      case "$addFields": {
        const { sql: addCols, binds: addBinds } = _buildAddFieldsCols(
          stage.$addFields,
          counter,
        );
        Object.assign(allBinds, addBinds);
        ctes.push({
          alias: stageAlias,
          sql: `SELECT ${prevSource}.*, ${addCols} FROM ${prevSource}`,
        });
        _addComputedAliases(stage.$addFields, aliases);
        break;
      }

      case "$lookup": {
        const { buildJoinSQL } = (require("../joins/joinBuilder") as typeof import("../joins/joinBuilder"));
        const lk = stage.$lookup;
        if (lk && lk.pipeline !== undefined) {
          // Join the RESULT of a pipeline on `from` (e.g. a grouped total per key), not its rows.
          if (!Array.isArray(lk.pipeline)) throw new Error(MSG.PIPELINE_LOOKUP_PIPELINE);
          const subSql = nested(lk.from, lk.pipeline, `${stageAlias}_`, `lk${stageIdx}_`);
          // buildJoinSQL validates the join type, on and select; the placeholder table becomes the subquery.
          const joinSql = buildJoinSQL(prevSource, { ...lk, from: LOOKUP_SUB, as: lk.as ?? "SUB" });
          ctes.push({ alias: stageAlias, sql: joinSql.replace(quoteIdentifier(LOOKUP_SUB), () => `(${subSql})`) });
        } else {
          ctes.push({ alias: stageAlias, sql: buildJoinSQL(prevSource, lk) });
        }
        break;
      }

      case "$connectBy": {
        // The tree as a stage: CONNECT BY over the rows so far, so it can feed $lookup / $group.
        const { buildConnectBy } = (require("../advanced/oracleAdvanced") as typeof import("../advanced/oracleAdvanced"));
        const spec = stage.$connectBy;
        const built = buildConnectBy(prevSource.slice(1, -1).replace(/""/g, '"'), spec);
        ctes.push({ alias: stageAlias, sql: addStageBinds(built.sql, built.binds, `cb${stageIdx}_`) });
        if (spec?.includeLevel) aliases.add("LEVEL");
        for (const c of spec?.root == null ? [] : Array.isArray(spec.root) ? spec.root : [spec.root]) aliases.add(`ROOT_${String(c).toUpperCase()}`);
        break;
      }

      case "$jsonTable": {
        // One row per element of a JSON array, joined to its source row:
        // { $jsonTable: { column: "DOC", path: "items", columns: { SKU: "sku", QTY: { path: "qty", type: "NUMBER" } },
        //                 ordinality: "N", outer: true } }
        const jt = stage.$jsonTable ?? {};
        const bad = (why: string): never => {
          throw new Error(MSG.JSON_PATH_INVALID(`$jsonTable: ${why}`));
        };
        if (typeof jt.column !== "string" || jt.column === "") bad("column names the JSON column");
        if (!jt.columns || typeof jt.columns !== "object" || Object.keys(jt.columns).length === 0) bad("columns maps each output column to a path in the element");
        const arrayPath = jt.path === undefined || jt.path === "" ? "$" : pathText(splitPath(`x.${jt.path}`).segments);
        const cols = Object.entries(jt.columns as Record<string, DslSpec>).map(([name, spec]) => {
          const s = typeof spec === "string" ? { path: spec } : spec ?? {};
          if (typeof s.path !== "string" || s.path === "") bad(`${name}: give the path of the value in the element`);
          const type = s.type ?? "VARCHAR2(4000)";
          if (typeof type !== "string" || !JSON_TABLE_TYPE.test(type.trim())) bad(`${name}: type must be NUMBER[(p[,s])], VARCHAR2(n), DATE, TIMESTAMP[(n)] [WITH TIME ZONE], CLOB or JSON`);
          // "$" is the element itself (an array of plain values: ["tea", "water"]).
          const colPath = s.path === "$" ? "$" : pathText(splitPath(`x.${s.path}`).segments);
          const sqlType = type.trim().toUpperCase() === "JSON" ? "CLOB FORMAT JSON" : type.trim().toUpperCase();
          return `${quoteIdentifier(name)} ${sqlType} PATH '${colPath}'`;
        });
        if (jt.ordinality !== undefined) {
          if (typeof jt.ordinality !== "string" || jt.ordinality === "") bad("ordinality names the column numbering the elements");
          cols.unshift(`${quoteIdentifier(jt.ordinality)} FOR ORDINALITY`);
        }
        const table = `JSON_TABLE(${prevSource}.${quoteIdentifier(jt.column)}, '${arrayPath}[*]' COLUMNS (${cols.join(", ")})) "MIRA_JT"`;
        ctes.push({
          alias: stageAlias,
          // outer: true keeps source rows whose array is empty or missing (one row of NULLs).
          sql: jt.outer === true
            ? `SELECT ${prevSource}.*, "MIRA_JT".* FROM ${prevSource} LEFT OUTER JOIN ${table} ON 1 = 1`
            : `SELECT ${prevSource}.*, "MIRA_JT".* FROM ${prevSource}, ${table}`,
        });
        for (const name of Object.keys(jt.columns)) aliases.add(name.toUpperCase());
        break;
      }

      case "$lateralJoin": {
        const lj = stage.$lateralJoin;
        const built = _buildLateralSub(lj, prevSource);
        const subSql = addStageBinds(built.sql, built.binds, `lj${stageIdx}_`);
        ctes.push({
          alias: stageAlias,
          // outer: true keeps outer rows the subquery returns nothing for (OUTER APPLY),
          // e.g. an invoice in a currency with no rate yet.
          sql: lj.outer === true
            ? `SELECT ${prevSource}.*, ${quoteIdentifier(lj.as)}.* FROM ${prevSource} OUTER APPLY (${subSql}) ${quoteIdentifier(lj.as)}`
            : `SELECT ${prevSource}.*, ${quoteIdentifier(lj.as)}.* FROM ${prevSource}, LATERAL (${subSql}) ${quoteIdentifier(lj.as)}`,
        });
        break;
      }

      case "$out": {
        // Don't push a CTE — store the target table.
        // INSERT INTO is prepended to the final assembled SQL.
        outTable = stage.$out;
        break;
      }

      case "$merge": {
        // MERGE is a statement, not a row source: it must end the pipeline and
        // wraps everything before it (see _buildMergeStatement).
        if (pipeline[pipeline.length - 1] !== stage) throw new Error(MSG.PIPELINE_MERGE_INVALID("$merge must be the last stage"));
        mergeSpec = stage.$merge;
        hasMerge = true;
        continue;
      }

      case "$matchRecognize": {
        const { sql, binds, outputs } = _buildMatchRecognize(stage.$matchRecognize, prevSource, counter);
        Object.assign(allBinds, binds);
        ctes.push({ alias: stageAlias, sql });
        for (const o of outputs) aliases.add(o);
        break;
      }

      case "$bucket": {
        const { sql, binds } = _buildBucket(stage.$bucket, prevSource, counter);
        Object.assign(allBinds, binds);
        ctes.push({ alias: stageAlias, sql });
        break;
      }

      case "$facet": {
        // Each facet pipeline is a separate CTE, union all at end
        const facetCtes: string[] = [];
        let facetIdx = 0;
        for (const [facetName, facetPipeline] of Object.entries(stage.$facet as Record<string, unknown[]>)) {
          // Every facet numbers its binds from 0 (renamed on clash: f0_where_S_0 …) and its
          // steps are hoisted into this WITH list (see nested()).
          const sql = nested(prevSource.slice(1, -1).replace(/""/g, '"'), facetPipeline, `${stageAlias}_f${facetIdx}_`, `f${facetIdx}_`);
          facetIdx++;
          facetCtes.push(
            `SELECT '${facetName.replace(/'/g, "''")}' AS "facet_name", sub.* FROM (${sql}) sub`,
          );
        }
        ctes.push({
          alias: stageAlias,
          sql: facetCtes.join("\nUNION ALL\n"),
        });
        break;
      }

      case "$replaceRoot": {
        // Use the expression as the new root
        const newRoot = stage.$replaceRoot.newRoot;
        const fieldName =
          typeof newRoot === "string" && newRoot.startsWith("$")
            ? newRoot.substring(1)
            : null;
        if (fieldName) {
          ctes.push({
            alias: stageAlias,
            sql: `SELECT ${quoteIdentifier(fieldName)}.* FROM ${prevSource}`,
          });
        } else {
          ctes.push({
            alias: stageAlias,
            sql: `SELECT * FROM ${prevSource}`,
          });
        }
        break;
      }

      case "$unwind": {
        // Basic support: pass through (Oracle doesn't natively unwind arrays)
        ctes.push({
          alias: stageAlias,
          sql: `SELECT * FROM ${prevSource}`,
        });
        break;
      }

      case "$having":
        // Reached only when the pre-scan could not attach it to a preceding $group.
        throw new Error(MSG.PIPELINE_HAVING_WITHOUT_GROUP);

      default:
        // A typo ($mtach) silently skipped would turn a filtered query into a full read.
        throw new Error(MSG.PIPELINE_UNKNOWN_STAGE(key));
    }

    prevSource = quoteIdentifier(stageAlias);
    stageIdx++;
  }

  // Nested pipeline: hand its steps to the outer WITH, return only the final SELECT.
  if (hoist) {
    if (hasMerge || outTable) throw new Error(MSG.PIPELINE_NESTED_WRITE);
    hoist.push(...ctes.slice(0, -1));
    return { sql: ctes.length ? ctes[ctes.length - 1].sql : `SELECT * FROM ${quoteIdentifier(tableName)}`, binds: allBinds };
  }

  // Build final SQL: the SELECT the pipeline produces, after any base CTEs (a
  // recursive CTE or a series the pipeline runs on) and the stages before it.
  const finalSql = ctes.length ? ctes[ctes.length - 1].sql : `SELECT * FROM ${quoteIdentifier(tableName)}`;
  const withParts = [...(base ?? []), ...ctes.slice(0, -1)].map(
    (c: { alias: string; sql: string; cols?: string[]; suffix?: string }) => `${quoteIdentifier(c.alias)}${c.cols ? ` (${c.cols.map(quoteIdentifier).join(", ")})` : ""} AS (${c.sql})${c.suffix ?? ""}`,
  );
  let sql = withParts.length ? `WITH ${withParts.join(",\n     ")}\n${finalSql}` : finalSql;

  // … optionally written somewhere by $merge / $out.
  if (hasMerge) return { sql: _buildMergeStatement(mergeSpec, sql), binds: allBinds };
  if (outTable) sql = `INSERT INTO ${quoteIdentifier(outTable)} ${sql}`;
  return Object.keys(arrays).length ? { sql, binds: allBinds, arrays } : { sql, binds: allBinds };
}

/**
 * Rewrite a $match filter's field names to the upper-case aliases earlier stages
 * produced ($group, $project, $addFields and $count upper-case their aliases), so
 * `{ $match: { total: … } }` after `{ $group: { total: … } }` finds TOTAL. Names that
 * are not aliases, and operator keys, are left alone; $and / $or / $nor / $not recurse.
 */
function _alignToAliases(filter: Record<string, any>, aliases: Set<string>): Record<string, any> {
  if (aliases.size === 0 || !filter || typeof filter !== "object") return filter;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(filter)) {
    if ((k === "$and" || k === "$or" || k === "$nor") && Array.isArray(v)) out[k] = v.map((f) => _alignToAliases(f, aliases));
    else if (k === "$not") out[k] = _alignToAliases(v, aliases);
    else if (!k.startsWith("$") && !aliases.has(k) && aliases.has(k.toUpperCase())) out[k.toUpperCase()] = v;
    else out[k] = v;
  }
  return out;
}

/** Record the aliases a $project / $addFields stage computes (pass-through `col: 1` keeps its own name). */
function _addComputedAliases(spec: Record<string, any>, aliases: Set<string>): void {
  for (const [k, v] of Object.entries(spec)) if (v !== 1 && v !== 0 && v !== true && v !== false) aliases.add(k.toUpperCase());
}

/**
 * Build a GROUP BY clause with aggregate functions and optional HAVING.
 *
 * Supports special grouping modes:
 *   _id: null           → aggregate entire table (no GROUP BY)
 *   _id: "$field"       → group by a single column
 *   _id: { a: "$f1" }   → group by multiple columns with aliases
 *   _id: { $rollup: [] } → ROLLUP grouping
 *   _id: { $cube: [] }   → CUBE grouping
 *   _id: { $groupingSets: [] } → GROUPING SETS
 *
 * @param {Object} group - The $group stage value
 * @param {string} source - Previous CTE alias or table name
 * @param {Object} [having] - Optional HAVING conditions
 * @param {Object} counter - Bind variable counter
 * @returns {{ sql: string, binds: Object }}
 */
function _buildGroup(group: Record<string, DslSpec>, source: string, having: Record<string, DslSpec>, counter: Counter): { sql: string; binds: Record<string, unknown>; } {
  const binds: Record<string, unknown> = {};
  const selectParts: string[] = [];
  const groupByParts: string[] = [];

  // _id defines the GROUP BY columns
  const idSpec = group._id;

  if (idSpec === null) {
    // No grouping — aggregate over entire table
  } else if (typeof idSpec === "string") {
    const col = idSpec.startsWith("$") ? idSpec.substring(1) : idSpec;
    selectParts.push(`${quoteIdentifier(col)}`);
    groupByParts.push(quoteIdentifier(col));
  } else if (typeof idSpec === "object" && !Array.isArray(idSpec)) {
    // Check for $rollup, $cube, $groupingSets
    // grouping: true adds GROUPING_<col> (1 on a subtotal row for that column), so a
    // subtotal can be told from a group whose key really is NULL.
    const flags = (cols: string[]) => (idSpec.grouping === true ? cols.map((c) => `GROUPING(${quoteIdentifier(c)}) AS ${quoteIdentifier(`GROUPING_${c.toUpperCase()}`)}`) : []);
    if (idSpec.$rollup) {
      const cols = idSpec.$rollup.map((c: string) => quoteIdentifier(c));
      selectParts.push(...idSpec.$rollup.map(quoteIdentifier));
      groupByParts.push(`ROLLUP(${cols.join(", ")})`);
      selectParts.push(...flags(idSpec.$rollup));
    } else if (idSpec.$cube) {
      const cols = idSpec.$cube.map((c: string) => quoteIdentifier(c));
      selectParts.push(...idSpec.$cube.map(quoteIdentifier));
      groupByParts.push(`CUBE(${cols.join(", ")})`);
      selectParts.push(...flags(idSpec.$cube));
    } else if (idSpec.$groupingSets) {
      const sets = idSpec.$groupingSets.map((set: string[]) => {
        if (Array.isArray(set) && set.length === 0) return "()";
        if (Array.isArray(set))
          return `(${set.map(quoteIdentifier).join(", ")})`;
        return quoteIdentifier(set);
      });
      // Collect all unique columns
      const allCols = new Set<string>();
      idSpec.$groupingSets.forEach((set: string[]) => {
        if (Array.isArray(set)) set.forEach((c) => allCols.add(c));
        else if (set) allCols.add(set);
      });
      selectParts.push(...[...allCols].map(quoteIdentifier));
      groupByParts.push(`GROUPING SETS(${sets.join(", ")})`);
      selectParts.push(...flags([...allCols]));
    } else {
      // Regular object — { alias: '$field', ... }
      for (const [alias, fieldRef] of Object.entries(idSpec)) {
        const col =
          typeof fieldRef === "string" && fieldRef.startsWith("$")
            ? fieldRef.substring(1)
            : alias;
        selectParts.push(
          `${quoteIdentifier(col)} AS ${quoteIdentifier(alias.toUpperCase())}`,
        );
        groupByParts.push(quoteIdentifier(col));
      }
    }
  }

  // Aggregate expressions
  const aliasToExpr: Record<string, unknown> = {};
  for (const [alias, expr] of Object.entries(group)) {
    if (alias === "_id") continue;
    const aggSql = _buildAggExpr(expr, binds, counter);
    aliasToExpr[alias] = aggSql;
    selectParts.push(`${aggSql} AS ${quoteIdentifier(alias.toUpperCase())}`);
  }

  let sql = `SELECT ${selectParts.join(", ")} FROM ${source}`;
  if (groupByParts.length > 0) {
    sql += ` GROUP BY ${groupByParts.join(", ")}`;
  }

  // HAVING
  if (having) {
    const havingParts: string[] = [];
    for (const [col, cond] of Object.entries(having)) {
      // Use the aggregate expression instead of the alias
      const aggExpr = aliasToExpr[col] || quoteIdentifier(col.toUpperCase());
      if (typeof cond === "object") {
        for (const [op, val] of Object.entries(cond)) {
          const bname = counter.next("having");
          binds[bname] = val;
          const sqlOp =
            {
              $gt: ">",
              $gte: ">=",
              $lt: "<",
              $lte: "<=",
              $eq: "=",
              $ne: "<>",
            }[op] || "=";
          havingParts.push(`${aggExpr} ${sqlOp} :${bname}`);
        }
      }
    }
    if (havingParts.length > 0) {
      sql += ` HAVING ${havingParts.join(" AND ")}`;
    }
  }

  return { sql, binds };
}

/**
 * Translate a MongoDB aggregate expression into Oracle SQL.
 *
 * This handles all the $ operators used inside $group, $project, $addFields:
 *   { $sum: "$amount" }  → SUM("amount")
 *   { $avg: "$price" }   → AVG("price")
 *   { $cond: { if: {...}, then: X, else: Y } } → CASE WHEN ... THEN X ELSE Y END
 *   etc.
 *
 * @param {Object} expr - The expression object (e.g. { $sum: "$amount" })
 * @param {Object} binds - Bind variables accumulator (mutated)
 * @param {Object} counter - Bind name counter
 * @returns {string} Oracle SQL expression
 */
function _buildAggExpr(expr: Record<string, DslSpec>, binds: Record<string, unknown>, counter: Counter): string {
  if (typeof expr === "object") {
    for (const [op, val] of Object.entries(expr)) {
      // Aggregates take a column ("$A"), "*", or any expression ({ $mul: [...] }).
      const one = (v: DslSpec) => _one(v, binds, counter);
      const arg = (v: DslSpec) => _fieldRefOrBind(v, binds, counter);
      const list = (v: DslSpec, min: number) => {
        if (!Array.isArray(v) || v.length < min) throw new Error(MSG.PIPELINE_EXPRESSION_ARGS(op, `a list of at least ${min} values`));
        return v.map(arg);
      };
      switch (op) {
        // ── 2.1 statistics: each takes "$COL" / an expression, or { input, ...options } ──
        case "$countDistinct":
          return `COUNT(DISTINCT ${one(_accInput(op, val).input)})`;
        case "$median":
          return `MEDIAN(${one(_accInput(op, val).input)})`;
        case "$stdDevPop":
          return `STDDEV_POP(${one(_accInput(op, val).input)})`;
        case "$stdDevSamp":
          return `STDDEV_SAMP(${one(_accInput(op, val).input)})`;
        case "$push":
        case "$addToSet": {
          // A JSON array the caller gets back as a JS array (aggregate() parses the
          // columns buildAggregateSQL flags). NULL ON NULL keeps NULLs, as MongoDB does;
          // $addToSet de-duplicates after parsing, because 19c's JSON_ARRAYAGG has no DISTINCT.
          const { input, orderBy } = _accInput(op, val);
          return `JSON_ARRAYAGG(${one(input)}${_accOrder(orderBy, " ")} NULL ON NULL RETURNING CLOB)`;
        }
        case "$listAgg": {
          const { input, orderBy, separator = ",", distinct } = _accInput(op, val);
          if (typeof separator !== "string") throw new Error(MSG.ACCUMULATOR_INVALID(op, "separator must be a string"));
          const value = one(input);
          const within = orderBy ? _accOrder(orderBy, "") : `ORDER BY ${value}`;
          return `LISTAGG(${distinct === true ? "DISTINCT " : ""}${value}, ${_bindValue(separator, binds, counter)}) WITHIN GROUP (${within})`;
        }
        case "$percentile": {
          const { input, p, method = "continuous" } = _accInput(op, val);
          if (method !== "continuous" && method !== "discrete") throw new Error(MSG.ACCUMULATOR_INVALID(op, 'method must be "continuous" or "discrete"'));
          const ps = Array.isArray(p) ? p : [p];
          // p is written into the SQL (Oracle wants a constant), so it must be a number in [0, 1].
          if (ps.length === 0 || !ps.every((x) => typeof x === "number" && x >= 0 && x <= 1)) {
            throw new Error(MSG.ACCUMULATOR_INVALID(op, "p must be a number from 0 to 1, or a non-empty list of them"));
          }
          const fn = method === "discrete" ? "PERCENTILE_DISC" : "PERCENTILE_CONT";
          const value = one(input);
          const terms = ps.map((x) => `${fn}(${x}) WITHIN GROUP (ORDER BY ${value})`);
          return Array.isArray(p) ? `JSON_ARRAY(${terms.join(", ")})` : terms[0];
        }
        case "$sum":
          return `SUM(${one(val)})`;
        case "$avg":
          return `AVG(${one(val)})`;
        case "$min":
          // A list compares values in the row (LEAST); a single value aggregates rows (MIN).
          return Array.isArray(val) ? `LEAST(${list(val, 2).join(", ")})` : `MIN(${one(val)})`;
        case "$max":
          return Array.isArray(val) ? `GREATEST(${list(val, 2).join(", ")})` : `MAX(${one(val)})`;
        case "$count":
          return `COUNT(${val === "*" ? "*" : one(val)})`;
        case "$first":
          return `MIN(${one(val)})`;
        case "$last":
          return `MAX(${one(val)})`;
        case "$mul":
          return Array.isArray(val) ? `(${val.map(arg).join(" * ")})` : one(val);
        case "$add":
          return Array.isArray(val) ? `(${val.map(arg).join(" + ")})` : one(val);
        case "$subtract":
          return Array.isArray(val) ? `(${val.map(arg).join(" - ")})` : one(val);
        case "$divide":
          return Array.isArray(val) ? `(${val.map(arg).join(" / ")})` : one(val);
        case "$mod": {
          const [a, b] = list(val, 2);
          return `MOD(${a}, ${b})`;
        }
        case "$abs":
          return `ABS(${one(val)})`;
        case "$ceil":
          return `CEIL(${one(val)})`;
        case "$floor":
          return `FLOOR(${one(val)})`;
        case "$round":
        case "$trunc": {
          const fn = op === "$round" ? "ROUND" : "TRUNC";
          if (!Array.isArray(val)) return `${fn}(${one(val)})`;
          return `${fn}(${arg(val[0])}${val.length > 1 ? `, ${arg(val[1])}` : ""})`;
        }
        case "$literal":
          return _bindValue(val, binds, counter);
        case "$concat": {
          if (Array.isArray(val)) {
            // "$col" is a column; any other string/number is a literal and is bound.
            return val.map(arg).join(" || ");
          }
          return one(val);
        }
        case "$toUpper":
          return `UPPER(${one(val)})`;
        case "$toLower":
          return `LOWER(${one(val)})`;
        case "$substr": {
          if (Array.isArray(val)) {
            return `SUBSTR(${one(val[0])}, ${Number(val[1])}, ${Number(val[2])})`;
          }
          return one(val);
        }
        case "$dateToString": {
          const fmt = (val.format || "YYYY-MM-DD").replace(/'/g, "''");
          return `TO_CHAR(${one(val.date)}, '${fmt}')`;
        }
        case "$dateTrunc": {
          const fmt = DATE_TRUNC_UNITS[val?.unit];
          if (!fmt) throw new Error(MSG.PIPELINE_EXPRESSION_ARGS(op, `unit one of ${Object.keys(DATE_TRUNC_UNITS).join(", ")}`));
          return `TRUNC(${one(val.date)}, '${fmt}')`;
        }
        case "$dateAdd": {
          const start = one(val?.startDate);
          const n = arg(val?.amount);
          switch (val?.unit) {
            case "day":
              return `(CAST(${start} AS DATE) + ${n})`;
            case "week":
              return `(CAST(${start} AS DATE) + 7 * ${n})`;
            case "hour":
            case "minute":
            case "second":
              return `(${start} + NUMTODSINTERVAL(${n}, '${String(val.unit).toUpperCase()}'))`;
            case "month":
              return `ADD_MONTHS(${start}, ${n})`;
            case "quarter":
              return `ADD_MONTHS(${start}, 3 * ${n})`;
            case "year":
              return `ADD_MONTHS(${start}, 12 * ${n})`;
            default:
              throw new Error(MSG.PIPELINE_EXPRESSION_ARGS(op, "unit one of second, minute, hour, day, week, month, quarter, year"));
          }
        }
        case "$dateDiff": {
          // Boundaries crossed between the two dates (MongoDB semantics): days between
          // the calendar dates, months between the calendar months, and so on.
          const s = one(val?.startDate);
          const e = one(val?.endDate);
          const months = (x: string) => `(EXTRACT(YEAR FROM ${x}) * 12 + EXTRACT(MONTH FROM ${x}))`;
          switch (val?.unit) {
            case "day":
              return `(TRUNC(CAST(${e} AS DATE)) - TRUNC(CAST(${s} AS DATE)))`;
            case "week":
              return `((TRUNC(CAST(${e} AS DATE), 'IW') - TRUNC(CAST(${s} AS DATE), 'IW')) / 7)`;
            case "month":
              return `(${months(e)} - ${months(s)})`;
            case "quarter":
              return `(TRUNC((${months(e)} - 1) / 3) - TRUNC((${months(s)} - 1) / 3))`;
            case "year":
              return `(EXTRACT(YEAR FROM ${e}) - EXTRACT(YEAR FROM ${s}))`;
            default:
              throw new Error(MSG.PIPELINE_EXPRESSION_ARGS(op, "unit one of day, week, month, quarter, year"));
          }
        }
        case "$prev":
        case "$next": {
          // Row-pattern navigation (only meaningful inside $matchRecognize define / measures).
          const fn = op === "$prev" ? "PREV" : "NEXT";
          if (!Array.isArray(val)) return `${fn}(${one(val)})`;
          const n = val[1];
          if (!Number.isInteger(n) || n < 0) throw new Error(MSG.PIPELINE_EXPRESSION_ARGS(op, "[column, a non-negative whole number of rows]"));
          return `${fn}(${one(val[0])}, ${n})`;
        }
        case "$lastDayOfMonth":
          return `LAST_DAY(${one(val)})`;
        case "$year":
          return `EXTRACT(YEAR FROM ${one(val)})`;
        case "$month":
          return `EXTRACT(MONTH FROM ${one(val)})`;
        case "$dayOfMonth":
          return `EXTRACT(DAY FROM ${one(val)})`;
        case "$cond": {
          const { if: ifCond, then: thenVal, else: elseVal } = val;
          const condSql = _buildCondExpr(ifCond, binds, counter);
          return `CASE WHEN ${condSql} THEN ${arg(thenVal)} ELSE ${arg(elseVal)} END`;
        }
        case "$switch": {
          const branches = val?.branches;
          if (!Array.isArray(branches) || branches.length === 0) throw new Error(MSG.PIPELINE_EXPRESSION_ARGS(op, "branches: [{ case, then }, …]"));
          const whens = branches.map((b: DslSpec) => `WHEN ${_buildCondExpr(b.case, binds, counter)} THEN ${arg(b.then)}`);
          const otherwise = val.default !== undefined ? ` ELSE ${arg(val.default)}` : "";
          return `CASE ${whens.join(" ")}${otherwise} END`;
        }
        case "$ifNull": {
          if (Array.isArray(val)) {
            const parts = val.map(arg);
            return `COALESCE(${parts.join(", ")})`;
          }
          return one(val);
        }
        case "$size":
          // Number of elements in a JSON array column (19c item method size()).
          return `JSON_VALUE(${one(val)}, '$.size()' RETURNING NUMBER)`;
        case "$window": {
          const { buildWindowExpr } = (require("./windowFunctions") as typeof import("./windowFunctions"));
          return buildWindowExpr(val, (v) => _bindValue(v, binds, counter));
        }
        default:
          // An unknown operator used to fall through to a column named after its
          // argument ("$round" → "$A,0"), failing later with a misleading ORA-00904.
          throw new Error(MSG.PIPELINE_UNKNOWN_EXPRESSION(op));
      }
    }
  }
  return String(expr);
}

/**
 * While set, column references ("$X") resolve through this instead of a plain quoted
 * name. compileExpression / compileCondition set it for the duration of one
 * synchronous build, e.g. a recursive CTE where "$prior.X" is the parent row.
 */
let _refResolver: ((name: string) => string) | null = null;

/**
 * Compile one pipeline expression (or a $cond-style condition) outside a pipeline,
 * with column references resolved by `resolve`. Binds are added to `binds`, named
 * `${prefix}agg_N` / `${prefix}cond_N`.
 */
function compileExpression(expr: unknown, binds: Record<string, unknown>, prefix: string, resolve: (name: string) => string, asCondition = false): string {
  const base = _createCounter();
  const counter: Counter = { next: (p) => `${prefix}${base.next(p)}` };
  _refResolver = resolve;
  try {
    return asCondition ? _buildCondExpr(expr, binds, counter) : _fieldRefOrBind(expr, binds, counter);
  } finally {
    _refResolver = null;
  }
}

/** Placeholder table name a $lookup pipeline's subquery replaces in the join builder's SQL. */
const LOOKUP_SUB = "MIRA_LOOKUP_SUB$";

/** Comparison operators usable in $cond / $switch conditions. */
const COND_OPS: Readonly<Record<string, string>> = Object.freeze({ $gt: ">", $gte: ">=", $lt: "<", $lte: "<=", $eq: "=", $ne: "<>" });

/** Units $dateTrunc accepts, with the TRUNC format each maps to. */
const DATE_TRUNC_UNITS: Readonly<Record<string, string>> = Object.freeze({ year: "YYYY", quarter: "Q", month: "MM", week: "IW", day: "DD", hour: "HH24", minute: "MI" });

/** A nested expression: a plain object whose only key is an operator, e.g. { $mul: [...] }. */
function _isExpr(val: unknown): val is Record<string, unknown> {
  if (!val || typeof val !== "object" || Array.isArray(val) || val instanceof Date) return false;
  const keys = Object.keys(val);
  return keys.length === 1 && keys[0].startsWith("$");
}

/**
 * A 2.1 accumulator's argument: "$COL" or an expression ({ $mul: … }) is the input
 * itself; an options object ({ input, orderBy, … }, no "$" keys) carries it in `input`.
 */
function _accInput(op: string, val: DslSpec): DslSpec {
  const isOptions = val !== null && typeof val === "object" && !Array.isArray(val) && !(val instanceof Date) && !Object.keys(val).some((k) => k.startsWith("$"));
  const spec = isOptions ? val : { input: val };
  if (spec.input === undefined) throw new Error(MSG.ACCUMULATOR_INVALID(op, "give a column (\"$COL\"), an expression, or { input: … }"));
  return spec;
}

/** An accumulator's own ORDER BY (inside JSON_ARRAYAGG / WITHIN GROUP); "" when none. */
function _accOrder(orderBy: DslSpec, lead: string): string {
  if (!orderBy) return "";
  return `${lead}ORDER BY ${Object.entries(orderBy as Record<string, unknown>).map(([c, d]) => sortTerm(c, d)).join(", ")}`;
}

/** $group accumulators whose JSON result aggregate() turns into a JS array. */
const ARRAY_ACCUMULATORS: Readonly<Record<string, "array" | "set">> = Object.freeze({ $push: "array", $addToSet: "set" });

/** Bind any literal value (number, string, boolean, Date, null) and return its placeholder. */
function _bindValue(val: unknown, binds: Record<string, unknown>, counter: Counter): string {
  const bname = counter.next("agg");
  binds[bname] = val;
  return `:${bname}`;
}

/** A single-value operand: a column, a nested expression or a Date literal; other values as before. */
function _one(val: DslSpec, binds: Record<string, unknown>, counter: Counter): string {
  if (_isExpr(val)) return `(${_buildAggExpr(val as Record<string, DslSpec>, binds, counter)})`;
  if (val instanceof Date) return _bindValue(val, binds, counter);
  return _fieldRef(val);
}

/**
 * Convert a value to a column reference.
 * "$amount" → '"amount"' (quoted column name)
 * "*"       → '*'
 * 42        → '42'
 */
function _fieldRef(val: DslSpec) {
  if (typeof val === "string" && val.startsWith("$")) {
    return _refResolver ? _refResolver(val.substring(1)) : quoteIdentifier(val.substring(1));
  }
  if (val === "*") return "*";
  if (typeof val === "number") return String(val);
  return quoteIdentifier(val);
}

/**
 * Convert a value to either a column reference (if starts with $)
 * or a bind variable (if it's a literal string/number/boolean).
 * This ensures literal values are NEVER interpolated into SQL.
 */
function _fieldRefOrBind(val: unknown, binds: Record<string, unknown>, counter: Counter) {
  if (typeof val === "string" && val.startsWith("$")) {
    return _refResolver ? _refResolver(val.substring(1)) : quoteIdentifier(val.substring(1));
  }
  if (_isExpr(val)) return `(${_buildAggExpr(val as Record<string, DslSpec>, binds, counter)})`;
  if (val === null) return "NULL";
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "string" || typeof val === "bigint" || val instanceof Date) {
    return _bindValue(val, binds, counter);
  }
  return String(val);
}

/**
 * Build a SQL condition for $cond expressions.
 * { $amount: { $gt: 100 } } → '"amount" > :cond_0'
 */
function _buildCondExpr(cond: DslSpec, binds: Record<string, unknown>, counter: Counter): string {
  // Expression form (MongoDB $expr style): { $gt: [a, b] } compares two operands,
  // each a column, a nested expression or a literal; $and / $or / $not combine.
  if (cond && typeof cond === "object" && !Array.isArray(cond) && Object.keys(cond).length === 1) {
    const [k, v] = Object.entries(cond)[0];
    const cmp = COND_OPS[k];
    if (cmp && Array.isArray(v)) {
      if (v.length !== 2) throw new Error(MSG.PIPELINE_EXPRESSION_ARGS(k, "two operands"));
      if (v[1] === null && (k === "$eq" || k === "$ne")) return `${_fieldRefOrBind(v[0], binds, counter)} ${k === "$eq" ? "IS NULL" : "IS NOT NULL"}`;
      return `${_fieldRefOrBind(v[0], binds, counter)} ${cmp} ${_fieldRefOrBind(v[1], binds, counter)}`;
    }
    if ((k === "$and" || k === "$or") && Array.isArray(v) && v.length > 0) {
      return `(${v.map((c) => _buildCondExpr(c, binds, counter)).join(k === "$and" ? " AND " : " OR ")})`;
    }
    if (k === "$not") return `NOT (${_buildCondExpr(v, binds, counter)})`;
  }
  // Simple condition: { field: { $gt: value } }
  if (typeof cond === "object") {
    for (const [field, ops] of Object.entries(cond)) {
      const fref = _fieldRef(field.startsWith("$") ? field : `$${field}`);
      if (typeof ops === "object") {
        for (const [op, val] of Object.entries(ops as Record<string, unknown>)) {
          const bname = counter.next("cond");
          binds[bname] = val;
          const sqlOp =
            {
              $gt: ">",
              $gte: ">=",
              $lt: "<",
              $lte: "<=",
              $eq: "=",
              $ne: "<>",
            }[op] || "=";
          return `${fref} ${sqlOp} :${bname}`;
        }
      } else {
        const bname = counter.next("cond");
        binds[bname] = ops;
        return `${fref} = :${bname}`;
      }
    }
  }
  return "1=1";
}

/**
 * Build an ORDER BY string from a sort spec.
 * { total: -1, name: 1 } → '"TOTAL" DESC, "NAME" ASC'
 */
function _buildSortString(sortSpec: Record<string, unknown>) {
  return Object.entries(sortSpec)
    .map(
      ([col, dir]) => sortTerm(col.toUpperCase(), dir),
    )
    .join(", ");
}

/**
 * Build SELECT columns for a $project stage.
 *
 * Handles:
 *   - { col: 1 }             → include column as-is
 *   - { alias: "$col" }      → rename a column
 *   - { alias: { $sum: .. }} → computed expression with alias
 */
function _buildProjectCols(project: Record<string, DslSpec>, counter: Counter) {
  const parts: string[] = [];
  const binds: Record<string, unknown> = {};
  for (const [col, spec] of Object.entries(project)) {
    if (spec === 1 || spec === true) {
      parts.push(quoteIdentifier(col));
    } else if (typeof spec === "string" && spec.startsWith("$")) {
      parts.push(
        `${quoteIdentifier(spec.substring(1))} AS ${quoteIdentifier(col.toUpperCase())}`,
      );
    } else if (typeof spec === "object") {
      const expr = _buildAggExpr(spec as Record<string, unknown>, binds, counter);
      parts.push(`${expr} AS ${quoteIdentifier(col.toUpperCase())}`);
    }
  }
  return { cols: parts.length > 0 ? parts.join(", ") : "*", binds };
}

/**
 * Build extra computed columns for $addFields stage.
 * Existing columns are kept (SELECT prev.*, newCol1, newCol2).
 */
function _buildAddFieldsCols(addFields: Record<string, DslSpec>, counter: Counter) {
  const binds: Record<string, unknown> = {};
  const parts: string[] = [];
  for (const [alias, spec] of Object.entries(addFields)) {
    if (typeof spec === "object") {
      const expr = _buildAggExpr(spec as Record<string, unknown>, binds, counter);
      parts.push(`${expr} AS ${quoteIdentifier(alias.toUpperCase())}`);
    } else if (typeof spec === "string" && spec.startsWith("$")) {
      parts.push(
        `${quoteIdentifier(spec.substring(1))} AS ${quoteIdentifier(alias.toUpperCase())}`,
      );
    } else {
      const bname = counter.next("addf");
      binds[bname] = spec;
      parts.push(`:${bname} AS ${quoteIdentifier(alias.toUpperCase())}`);
    }
  }
  return { sql: parts.join(", "), binds };
}

/**
 * Build a LATERAL subquery for $lateralJoin.
 *
 * A lateral join is like a correlated subquery used as a join source.
 * Values prefixed with "$outer." reference the outer table's columns.
 */
function _buildLateralSub(lj: DslSpec, prevSource: unknown) {
  if (lj.subquery && typeof lj.subquery._buildSQL === "function") {
    // pageByRowid: a row limit inside LATERAL is mis-decorrelated by Oracle (see QueryBuilder._buildSQL).
    const { sql: builtSql, binds } = lj.subquery._buildSQL({ pageByRowid: true });
    let sql = builtSql;
    // Post-process: replace bind variables whose values start with "$outer."
    // with direct column references to the outer table (prevSource)
    for (const [key, val] of Object.entries(binds)) {
      if (typeof val === "string" && val.startsWith("$outer.")) {
        const outerCol = val.slice(7);
        sql = sql.replace(
          new RegExp(`:${key}\\b`, "g"),
          `${prevSource}.${quoteIdentifier(outerCol)}`,
        );
        delete binds[key];
      }
    }
    return { sql, binds };
  }
  return { sql: "SELECT 1 FROM DUAL", binds: {} };
}

/**
 * Wrap the pipeline's SELECT in a MERGE INTO for the $merge stage.
 *
 *   { $merge: {
 *       into: "TARGET",                 // target table
 *       on: { ID: "ID" },               // target column -> pipeline column
 *       fields: ["ID", "TOTAL"],        // pipeline columns to write (same names in the target)
 *       whenMatched: "merge",           // "merge" (update non-key fields, default) | "keepExisting"
 *       whenNotMatched: "insert",       // "insert" (default) | "discard"
 *   } }
 *
 * `fields` is required: the builder never sees the result columns, and Oracle
 * accepts neither `INSERT VALUES (src.*)` nor updating an ON column (ORA-38104).
 */
function _buildMergeStatement(merge: DslSpec, sourceSql: string): string {
  const { into, on, fields, whenMatched = "merge", whenNotMatched = "insert" } = merge ?? {};
  if (!into) throw new Error(MSG.PIPELINE_MERGE_INVALID("into is required"));
  if (!on || typeof on !== "object" || Object.keys(on).length === 0) throw new Error(MSG.PIPELINE_MERGE_INVALID("on must map at least one target column"));
  if (!Array.isArray(fields) || fields.length === 0) throw new Error(MSG.PIPELINE_MERGE_INVALID("fields must list the columns to write"));
  if (whenMatched !== "merge" && whenMatched !== "keepExisting") throw new Error(MSG.PIPELINE_MERGE_INVALID('whenMatched must be "merge" or "keepExisting"'));
  if (whenNotMatched !== "insert" && whenNotMatched !== "discard") throw new Error(MSG.PIPELINE_MERGE_INVALID('whenNotMatched must be "insert" or "discard"'));

  const onSql = Object.entries(on as Record<string, string>)
    .map(([t, s]) => `tgt.${quoteIdentifier(t)} = src.${quoteIdentifier(s)}`)
    .join(" AND ");
  const updatable = (fields as string[]).filter((f) => !(f in on));
  const matched =
    whenMatched === "merge" && updatable.length > 0
      ? ` WHEN MATCHED THEN UPDATE SET ${updatable.map((c) => `tgt.${quoteIdentifier(c)} = src.${quoteIdentifier(c)}`).join(", ")}`
      : "";
  const notMatched =
    whenNotMatched === "insert"
      ? ` WHEN NOT MATCHED THEN INSERT (${(fields as string[]).map(quoteIdentifier).join(", ")}) VALUES (${(fields as string[]).map((c) => `src.${quoteIdentifier(c)}`).join(", ")})`
      : "";
  if (!matched && !notMatched) throw new Error(MSG.PIPELINE_MERGE_INVALID("nothing to do: no updatable fields and whenNotMatched is discard"));
  return `MERGE INTO ${quoteIdentifier(into)} tgt USING (${sourceSql}) src ON (${onSql})${matched}${notMatched}`;
}

/** Pattern variables: unquoted upper-case identifiers, so they can be written into SQL as is. */
const MR_VAR = /^[A-Z][A-Z0-9_]{0,29}$/;
const MR_AGGS: Readonly<Record<string, string>> = Object.freeze({ $first: "FIRST", $last: "LAST", $sum: "SUM", $min: "MIN", $max: "MAX", $avg: "AVG", $count: "COUNT" });

/**
 * Build the $matchRecognize stage: Oracle row pattern matching (MATCH_RECOGNIZE).
 *
 *   { $matchRecognize: {
 *       partitionBy: ["SKU"], orderBy: { D: 1 },
 *       measures: { START_D: { $first: "$D" }, DAYS: { $count: "*" } },
 *       rowsPerMatch: "one" | "all",            // default "one"
 *       afterMatch: "pastLastRow" | "nextRow",  // default "pastLastRow"
 *       pattern: "Z+",                          // variables, quantifiers, ( ) | ^ $
 *       define: { Z: { QTY: 0 } },              // a $cond-style condition per variable
 *   } }
 *
 * The pattern is checked token by token and every variable must be defined, so
 * nothing but a pattern reaches the SQL. Conditions are built like $cond (values
 * bound); $prev / $next look at neighbouring rows. Measures: $first / $last /
 * $sum / $min / $max / $avg / $count of a column ("$COL" or "$VAR.COL"),
 * $classifier, $matchNumber.
 */
function _buildMatchRecognize(spec: DslSpec, source: string, counter: Counter): { sql: string; binds: Record<string, unknown>; outputs: string[] } {
  const binds: Record<string, unknown> = {};
  const bad = (why: string) => new Error(MSG.PIPELINE_MATCH_RECOGNIZE(why));
  if (!spec || typeof spec !== "object") throw bad("expects an object");
  const { partitionBy, orderBy, measures, rowsPerMatch = "one", afterMatch = "pastLastRow", pattern, define } = spec;
  if (!orderBy || typeof orderBy !== "object" || Object.keys(orderBy).length === 0) throw bad("orderBy is required");
  if (!define || typeof define !== "object") throw bad("define is required");
  for (const v of Object.keys(define)) if (!MR_VAR.test(v)) throw bad(`variable ${v} must be an upper-case name`);

  // PATTERN: only variables, quantifiers, grouping, alternation and anchors.
  const tokens = typeof pattern === "string" ? pattern.match(/[A-Za-z_][A-Za-z0-9_]*|\{\d+(?:,\d*)?\}|[()|*+?^$]|\s+/g) : null;
  if (!tokens || tokens.join("") !== pattern || !pattern.trim()) throw bad("pattern may contain only variable names, quantifiers (* + ? {n,m}), ( ) | ^ $");
  for (const t of tokens) if (/^[A-Za-z_]/.test(t) && !(t in define)) throw bad(`variable ${t} is not defined (add it to define)`);

  const col = (ref: unknown): string => {
    if (ref === "*") return "*";
    const m = typeof ref === "string" ? /^\$(?:([A-Z][A-Z0-9_]*)\.)?(.+)$/.exec(ref) : null;
    if (!m) throw bad(`a measure takes "$COLUMN" or "$VARIABLE.COLUMN", got ${JSON.stringify(ref)}`);
    if (m[1] && !(m[1] in define)) throw bad(`variable ${m[1]} is not defined`);
    return `${m[1] ? `${m[1]}.` : ""}${quoteIdentifier(m[2])}`;
  };
  const outputs: string[] = [];
  const measureSql = Object.entries((measures ?? {}) as Record<string, Record<string, unknown>>).map(([alias, m]) => {
    const [op, val] = Object.entries(m ?? {})[0] ?? [];
    let expr: string;
    if (op === "$classifier") expr = "CLASSIFIER()";
    else if (op === "$matchNumber") expr = "MATCH_NUMBER()";
    else if (op && MR_AGGS[op]) expr = `${MR_AGGS[op]}(${col(val)})`;
    else throw bad(`measure ${alias}: use $first, $last, $sum, $min, $max, $avg, $count, $classifier or $matchNumber`);
    outputs.push(alias.toUpperCase());
    return `${expr} AS ${quoteIdentifier(alias.toUpperCase())}`;
  });

  const parts: string[] = [];
  const pcols = partitionBy == null ? [] : Array.isArray(partitionBy) ? partitionBy : [partitionBy];
  if (pcols.length) parts.push(`PARTITION BY ${pcols.map((c: string) => quoteIdentifier(c)).join(", ")}`);
  parts.push(`ORDER BY ${_buildSortString(orderBy)}`);
  if (measureSql.length) parts.push(`MEASURES ${measureSql.join(", ")}`);
  if (rowsPerMatch !== "one" && rowsPerMatch !== "all") throw bad('rowsPerMatch is "one" or "all"');
  parts.push(rowsPerMatch === "all" ? "ALL ROWS PER MATCH" : "ONE ROW PER MATCH");
  if (afterMatch !== "pastLastRow" && afterMatch !== "nextRow") throw bad('afterMatch is "pastLastRow" or "nextRow"');
  parts.push(afterMatch === "nextRow" ? "AFTER MATCH SKIP TO NEXT ROW" : "AFTER MATCH SKIP PAST LAST ROW");
  parts.push(`PATTERN (${pattern})`);
  parts.push(`DEFINE ${Object.entries(define).map(([v, c]) => `${v} AS ${c === true ? "1=1" : _buildCondExpr(c, binds, counter)}`).join(", ")}`);
  return { sql: `SELECT * FROM ${source} MATCH_RECOGNIZE (${parts.join(" ")})`, binds, outputs };
}

/**
 * Build a CASE-based bucket grouping for the $bucket stage.
 *
 * Groups values into ranges using CASE WHEN expressions.
 * Example: boundaries [0, 100, 500] creates buckets: 0-99, 100-499
 */
function _buildBucket(bucket: DslSpec, source: unknown, counter: Counter) {
  const binds: Record<string, unknown> = {};
  const { groupBy, boundaries, default: defaultBucket, output } = bucket;
  const col = groupBy.startsWith("$") ? groupBy.substring(1) : groupBy;
  const cases: string[] = [];

  // Determine if boundaries are numeric — if so, use TO_CHAR for THEN labels
  // so that the default bucket string doesn't cause ORA-00932 (inconsistent datatypes).
  const numericBoundaries = boundaries.every((b: unknown) => typeof b === "number");

  for (let i = 0; i < boundaries.length - 1; i++) {
    const lo = counter.next("bkt");
    const hi = counter.next("bkt");
    binds[lo] = boundaries[i];
    binds[hi] = boundaries[i + 1];
    const thenBind = counter.next("bkt");
    binds[thenBind] =
      numericBoundaries && defaultBucket
        ? String(boundaries[i])
        : boundaries[i];
    cases.push(
      `WHEN ${quoteIdentifier(col)} >= :${lo} AND ${quoteIdentifier(col)} < :${hi} THEN :${thenBind}`,
    );
  }
  if (defaultBucket) {
    const defBind = counter.next("bkt");
    binds[defBind] = String(defaultBucket);
    cases.push(`ELSE :${defBind}`);
  }

  const bucketExpr = `CASE ${cases.join(" ")} END`;
  const selectParts = [`${bucketExpr} AS bucket`];

  if (output) {
    for (const [alias, agg] of Object.entries(output as Record<string, Record<string, unknown>>)) {
      const aggSql = _buildAggExpr(agg, binds, counter);
      selectParts.push(`${aggSql} AS ${quoteIdentifier(alias.toUpperCase())}`);
    }
  } else {
    selectParts.push("COUNT(*) AS count");
  }

  return {
    sql: `SELECT ${selectParts.join(", ")} FROM ${source} GROUP BY ${bucketExpr}`,
    binds,
  };
}

export { compileExpression, buildAggregateSQL };
