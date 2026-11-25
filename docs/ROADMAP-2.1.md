# Mira 2.1 Roadmap

**Status:** released as **v2.1.0** (2026-11-26). All nine items built on `feature/2.1.0` (PRs #21–#31) · **Base:** v2.0.0 (2026-11-24) · **Branch:** `feature/2.1.0`

This roadmap compares Mira 2.0 with the Node / TypeScript ORMs and query builders that support Oracle, and with Oracle's own MongoDB-style APIs. It lists what Mira lacks, then drafts 2.1.

**The short version:** Mira's niche is real. It is the only option that puts a MongoDB-style API over *ordinary relational Oracle tables* with deep Oracle SQL, and that is proven against a live database. It trails on the "ORM" layer around the queries: typed models, migrations, relations, and packaging. 2.1 closes that layer without giving up the Oracle depth.

---

## 1. The landscape

| Library | Oracle support | Kind |
|---|---|---|
| **Prisma** | **None.** Not in the supported databases; the Oracle request ([#2853](https://github.com/prisma/prisma/issues/2853)) has been open since 2020 | ORM |
| **Drizzle** | **None.** No Oracle dialect in the docs; a feature request exists | ORM / query builder |
| **TypeORM** | Official | ORM |
| **MikroORM** | Official `@mikro-orm/oracledb` driver (sequences, schema diffing for migrations) | ORM |
| **Sequelize** | Official dialect since v6.22, contributed by the Oracle team. v6 needs node-oracledb ^5.4 and Oracle ≥ 18.4. v7 moves it to a separate `@sequelize/oracle` package (Thin mode by default), but **v7 is still alpha**; v6.37.8 shipped in March 2026 | ORM |
| **Knex** | Supported | Query builder |
| **Kysely** | Supported | Query builder (no migration CLI) |
| **Oracle Database API for MongoDB / SODA** | Oracle's own | MongoDB wire protocol / document API over **JSON collections** |

### Sequelize compared with Mira

Sequelize is the most complete ORM that supports Oracle.

| | Sequelize | Mira 2.0 |
|---|---|---|
| Oracle support | Official, v6.22+; v7 still alpha | Oracle only, oracledb 7.0.1 |
| Models and associations | Full: `define`, `hasMany` / `belongsTo` / `belongsToMany`, eager loading with `include` | None; joins are `$lookup` |
| Migrations | sequelize-cli / umzug | DDL methods only |
| Model conveniences | validations, hooks, scopes, soft delete ("paranoid"), automatic timestamps | none |
| Locking | `lock`, `skipLocked`; Oracle has no row-level shared locks | `forUpdate` `{ of, wait, nowait, skipLocked }`, safe work queues |
| Oracle-specific SQL (CONNECT BY, MATCH_RECOGNIZE, PIVOT, flashback, recursion with calculations, row generators, ROLLUP flags) | raw SQL | **built in** |
| TypeScript | types added on top in v6; native only in the alpha v7 | written in TypeScript, but results are not typed from the schema |
| Proof against Oracle | dialect tests | 363 tests at 100% coverage plus a 50-query simulation |

---

## 2. What Mira does better

| Mira | Compared with |
|---|---|
| **A MongoDB-style API over existing relational tables.** | Oracle's MongoDB API and its document API (SODA) work on **JSON collections**, not your existing relational tables. Their pipeline support also varies by Oracle release (`$lookup` has had reports of not working). |
| **Deep Oracle SQL through the API:** CONNECT BY, MATCH_RECOGNIZE, PIVOT/UNPIVOT, flashback `AS OF`, SAMPLE, ROLLUP/CUBE/GROUPING, MERGE, recursion that carries a calculation, row generators (`series`), window frames, SKIP LOCKED work queues, DCL, materialized views, EXPLAIN PLAN. | TypeORM, MikroORM, Knex, Kysely and Sequelize aim at what every database shares. These need raw SQL. |
| **Production Oracle plumbing:** two pools (interactive `appDb`, bulk `appDbBulk`), a health monitor and circuit breaker, a retry policy that knows which errors are temporary, exact money values, log redaction. | Left to the application, or the plain driver. |
| **Safety:** every option that reaches SQL is either bound or checked against an allow-list. A large `$in` list is a single collection bind, so ORA-01795 never happens. | Query builders are safe for values; raw-SQL escape hatches are common for exactly these Oracle features. |
| **Proof:** 363 tests at 100% coverage against a real Oracle database, plus `bun run sim`, where 50 of 50 business queries go through the API. | Most ORMs test their Oracle support much less deeply than their Postgres support. |
| **No build step:** Bun runs the TypeScript directly. | Prisma needs its generate step. |

---

## 3. What Mira lacks

In suggested order of value.

1. **Typed results.** `toArray<T>()` takes a type written by hand. Prisma, Drizzle, Kysely and MikroORM infer row types from the schema. *Idea:* generate TypeScript types from Oracle's column catalogue (`USER_TAB_COLUMNS`).
2. **Migrations.** Mira has DDL methods but no versioned migration files, no history table and no schema diffing. TypeORM, MikroORM, Knex and Sequelize all have these.
3. **Common statistics in aggregates.** No `COUNT(DISTINCT)`, `LISTAGG`, `MEDIAN`, `STDDEV` or `PERCENTILE`. This was the top gap in the 2.0 capability map, and real reports need these.
4. **JSON and array support.** No `JSON_VALUE` / `JSON_TABLE` operators, no `$elemMatch`, no `$push` / `$pull`. Developers coming from MongoDB will expect nested documents and arrays.
5. **Packaging for Node.** `main` points at `.ts` files, so the library only works on Bun. A compiled JS build with type declarations, published to npm, makes it usable from Node.
6. **Relations and an entity layer.** No defined relationships, no eager or lazy loading, no nested writes, no change tracking (MikroORM's "unit of work"), no version-column optimistic locking. `$lookup` is fine for reports; ORM users miss it in application code.
7. **Smaller conveniences:**
   - a raw-SQL helper that binds values safely (``sql`…` ``)
   - async-iterator streaming
   - keyset (cursor) pagination
   - `FETCH … WITH TIES`
   - automatic `createdAt` / `updatedAt`
   - soft delete
   - hooks before and after writes
   - query-logging and OpenTelemetry hooks (oracledb 7 added trace handlers)

---

## 4. Draft: Mira 2.1

**Theme: Oracle-first, MongoDB-shaped, typed.** Everything adds to 2.0; nothing breaks.

### Must-have

1. **Usable from Node, not just Bun** (covers lack 5)
   - Compile to JS plus `.d.ts` type files, with a proper `exports` map, and publish to npm.
   - Run the live tests in CI against an Oracle Free container on GitHub Actions. Today CI runs no database tests.
2. **Typed tables** (covers lack 1)
   - `defineTable("ORDERS", { ID: t.id(), TOTAL: t.money(), CREATED_AT: t.timestamp() })` returns a collection whose filters, projections and results are type-checked.
   - `mira generate types` reads `USER_TAB_COLUMNS` and writes the types for existing tables.
3. **Migrations** (covers lack 2)
   - `mira migrate up | down | status`: TypeScript migration files, and a `MIRA_MIGRATIONS` history table with checksums.
   - A lock, so two deployments cannot migrate at once, and a dry-run mode.
4. **The missing statistics** (covers lacks 3 and 7)
   - `$countDistinct`, `$addToSet` / `$push` (LISTAGG / JSON_ARRAYAGG), `$median`, `$stdDevPop` / `$stdDevSamp`, `$percentile`.
   - Window functions: LAG / LEAD with a default value, IGNORE NULLS, RATIO_TO_REPORT.
   - Sorting and paging: `NULLS FIRST/LAST`, `FETCH … WITH TIES`.

### Should-have

5. **Relations, lightly** (Sequelize's `include`, in one query; covers lack 6)
   - Declare `hasMany` / `belongsTo` in `defineTable`.
   - `find().include("orders")` returns nested rows built with JSON_ARRAYAGG. One query, with no "N+1" extra query per row.
6. **JSON columns** (covers lack 4)
   - Dot paths in filters (`"doc.address.city"` → JSON_VALUE).
   - `$elemMatch` (JSON_EXISTS), a `$jsonTable` stage, `$set` on paths (JSON_MERGEPATCH), `$push` / `$pull`.
7. **Model conveniences** (covers lack 7)
   - Automatic `createdAt` / `updatedAt`; soft delete with `withDeleted()`.
   - Hooks before and after writes.
   - Validation derived from the table definition.
8. **Optimistic locking** (covers lack 6)
   - A version column. A stale `updateOne` raises a concurrency error instead of overwriting someone else's change.

### Could-have

9. **Smaller additions** (covers lack 7)
   - a raw-SQL helper (``sql`…` ``) that always binds its values
   - `for await (const row of find())` streaming
   - keyset pagination with `.after({ ID })`
   - query events and OpenTelemetry hooks

### Not a goal

Support for other databases. Being Oracle-only is Mira's edge.

### How each item is proven

The same rules as 2.0:
- Tests first, at 100% line and function coverage against a live Oracle 19c.
- Every feature is used in the simulation. For example: the simulation builds its schema through migrations, runs its reports on typed tables, and fetches nested orders with `include`.
- The simulation reports any **ORM gap** the way it now reports query coverage gaps.
- Every defect found on the way is proven with a failing test before it is fixed.

### Order of work (one PR each, onto `feature/2.1.0`)

| Step | Items | Why first |
|---|---|---|
| 1 | 4 (statistics), then 1 (packaging and CI) | Cheap; closes real gaps; CI on a live Oracle guards everything after it |
| 2 | 2 (typed tables), then 3 (migrations) | The big moves toward a full ORM; relations build on typed tables |
| 3 | 5 (relations), 6 (JSON) | Need typed tables |
| 4 | 7 (conveniences), 8 (optimistic locking), 9 as time allows | Then release **2.1.0** |

---

## Sources

- Prisma: [supported databases](https://www.prisma.io/docs/orm/reference/supported-databases), [Oracle request #2853](https://github.com/prisma/prisma/issues/2853)
- Drizzle: [docs index](https://orm.drizzle.team/llms.txt), [ORM support for Oracle (overview)](https://devactivity.com/insights/navigating-orm-support-for-oracle-impacting-developer-activity)
- Oracle Database API for MongoDB: [feature support](https://docs.oracle.com/en/database/oracle/mongodb-api/mgapi/support-mongodb-operations-reference.html), [aggregation pipelines](https://docs.oracle.com/en/database/oracle/mongodb-api/mgapi/pipelines.html), [forum: `$lookup` not supported](https://forums.oracle.com/ords/apexds/post/mongodb-api-mongoservererror-stage-lookup-is-not-supported-6539)
- MikroORM: [SQL drivers](https://mikro-orm.io/docs/usage-with-sql), [@mikro-orm/oracledb](https://jsr.io/@mikro-orm/oracledb/7.1.11/README.md)
- Sequelize: [Oracle (v7 docs)](https://sequelize.org/docs/v7/databases/oracle/), [versioning policy](https://sequelize.org/releases/), [v6 dialect-specific notes](https://sequelize.readthedocs.io/docs/v6/other-topics/dialect-specific-things/), [Oracle locking PR #14638](https://github.com/sequelize/sequelize/pull/14638), [release updates](https://opencollective.com/sequelize/updates), [maintainers meeting 2024](https://github-users.yhajoa.workers.dev/sequelize/meetings/wiki/Meeting-2024%E2%80%9003%E2%80%9022)
- Comparisons: [Top TypeScript ORMs (Bytebase)](https://www.bytebase.com/blog/top-typescript-orm/), [npm-compare](https://npm-compare.com/@mikro-orm/core,knex,sequelize,typeorm)
- Mira's own capability map and simulation results: `sim/RESEARCH.md`
