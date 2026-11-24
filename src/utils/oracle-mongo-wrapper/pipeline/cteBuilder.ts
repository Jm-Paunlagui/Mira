

/**
 * ============================================================================
 * cteBuilder.js — CTE (Common Table Expressions) for Oracle
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   Lets you compose multiple QueryBuilder queries as named CTEs (WITH ... AS)
 *   and then query across them with joins, sorts, limits, etc.
 *
 * TWO KINDS OF CTEs:
 *   1. Regular CTE — withCTE(db, { name1: qb1, name2: qb2 })
 *      Wraps multiple named queries in WITH clauses, then lets you
 *      SELECT from one and optionally JOIN another.
 *
 *   2. Recursive CTE — withRecursiveCTE(db, "name", { anchor, recursive })
 *      For hierarchical/tree data. Starts with an anchor query, then
 *      recursively joins the table to itself using UNION ALL.
 *      Automatically adds a LVL (level/depth) column.
 *
 * USAGE:
 *   // Regular CTE
 *   const result = await withCTE(db, {
 *     active: users.find({ status: "active" }).project({ id: 1, name: 1 }),
 *     orders: ordersColl.find({ year: 2024 }).project({ userId: 1, total: 1 })
 *   })
 *     .from("active")
 *     .join({ from: "orders", localField: "id", foreignField: "userId" })
 *     .sort({ total: -1 })
 *     .limit(10)
 *     .toArray();
 *
 *   // Recursive CTE (org chart)
 *   const tree = await withRecursiveCTE(db, "org", {
 *     anchor: employees.find({ managerId: null }),
 *     recursive: { collection: "employees", joinOn: { managerId: "$org.id" } }
 *   })
 *     .sort({ LVL: 1 })
 *     .toArray();
 *
 * CLASSES:
 *   CTEResult          — chainable result for regular CTEs
 *   RecursiveCTEResult — chainable result for recursive CTEs
 * ============================================================================
 */

import type { DbConnection } from "../db";
import type { QueryBuilder } from "../core/QueryBuilder";
import { quoteIdentifier, renameBinds } from "../utils";
import { buildAggregateSQL, compileExpression } from "./aggregatePipeline";
import { oracleMongoWrapperMessages as MSG } from "../../../constants/messages";

/**
 * Create a regular CTE from named QueryBuilder instances.
 * Returns a chainable CTEResult with .from(), .join(), .sort(), .limit(), .skip(), .toArray().
 *
 * @param {Object} db - db interface from createDb()
 * @param {Object} cteDefs - Map of CTE names to QueryBuilder instances
 *                           e.g. { active: users.find({...}), recent: orders.find({...}) }
 * @returns {CTEResult} Chainable CTE result
 *
 * @example
 *   const rows = await withCTE(db, {
 *     topUsers: users.find({ role: "admin" }).project({ id: 1, name: 1 }),
 *     activity: logs.find({ year: 2024 }).project({ userId: 1, action: 1 })
 *   })
 *     .from("topUsers")
 *     .join({ from: "activity", localField: "id", foreignField: "userId" })
 *     .toArray();
 */
/** A join from the CTE's FROM to another CTE: `localField = <cte>.foreignField`. */
type CteJoin = { from: string; localField: string; foreignField: string; joinType?: string };
/** A recursive CTE: anchor query plus the self-join that walks the hierarchy. */
type RecursiveDef = {
  anchor: QueryBuilder;
  recursive: {
    collection: string;
    /** child column → "$<cte>.<parent column>"; {} recurses on every row of `collection` (ON 1=1). */
    joinOn: Record<string, unknown>;
    /** Columns computed on each level: "$prior.X" is the parent row, "$X" the child row. */
    set?: Record<string, unknown>;
    /** Keep recursing only while this ($cond-style) condition holds for parent / child. */
    while?: unknown;
  };
};

function withCTE(db: import("../db").WrapperDb, cteDefs: Record<string, QueryBuilder>): CTEResult {
  return new CTEResult(db, cteDefs);
}

/**
 * Create a recursive CTE for hierarchical/tree-structured data.
 * Automatically adds a LVL column tracking depth.
 *
 * @param {Object} db - db interface from createDb()
 * @param {string} cteName - Name for the recursive CTE
 * @param {Object} def - Recursive definition
 * @param {QueryBuilder} def.anchor - The starting query (root nodes)
 * @param {Object} def.recursive - How to recurse: { collection, joinOn }
 * @param {string} def.recursive.collection - Table to recurse into
 * @param {Object} def.recursive.joinOn - Join conditions using "$cteName.col" references
 * @returns {RecursiveCTEResult} Chainable recursive CTE result
 *
 * @example
 *   const tree = await withRecursiveCTE(db, "org", {
 *     anchor: employees.find({ managerId: null }),  // root: employees with no manager
 *     recursive: {
 *       collection: "employees",
 *       joinOn: { managerId: "$org.id" }  // child.managerId = parent.id
 *     }
 *   }).sort({ LVL: 1, name: 1 }).toArray();
 */
