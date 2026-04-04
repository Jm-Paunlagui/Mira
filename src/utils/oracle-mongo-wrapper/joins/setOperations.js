"use strict";

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

const { quoteIdentifier } = require("../utils");
const {
    oracleMongoWrapperMessages: MSG,
} = require("../../../constants/messages");

/**
 * Wraps two QueryBuilder instances with a SQL set operator.
 * Supports chaining: .sort(), .limit(), .skip()
 * Terminal methods: .toArray(), .then() (thenable)
 *
 * BIND VARIABLE SAFETY:
 *   The second query's bind variables are re-keyed with a "set2_" prefix
 *   to prevent collisions with the first query's binds.
 */
class SetResultBuilder {
    /**
     * @param {QueryBuilder} qb1
     * @param {QueryBuilder} qb2
     * @param {string} operator - 'UNION' | 'UNION ALL' | 'INTERSECT' | 'MINUS'
     */
    constructor(qb1, qb2, operator) {
        // Validate column counts if projections are set
        if (qb1._projection && qb2._projection) {
            const count1 = Object.keys(qb1._projection).filter(
                (k) => qb1._projection[k] === 1,
            ).length;
            const count2 = Object.keys(qb2._projection).filter(
                (k) => qb2._projection[k] === 1,
            ).length;
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
    sort(sortSpec) {
        this._sort = sortSpec;
        return this;
    }

    /**
     * @param {number} n
     * @returns {SetResultBuilder}
     */
    limit(n) {
        this._limitVal = n;
        return this;
    }

    /**
     * @param {number} n
     * @returns {SetResultBuilder}
     */
    skip(n) {
        this._skipVal = n;
        return this;
    }

    /**
     * Build the combined SQL.
     * @returns {{ sql: string, binds: Object }}
     */
    _buildSQL() {
        const { sql: sql1, binds: binds1 } = this._qb1._buildSQL();
        const { sql: sql2, binds: binds2Raw } = this._qb2._buildSQL();

        // Re-key binds2 to avoid collisions with binds1
        const binds2 = {};
        const keyMap = {};
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
    then(resolve, reject) {
        return this.toArray().then(resolve, reject);
    }

    /**
     * Execute the set operation and return all rows.
     * @returns {Promise<Array>}
     */
    async toArray() {
        const db = this._qb1.db;
        const conn = this._qb1._conn;
        const { sql, binds } = this._buildSQL();

        const exec = async (connection) => {
            try {
                const result = await connection.execute(sql, binds, {
                    outFormat: db.oracledb.OUT_FORMAT_OBJECT,
                    autoCommit: true,
                });
                return result.rows || [];
            } catch (err) {
                throw new Error(
                    MSG.wrapError("SetResultBuilder.toArray", err, sql),
                );
            }
        };

        if (conn) return exec(conn);
        return db.withConnection(exec);
    }
}

module.exports = { SetResultBuilder };
