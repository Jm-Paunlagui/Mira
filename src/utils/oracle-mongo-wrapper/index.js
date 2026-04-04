"use strict";

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
const { createDb } = require("./db"); // Factory to create a db interface
const { OracleCollection } = require("./core/OracleCollection"); // Main class — find, insert, update, delete
const { OracleSchema } = require("./schema/OracleSchema"); // DDL — CREATE/ALTER/DROP tables/views
const { OracleDCL } = require("./schema/OracleDCL"); // DCL — GRANT/REVOKE permissions
const { QueryBuilder } = require("./core/QueryBuilder"); // Lazy cursor from .find()
const { Transaction } = require("./Transaction"); // Transaction manager with savepoints

// ─── Parsers: Convert MongoDB operators to SQL fragments ─────────
const { parseFilter } = require("./parsers/filterParser"); // { status: "active" } → WHERE clause
const { parseUpdate } = require("./parsers/updateParser"); // { $set: { name: "X" } } → SET clause

// ─── Aggregation pipeline: Complex queries via MongoDB-style stages ──
const { buildAggregateSQL } = require("./pipeline/aggregatePipeline"); // Pipeline → CTE-chained SQL
const { buildWindowExpr } = require("./pipeline/windowFunctions"); // $window → OVER() analytics

// ─── Joins & Set Operations ─────────────────────────────────────
const { buildJoinSQL } = require("./joins/joinBuilder"); // $lookup → JOIN SQL
const { SetResultBuilder } = require("./joins/setOperations"); // UNION, INTERSECT, MINUS

// ─── CTE (Common Table Expressions) ─────────────────────────────
const { withCTE, withRecursiveCTE } = require("./pipeline/cteBuilder"); // Named subquery builders

// ─── Subquery helpers ────────────────────────────────────────────
const {
    buildScalarSubquery, // Single-value subquery in SELECT
    buildExistsSubquery, // EXISTS (SELECT 1 FROM ...)
    buildNotExistsSubquery, // NOT EXISTS (SELECT 1 FROM ...)
    buildCorrelatedSubquery, // Subquery that references the outer query
    buildInSelectSubquery, // WHERE col IN (SELECT ...)
    buildAnyAllSubquery, // WHERE col > ANY/ALL (SELECT ...)
} = require("./pipeline/subqueryBuilder");

// ─── Oracle-specific advanced features ───────────────────────────
const {
    buildConnectBy, // Hierarchical queries (tree/graph traversal)
    buildPivot, // Rotate rows → columns
    buildUnpivot, // Rotate columns → rows
} = require("./advanced/oracleAdvanced");

// ─── Performance & DBA utilities ─────────────────────────────────
const { createPerformance } = require("./advanced/performanceUtils"); // EXPLAIN PLAN, ANALYZE, etc.

// ─── Shared utility functions ────────────────────────────────────
const {
    quoteIdentifier, // Wrap names in double-quotes for Oracle safety
    convertTypes, // Convert Oracle string-numbers to JS numbers
    rowToDoc, // Alias for convertTypes
    mergeBinds, // Safely combine two bind objects
    buildOrderBy, // { col: 1 } → ORDER BY "col" ASC
    buildProjection, // { col: 1 } → column list for SELECT
} = require("./utils");

module.exports = {
    // Core
    createDb,
    OracleCollection,
    OracleSchema,
    OracleDCL,
    QueryBuilder,
    Transaction,

    // Parsers
    parseFilter,
    parseUpdate,

    // Aggregation
    buildAggregateSQL,
    buildWindowExpr,

    // Joins & Set Operations
    buildJoinSQL,
    SetResultBuilder,

    // CTEs
    withCTE,
    withRecursiveCTE,

    // Subqueries
    buildScalarSubquery,
    buildExistsSubquery,
    buildNotExistsSubquery,
    buildCorrelatedSubquery,
    buildInSelectSubquery,
    buildAnyAllSubquery,

    // Oracle Advanced
    buildConnectBy,
    buildPivot,
    buildUnpivot,

    // Performance
    createPerformance,

    // Utils
    quoteIdentifier,
    convertTypes,
    rowToDoc,
    mergeBinds,
    buildOrderBy,
    buildProjection,
};