function withRecursiveCTE(db: import("../db").WrapperDb, cteName: string, def: RecursiveDef): RecursiveCTEResult {
  return new RecursiveCTEResult(db, cteName, def);
}

/**
 * Chainable result for regular CTEs.
 *
 * Chain methods (return `this` for chaining):
 *   .from(cteName)  — pick which CTE to SELECT FROM
 *   .join({...})    — JOIN another CTE
 *   .sort({...})    — ORDER BY
 *   .limit(n)       — FETCH FIRST N ROWS ONLY
 *   .skip(n)        — OFFSET N ROWS
 *
 * Terminal method:
 *   .toArray()      — Execute and return rows
 */
class CTEResult {
  declare _skipVal: unknown;
  declare _limitVal: unknown;
  declare _sort: unknown;
  declare _join: CteJoin | null;
  declare _from: string | null;
  declare _cteDefs: Record<string, QueryBuilder>;
  declare _db: import("../db").WrapperDb;
  constructor(db: import("../db").WrapperDb, cteDefs: Record<string, QueryBuilder>) {
    this._db = db;
    this._cteDefs = cteDefs;
    this._from = null;
    this._join = null;
    this._sort = null;
    this._limitVal = null;
    this._skipVal = null;
  }

  from(cteName: string) {
    this._from = cteName;
    return this;
  }

  join(joinSpec: CteJoin) {
    this._join = joinSpec;
    return this;
  }

  sort(sortSpec: unknown) {
    this._sort = sortSpec;
    return this;
  }

  limit(n: unknown) {
    this._limitVal = n;
    return this;
  }

  skip(n: unknown) {
    this._skipVal = n;
    return this;
  }

  _buildSQL() {
    const withParts: string[] = [];
    const allBinds: Record<string, unknown> = {};

    // Each named query numbers its binds from 0; prefix them per CTE so two CTEs
    // filtering the same column keep their own values.
    let i = 0;
    for (const [name, qb] of Object.entries(this._cteDefs)) {
      const built = qb._buildSQL();
      const { sql, binds } = renameBinds(built.sql, built.binds, `c${i++}_`);
      Object.assign(allBinds, binds);
      withParts.push(`${quoteIdentifier(name)} AS (${sql})`);
    }

    const fromSource = this._from
      ? quoteIdentifier(this._from)
      : Object.keys(this._cteDefs)[0];

    let selectSql = `SELECT * FROM ${fromSource}`;

    if (this._join) {
      const {
        from: joinFrom,
        localField,
        foreignField,
        joinType = "inner",
      } = this._join;
      const jt = _resolveJoinType(joinType);
      selectSql = `SELECT ${fromSource}.*, ${quoteIdentifier(joinFrom)}.* FROM ${fromSource} ${jt} ${quoteIdentifier(joinFrom)} ON ${fromSource}.${quoteIdentifier(localField)} = ${quoteIdentifier(joinFrom)}.${quoteIdentifier(foreignField)}`;
    }

    if (this._sort) {
      const orderBy = Object.entries(this._sort)
        .map(
          ([col, dir]) =>
            `${quoteIdentifier(col)} ${dir === -1 ? "DESC" : "ASC"}`,
        )
        .join(", ");
      selectSql += ` ORDER BY ${orderBy}`;
    }

    if (this._skipVal != null) {
      selectSql += ` OFFSET ${Number(this._skipVal)} ROWS`;
    }
    if (this._limitVal != null) {
      selectSql += ` FETCH FIRST ${Number(this._limitVal)} ROWS ONLY`;
    }

    const sql = `WITH ${withParts.join(",\n     ")}\n${selectSql}`;
    return { sql, binds: allBinds };
  }

  async toArray() {
    const { sql, binds } = this._buildSQL();
    return this._db.withConnection(async (conn: DbConnection) => {
      try {
        const result = await conn.execute(sql, binds, {
          outFormat: this._db.oracledb.OUT_FORMAT_OBJECT,
          autoCommit: true,
        });
        return result.rows || [];
      } catch (err) {
        throw new Error(MSG.wrapError("CTEResult.toArray", err, sql));
      }
    });
  }
}

/**
 * Chainable result for recursive CTEs.
 *
 * Adds a LVL column automatically (depth in the tree: 1 = root, 2 = child, etc.).
 * The recursive CTE uses UNION ALL internally to build the tree.
 *
 * Chain methods: .sort(), .limit(), .skip()
 * Terminal method: .toArray()
 */
