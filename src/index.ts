

/**
 * ============================================================================
 * index.js — Barrel File (Central Export Hub)
 * ============================================================================
 *
 * WHAT IS A BARREL FILE?
 *   A barrel file re-exports everything from the library through a single
 *   entry point. Instead of importing from 10 different files:
 *     const { createDb } = require("./driver/db");
 *     const { OracleCollection } = require("./core/OracleCollection");
 *     const { parseFilter } = require("./parsers/filterParser");
 *
 *   You import everything from ONE place:
 *     const { createDb, OracleCollection, parseFilter } = require("@jm-paunlagui/mira");
 *
 * WHY?
 *   - Cleaner imports in your application code
 *   - If a file moves internally, only this barrel file needs updating
 *   - Documents ALL available exports in one place
 *
 * IMPORTANT:
 *   When you create a new function or class in the library, you MUST add
 *   it here. Otherwise, users can't import it from the barrel file.
 * ============================================================================
 */

// ─── Core: The essentials you need for basic CRUD operations ─────
import { createDb } from "./driver/db"; // Factory to create a db interface
import { OracleCollection } from "./core/OracleCollection"; // Main class — find, insert, update, delete
import { OracleSchema } from "./schema/OracleSchema"; // DDL — CREATE/ALTER/DROP tables/views
import { OracleDCL } from "./schema/OracleDCL"; // DCL — GRANT/REVOKE permissions
import { QueryBuilder } from "./core/QueryBuilder"; // Lazy cursor from .find()
import { Transaction } from "./core/Transaction"; // Transaction manager with savepoints

// ─── Parsers: Convert MongoDB operators to SQL fragments ─────────
import { parseFilter } from "./parsers/filterParser"; // { status: "active" } → WHERE clause
import { parseUpdate } from "./parsers/updateParser"; // { $set: { name: "X" } } → SET clause

// ─── Aggregation pipeline: Complex queries via MongoDB-style stages ──
import { buildAggregateSQL } from "./pipeline/aggregatePipeline"; // Pipeline → CTE-chained SQL
import { buildWindowExpr } from "./pipeline/windowFunctions"; // $window → OVER() analytics

// ─── Joins & Set Operations ─────────────────────────────────────
import { buildJoinSQL } from "./joins/joinBuilder"; // $lookup → JOIN SQL
import { SetResultBuilder } from "./joins/setOperations"; // UNION, INTERSECT, MINUS

// ─── CTE (Common Table Expressions) ─────────────────────────────
import { withCTE, withRecursiveCTE } from "./pipeline/cteBuilder"; // Named subquery builders
import { series } from "./pipeline/seriesBuilder"; // Row generator: numbers or a calendar

// ─── Subquery helpers ────────────────────────────────────────────
import { buildScalarSubquery, buildExistsSubquery, buildNotExistsSubquery, buildCorrelatedSubquery, buildInSelectSubquery, buildAnyAllSubquery } from "./pipeline/subqueryBuilder";

// ─── Oracle-specific advanced features ───────────────────────────
import { buildConnectBy, buildPivot, buildUnpivot } from "./advanced/oracleAdvanced";

// ─── Performance & DBA utilities ─────────────────────────────────
import { createPerformance } from "./advanced/performanceUtils"; // EXPLAIN PLAN, ANALYZE, etc.

// ─── Typed tables (2.1): defineTable, column builders, type generator ─
import { defineTable, TypedTable } from "./typed/table";
import { t } from "./typed/columns";
import { generateTableTypes } from "./typed/generate";
import { MiraValidationError } from "./typed/validate";
import { ModelCollection, MiraConcurrencyError } from "./typed/model";
import { sql, SqlStatement } from "./core/sql";
import { onQuery } from "./core/events";
import { relations, hasMany, hasOne, belongsTo } from "./typed/relations";

// ─── Migrations (2.1): versioned schema changes with history, lock and dry run ─
import { createMigrator } from "./migrate/migrator";

// ─── Config-object API (2.2, the 3.0 entry point): createMira, defineConfig, fromEnv ─
import { createMira } from "./driver/createMira";
import { defineConfig, MiraConfigError } from "./config/defineConfig";
import { fromEnv } from "./config/fromEnv";
import { buildSimpleConnectString, buildTNSConnectString } from "./driver/registry";
import { configureDriver, initDriver } from "./driver/oracle";
import { setLogger } from "./shared/log";

// ─── Shared utility functions ────────────────────────────────────
import { quoteIdentifier, convertTypes, rowToDoc, mergeBinds, buildOrderBy, buildProjection } from "./shared/utils";

export { createDb, OracleCollection, OracleSchema, OracleDCL, QueryBuilder, Transaction, parseFilter, parseUpdate, buildAggregateSQL, buildWindowExpr, buildJoinSQL, SetResultBuilder, withCTE, withRecursiveCTE, series, buildScalarSubquery, buildExistsSubquery, buildNotExistsSubquery, buildCorrelatedSubquery, buildInSelectSubquery, buildAnyAllSubquery, buildConnectBy, buildPivot, buildUnpivot, createPerformance, quoteIdentifier, convertTypes, rowToDoc, mergeBinds, buildOrderBy, buildProjection, defineTable, TypedTable, t, generateTableTypes, createMigrator, relations, hasMany, hasOne, belongsTo, MiraValidationError, ModelCollection, MiraConcurrencyError, sql, SqlStatement, onQuery, createMira, defineConfig, fromEnv, MiraConfigError, buildSimpleConnectString, buildTNSConnectString, configureDriver, initDriver, setLogger };
export type { RowOf, InsertOf, Filter, Update, Sort, Projection, Projected, TypedCollection, TypedQuery, TableTarget, IncludeOptionsOf, TableOptions, TableHooks, SoftDeleteMethods, CollectionOf } from "./typed/table";
export type { HookContext } from "./typed/model";
export type { SqlTarget } from "./core/sql";
export type { QueryEvent, QueryListener } from "./core/events";
export type { ValidationIssue } from "./typed/validate";
export type { Relation, NestedRow } from "./typed/relations";
export type { IncludeOptions } from "./typed/include";
export type { Column, ColumnMeta } from "./typed/columns";
export type { GenerateOptions } from "./typed/generate";
export type { Migration, MigrationContext, MigratorOptions, MigrationStatus, MigrationState, MigrationRun, Migrator } from "./migrate/migrator";
export type { Mira } from "./driver/createMira";
export type { MiraConfig, PoolConfig, ResolvedMiraConfig, DriverMode, DriverOptions, MiraLogger } from "./config/types";
export type { FromEnvOptions } from "./config/fromEnv";
