# Changelog

## [Unreleased] — 2.1.0

Theme: Oracle-first, MongoDB-shaped, typed. Everything adds to 2.0; nothing breaks. Built step by step on `feature/2.1.0` (see `docs/ROADMAP-2.1.md`).

### Added — statistics (roadmap step 1)

- **`$group` accumulators.** Each takes a column, an expression, or `{ input, … }`.
  - `$countDistinct` → `COUNT(DISTINCT …)`
  - `$median` → `MEDIAN`
  - `$stdDevPop` / `$stdDevSamp` → `STDDEV_POP` / `STDDEV_SAMP`
  - `$percentile: { input, p, method }` → `PERCENTILE_CONT` (default) or `PERCENTILE_DISC`. `p` is a number from 0 to 1 or a list of them; a list returns a JS array.
  - `$push` / `$addToSet` → `JSON_ARRAYAGG(… NULL ON NULL RETURNING CLOB)`, returned by `aggregate()` as JS arrays, with an optional `orderBy`. `$push` keeps NULLs; `$addToSet` keeps each value once.
  - `$listAgg: { input, separator, distinct, orderBy }` → `LISTAGG(…) WITHIN GROUP (…)`, one string. The separator is bound.
- **Window options** in `$window`:
  - `default` for LAG / LEAD.
  - `ignoreNulls` for LAG / LEAD / FIRST_VALUE / LAST_VALUE / NTH_VALUE.
  - `RATIO_TO_REPORT`.
- **NULLS FIRST / LAST** wherever a sort is given: `{ col: { order: 1 | -1, nulls: "first" | "last" } }` in `sort()`, `$sort`, a window's `orderBy`, an accumulator's `orderBy`, set operations, `withCTE`, `withRecursiveCTE` and `connectBy`'s `orderSiblings`. `1` / `-1` still work as before.
- **`FETCH … WITH TIES`:** `limit(n, { withTies: true })` on a sorted `find()`, and `{ $limit: { n, withTies: true } }` directly after a `$sort`. Without a sort Mira throws: Oracle would silently return exactly n rows.
- `buildAggregateSQL` also returns `arrays` (the output columns holding a JSON array) when there are any; `buildWindowExpr` takes an optional bind function, used for a non-number `default`.

### Changed

- A pipeline `$limit` must be a non-negative integer (or `{ n, withTies }`); anything else throws instead of reaching Oracle as `FETCH FIRST NaN ROWS`.

### Tests and simulation

- New `test/unit/statistics.test.ts` (SQL shape and argument checks) and `test/integration/statistics.test.ts`. The live tests compute every expected value from the fixture, including Oracle's percentile interpolation.
- The `unknown expression operator` test used `$stdDevPop` as its example of an unknown operator; it now uses `$kurtosis`.
- The simulation's reports stage adds the branch KPIs: distinct customers, median, standard deviation, P10/P90 and discrete P90 of the ticket, receipts (`$push`), quarters traded (`$addToSet`, `$listAgg`), each branch's revenue share (`RATIO_TO_REPORT`) with the previous branch's revenue (`LAG` default 0), the next customer with a known city (`LEAD` IGNORE NULLS), customers by city with NULLs first, and ties at the top (`WITH TIES` in `find()` and in a pipeline). 55 queries through Mira, 0 gaps.

### Added — usable from Node, and CI on a live Oracle (roadmap step 1)

- **npm package `@jm-paunlagui/mira`.**
  - `bun run build` compiles `src/` to CommonJS JavaScript with `.d.ts` types (and source maps) in `dist/`.
  - `package.json` gets `main`, `types`, an `exports` map and a `files` list. `npm pack` / `prepack` rebuild first.
  - Runs on Node.js 20+ as well as Bun 1.4+.
- **`@types/oracledb` is now a runtime dependency.** The public types refer to `oracledb`'s types, so a consumer without it failed to type-check (TS7016).
- **CI (`.github/workflows/ci.yml`).** Runs on every push and pull request.
  - A build job: type-check, build, and `npm pack --dry-run`.
  - A live job against Oracle Database Free 23ai (`gvenzl/oracle-free:23-slim-faststart`), run once in **Thin** and once in **Thick** mode: full suite with coverage, the simulation, and a Node smoke test of the built package.
  - The job creates the `MIRA` and `MIRA_SIM` schemas with `.github/oracle/setup-users.sql`. It lets the listener accept `FREEPDB1` as a SID, because Mira connects with `(SID=…)`.
