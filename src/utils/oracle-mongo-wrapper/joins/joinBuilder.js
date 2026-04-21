"use strict";

/**
 * ============================================================================
 * joinBuilder.js — $lookup Stage → Oracle JOIN SQL
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   Translates the $lookup pipeline stage into Oracle JOIN SQL.
 *   $lookup is MongoDB's way of doing JOINs between collections.
 *
 * SUPPORTED JOIN TYPES:
 *   left    → LEFT OUTER JOIN  (default — keep all left rows)
 *   right   → RIGHT OUTER JOIN
 *   full    → FULL OUTER JOIN
 *   inner   → INNER JOIN       (only matching rows)
 *   cross   → CROSS JOIN       (cartesian product)
 *   self    → INNER JOIN t1 JOIN t1 t2  (join table to itself)
 *   natural → NATURAL JOIN     (join on same-named columns)
 *
 * MULTI-CONDITION JOINS:
 *   Pass `on: [{ localField, foreignField }, ...]` for multiple join conditions.
 *
 * EXAMPLE:
 *   buildJoinSQL('"users"', {
 *     from: "orders",
 *     localField: "id",
 *     foreignField: "userId",
 *     as: "o",
 *     joinType: "left"
 *   })
 *   → 'SELECT "users".*, "o".* FROM "users" LEFT OUTER JOIN "orders" "o" ON "users"."id" = "o"."userId"'
 * ============================================================================
 */

const { quoteIdentifier } = require("../utils");

/**
 * Build a JOIN SQL fragment from a $lookup specification.
 *
 * @param {string} source - Current source table/CTE alias (already quoted)
 * @param {Object} lookup - The $lookup stage specification
 * @param {string} lookup.from - Table to join with
 * @param {string} lookup.localField - Column on the source (left) side
 * @param {string} lookup.foreignField - Column on the joined (right) side
 * @param {string} [lookup.as] - Alias for the joined table (defaults to `from`)
 * @param {string} [lookup.joinType='left'] - Join type: left, right, inner, full, cross, self, natural
 * @param {Array} [lookup.on] - Multi-condition join: [{ localField, foreignField }, ...]
 * @param {string[]} [lookup.select] - Columns to take from the joined table (omit to take all)
 * @returns {string} Complete SELECT ... JOIN ... ON ... SQL
 */
function buildJoinSQL(source, lookup) {
    const {
        from,
        localField,
        foreignField,
        as,
        joinType = "left",
        on,
        select,
    } = lookup;
    const joinAlias = as || from;
    const jt = _resolveJoinType(joinType);

    // When `select` is provided, pull only those columns from the right side.
    // This avoids ORA-00918 when the two tables share column names (e.g. USERID).
    const rightCols = Array.isArray(select) && select.length > 0
        ? select.map((col) => `${quoteIdentifier(joinAlias)}.${quoteIdentifier(col)}`).join(", ")
        : `${quoteIdentifier(joinAlias)}.*`;

    let onClause;
    if (on && Array.isArray(on)) {
        // Multi-condition join
        onClause = on
            .map(
                (cond) =>
                    `${source}.${quoteIdentifier(cond.localField)} = ${quoteIdentifier(joinAlias)}.${quoteIdentifier(cond.foreignField)}`,
            )
            .join(" AND ");
    } else if (joinType === "self") {
        // Self-join
        return `SELECT t1.*, t2.* FROM ${quoteIdentifier(from)} t1 INNER JOIN ${quoteIdentifier(from)} t2 ON t1.${quoteIdentifier(foreignField)} = t2.${quoteIdentifier(localField)}`;
    } else if (joinType === "natural") {
        return `SELECT * FROM ${source} NATURAL JOIN ${quoteIdentifier(from)}`;
    } else if (joinType === "cross") {
        return `SELECT ${source}.*, ${quoteIdentifier(joinAlias)}.* FROM ${source} CROSS JOIN ${quoteIdentifier(from)} ${quoteIdentifier(joinAlias)}`;
    } else {
        onClause = `${source}.${quoteIdentifier(localField)} = ${quoteIdentifier(joinAlias)}.${quoteIdentifier(foreignField)}`;
    }

    return `SELECT ${source}.*, ${rightCols} FROM ${source} ${jt} ${quoteIdentifier(from)} ${quoteIdentifier(joinAlias)} ON ${onClause}`;
}

/** Map a join type string to Oracle JOIN keyword */
function _resolveJoinType(type) {
    switch ((type || "left").toLowerCase()) {
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
        case "self":
            return "INNER JOIN";
        case "natural":
            return "NATURAL JOIN";
        default:
            return "LEFT OUTER JOIN";
    }
}

module.exports = { buildJoinSQL };
