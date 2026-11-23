

/**
 * ============================================================================
 * OracleDCL.js — DCL (Data Control Language) Operations
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   Manages Oracle database access permissions using GRANT and REVOKE.
 *
 * OPERATIONS:
 *   grant()  — Give privileges on a table/object to a user or role
 *   revoke() — Remove privileges from a user or role
 *
 * USAGE:
 *   const dcl = new OracleDCL(db);
 *   await dcl.grant(["SELECT", "INSERT"], "orders", "app_user");
 *   await dcl.revoke(["DELETE"], "orders", "app_user");
 *
 * PRIVILEGE HANDLING:
 *   Detects ORA-01031 (insufficient privileges) and similar errors,
 *   throwing descriptive messages explaining what went wrong.
 * ============================================================================
 */

import type { DbConnection } from "../db";
import { quoteIdentifier } from "../utils";
import { oracleMongoWrapperMessages as MSG } from "../../../constants/messages";
const PRIVILEGE_ERROR_CODES = [1031, 942, 1917, 1919];

/**
 * Oracle DCL (Data Control Language) manager.
 * Handles GRANT and REVOKE operations for database permissions.
 */
class OracleDCL {
    declare db: Record<string, any>;
    /**
     * @param {Object} db - db interface from createDb
     */
    constructor(db: Record<string, unknown>) {
        this.db = db;
    }

    /**
     * Grant privileges on a database object to a user or role.
     *
     * @param {string[]} privileges - Privileges to grant: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL']
     * @param {string} on - Table or object name
     * @param {string} to - USER or role name
     * @returns {Promise<{ acknowledged: boolean }>}
     *
     * @example
     *   await dcl.grant(["SELECT", "INSERT"], "orders", "app_readonly");
     */
    async grant(privileges: string[], on: string, to: string): Promise<{ acknowledged: boolean; }> {
        return this.db.withConnection(async (conn: DbConnection) => {
            const privList = privileges.join(", ");
            const sql = `GRANT ${privList} ON ${quoteIdentifier(on)} TO ${quoteIdentifier(to)}`;

            try {
                await conn.execute(sql, {}, { autoCommit: true });
                return { acknowledged: true };
            } catch (err) {
                const code = err.errorNum || err.code;
                if (PRIVILEGE_ERROR_CODES.includes(code)) {
                    throw new Error(MSG.DCL_GRANT_INSUFFICIENT(err, sql));
                }
                throw new Error(MSG.wrapError("OracleDCL.grant", err, sql));
            }
        });
    }

    /**
     * Revoke privileges on a database object from a user or role.
     *
     * @param {string[]} privileges - Privileges to revoke: ['DELETE', 'UPDATE', etc.]
     * @param {string} on - Table or object name
     * @param {string} from - USER or role name
     * @returns {Promise<{ acknowledged: boolean }>}
     *
     * @example
     *   await dcl.revoke(["DELETE", "UPDATE"], "orders", "intern_user");
     */
    async revoke(privileges: string[], on: string, from: string): Promise<{ acknowledged: boolean; }> {
        return this.db.withConnection(async (conn: DbConnection) => {
            const privList = privileges.join(", ");
            const sql = `REVOKE ${privList} ON ${quoteIdentifier(on)} FROM ${quoteIdentifier(from)}`;

            try {
                await conn.execute(sql, {}, { autoCommit: true });
                return { acknowledged: true };
            } catch (err) {
                const code = err.errorNum || err.code;
                if (PRIVILEGE_ERROR_CODES.includes(code)) {
                    throw new Error(MSG.DCL_REVOKE_INSUFFICIENT(err, sql));
                }
                throw new Error(MSG.wrapError("OracleDCL.revoke", err, sql));
            }
        });
    }
}

export { OracleDCL };