- `test/node/smoke.cjs`: loads the package by name under plain Node, then does a live round trip that checks money, CLOB and aggregate values.
- README: install from npm, and how `.env` is loaded under Node (`node --env-file=.env`; Bun reads it by itself).

### Tests fixed on the CI database

Two tests failed only on the CI database:
- **`unit/adapter` "existing keys win"** expected `APP_DB_USERNAME` to be `mira`, the value in one developer's `.env`. It now sets its own value.
- **`appDbInUse()`**, used by the leak checks, could catch the pool health monitor's 30-second `ping()` in flight and report 1 connection checked out (2 runs in 3 on the CI image). It now re-reads the count for up to 2 s and returns the lowest value seen, so a real leak, which never returns to 0, still fails the test.

### Found by CI: Thick mode can hang when there are too few worker threads

- **The hang:** on the 4-core GitHub runner, the Thick-mode job hung in "concurrent transfers keep the ledger balanced". That test runs 8 transactions that wait on each other's row locks.
- **The cause:** in Thick mode each database call runs on a native worker thread (`UV_THREADPOOL_SIZE`), and a call waiting on a lock keeps its thread. With too few threads, the transaction holding the lock never gets one to commit. The database is fine, and Thin mode is unaffected.
- **Reproduced locally:** `UV_THREADPOOL_SIZE=2` hangs and `16` passes.
- **What changed:**
  - CI sets `UV_THREADPOOL_SIZE=32`.
  - The README warns Thick-mode users to set it to at least their largest `poolMax` before the process starts.

### Added — typed tables (roadmap step 2)

- **`defineTable(name, columns)` with column builders `t.*`.** A definition needs no database: `Table.on(db)` or `Table.on(session)` binds it.
  - Builders: `t.id()`, `t.number(p?, s?)`, `t.money()`, `t.decimal(p, s)`, `t.text(n, "char"?)`, `t.char(n)`, `t.clob()`, `t.blob()`, `t.date()`, `t.timestamp(p?)`, `t.timestampTz(p?)`, `t.raw<T>(type)`.
  - Modifiers: `.nullable()`, `.default()`, `.primaryKey()`, `.check()`, `.references()`, `.identity()`, `.identityByDefault()`.
  - Each column's type matches what Mira returns: scaled NUMBER is a `string`, CLOB a `string`, BLOB a `Buffer`, dates a `Date`, and nullable columns add `null`.
- **Type checking.** Filters (known columns, value types, operators by column type), inserts (identity columns refused; nullable, defaulted and BY DEFAULT identity columns optional), `$set` / `$inc` / `$currentDate` updates, sorts, and projections (the result type narrows) are all checked. `typeof Table.$row` and `typeof Table.$insert` name the types.
- **Compile-time only.** `on()` returns the plain `OracleCollection`, so behaviour is unchanged. New `.untyped` getters on `OracleCollection` and `QueryBuilder` return the object itself with the 2.0 signatures.
- `Table.ddl()` returns the `createTable()` column spec; `Table.create(db)` runs it. `defineTable` refuses a second identity column, because Oracle allows one (ORA-30669).
- **`mira generate types`** (package `bin`) and **`generateTableTypes(db, { tables, importFrom })`**: read `USER_TAB_COLUMNS`, identity columns, primary keys and single-column foreign keys, and write one `defineTable()` and one `…Row` type per table.
  - `--tables` takes exact names or `%` patterns; `--out`, `--import`, `--env` and `--verbose` are also available.
  - Log lines stay off stdout unless `--verbose`.
- Exported types: `RowOf`, `InsertOf`, `Filter`, `Update`, `Sort`, `Projection`, `Projected`, `TypedCollection`, `TypedQuery`, `TableTarget`, `Column`, `ColumnMeta`, `GenerateOptions`.

### Fixed — insertMany (found while testing typed tables)

- **Columns only later documents had were silently dropped.** `insertMany` took its column list from the first document, so with `[{ A }, { A, B }]` every `B` was lost with no error.
  - Documents are now split into consecutive runs with the same column set, with one `executeMany` per run in the same transaction.
  - Rows are still inserted in the caller's order (identity values follow it), and an omitted column keeps its DEFAULT.
  - `insertedIds`, `returning` and `batchErrors` offsets refer to the caller's positions.
- **A `Buffer` value failed with `NJS-011`.** Buffers are now bound as binary, and as a BLOB past 32 KB. Text past 32 KB is bound as a CLOB.

### Tests and simulation (typed tables)

