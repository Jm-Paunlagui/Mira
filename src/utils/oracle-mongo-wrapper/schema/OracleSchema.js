"use strict";

/**
 * ============================================================================
 * OracleSchema.js — DDL (Data Definition Language) Operations
 * ============================================================================
 *
 * WHAT THIS FILE DOES:
 *   Provides a class for managing Oracle database schema objects:
 *   tables, views, sequences, and schemas.
 *
 * AVAILABLE OPERATIONS:
 *   createTable()    — CREATE TABLE with full column spec (PK, auto-increment, FK, etc.)
 *   alterTable()     — ALTER TABLE: add/drop/modify/rename columns, add/drop constraints
 *   dropTable()      — DROP TABLE (with optional CASCADE CONSTRAINTS PURGE)
 *   truncateTable()  — TRUNCATE TABLE (remove all rows instantly)
 *   renameTable()    — RENAME table
 *   createView()     — CREATE [OR REPLACE] [FORCE] VIEW from a QueryBuilder or raw SQL
 *   dropView()       — DROP VIEW
 *   createSequence() — CREATE SEQUENCE (for generating unique IDs)
 *   createSchema()   — CREATE SCHEMA AUTHORIZATION
 *
 * USAGE:
 *   const schema = new OracleSchema(db);
 *
 *   await schema.createTable("users", {
 *     id:    { type: "NUMBER", primaryKey: true, autoIncrement: true },
 *     name:  { type: "VARCHAR2(100)", notNull: true },
 *     email: { type: "VARCHAR2(200)" },
 *     deptId: { type: "NUMBER", references: { table: "departments", column: "id" } }
 *   });
 *
 *   await schema.alterTable("users", { addColumn: { phone: "VARCHAR2(20)" } });
 *   await schema.dropTable("temp_data", { cascade: true, ifExists: true });
 *
 * ifNotExists / ifExists:
 *   Oracle doesn't natively support IF NOT EXISTS / IF EXISTS for DDL.
 *   These options wrap the DDL in PL/SQL exception handlers that catch
 *   ORA-00955 (already exists) or ORA-00942 (does not exist).
 * ============================================================================
 */

const { quoteIdentifier } = require("../utils");
const {
    oracleMongoWrapperMessages: MSG,
} = require("../../../constants/messages");

/**
 * Oracle DDL (Data Definition Language) manager.
 * All methods use db.withConnection() to borrow a connection from the pool.
 * All DDL statements use autoCommit: true (DDL is auto-committed by Oracle anyway).
 */
class OracleSchema {
    /**
     * @param {Object} db - db interface from createDb
     */
    constructor(db) {
        this.db = db;
    }

