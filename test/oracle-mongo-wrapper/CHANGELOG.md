# Changelog

## [1.0.2] — 2026-04-05

### Performance

- **oracle.js** — Removed redundant `await conn.ping()` from `withConnection()` hot path; pool-level `poolPingInterval: 30` already validates connections
- **oracle.js** — Set `oracledb.fetchArraySize = 1000` globally (up from default 100), reducing internal driver round-trips for bulk reads; also added to `EXECUTE_OPTIONS` for visibility
- **OracleCollection.js** — `findOneAndUpdate()` upsert path now uses Oracle MERGE for atomic INSERT-or-UPDATE when `upsert:true`, `returnDocument:"after"`, and simple equality filter, reducing from 3 round-trips to 2 and eliminating TOCTOU race
- **OracleCollection.js** — `findOneAndDelete()` fetches ROWID in the initial SELECT and uses it directly in the DELETE, eliminating the redundant subquery table scan
- **aggregatePipeline.js** — Adjacent `$match` stages are coalesced into a single `$match` via `$and` before CTE generation, reducing optimizer overhead for multi-predicate pipelines

## [1.0.1] — 2026-04-05

### Security

- **aggregatePipeline.js** — Replaced raw interpolation with bind variables or `Number()` coercion:
    - `$limit` / `$skip` values: wrapped with `Number()` to prevent injection
    - `$count` alias: routed through `quoteIdentifier()` (with `.toUpperCase()` for Oracle convention)
    - `$facet` facet names: escaped single quotes via `.replace(/'/g, "''")`; quoted identifiers
    - `$replaceRoot` field reference: routed through `quoteIdentifier()`
    - `$substr` positional arguments: wrapped with `Number()`
    - `$dateToString` format string: escaped single quotes; added fallback default
    - `$group` / `$project` / `$addFields` aggregate aliases: routed through `quoteIdentifier()`
    - `_buildBucket` boundary and default values: converted from interpolation to bind variables
    - `_buildAddFieldsCols` literal values: converted from interpolation to bind variables
- **Transaction.js** — Added `_validateSavepointName()` regex guard (`/^[A-Za-z_][A-Za-z0-9_]*$/`) to `savepoint()` and `rollbackTo()` to prevent SQL injection via savepoint names
- **cteBuilder.js** — Wrapped `_skipVal` and `_limitVal` in `Number()` in both `CTEResult` and `RecursiveCTEResult` to prevent injection through limit/skip values
- **OracleSchema.js** — Wrapped all numeric sequence DDL options (`startWith`, `incrementBy`, `maxValue`, `minValue`, `cache`) in `Number()` to prevent injection
- **filterParser.js** — Added SECURITY WARNING comment on `$inSelect` raw SQL string fallback path documenting the risk and recommending the object form

## [1.0.0] — 2025-01-01

### Added