- `test/types/typedTables.types.ts`, checked by `bun run typecheck`: exact inferred row and insert types, plus 16 misuses that must not compile (`@ts-expect-error`).
- `test/unit/typedTables.test.ts`: builders, `ddl()`, validation, `on()`, and the generator against a stub catalogue covering every Oracle type branch.
- `test/integration/typedTables.test.ts`: typed CRUD on a live table, `on(session)` rollback, the foreign key from `references()`, and the CLI.
  - Also a round trip: definition → `create()` → catalogue → generated code → imported → the same `ddl()`.
- `test/integration/defects.test.ts`: the two `insertMany` defects, batch-error offsets across groups, and CLOB text past 32 KB.
- Simulation, reports stage:
  - generates definitions for `SIM_CUSTOMERS` / `SIM_ORDERS` and checks them against 01-schema,
  - queries `SIM_ORDERS` through a hand-written typed definition,
  - creates `SIM_LOYALTY` from a definition and fills it in one transaction with documents of two shapes.
  - Result: 58 queries, 0 gaps, 124 of 124 public functions.

## [2.0.1] — 2026-11-25

Patch release: Mira now behaves the same in node-oracledb Thin and Thick mode. 2.0.0 was only tested in Thin mode. On a machine with an Oracle Client on the system PATH, the adapter loads Thick mode even when `ORACLE_INSTANT_CLIENT` is blank, and two things broke.

### Behaviour change

- **LOB columns come back as plain values.** CLOB and NCLOB return a `string`, and BLOB returns a `Buffer`, in both modes. In 2.0.0 they came back as driver `Lob` objects tied to a connection the wrapper had already released. In Thin mode `lob.getData()` still happened to work. In Thick mode it failed with `NJS-003: invalid or closed connection`. **Migration:** replace `await row.COL.getData()` with `row.COL`.

### Fixed

- **`performance.explainPlan(queryBuilder)` in Thick mode.** It failed with `ORA-01036: illegal variable name/number` because Thick mode refuses bind values on `EXPLAIN PLAN`. Thin mode requires them (`NJS-098`), so the bind values are now passed in Thin mode only. `EXPLAIN PLAN` never evaluates them either way.
- **`$lateralJoin` with a `limit` returned too few rows.** Oracle mis-handles a row limit (`FETCH FIRST` or `ROWNUM`) inside a LATERAL / APPLY subquery once it decorrelates it. On 23.26 one active user kept a match out of six. The subquery now picks its page by ROWID (`t0.ROWID IN (… FETCH FIRST n ROWS ONLY)`), which Oracle evaluates correctly. Plain queries are unchanged.
- **Wrapper error messages:** `COLLECTION_INVALID_TABLE_NAME`, `INVALID_ROW_COUNT` and `WINDOW_INVALID_ARGUMENT` show the refused value (cut to 40 characters), not only its type.

### Docs

- README: a blank `ORACLE_INSTANT_CLIENT` does not guarantee Thin mode. The startup log says which mode loaded.

### Tests

- Chaos: the `FOR UPDATE WAIT n` timeout test accepts `ORA-30006` (19c) and `ORA-00054` (23ai).
- Reliability: the CLOB round-trip expects a string, and a new 70,000-byte BLOB round-trip expects a `Buffer`.
- Unit: the fetch handler's CLOB, NCLOB and BLOB mappings.
- Integration: `$lateralJoin` with `sort` + `limit` keeps every outer row and picks each one's top row.
- Chaos: the queueTimeout test asserts the bound itself. Every NJS-040 lands near `queueTimeout`, never about 3× later. It no longer asserts an exact count, which depended on how many pooled connections were ready at that instant.
- Simulation:
  - A blank `MIRA_SIM_GRANTEE=` falls back to `APP_DB_USERNAME`. Before, the grant ran with grantee `""` (`ORA-01741`), so `OracleDCL.revoke` was never reached.
  - The hostile-identifier checks accept 23ai's `ORA-25716` (quote inside an identifier).
- Checked in Thick (Oracle Client 19.6) and Thin mode against Oracle 23ai Free (23.26.3):
  - Test suite: 365 of 365 pass, 100% coverage.
  - Simulation: 287 of 287 checks, 119 of 119 public functions.

## [2.0.0] — 2026-11-24

Major release: TypeScript on Bun, and a far more capable wrapper. Full notes: GitHub release `v2.0.0`.

### Breaking

