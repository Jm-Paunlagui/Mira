

/**
 * ============================================================================
 * index.js — Barrel File (Central Export Hub)
 * ============================================================================
 *
 * WHAT IS A BARREL FILE?
 *   A barrel file re-exports everything from the library through a single
 *   entry point. Instead of importing from 10 different files:
 *     const { createDb } = require("./db");
 *     const { OracleCollection } = require("./core/OracleCollection");
 *     const { parseFilter } = require("./parsers/filterParser");
 *
 *   You import everything from ONE place:
 *     const { createDb, OracleCollection, parseFilter } = require("./oracle-mongo-wrapper");
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
import { createDb } from "./db"; // Factory to create a db interface
import { OracleCollection } from "./core/OracleCollection"; // Main class — find, insert, update, delete
import { OracleSchema } from "./schema/OracleSchema"; // DDL — CREATE/ALTER/DROP tables/views
import { OracleDCL } from "./schema/OracleDCL"; // DCL — GRANT/REVOKE permissions
import { QueryBuilder } from "./core/QueryBuilder"; // Lazy cursor from .find()
import { Transaction } from "./Transaction"; // Transaction manager with savepoints

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
import { ModelCollection } from "./typed/model";
import { relations, hasMany, hasOne, belongsTo } from "./typed/relations";

// ─── Migrations (2.1): versioned schema changes with history, lock and dry run ─
import { createMigrator } from "./migrate/migrator";

// ─── Shared utility functions ────────────────────────────────────
import { quoteIdentifier, convertTypes, rowToDoc, mergeBinds, buildOrderBy, buildProjection } from "./utils";

export { createDb, OracleCollection, OracleSchema, OracleDCL, QueryBuilder, Transaction, parseFilter, parseUpdate, buildAggregateSQL, buildWindowExpr, buildJoinSQL, SetResultBuilder, withCTE, withRecursiveCTE, series, buildScalarSubquery, buildExistsSubquery, buildNotExistsSubquery, buildCorrelatedSubquery, buildInSelectSubquery, buildAnyAllSubquery, buildConnectBy, buildPivot, buildUnpivot, createPerformance, quoteIdentifier, convertTypes, rowToDoc, mergeBinds, buildOrderBy, buildProjection, defineTable, TypedTable, t, generateTableTypes, createMigrator, relations, hasMany, hasOne, belongsTo, MiraValidationError, ModelCollection };
export type { RowOf, InsertOf, Filter, Update, Sort, Projection, Projected, TypedCollection, TypedQuery, TableTarget, IncludeOptionsOf, TableOptions, TableHooks, SoftDeleteMethods, CollectionOf } from "./typed/table";
export type { HookContext } from "./typed/model";
export type { ValidationIssue } from "./typed/validate";
export type { Relation, NestedRow } from "./typed/relations";
export type { IncludeOptions } from "./typed/include";
export type { Column, ColumnMeta } from "./typed/columns";
export type { GenerateOptions } from "./typed/generate";
export type { Migration, MigrationContext, MigratorOptions, MigrationStatus, MigrationState, MigrationRun, Migrator } from "./migrate/migrator";