- **db.js** — Thin adapter factory (`createDb`) binding named connections from `src/config/database.js`
- **utils.js** — Shared helpers: `quoteIdentifier`, `convertTypes`, `rowToDoc`, `mergeBinds`, `buildOrderBy`, `buildProjection`
- **filterParser.js** — MongoDB filter → Oracle WHERE clause translator
    - Supports: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$between`, `$notBetween`, `$exists`, `$regex`, `$like`, `$any`, `$all`, `$and`, `$or`, `$nor`, `$not`, `$case`, `$coalesce`, `$nullif`
    - Subquery operators: `$exists` (collection), `$notExists`, `$inSelect`, `$subquery`, `$gtAny`, `$gtAll`, `$ltAny`, `$ltAll`
- **updateParser.js** — MongoDB update operators → Oracle SET clause translator
    - Supports: `$set`, `$unset`, `$inc`, `$mul`, `$min`, `$max`, `$currentDate`, `$rename` (throws with guidance)
- **QueryBuilder.js** — Chainable cursor with lazy SQL execution
    - Builder: `.sort()`, `.limit()`, `.skip()`, `.project()`, `.forUpdate()`
    - Terminal: `.toArray()`, `.forEach()`, `.next()`, `.hasNext()`, `.count()`, `.explain()`
    - Oracle features: AS OF SCN/timestamp flashback, TABLESAMPLE, FOR UPDATE modes
- **Transaction.js** — Transaction manager with Session class
    - `withTransaction(fn)` delegates to `db.withTransaction()`
    - Session: `collection()`, `savepoint()`, `rollbackTo()`, `releaseSavepoint()`
- **OracleCollection.js** — Core CRUD + all query methods
    - Read: `find()`, `findOne()`, `findOneAndUpdate()`, `findOneAndDelete()`, `findOneAndReplace()`, `countDocuments()`, `estimatedDocumentCount()`, `distinct()`
    - Insert: `insertOne()` (with RETURNING), `insertMany()` (executeMany, atomic)
    - Update: `updateOne()` (with upsert, RETURNING), `updateMany()`, `replaceOne()`, `bulkWrite()`
    - Delete: `deleteOne()` (with RETURNING), `deleteMany()`, `drop()`
    - Index: `createIndex()`, `createIndexes()`, `dropIndex()`, `dropIndexes()`, `getIndexes()`, `reIndex()`
    - Merge: `merge()`, `mergeFrom()`
    - Advanced: `connectBy()`, `pivot()`, `unpivot()`, `aggregate()`, `insertFromQuery()`, `updateFromJoin()`
    - Static set ops: `union()`, `intersect()`, `minus()`
- **aggregatePipeline.js** — MongoDB pipeline → Oracle SQL with CTE chaining
    - Stages: `$match`, `$group`, `$sort`, `$limit`, `$skip`, `$count`, `$project`, `$addFields`, `$lookup`, `$lateralJoin`, `$out`, `$merge`, `$bucket`, `$facet`, `$replaceRoot`, `$unwind`, `$having`
    - Advanced grouping: `$rollup`, `$cube`, `$groupingSets`
    - Expression operators: `$sum`, `$avg`, `$min`, `$max`, `$count`, `$first`, `$last`, `$concat`, `$toUpper`, `$toLower`, `$substr`, `$dateToString`, `$cond`, `$ifNull`, `$size`
- **windowFunctions.js** — Oracle analytic function builder
    - Functions: `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `NTILE`, `LAG`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE`, `SUM`, `AVG`, `COUNT`, `MIN`, `MAX`
    - Frame clause support: `ROWS BETWEEN`, `RANGE BETWEEN`
- **joinBuilder.js** — `$lookup` → Oracle JOIN clauses
    - Types: LEFT, RIGHT, FULL, INNER, CROSS, SELF, NATURAL
    - Multi-condition joins
- **setOperations.js** — UNION, UNION ALL, INTERSECT, MINUS
    - `SetResultBuilder` with `.sort()`, `.limit()`, `.skip()`, `.toArray()`
- **cteBuilder.js** — CTE builders
    - `withCTE(db, cteDefs)` — regular CTEs from named QueryBuilders
    - `withRecursiveCTE(db, name, def)` — recursive CTEs for hierarchies
- **subqueryBuilder.js** — Subquery utilities
    - Scalar, correlated, EXISTS, NOT EXISTS, IN (SELECT), ANY, ALL
- **oracleAdvanced.js** — Oracle-specific features
    - `buildConnectBy()` — hierarchical queries with NOCYCLE, SYS_CONNECT_BY_PATH
    - `buildPivot()` — PIVOT aggregation
    - `buildUnpivot()` — UNPIVOT with null handling
- **performanceUtils.js** — Performance utilities via `createPerformance(db)`
    - `explainPlan()` — EXPLAIN PLAN + DBMS_XPLAN.DISPLAY
    - `analyze()` — DBMS_STATS.GATHER_TABLE_STATS
    - `createMaterializedView()` — with refresh modes
    - `refreshMaterializedView()` — DBMS_MVIEW.REFRESH
    - `dropMaterializedView()`
- **OracleSchema.js** — DDL operations
    - `createTable()`, `alterTable()`, `dropTable()`, `truncateTable()`, `renameTable()`
    - `createView()`, `dropView()`, `createSequence()`, `createSchema()`
- **OracleDCL.js** — DCL operations
    - `grant()`, `revoke()`
- **index.js** — Barrel file re-exporting everything
- **test.js** — End-to-end test suite with 24 sections
- **README.md** — Usage examples for every category