class RecursiveCTEResult {
  declare _skipVal: unknown;
  declare _limitVal: unknown;
  declare _sort: unknown;
  declare _def: RecursiveDef;
  declare _cteName: string;
  declare _db: import("../db").WrapperDb;
  constructor(db: import("../db").WrapperDb, cteName: string, def: RecursiveDef) {
    this._db = db;
    this._cteName = cteName;
    this._def = def;
    this._sort = null;
    this._limitVal = null;
    this._skipVal = null;
  }

  sort(sortSpec: unknown) {
    this._sort = sortSpec;
    return this;
  }

  limit(n: unknown) {
    this._limitVal = n;
    return this;
  }

  skip(n: unknown) {
    this._skipVal = n;
    return this;
  }

  _buildSQL(colNames: string[] = []) {
    const { anchor, recursive } = this._def;
    const allBinds: Record<string, unknown> = {};

    // Anchor query
    const { sql: anchorSql, binds: anchorBinds } = anchor._buildSQL();
    Object.assign(allBinds, anchorBinds);

    // Recursive part
    const recTable = recursive.collection;
    const joinParts = Object.entries(recursive.joinOn)
      .map(([childCol, parentRef]) => {
        const parentCol = (parentRef as string).replace(`$${this._cteName}.`, "");
        return `e.${quoteIdentifier(childCol)} = o.${quoteIdentifier(parentCol)}`;
      })
      .join(" AND ");
    // An empty joinOn recurses on every row of the table at each level (ON 1=1). Oracle's
    // default cycle check sees the same table row in its own ancestry and stops with
    // ORA-32044, so such a recursion carries a CYCLE clause on LVL (which always grows)
    // and must say when to stop with `while`. A joinOn recursion keeps Oracle's check,
    // so real loops in the data still fail instead of running forever.
    const free = joinParts === "";
    if (free && recursive.while === undefined) throw new Error(MSG.CTE_FREE_NEEDS_WHILE);

    // set / while: expressions over the parent ("$prior.X" → o."X") and child ("$X" → e."X") rows.
    const resolve = (name: string) => (name.startsWith("prior.") ? `o.${quoteIdentifier(name.slice(6))}` : `e.${quoteIdentifier(name)}`);
    const set = recursive.set ?? {};
    for (const c of Object.keys(set)) if (!colNames.includes(c)) throw new Error(MSG.CTE_SET_UNKNOWN_COLUMN(c, this._def.anchor.tableName));
    const whereSql = recursive.while === undefined ? "" : ` WHERE ${compileExpression(recursive.while, allBinds, "rw_", resolve, true)}`;

    // Use explicit column names to avoid ORA-01789 column count mismatches
    let anchorWrapped;
    let recursiveSql;

    if (colNames.length > 0) {
      // Explicit column references — more reliable than wildcards in recursive CTEs
      const anchorCols = colNames
        .map((c) => `t0.${quoteIdentifier(c)}`)
        .join(", ");
      const recCols = colNames.map((c) => (c in set ? compileExpression(set[c], allBinds, `rs${colNames.indexOf(c)}_`, resolve) : `e.${quoteIdentifier(c)}`)).join(", ");

      // Replace SELECT clause in anchor to use explicit columns + LVL
      anchorWrapped = anchorSql.replace(
        /SELECT\s+(?:\S+\.\*)?\*?\s+FROM/i,
        `SELECT ${anchorCols}, 1 AS "LVL" FROM`,
      );

      recursiveSql = `SELECT ${recCols}, o."LVL" + 1 AS "LVL" FROM ${quoteIdentifier(recTable)} e JOIN ${quoteIdentifier(this._cteName)} o ON ${joinParts || "1=1"}${whereSql}`;
    } else {
      // Fallback: use wildcard approach
      anchorWrapped = anchorSql;
      if (/SELECT\s+\*\s+FROM/i.test(anchorWrapped)) {
        anchorWrapped = anchorWrapped.replace(
          /SELECT\s+\*\s+FROM/i,
          'SELECT t0.*, 1 AS "LVL" FROM',
        );
      } else if (/SELECT\s+\S+\.\*\s+FROM/i.test(anchorWrapped)) {
        anchorWrapped = anchorWrapped.replace(
          /SELECT\s+(\S+\.\*)\s+FROM/i,
          'SELECT $1, 1 AS "LVL" FROM',
        );
      } else {
        anchorWrapped = anchorWrapped
          .replace(/^SELECT\s+/i, "SELECT ")
          .replace(/FROM/i, ', 1 AS "LVL" FROM');
      }
      recursiveSql = `SELECT e.*, o."LVL" + 1 AS "LVL" FROM ${quoteIdentifier(recTable)} e JOIN ${quoteIdentifier(this._cteName)} o ON ${joinParts || "1=1"}${whereSql}`;
    }

    const cycle = free ? ` CYCLE "LVL" SET "MIRA_CYCLE$" TO 'Y' DEFAULT 'N'` : "";
    // Only the table's columns and LVL (never the cycle mark).
    const outCols = colNames.length && free ? [...colNames, "LVL"].map((c) => quoteIdentifier(c)).join(", ") : "*";
    let selectSql = `SELECT ${outCols} FROM ${quoteIdentifier(this._cteName)}`;

    if (this._sort) {
      const orderBy = Object.entries(this._sort)
        .map(
          ([col, dir]) =>
            `${quoteIdentifier(col)} ${dir === -1 ? "DESC" : "ASC"}`,
        )
        .join(", ");
      selectSql += ` ORDER BY ${orderBy}`;
    }
    if (this._skipVal != null) {
      selectSql += ` OFFSET ${Number(this._skipVal)} ROWS`;
    }
    if (this._limitVal != null) {
      selectSql += ` FETCH FIRST ${Number(this._limitVal)} ROWS ONLY`;
    }

    // Oracle requires a column alias list for recursive CTEs
    const cteColList =
      colNames.length > 0
        ? ` (${colNames.map((c) => quoteIdentifier(c)).join(", ")}, "LVL")`
        : "";

    const body = `\n  ${anchorWrapped}\n  UNION ALL\n  ${recursiveSql}\n`;
    const sql = `WITH ${quoteIdentifier(this._cteName)}${cteColList} AS (${body})${cycle}\n${selectSql}`;

    return { sql, binds: allBinds, body, cycle };
  }