- **Runtime:** TypeScript on Bun ≥ 1.4 (`.ts` sources, `bun.lock`, `main` → `src/utils/oracle-mongo-wrapper/index.ts`). Tests run on `bun test`; mocha and chai are removed.
- **Driver:** oracledb 7.0.1. Thick mode needs Oracle Client 19c or later.
- **Connections:** the `userAccount` / `unitInventory` registry is replaced by `appDb` / `appDbBulk` on `APP_DB_*` credentials. There is an optional test-database switch (`NODE_ENV=development` + `APP_TEST_DB_USERNAME`).
- **Behaviour fixes that change results:**
  - `$eq` / `$ne` with null → `IS [NOT] NULL`.
  - `$now` → database wall-clock time (`withTimeZone: true` for TIMESTAMP WITH TIME ZONE columns).
  - `findOneAndUpdate` / `findOneAndReplace` change one row.
  - `bulkWrite` joins a session's transaction.
  - `skip locked` + `limit` locks while fetching.
  - Locking reads never auto-commit.
  - Filter `$case` / `$coalesce` / `$nullif` compare the field.
  - Views from filtered queries inline their literals.
  - Unknown stages, operators and join types throw.
  - Window, PIVOT, subquery and set-operation options are allow-listed or integer-only.
  - `$merge` needs `fields`.
  - `isHealthy()` is false after `closePool()`.

### Added

- **Expression engine:**
  - nesting everywhere; aggregates over expressions
  - `$abs` `$ceil` `$floor` `$round` `$trunc` `$mod` `$literal`
  - GREATEST / LEAST
  - `$switch`
  - `$dateDiff` `$dateAdd` `$dateTrunc` `$lastDayOfMonth` `$year` `$month` `$dayOfMonth`
  - column-to-column conditions with `$and` / `$or` / `$not`
  - `grouping: true` subtotal flags
- **`$matchRecognize` stage**, with `$prev` / `$next`.
- **`connectBy` columns:** `root`, `includeIsLeaf`, `includeIsCycle`, `pathColumn`.
- **Joins and trees in the pipeline:**
  - `$lookup` with a `pipeline`
  - `$lateralJoin` with `outer: true`
  - a `$connectBy` stage
  - nested pipelines hoisted into the outer WITH
- **Recursion and generators:**
  - `withRecursiveCTE` `set` / `while` / `.aggregate()`
  - `series()` row generator
- **Collections and transactions:**
  - `insertMany` `returning` / `batchErrors`
  - `bulkUpdateByKeys`
  - `session.execute()`
  - `$in` over 1,000 values as one collection bind
  - `forUpdate` `{ of, wait, nowait, skipLocked }`
  - precise `$currentDate` timestamps

### Fixed

- **43 defects, each proven by a failing test first.** About ten of them returned wrong data with no error:
  - time zone (`$now`)
  - null comparisons
  - bind-name clashes
  - multi-row find-and-modify
  - `bulkWrite` and the session
  - SKIP LOCKED queues
  - lateral cross join
  - async `forEach`
  - silently skipped stages
  - lost money digits
- The full list is in the GitHub release `v2.0.0`.

### Security

- Window, frame, PIVOT, subquery and set-operation options are no longer spliced into SQL.
- Bind names are cleaned.
- `$in` lists are linear-time (DoS).

### Tests

- **363 / 363** (unit, integration, performance, chaos, security, reliability), 100% lines and functions, on a live Oracle 19c.
- **`bun run sim`:** 287 / 287 checks, 119 / 119 public functions, 50 / 50 business queries through Mira.

## [1.0.5] — 2026-04-05

### Security

- **utils.js** — `quoteIdentifier()` now escapes embedded double-quote characters (`"` → `""`) before wrapping, preventing identifier injection (CWE-116). Previously, a malicious identifier containing `"` could break out of the quoted context.
- **filterParser.js** — `$gtAny`/`$ltAny`/`$gteAny`/`$lteAny` and `$gtAll`/`$ltAll`/`$gteAll`/`$lteAll` operator parsing now uses regex with the global flag (`/Any/g`, `/All/g`, `/\$/g`) instead of `String.replace()` which only replaces the first occurrence (CWE-20, CWE-116).

### Bug Fixes

- **oracle.js** — Removed useless `committed` flag and redundant `if (!committed)` guard in `withTransaction()`. If execution reaches the `catch` block, `conn.commit()` never succeeded, so `rollback()` is always needed.
- **test.js** — Fixed useless type test: `"plain object" === typeof doc ? "object" : "object"` (both branches identical, `typeof` never returns `"plain object"`) replaced with `expect(doc).to.be.an("object")`.
- **test.js** — Removed unused first `scn` assignment in AS OF SCN test (value was always overwritten after the wait).

