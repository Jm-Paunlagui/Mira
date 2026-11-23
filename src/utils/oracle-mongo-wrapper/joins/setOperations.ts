

/**
 * ============================================================================
 * setOperations.js — UNION / INTERSECT / MINUS Set Operations
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   Combines the results of two QueryBuilder queries using SQL set operators:
 *     UNION      — combine results, remove duplicates
 *     UNION ALL  — combine results, keep duplicates
 *     INTERSECT  — only rows that appear in BOTH queries
 *     MINUS      — rows in the first query but NOT in the second
 *
 * HOW IT WORKS:
 *   SetResultBuilder wraps two QueryBuilder instances with a set operator.
 *   It supports chaining (.sort(), .limit(), .skip()) and execution (.toArray()).
 *   It automatically re-keys bind variables from the second query to prevent
 *   naming collisions.
 *
 * USAGE:
 *   const result = await OracleCollection.union(
 *     users.find({ dept: "A" }).project({ name: 1 }),
 *     users.find({ dept: "B" }).project({ name: 1 })
 *   ).sort({ name: 1 }).toArray();
 *
 * IMPORTANT:
 *   Both queries MUST have the same number of columns (Oracle requirement).
 *   The constructor validates this when projections are set.
 *
 * THENABLE:
 *   SetResultBuilder has a .then() method, so you can await it directly:
 *     const rows = await OracleCollection.union(qb1, qb2);
 * ============================================================================
 */

import type { DbConnection } from "../db";
import type { QueryBuilder } from "../core/QueryBuilder";
import { quoteIdentifier } from "../utils";
import { oracleMongoWrapperMessages as MSG } from "../../../constants/messages";

/**
 * Wraps two QueryBuilder instances with a SQL set operator.
 * Supports chaining: .sort(), .limit(), .skip()
 * Terminal methods: .toArray(), .then() (thenable)
 *
 * BIND VARIABLE SAFETY:
 *   The second query's bind variables are re-keyed with a "set2_" prefix
 *   to prevent collisions with the first query's binds.
 */
/** limit/skip are spliced into SQL, so only a non-negative integer is accepted (CWE-89). */
function _rowCount(what: string, n: unknown): number {
  if (!Number.isInteger(n) || (n as number) < 0) throw new TypeError(MSG.INVALID_ROW_COUNT(`SetResultBuilder.${what}`, what, n));
  return n as number;
}

class SetResultBuilder {
  declare _skipVal: unknown;
  declare _limitVal: unknown;
  declare _sort: unknown;
  declare _operator: string;
  declare _qb2: QueryBuilder;
  declare _qb1: QueryBuilder;
  /**
   * @param {QueryBuilder} qb1
   * @param {QueryBuilder} qb2
   * @param {string} operator - 'UNION' | 'UNION ALL' | 'INTERSECT' | 'MINUS'
   */
  constructor(qb1: QueryBuilder, qb2: QueryBuilder, operator: string) {
    // Validate column counts if projections are set
    const p1 = qb1._projection;
    const p2 = qb2._projection;
    if (p1 && p2) {
      const count1 = Object.keys(p1).filter((k) => p1[k] === 1).length;
      const count2 = Object.keys(p2).filter((k) => p2[k] === 1).length;
      if (count1 !== count2) {
        throw new Error(MSG.SET_OP_COLUMN_COUNT_MISMATCH);
      }
    }
    this._qb1 = qb1;
    this._qb2 = qb2;
    this._operator = operator;
    this._sort = null;
    this._limitVal = null;
    this._skipVal = null;
  }

  /**
   * @param {Object} sortSpec - { col: 1|-1 }
   * @returns {SetResultBuilder}
   */
  sort(sortSpec: Record<string, unknown>): SetResultBuilder {
    this._sort = sortSpec;
    return this;
  }

  /**
   * @param {number} n
   * @returns {SetResultBuilder}
   */
  limit(n: number): SetResultBuilder {
    this._limitVal = _rowCount("limit", n);
    return this;
  }

  /**
   * @param {number} n
   * @returns {SetResultBuilder}
   */
  skip(n: number): SetResultBuilder {
    this._skipVal = _rowCount("skip", n);
    return this;
  }

  /**
   * Build the combined SQL.
   * @returns {{ sql: string, binds: Object }}
   */
  _buildSQL(): { sql: string; binds: Record<string, unknown>; } {
    const { sql: sql1, binds: binds1 } = this._qb1._buildSQL();
    const { sql: sql2, binds: binds2Raw } = this._qb2._buildSQL();

    // Re-key binds2 to avoid collisions with binds1
    const binds2: Record<string, unknown> = {};
    const keyMap: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(binds2Raw)) {
      const newKey = `set2_${k}`;
      binds2[newKey] = v;
      keyMap[k] = newKey;
    }

    // Replace bind references in sql2
    let sql2Remapped = sql2;
    for (const [oldKey, newKey] of Object.entries(keyMap)) {
      sql2Remapped = sql2Remapped.replace(
        new RegExp(`:${oldKey}\\b`, "g"),
        `:${newKey}`,
      );
    }

    let sql = `(${sql1})\n${this._operator}\n(${sql2Remapped})`;

    if (this._sort || this._skipVal != null || this._limitVal != null) {
      sql = `SELECT * FROM (${sql})`;
    }

    if (this._sort) {
      const orderBy = Object.entries(this._sort)
        .map(
          ([col, dir]) =>
            `${quoteIdentifier(col)} ${dir === -1 ? "DESC" : "ASC"}`,
        )
        .join(", ");
      sql += ` ORDER BY ${orderBy}`;
    }

    if (this._skipVal != null) {
      sql += ` OFFSET ${this._skipVal} ROWS`;
    }
    if (this._limitVal != null) {
      sql += ` FETCH FIRST ${this._limitVal} ROWS ONLY`;
    }

    return { sql, binds: { ...binds1, ...binds2 } };
  }

  /**
   * Make SetResultBuilder thenable so `await union(...)` returns rows directly.
   */
  then(resolve: any, reject: any) {
    return this.toArray().then(resolve, reject);
  }

  /**
   * Execute the set operation and return all rows.
   * @returns {Promise<Array>}
   */
  async toArray(): Promise<Array<unknown>> {
    const db = this._qb1.db;
    const conn = this._qb1._conn;
    const { sql, binds } = this._buildSQL();

    const exec = async (connection: DbConnection) => {
      try {
        // On a session connection, committing would end the caller's
        // transaction (and release its locks); only a pooled conn commits.
        const result = await connection.execute(sql, binds, {
          outFormat: db.oracledb.OUT_FORMAT_OBJECT,
          autoCommit: !conn,
        });
        return result.rows || [];
      } catch (err) {
        throw new Error(MSG.wrapError("SetResultBuilder.toArray", err, sql));
      }
    };

    if (conn) return exec(conn);
    return db.withConnection(exec);
  }
}

export { SetResultBuilder };
