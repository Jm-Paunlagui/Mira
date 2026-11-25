

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

import type { DbConnection } from "../db";
import type { QueryBuilder } from "../core/QueryBuilder";
import { quoteIdentifier, inlineBinds } from "../utils";
import { oracleMongoWrapperMessages as MSG } from "../../../constants/messages";

/**
 * Oracle DDL (Data Definition Language) manager.
 * All methods use db.withConnection() to borrow a connection from the pool.
 * All DDL statements use autoCommit: true (DDL is auto-committed by Oracle anyway).
 */
/** One column in createTable(): an Oracle type plus optional constraints (developer-written DDL). */
type ColumnSpec = {
  type: string;
  autoIncrement?: boolean;
  primaryKey?: boolean;
  notNull?: boolean;
  default?: string | number;
  check?: string;
  references?: { table: string; column: string };
};
/** Exactly one ALTER TABLE operation (column -> Oracle type for add/modify). */
type AlterOperation = {
  addColumn?: Record<string, string>;
  dropColumn?: string;
  modifyColumn?: Record<string, string>;
  renameColumn?: { from: string; to: string };
  addConstraint?: { type: string; columns: string[]; name?: string };
  dropConstraint?: string;
};

class OracleSchema {
  declare db: import("../db").WrapperDb;
  /**
   * @param {Object} db - db interface from createDb
   */
  constructor(db: import("../db").WrapperDb) {
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
  async createTable(tableName: string, columns: Record<string, ColumnSpec>, options: Record<string, unknown> = {}): Promise<{ acknowledged: boolean; }> {
    return this.db.withConnection(async (conn: DbConnection) => {
      const colDefs: string[] = [];
      const constraints: unknown[] = [];

      // The JSON column type arrived in 21c; 19c answers ORA-00902 "invalid datatype".
      const jsonTyped = Object.entries(columns).filter(([, spec]) => /^\s*JSON\s*$/i.test(spec.type)).map(([name]) => name);
      if (jsonTyped.length > 0 && conn.oracleServerVersion && conn.oracleServerVersion < 2100000000) {
        throw new Error(MSG.JSON_TYPE_NEEDS_21C(tableName, jsonTyped.join(", "), conn.oracleServerVersionString));
      }

      for (const [colName, spec] of Object.entries(columns)) {
        const parts = [quoteIdentifier(colName), spec.type];

        if (spec.autoIncrement) {
          parts.push("GENERATED ALWAYS AS IDENTITY");
        }
        // Oracle's column grammar puts DEFAULT before every inline constraint:
        // "NOT NULL DEFAULT 0" or "PRIMARY KEY DEFAULT 1" is ORA-00907.
        if (spec.default != null) {
          parts.push(`DEFAULT ${spec.default}`);
        }
        if (spec.primaryKey) {
          parts.push("PRIMARY KEY");
        }
        if (spec.notNull) {
          parts.push("NOT NULL");
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

      const allDefs: string = [...colDefs, ...constraints].join(", ");
      let sql = `CREATE TABLE ${quoteIdentifier(tableName)} (${allDefs})`;

      if (options.ifNotExists) {
        // Wrap in PL/SQL block to check existence
        sql = `BEGIN EXECUTE IMMEDIATE '${sql.replace(/'/g, "''")}'; EXCEPTION WHEN OTHERS THEN IF SQLCODE = -955 THEN NULL; ELSE RAISE; END IF; END;`;
      }

      try {
        await conn.execute(sql, {}, { autoCommit: true });
        return { acknowledged: true };
      } catch (err) {
        throw new Error(MSG.wrapError("OracleSchema.createTable", err, sql));
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
  async alterTable(tableName: string, operation: AlterOperation): Promise<{ acknowledged: boolean; }> {
    return this.db.withConnection(async (conn: DbConnection) => {
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
        throw new Error(MSG.wrapError("OracleSchema.alterTable", err, sql));
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
  async dropTable(tableName: string, options: { cascade?: boolean; ifExists?: boolean; } = {}): Promise<{ acknowledged: boolean; }> {
    return this.db.withConnection(async (conn: DbConnection) => {
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
        throw new Error(MSG.wrapError("OracleSchema.dropTable", err, sql));
      }
    });
  }

  /**
   * Truncate a table.
   * @param {string} tableName
   * @returns {Promise<{ acknowledged: boolean }>}
   */
  async truncateTable(tableName: string): Promise<{ acknowledged: boolean; }> {
    return this.db.withConnection(async (conn: DbConnection) => {
      const sql = `TRUNCATE TABLE ${quoteIdentifier(tableName)}`;
      try {
        await conn.execute(sql, {}, { autoCommit: true });
        return { acknowledged: true };
      } catch (err) {
        throw new Error(MSG.wrapError("OracleSchema.truncateTable", err, sql));
      }
    });
  }

  /**
   * Rename a table.
   * @param {string} oldName
   * @param {string} newName
   * @returns {Promise<{ acknowledged: boolean }>}
   */
  async renameTable(oldName: string, newName: string): Promise<{ acknowledged: boolean; }> {
    return this.db.withConnection(async (conn: DbConnection) => {
      const sql = `RENAME ${quoteIdentifier(oldName)} TO ${quoteIdentifier(newName)}`;
      try {
        await conn.execute(sql, {}, { autoCommit: true });
        return { acknowledged: true };
      } catch (err) {
        throw new Error(MSG.wrapError("OracleSchema.renameTable", err, sql));
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
  async createView(viewName: string, queryBuilderOrSQL: QueryBuilder | string, options: { orReplace?: boolean; force?: boolean; } = {}): Promise<{ acknowledged: boolean; }> {
    return this.db.withConnection(async (conn: DbConnection) => {
      let selectSql;

      if (typeof queryBuilderOrSQL === "string") {
        selectSql = queryBuilderOrSQL;
      } else if (
        queryBuilderOrSQL &&
        typeof queryBuilderOrSQL._buildSQL === "function"
      ) {
        // DDL cannot take bind values: the filter values become literals.
        const built = queryBuilderOrSQL._buildSQL();
        selectSql = inlineBinds(built.sql, built.binds, "OracleSchema.createView");
      } else {
        throw new Error(MSG.SCHEMA_CREATE_VIEW_INVALID_INPUT);
      }

      let prefix = "CREATE";
      if (options.orReplace) prefix = "CREATE OR REPLACE";
      if (options.force) prefix += " FORCE";

      const sql = `${prefix} VIEW ${quoteIdentifier(viewName)} AS ${selectSql}`;

      try {
        await conn.execute(sql, {}, { autoCommit: true });
        return { acknowledged: true };
      } catch (err) {
        throw new Error(MSG.wrapError("OracleSchema.createView", err, sql));
      }
    });
  }

  /**
   * Drop a view.
   * @param {string} viewName
   * @param {Object} [options] - ifExists
   * @returns {Promise<{ acknowledged: boolean }>}
   */
  async dropView(viewName: string, options: Record<string, unknown> = {}): Promise<{ acknowledged: boolean; }> {
    return this.db.withConnection(async (conn: DbConnection) => {
      let sql = `DROP VIEW ${quoteIdentifier(viewName)}`;

      if (options.ifExists) {
        sql = `BEGIN EXECUTE IMMEDIATE '${sql.replace(/'/g, "''")}'; EXCEPTION WHEN OTHERS THEN IF SQLCODE = -942 THEN NULL; ELSE RAISE; END IF; END;`;
      }

      try {
        await conn.execute(sql, {}, { autoCommit: true });
        return { acknowledged: true };
      } catch (err) {
        throw new Error(MSG.wrapError("OracleSchema.dropView", err, sql));
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
  async createSequence(name: string, options: { startWith?: number; incrementBy?: number; maxValue?: number; minValue?: number; cycle?: boolean; cache?: number; } = {}): Promise<{ acknowledged: boolean; }> {
    return this.db.withConnection(async (conn: DbConnection) => {
      const parts = [`CREATE SEQUENCE ${quoteIdentifier(name)}`];

      if (options.startWith != null)
        parts.push(`START WITH ${Number(options.startWith)}`);
      if (options.incrementBy != null)
        parts.push(`INCREMENT BY ${Number(options.incrementBy)}`);
      if (options.maxValue != null)
        parts.push(`MAXVALUE ${Number(options.maxValue)}`);
      if (options.minValue != null)
        parts.push(`MINVALUE ${Number(options.minValue)}`);
      parts.push(options.cycle ? "CYCLE" : "NOCYCLE");
      if (options.cache != null) parts.push(`CACHE ${Number(options.cache)}`);

      const sql = parts.join(" ");

      try {
        await conn.execute(sql, {}, { autoCommit: true });
        return { acknowledged: true };
      } catch (err) {
        throw new Error(MSG.wrapError("OracleSchema.createSequence", err, sql));
      }
    });
  }

  /**
   * Create a schema authorization.
   * @param {string} schemaName
   * @returns {Promise<{ acknowledged: boolean }>}
   */
  async createSchema(schemaName: string): Promise<{ acknowledged: boolean; }> {
    return this.db.withConnection(async (conn: DbConnection) => {
      const sql = `CREATE SCHEMA AUTHORIZATION ${quoteIdentifier(schemaName)}`;
      try {
        await conn.execute(sql, {}, { autoCommit: true });
        return { acknowledged: true };
      } catch (err) {
        throw new Error(MSG.wrapError("OracleSchema.createSchema", err, sql));
      }
    });
  }
}

export { OracleSchema };
