"use strict";

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
 *   _buildMergeStage()   → Build MERGE INTO for $merge stage
 *   _buildBucket()       → Build CASE-based grouping for $bucket
 *   _buildSortString()   → Build ORDER BY string
 * ============================================================================
 */

const { quoteIdentifier } = require("../utils");
const { parseFilter } = require("../parsers/filterParser");

/**
 * Create a per-call counter for unique bind variable names.
 * Each buildAggregateSQL() call gets its own counter so parallel
 * calls never produce colliding bind names.
 *
 * @returns {{ next: (prefix: string) => string }}
 */
function _createCounter() {
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
 * @returns {{ sql: string, binds: Object }} The SQL string and bind variables
 *
 * @example
 *   const { sql, binds } = buildAggregateSQL("orders", [
 *     { $match: { status: "completed" } },
 *     { $group: { _id: "$region", total: { $sum: "$amount" } } },
 *   ], db);
 */
function buildAggregateSQL(tableName, pipeline, db) {
    const counter = _createCounter();
    const ctes = [];
    const allBinds = {};
    let prevSource = quoteIdentifier(tableName);
    let stageIdx = 0;
    let outTable = null;

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

    for (const stage of pipeline) {
        const stageAlias = `stage_${stageIdx}`;
        const key = Object.keys(stage).filter((k) => k !== "_having")[0];

        switch (key) {
            case "$match": {
                const { whereClause, binds } = parseFilter(stage.$match);
                Object.assign(allBinds, binds);
                ctes.push({
                    alias: stageAlias,
                    sql: `SELECT * FROM ${prevSource} ${whereClause}`,
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
                break;
            }

            case "$sort": {
                const orderBy = _buildSortString(stage.$sort);
                ctes.push({
                    alias: stageAlias,
                    sql: `SELECT * FROM ${prevSource} ORDER BY ${orderBy}`,
                });
                break;
            }

            case "$limit": {
                ctes.push({
                    alias: stageAlias,
                    sql: `SELECT * FROM ${prevSource} FETCH FIRST ${Number(stage.$limit)} ROWS ONLY`,
                });
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
                break;
            }

            case "$lookup": {
                const { buildJoinSQL } = require("../joins/joinBuilder");
                const joinSql = buildJoinSQL(prevSource, stage.$lookup);
                ctes.push({ alias: stageAlias, sql: joinSql });
                break;
            }

            case "$lateralJoin": {
                const lj = stage.$lateralJoin;
                const { sql: subSql, binds: subBinds } = _buildLateralSub(
                    lj,
                    prevSource,
                );
                Object.assign(allBinds, subBinds);
                ctes.push({
                    alias: stageAlias,
                    sql: `SELECT ${prevSource}.*, ${quoteIdentifier(lj.as)}.* FROM ${prevSource}, LATERAL (${subSql}) ${quoteIdentifier(lj.as)}`,
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
                const mergeSql = _buildMergeStage(stage.$merge, prevSource);
                ctes.push({ alias: stageAlias, sql: mergeSql, isMerge: true });
                break;
            }

            case "$bucket": {
                const { sql, binds } = _buildBucket(
                    stage.$bucket,
                    prevSource,
                    counter,
                );
                Object.assign(allBinds, binds);
                ctes.push({ alias: stageAlias, sql });
                break;
            }

            case "$facet": {
                // Each facet pipeline is a separate CTE, union all at end
                const facetCtes = [];
                for (const [facetName, facetPipeline] of Object.entries(
                    stage.$facet,
                )) {
                    const { sql } = buildAggregateSQL(
                        prevSource.replace(/"/g, ""),
                        facetPipeline,
                        db,
                    );
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
                const fieldName = typeof newRoot === "string" && newRoot.startsWith("$")
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

            default:
                // Unknown stage — skip
                stageIdx++;
                continue;
        }

        prevSource = quoteIdentifier(stageAlias);
        stageIdx++;
    }

    // Build final SQL
    if (ctes.length === 0) {
        return {
            sql: `SELECT * FROM ${quoteIdentifier(tableName)}`,
            binds: allBinds,
        };
    }

    if (ctes.length === 1) {
        let sql = ctes[0].sql;
        if (outTable) {
            sql = `INSERT INTO ${quoteIdentifier(outTable)} ${sql}`;
        }
        return { sql, binds: allBinds };
    }

    // Build WITH ... AS chain
    const withParts = ctes
        .slice(0, -1)
        .map((c) => `${quoteIdentifier(c.alias)} AS (${c.sql})`);
    const lastCte = ctes[ctes.length - 1];

    let sql = `WITH ${withParts.join(",\n     ")}\n${lastCte.sql}`;
    if (outTable) {
        sql = `INSERT INTO ${quoteIdentifier(outTable)} ${sql}`;
    }
    return { sql, binds: allBinds };
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
function _buildGroup(group, source, having, counter) {
    const binds = {};
    const selectParts = [];
    const groupByParts = [];

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
        if (idSpec.$rollup) {
            const cols = idSpec.$rollup.map((c) => quoteIdentifier(c));
            selectParts.push(...idSpec.$rollup.map(quoteIdentifier));
            groupByParts.push(`ROLLUP(${cols.join(", ")})`);
        } else if (idSpec.$cube) {
            const cols = idSpec.$cube.map((c) => quoteIdentifier(c));
            selectParts.push(...idSpec.$cube.map(quoteIdentifier));
            groupByParts.push(`CUBE(${cols.join(", ")})`);
        } else if (idSpec.$groupingSets) {
            const sets = idSpec.$groupingSets.map((set) => {
                if (Array.isArray(set) && set.length === 0) return "()";
                if (Array.isArray(set))
                    return `(${set.map(quoteIdentifier).join(", ")})`;
                return quoteIdentifier(set);
            });
            // Collect all unique columns
            const allCols = new Set();
            idSpec.$groupingSets.forEach((set) => {
                if (Array.isArray(set)) set.forEach((c) => allCols.add(c));
                else if (set) allCols.add(set);
            });
            selectParts.push(...[...allCols].map(quoteIdentifier));
            groupByParts.push(`GROUPING SETS(${sets.join(", ")})`);
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
    const aliasToExpr = {};
    for (const [alias, expr] of Object.entries(group)) {
        if (alias === "_id") continue;
        const aggSql = _buildAggExpr(expr, binds, counter);
        aliasToExpr[alias] = aggSql;
        selectParts.push(
            `${aggSql} AS ${quoteIdentifier(alias.toUpperCase())}`,
        );
    }

    let sql = `SELECT ${selectParts.join(", ")} FROM ${source}`;
    if (groupByParts.length > 0) {
        sql += ` GROUP BY ${groupByParts.join(", ")}`;
    }

    // HAVING
    if (having) {
        const havingParts = [];
        for (const [col, cond] of Object.entries(having)) {
            // Use the aggregate expression instead of the alias
            const aggExpr =
                aliasToExpr[col] || quoteIdentifier(col.toUpperCase());
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
function _buildAggExpr(expr, binds, counter) {
    if (typeof expr === "object") {
        for (const [op, val] of Object.entries(expr)) {
            switch (op) {
                case "$sum":
                    return `SUM(${_fieldRef(val)})`;
                case "$avg":
                    return `AVG(${_fieldRef(val)})`;
                case "$min":
                    return `MIN(${_fieldRef(val)})`;
                case "$max":
                    return `MAX(${_fieldRef(val)})`;
                case "$count":
                    return `COUNT(${val === "*" ? "*" : _fieldRef(val)})`;
                case "$first":
                    return `MIN(${_fieldRef(val)})`;
                case "$last":
                    return `MAX(${_fieldRef(val)})`;
                case "$mul": {
                    if (Array.isArray(val)) {
                        return val
                            .map((v) => _fieldRefOrBind(v, binds, counter))
                            .join(" * ");
                    }
                    return _fieldRef(val);
                }
                case "$add": {
                    if (Array.isArray(val)) {
                        return `(${val.map((v) => _fieldRefOrBind(v, binds, counter)).join(" + ")})`;
                    }
                    return _fieldRef(val);
                }
                case "$subtract": {
                    if (Array.isArray(val)) {
                        return `(${val.map((v) => _fieldRefOrBind(v, binds, counter)).join(" - ")})`;
                    }
                    return _fieldRef(val);
                }
                case "$divide": {
                    if (Array.isArray(val)) {
                        return `(${val.map((v) => _fieldRefOrBind(v, binds, counter)).join(" / ")})`;
                    }
                    return _fieldRef(val);
                }
                case "$concat": {
                    if (Array.isArray(val)) {
                        return val.map(_fieldRef).join(" || ");
                    }
                    return _fieldRef(val);
                }
                case "$toUpper":
                    return `UPPER(${_fieldRef(val)})`;
                case "$toLower":
                    return `LOWER(${_fieldRef(val)})`;
                case "$substr": {
                    if (Array.isArray(val)) {
                        return `SUBSTR(${_fieldRef(val[0])}, ${Number(val[1])}, ${Number(val[2])})`;
                    }
                    return _fieldRef(val);
                }
                case "$dateToString": {
                    const fmt = (val.format || "YYYY-MM-DD").replace(
                        /'/g,
                        "''",
                    );
                    return `TO_CHAR(${_fieldRef(val.date)}, '${fmt}')`;
                }
                case "$cond": {
                    const { if: ifCond, then: thenVal, else: elseVal } = val;
                    const condSql = _buildCondExpr(ifCond, binds, counter);
                    const thenSql = _fieldRefOrBind(thenVal, binds, counter);
                    const elseSql = _fieldRefOrBind(elseVal, binds, counter);
                    return `CASE WHEN ${condSql} THEN ${thenSql} ELSE ${elseSql} END`;
                }
                case "$ifNull": {
                    if (Array.isArray(val)) {
                        const parts = val.map((v) =>
                            _fieldRefOrBind(v, binds, counter),
                        );
                        return `COALESCE(${parts.join(", ")})`;
                    }
                    return _fieldRef(val);
                }
                case "$size":
                    return `JSON_ARRAY_LENGTH(${_fieldRef(val)})`;
                case "$window": {
                    const { buildWindowExpr } = require("./windowFunctions");
                    return buildWindowExpr(val);
                }
                default:
                    return _fieldRef(val);
            }
        }
    }
    return String(expr);
}

/**
 * Convert a value to a column reference.
 * "$amount" → '"amount"' (quoted column name)
 * "*"       → '*'
 * 42        → '42'
 */
function _fieldRef(val) {
    if (typeof val === "string" && val.startsWith("$")) {
        return quoteIdentifier(val.substring(1));
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
function _fieldRefOrBind(val, binds, counter) {
    if (typeof val === "string" && val.startsWith("$")) {
        return quoteIdentifier(val.substring(1));
    }
    if (typeof val === "number" || typeof val === "boolean") {
        const bname = counter.next("agg");
        binds[bname] = val;
        return `:${bname}`;
    }
    if (typeof val === "string") {
        const bname = counter.next("agg");
        binds[bname] = val;
        return `:${bname}`;
    }
    return String(val);
}

/**
 * Build a SQL condition for $cond expressions.
 * { $amount: { $gt: 100 } } → '"amount" > :cond_0'
 */
function _buildCondExpr(cond, binds, counter) {
    // Simple condition: { field: { $gt: value } }
    if (typeof cond === "object") {
        for (const [field, ops] of Object.entries(cond)) {
            const fref = _fieldRef(field.startsWith("$") ? field : `$${field}`);
            if (typeof ops === "object") {
                for (const [op, val] of Object.entries(ops)) {
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
function _buildSortString(sortSpec) {
    return Object.entries(sortSpec)
        .map(
            ([col, dir]) =>
                `${quoteIdentifier(col.toUpperCase())} ${dir === -1 ? "DESC" : "ASC"}`,
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
function _buildProjectCols(project, counter) {
    const parts = [];
    const binds = {};
    for (const [col, spec] of Object.entries(project)) {
        if (spec === 1 || spec === true) {
            parts.push(quoteIdentifier(col));
        } else if (typeof spec === "string" && spec.startsWith("$")) {
            parts.push(
                `${quoteIdentifier(spec.substring(1))} AS ${quoteIdentifier(col.toUpperCase())}`,
            );
        } else if (typeof spec === "object") {
            const expr = _buildAggExpr(spec, binds, counter);
            parts.push(`${expr} AS ${quoteIdentifier(col.toUpperCase())}`);
        }
    }
    return { cols: parts.length > 0 ? parts.join(", ") : "*", binds };
}

/**
 * Build extra computed columns for $addFields stage.
 * Existing columns are kept (SELECT prev.*, newCol1, newCol2).
 */
function _buildAddFieldsCols(addFields, counter) {
    const binds = {};
    const parts = [];
    for (const [alias, spec] of Object.entries(addFields)) {
        if (typeof spec === "object") {
            const expr = _buildAggExpr(spec, binds, counter);
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
function _buildLateralSub(lj, prevSource) {
    if (lj.subquery && typeof lj.subquery._buildSQL === "function") {
        let { sql, binds } = lj.subquery._buildSQL();
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
 * Build a MERGE INTO statement for the $merge pipeline stage.
 * Merges results from the pipeline into a target table.
 */
function _buildMergeStage(merge, source) {
    const into = quoteIdentifier(merge.into);
    const onCols = Object.entries(merge.on)
        .map(
            ([l, r]) => `tgt.${quoteIdentifier(l)} = src.${quoteIdentifier(r)}`,
        )
        .join(" AND ");
    return `MERGE INTO ${into} tgt USING (SELECT * FROM ${source}) src ON (${onCols}) WHEN MATCHED THEN UPDATE SET tgt.updated = SYSDATE WHEN NOT MATCHED THEN INSERT VALUES (src.*)`;
}

/**
 * Build a CASE-based bucket grouping for the $bucket stage.
 *
 * Groups values into ranges using CASE WHEN expressions.
 * Example: boundaries [0, 100, 500] creates buckets: 0-99, 100-499
 */
function _buildBucket(bucket, source, counter) {
    const binds = {};
    const { groupBy, boundaries, default: defaultBucket, output } = bucket;
    const col = groupBy.startsWith("$") ? groupBy.substring(1) : groupBy;
    const cases = [];

    // Determine if boundaries are numeric — if so, use TO_CHAR for THEN labels
    // so that the default bucket string doesn't cause ORA-00932 (inconsistent datatypes).
    const numericBoundaries = boundaries.every((b) => typeof b === "number");

    for (let i = 0; i < boundaries.length - 1; i++) {
        const lo = counter.next("bkt");
        const hi = counter.next("bkt");
        binds[lo] = boundaries[i];
        binds[hi] = boundaries[i + 1];
        const thenBind = counter.next("bkt");
        binds[thenBind] = numericBoundaries && defaultBucket
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
        for (const [alias, agg] of Object.entries(output)) {
            const aggSql = _buildAggExpr(agg, binds, counter);
            selectParts.push(
                `${aggSql} AS ${quoteIdentifier(alias.toUpperCase())}`,
            );
        }
    } else {
        selectParts.push("COUNT(*) AS count");
    }

    return {
        sql: `SELECT ${selectParts.join(", ")} FROM ${source} GROUP BY ${bucketExpr}`,
        binds,
    };
}

module.exports = { buildAggregateSQL };