    /**
     * Create a new table with column definitions.
     *
     * Each column can have:
     *   type          — Oracle type: NUMBER, VARCHAR2(100), DATE, CLOB, etc.
     *   primaryKey    — Mark as PRIMARY KEY
     *   autoIncrement — GENERATED ALWAYS AS IDENTITY (Oracle 12c+)
     *   notNull       — NOT NULL constraint
     *   default       — DEFAULT value (raw SQL expression)
     *   check         — CHECK constraint (raw SQL condition)
     *   references    — FOREIGN KEY: { table, column }
     *
     * @param {string} tableName
     * @param {Object} columns - Column definitions
     * @param {Object} [options] - { ifNotExists: true } to silently skip if table exists
     * @returns {Promise<{ acknowledged: boolean }>}
     *
     * @example
     *   await schema.createTable("products", {
     *     id:    { type: "NUMBER", primaryKey: true, autoIncrement: true },
     *     name:  { type: "VARCHAR2(200)", notNull: true },
     *     price: { type: "NUMBER(10,2)", check: "price > 0" },
     *     categoryId: { type: "NUMBER", references: { table: "categories", column: "id" } }
     *   }, { ifNotExists: true });
     */
    async createTable(tableName, columns, options = {}) {
        return this.db.withConnection(async (conn) => {
            const colDefs = [];
            const constraints = [];

            for (const [colName, spec] of Object.entries(columns)) {
                const parts = [quoteIdentifier(colName), spec.type];

                if (spec.autoIncrement) {
                    parts.push("GENERATED ALWAYS AS IDENTITY");
                }
                if (spec.primaryKey) {
                    parts.push("PRIMARY KEY");
                }
                if (spec.notNull) {
                    parts.push("NOT NULL");
                }
                if (spec.default != null) {
                    parts.push(`DEFAULT ${spec.default}`);
                }
                if (spec.check) {
                    parts.push(`CHECK (${spec.check})`);
                }
                if (spec.references) {
                    parts.push(
                        `REFERENCES ${quoteIdentifier(spec.references.table)}(${quoteIdentifier(spec.references.column)})`,
                    );
                }

                colDefs.push(parts.join(" "));
            }

            const allDefs = [...colDefs, ...constraints].join(", ");
            let sql = `CREATE TABLE ${quoteIdentifier(tableName)} (${allDefs})`;

            if (options.ifNotExists) {
                // Wrap in PL/SQL block to check existence
                sql = `BEGIN EXECUTE IMMEDIATE '${sql.replace(/'/g, "''")}'; EXCEPTION WHEN OTHERS THEN IF SQLCODE = -955 THEN NULL; ELSE RAISE; END IF; END;`;
            }

            try {
                await conn.execute(sql, {}, { autoCommit: true });
                return { acknowledged: true };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleSchema.createTable", err, sql),
                );
            }
        });
    }

    /**
     * Alter an existing table's structure.
     *
     * Supported operations (pass ONE per call):
     *   addColumn:      { colName: "TYPE" }       — ADD column(s)
     *   dropColumn:     "colName"                  — DROP a column
     *   modifyColumn:   { colName: "NEW_TYPE" }    — MODIFY column type
     *   renameColumn:   { from: "old", to: "new" } — RENAME a column
     *   addConstraint:  { type: "UNIQUE", columns: [...], name: "..." }
     *   dropConstraint: "constraintName"
     *
     * @param {string} tableName
     * @param {Object} operation - The alteration to perform
     * @returns {Promise<{ acknowledged: boolean }>}
     *
     * @example
     *   await schema.alterTable("users", { addColumn: { phone: "VARCHAR2(20)" } });
     *   await schema.alterTable("users", { renameColumn: { from: "phone", to: "mobile" } });
     */
    async alterTable(tableName, operation) {
        return this.db.withConnection(async (conn) => {
            let sql;

            if (operation.addColumn) {
                const entries = Object.entries(operation.addColumn);
                const colDefs = entries
                    .map(([col, type]) => `${quoteIdentifier(col)} ${type}`)
                    .join(", ");
                sql = `ALTER TABLE ${quoteIdentifier(tableName)} ADD (${colDefs})`;
            } else if (operation.dropColumn) {
                const col =
                    typeof operation.dropColumn === "string"
                        ? operation.dropColumn
                        : operation.dropColumn;
                sql = `ALTER TABLE ${quoteIdentifier(tableName)} DROP COLUMN ${quoteIdentifier(col)}`;
            } else if (operation.modifyColumn) {
                const entries = Object.entries(operation.modifyColumn);
                const colDefs = entries
                    .map(([col, type]) => `${quoteIdentifier(col)} ${type}`)
                    .join(", ");
                sql = `ALTER TABLE ${quoteIdentifier(tableName)} MODIFY (${colDefs})`;
            } else if (operation.renameColumn) {
                const { from, to } = operation.renameColumn;
                sql = `ALTER TABLE ${quoteIdentifier(tableName)} RENAME COLUMN ${quoteIdentifier(from)} TO ${quoteIdentifier(to)}`;
            } else if (operation.addConstraint) {
                const { type, columns, name } = operation.addConstraint;
                const constraintName =
                    name || `${type}_${tableName}_${columns.join("_")}`;
                const colList = columns.map(quoteIdentifier).join(", ");
                sql = `ALTER TABLE ${quoteIdentifier(tableName)} ADD CONSTRAINT ${quoteIdentifier(constraintName)} ${type} (${colList})`;
            } else if (operation.dropConstraint) {
                sql = `ALTER TABLE ${quoteIdentifier(tableName)} DROP CONSTRAINT ${quoteIdentifier(operation.dropConstraint)}`;
            } else {
                throw new Error(MSG.SCHEMA_ALTER_TABLE_UNKNOWN_OP);
            }

            try {
                await conn.execute(sql, {}, { autoCommit: true });
                return { acknowledged: true };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleSchema.alterTable", err, sql),
                );
            }
        });
    }

    /**
     * Drop (delete) a table permanently.
     *
     * @param {string} tableName
     * @param {Object} [options]
     * @param {boolean} [options.cascade] - CASCADE CONSTRAINTS PURGE (remove FKs + purge from recycle bin)
     * @param {boolean} [options.ifExists] - Silently skip if table doesn't exist
     * @returns {Promise<{ acknowledged: boolean }>}
     *
     * @example
     *   await schema.dropTable("temp_data", { cascade: true, ifExists: true });
     */
    async dropTable(tableName, options = {}) {
        return this.db.withConnection(async (conn) => {
            let suffix = "";
            if (options.cascade) suffix = " CASCADE CONSTRAINTS PURGE";

            let sql = `DROP TABLE ${quoteIdentifier(tableName)}${suffix}`;

            if (options.ifExists) {
                sql = `BEGIN EXECUTE IMMEDIATE '${sql.replace(/'/g, "''")}'; EXCEPTION WHEN OTHERS THEN IF SQLCODE = -942 THEN NULL; ELSE RAISE; END IF; END;`;
            }

            try {
                await conn.execute(sql, {}, { autoCommit: true });
                return { acknowledged: true };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleSchema.dropTable", err, sql),
                );
            }
        });
    }

    /**
     * Truncate a table.
     * @param {string} tableName
     * @returns {Promise<{ acknowledged: boolean }>}
     */
    async truncateTable(tableName) {
        return this.db.withConnection(async (conn) => {
            const sql = `TRUNCATE TABLE ${quoteIdentifier(tableName)}`;
            try {
                await conn.execute(sql, {}, { autoCommit: true });
                return { acknowledged: true };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleSchema.truncateTable", err, sql),
                );
            }
        });
    }

    /**
     * Rename a table.
     * @param {string} oldName
     * @param {string} newName
     * @returns {Promise<{ acknowledged: boolean }>}
     */
    async renameTable(oldName, newName) {
        return this.db.withConnection(async (conn) => {
            const sql = `RENAME ${quoteIdentifier(oldName)} TO ${quoteIdentifier(newName)}`;
            try {
                await conn.execute(sql, {}, { autoCommit: true });
                return { acknowledged: true };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleSchema.renameTable", err, sql),
                );
            }
        });
    }

    /**
     * Create a view from a QueryBuilder query or raw SQL string.
     *
     * @param {string} viewName
     * @param {QueryBuilder|string} queryBuilderOrSQL - The SELECT to base the view on
     * @param {Object} [options]
     * @param {boolean} [options.orReplace] - CREATE OR REPLACE (overwrite if exists)
     * @param {boolean} [options.force] - FORCE (create even if referenced tables don't exist yet)
     * @returns {Promise<{ acknowledged: boolean }>}
     *
     * @example
     *   await schema.createView("active_users",
     *     users.find({ status: "active" }).project({ id: 1, name: 1, email: 1 }),
     *     { orReplace: true }
     *   );
     */
    async createView(viewName, queryBuilderOrSQL, options = {}) {
        return this.db.withConnection(async (conn) => {
            let selectSql;
            let binds = {};

            if (typeof queryBuilderOrSQL === "string") {
                selectSql = queryBuilderOrSQL;
            } else if (
                queryBuilderOrSQL &&
                typeof queryBuilderOrSQL._buildSQL === "function"
            ) {
                const built = queryBuilderOrSQL._buildSQL();
                selectSql = built.sql;
                binds = built.binds;
            } else {
                throw new Error(MSG.SCHEMA_CREATE_VIEW_INVALID_INPUT);
            }

            let prefix = "CREATE";
            if (options.orReplace) prefix = "CREATE OR REPLACE";
            if (options.force) prefix += " FORCE";

            const sql = `${prefix} VIEW ${quoteIdentifier(viewName)} AS ${selectSql}`;

            try {
                await conn.execute(sql, binds, { autoCommit: true });
                return { acknowledged: true };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleSchema.createView", err, sql),
                );
            }
        });
    }

    /**
     * Drop a view.
     * @param {string} viewName
     * @param {Object} [options] - ifExists
     * @returns {Promise<{ acknowledged: boolean }>}
     */
    async dropView(viewName, options = {}) {
        return this.db.withConnection(async (conn) => {
            let sql = `DROP VIEW ${quoteIdentifier(viewName)}`;

            if (options.ifExists) {
                sql = `BEGIN EXECUTE IMMEDIATE '${sql.replace(/'/g, "''")}'; EXCEPTION WHEN OTHERS THEN IF SQLCODE = -942 THEN NULL; ELSE RAISE; END IF; END;`;
            }

            try {
                await conn.execute(sql, {}, { autoCommit: true });
                return { acknowledged: true };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleSchema.dropView", err, sql),
                );
            }
        });
    }

    /**
     * Create an Oracle sequence for generating unique IDs.
     *
     * @param {string} name - Sequence name
     * @param {Object} [options]
     * @param {number} [options.startWith] - First value (default: 1)
     * @param {number} [options.incrementBy] - Step size (default: 1)
     * @param {number} [options.maxValue] - Maximum value
     * @param {number} [options.minValue] - Minimum value
     * @param {boolean} [options.cycle] - Restart after reaching max?
     * @param {number} [options.cache] - Number of values to cache in memory
     * @returns {Promise<{ acknowledged: boolean }>}
     *
     * @example
     *   await schema.createSequence("order_seq", { startWith: 1000, incrementBy: 1 });
     */
    async createSequence(name, options = {}) {
        return this.db.withConnection(async (conn) => {
            const parts = [`CREATE SEQUENCE ${quoteIdentifier(name)}`];

            if (options.startWith != null)
                parts.push(`START WITH ${options.startWith}`);
            if (options.incrementBy != null)
                parts.push(`INCREMENT BY ${options.incrementBy}`);
            if (options.maxValue != null)
                parts.push(`MAXVALUE ${options.maxValue}`);
            if (options.minValue != null)
                parts.push(`MINVALUE ${options.minValue}`);
            parts.push(options.cycle ? "CYCLE" : "NOCYCLE");
            if (options.cache != null) parts.push(`CACHE ${options.cache}`);

            const sql = parts.join(" ");

            try {
                await conn.execute(sql, {}, { autoCommit: true });
                return { acknowledged: true };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleSchema.createSequence", err, sql),
                );
            }
        });
    }

    /**
     * Create a schema authorization.
     * @param {string} schemaName
     * @returns {Promise<{ acknowledged: boolean }>}
     */
    async createSchema(schemaName) {
        return this.db.withConnection(async (conn) => {
            const sql = `CREATE SCHEMA AUTHORIZATION ${quoteIdentifier(schemaName)}`;
            try {
                await conn.execute(sql, {}, { autoCommit: true });
                return { acknowledged: true };
            } catch (err) {
                throw new Error(
                    MSG.wrapError("OracleSchema.createSchema", err, sql),
                );
            }
        });
    }
}

module.exports = { OracleSchema };