### Code Quality

- Removed 7 unused variables flagged by CodeQL static analysis:
    - `parseFilter` import in **subqueryBuilder.js**
    - `rowToDoc` import in **OracleCollection.js** and **QueryBuilder.js**
    - `joinType` variable in **OracleCollection.js** `updateFromJoin()`
    - `pathCol` variable in **oracleAdvanced.js** `buildConnectBy()`
    - `exact` variable in **test.js** `estimatedDocumentCount` test
    - `orig` variable in **test.js** `replaceOne` test

### CI/CD

- Added CodeQL workflow for automated code scanning on push/PR
- Added dependency-review workflow for PR dependency auditing
- Configured Dependabot for npm and GitHub Actions version updates
- Bumped `actions/checkout` from v4 to v6 (via Dependabot)
- Added `sample.js` and `test.dev.js` to `.gitignore`

### Tests

- Total: **236 passing**, 3 pending (privilege-dependent DCL only), 0 failing

## [1.0.4] — 2026-04-05

### Bug Fixes

- **aggregatePipeline.js** — Fixed `$out` stage: CTE + INSERT syntax (`WITH ... INSERT INTO`) is invalid Oracle SQL. Now emits `INSERT INTO "table" WITH ... SELECT ...` by deferring the INSERT to final SQL assembly instead of embedding it in a CTE.
- **aggregatePipeline.js** — Fixed `$bucket` stage: numeric boundary THEN-labels mixed with the string default label ("Other") caused ORA-00932 (inconsistent datatypes). All CASE WHEN result values are now coerced to strings when a default bucket is present.
- **aggregatePipeline.js** — Fixed `$replaceRoot` stage: `newRoot: "$"` (bare root reference) produced an empty quoted identifier (`"".*`) causing ORA-01741. Now correctly emits `SELECT * FROM prevSource` for root passthrough.

### Tests

- **test.js** — Converted 3 pending pipeline tests (`$out`, `$bucket`, `$replaceRoot`) to passing tests with full assertions.
- Total: **236 passing**, 3 pending (privilege-dependent DCL only)

## [1.0.3] — 2026-04-05

### Tests

- **test.js** — Added 64 new tests across 7 new sections (25–31), covering previously untested APIs:
    - **Section 25 — SQL Injection & Security**: bind-variable safety for filter/update payloads (`$in`, `$regex`, `$like`, `$set`), UNIQUE constraint violations, NOT NULL constraint violations
    - **Section 26 — mergeFrom, UNPIVOT, buildAnyAllSubquery**: `mergeFrom()` integration, `unpivot()` integration, `buildAnyAllSubquery()` unit tests for ANY/ALL
    - **Section 27 — Additional JOINs**: RIGHT OUTER, FULL OUTER, CROSS, NATURAL join types via `$lookup`
    - **Section 28 — Additional Window Functions**: LEAD, FIRST_VALUE, LAST_VALUE, NTH_VALUE, window AVG, COUNT, MIN, MAX
    - **Section 29 — Additional Filter Operators**: `$notBetween`, `$case`, `$coalesce`, `$nullif`, `$not`, `$nor`, `$gtAny`, `$ltAll`, `$gteAny`, `$lteAll`, `$inSelect` (array & empty array), nested `$and`/`$or`
    - **Section 30 — Pipeline Stages & Aggregate Expressions**: `$first`, `$last`, `$concat`, `$toUpper`, `$toLower`, `$substr`, `$cond`, `$ifNull`, `$dateToString`, `$mul`, `$subtract`, `$divide`; `$out`, `$bucket`, `$replaceRoot` marked pending (known CTE/type limitations)
    - **Section 31 — Edge Cases & Streaming**: `forEach` streaming, `estimatedDocumentCount`, `distinct` (with/without filter), combined `$set`/`$inc`/`$mul`, `$unset`, `$currentDate`, `$rename` error, `skip`/`count`/chained cursor, `findOneAndUpdate`, `findOneAndDelete`, `buildWindowExpr` unit, `buildJoinSQL` unit (all 7 join types), adjacent `$match` merge, `drop()`, `replaceOne`, `updateMany`
- Total: **233 passing**, 6 pending (3 privilege-dependent DCL + 3 known pipeline limitations)

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
