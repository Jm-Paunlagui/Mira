"use strict";

/**
 * ============================================================================
 * updateParser.js — MongoDB Update Operators → Oracle SET Clause Translator
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   Takes MongoDB-style update operators and converts them into an Oracle SQL
 *   SET clause with bind variables.
 *
 * THE BIG PICTURE:
 *   When you write:   { $set: { name: "Ana" }, $inc: { loginCount: 1 } }
 *   This file produces:
 *     SET clause: 'SET "name" = :upd_name_0, "loginCount" = "loginCount" + :upd_loginCount_1'
 *     Bind values: { upd_name_0: "Ana", upd_loginCount_1: 1 }
 *
 * SUPPORTED UPDATE OPERATORS:
 *   ┌──────────────┬──────────────────────────────────────────────────────────┐
 *   │ Operator     │ What it does                                            │
 *   ├──────────────┼──────────────────────────────────────────────────────────┤
 *   │ $set         │ Set a field to a specific value                         │
 *   │              │ { $set: { name: "Ana" } } → "name" = :val               │
 *   │ $unset       │ Set a field to NULL (remove its value)                  │
 *   │              │ { $unset: { temp: 1 } } → "temp" = NULL                 │
 *   │ $inc         │ Increment a number field                                │
 *   │              │ { $inc: { count: 1 } } → "count" = "count" + :val       │
 *   │ $mul         │ Multiply a number field                                 │
 *   │              │ { $mul: { price: 1.1 } } → "price" = "price" * :val     │
 *   │ $min         │ Set to the LESSER of current value and given value      │
 *   │              │ { $min: { score: 50 } } → "score" = LEAST("score", :val)│
 *   │ $max         │ Set to the GREATER of current value and given value     │
 *   │              │ { $max: { score: 100 } } → GREATEST("score", :val)      │
 *   │ $currentDate │ Set a field to the current date/time (SYSDATE)          │
 *   │              │ { $currentDate: { updatedAt: true } } → SYSDATE         │
 *   │ $rename      │ NOT SUPPORTED by Oracle — throws an error               │
 *   └──────────────┴──────────────────────────────────────────────────────────┘
 *
 * BIND VARIABLE NAMING:
 *   All bind variables from this parser are prefixed with "upd_" to avoid
 *   collisions with bind variables from the filter parser (prefixed "where_").
 *   Example: upd_name_0, upd_loginCount_1
 * ============================================================================
 */

const { quoteIdentifier } = require("../utils");
const {
    oracleMongoWrapperMessages: MSG,
} = require("../../../constants/messages");

// ─── _createCounter ─────────────────────────────────────────────
/**
 * Creates a fresh counter for generating unique update bind variable names.
 *
 * Same concept as _createCounter in filterParser.js — each parseUpdate() call
 * gets its own counter so concurrent calls don't collide on bind names.
 *
 * All names are prefixed with "upd_" to distinguish from WHERE binds.
 *
 * @returns {{ next: (prefix: string) => string }} Counter with a next() method
 *
 * @example
 *   const counter = _createCounter();
 *   counter.next("name")    // → "upd_name_0"
 *   counter.next("status")  // → "upd_status_1"
 */
function _createCounter() {
    let c = 0;
    return {
        next(prefix) {
            return `upd_${prefix}_${c++}`;
        },
    };
}

/**
 * Reset update bind counter — no-op.
 * Kept for backward compatibility (counters are now per-call).
 */
function resetUpdateCounter() {}

// ─── parseUpdate (MAIN ENTRY POINT) ─────────────────────────────
/**
 * Converts a MongoDB-style update object into an Oracle SET clause.
 *
 * This is the main function you call from outside this file.
 * It iterates each update operator ($set, $inc, etc.) and builds
 * the corresponding SQL SET fragments.
 *
 * @param {Object} update - MongoDB-style update object with $ operators
 * @returns {{ setClause: string, binds: Object }}
 *   - setClause: SQL SET clause (e.g. 'SET "name" = :upd_name_0')
 *   - binds: Object mapping bind names to values (e.g. { upd_name_0: "Ana" })
 *
 * @throws {Error} If:
 *   - The update object is empty or not an object
 *   - It contains $rename (not supported by Oracle)
 *   - It contains an unrecognized operator
 *
 * @example
 *   parseUpdate({ $set: { name: "Ana" }, $inc: { loginCount: 1 } })
 *   // → {
 *   //     setClause: 'SET "name" = :upd_name_0, "loginCount" = "loginCount" + :upd_loginCount_1',
 *   //     binds: { upd_name_0: "Ana", upd_loginCount_1: 1 }
 *   //   }
 *
 *   parseUpdate({ $currentDate: { updatedAt: true } })
 *   // → { setClause: 'SET "updatedAt" = SYSDATE', binds: {} }
 */
function parseUpdate(update) {
    if (
        !update ||
        typeof update !== "object" ||
        Object.keys(update).length === 0
    ) {
        throw new Error(MSG.UPDATE_EMPTY);
    }

    const counter = _createCounter();
    const parts = [];
    const binds = {};
    let hasOp = false;

    for (const [op, fields] of Object.entries(update)) {
        if (op === "$set") {
            hasOp = true;
            for (const [field, val] of Object.entries(fields)) {
                const bname = counter.next(field);
                binds[bname] = val;
                parts.push(`${quoteIdentifier(field)} = :${bname}`);
            }
        } else if (op === "$unset") {
            hasOp = true;
            for (const field of Object.keys(fields)) {
                parts.push(`${quoteIdentifier(field)} = NULL`);
            }
        } else if (op === "$inc") {
            hasOp = true;
            for (const [field, val] of Object.entries(fields)) {
                const bname = counter.next(field);
                binds[bname] = val;
                parts.push(
                    `${quoteIdentifier(field)} = ${quoteIdentifier(field)} + :${bname}`,
                );
            }
        } else if (op === "$mul") {
            hasOp = true;
            for (const [field, val] of Object.entries(fields)) {
                const bname = counter.next(field);
                binds[bname] = val;
                parts.push(
                    `${quoteIdentifier(field)} = ${quoteIdentifier(field)} * :${bname}`,
                );
            }
        } else if (op === "$min") {
            hasOp = true;
            for (const [field, val] of Object.entries(fields)) {
                const bname = counter.next(field);
                binds[bname] = val;
                parts.push(
                    `${quoteIdentifier(field)} = LEAST(${quoteIdentifier(field)}, :${bname})`,
                );
            }
        } else if (op === "$max") {
            hasOp = true;
            for (const [field, val] of Object.entries(fields)) {
                const bname = counter.next(field);
                binds[bname] = val;
                parts.push(
                    `${quoteIdentifier(field)} = GREATEST(${quoteIdentifier(field)}, :${bname})`,
                );
            }
        } else if (op === "$currentDate") {
            hasOp = true;
            for (const field of Object.keys(fields)) {
                parts.push(`${quoteIdentifier(field)} = SYSDATE`);
            }
        } else if (op === "$rename") {
            throw new Error(MSG.UPDATE_RENAME_NOT_SUPPORTED);
        } else {
            throw new Error(MSG.UPDATE_UNSUPPORTED_OPERATOR(op));
        }
    }

    if (!hasOp) {
        throw new Error(MSG.UPDATE_NO_OPERATOR);
    }

    return {
        setClause: `SET ${parts.join(", ")}`,
        binds,
    };
}

module.exports = { parseUpdate, resetUpdateCounter };