  /** The anchor table's columns, in order (the recursive CTE needs an explicit column list). */
  async _columns(): Promise<string[]> {
    const anchorTableName = this._def.anchor.tableName;
    return this._db.withConnection(async (conn: DbConnection) => {
      const result = await conn.execute<{ COLUMN_NAME: string }>(
        `SELECT COLUMN_NAME FROM USER_TAB_COLUMNS WHERE TABLE_NAME = UPPER(:t) ORDER BY COLUMN_ID`,
        { t: anchorTableName },
        { outFormat: this._db.oracledb.OUT_FORMAT_OBJECT },
      );
      return (result.rows ?? []).map((r) => r.COLUMN_NAME);
    });
  }

  /**
   * Run an aggregation pipeline over the recursive result (group, join, filter the
   * tree), e.g. total quantity per finished product and raw material.
   */
  async aggregate(pipeline: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
    const colNames = await this._columns();
    const built = this._buildSQL(colNames);
    // The CTE's own binds get a prefix so the pipeline's cannot clash with them.
    const own = renameBinds(built.body, built.binds, "rcte_");
    // The pipeline reads a plain view of the CTE (table columns + LVL, no cycle mark).
    const rowsAlias = `${this._cteName}_ROWS`;
    const cols = [...colNames, "LVL"];
    const agg = buildAggregateSQL(rowsAlias, pipeline, this._db as never, "", undefined, [
      { alias: this._cteName, sql: own.sql, cols, suffix: built.cycle },
      { alias: rowsAlias, sql: `SELECT ${cols.map((c) => quoteIdentifier(c)).join(", ")} FROM ${quoteIdentifier(this._cteName)}` },
    ]);
    const binds = { ...own.binds, ...agg.binds };
    return this._db.withConnection(async (conn: DbConnection) => {
      try {
        const result = await conn.execute(agg.sql, binds, { outFormat: this._db.oracledb.OUT_FORMAT_OBJECT, autoCommit: true });
        return (result.rows ?? []) as Array<Record<string, unknown>>;
      } catch (err) {
        throw new Error(MSG.wrapError("RecursiveCTEResult.aggregate", err, agg.sql));
      }
    });
  }

  async toArray<T = Record<string, unknown>>(): Promise<T[]> {
    // Fetch column names from anchor table to build CTE column alias list
    const colNames = await this._columns();

    const { sql, binds } = this._buildSQL(colNames);
    return this._db.withConnection(async (conn: DbConnection) => {
      try {
        const result = await conn.execute(sql, binds, {
          outFormat: this._db.oracledb.OUT_FORMAT_OBJECT,
          autoCommit: true,
        });
        return (result.rows || []) as T[];
      } catch (err) {
        throw new Error(MSG.wrapError("RecursiveCTEResult.toArray", err, sql));
      }
    });
  }
}

/** Map a join type string to Oracle JOIN keyword */
function _resolveJoinType(type: string | undefined) {
  switch ((type || "inner").toLowerCase()) {
    case "left":
      return "LEFT OUTER JOIN";
    case "right":
      return "RIGHT OUTER JOIN";
    case "full":
      return "FULL OUTER JOIN";
    case "inner":
      return "INNER JOIN";
    case "cross":
      return "CROSS JOIN";
    default:
      throw new Error(MSG.JOIN_UNKNOWN_TYPE("CTEResult.join", type));
  }
}

export { withCTE, withRecursiveCTE };
