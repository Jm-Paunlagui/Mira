# Mira

Write MongoDB-style JavaScript. Get Oracle SQL. Never write raw SQL again.

```
Your JavaScript / TypeScript (MongoDB-style)
        ↓
Mira
        ↓
Oracle SQL with bind variables (safe from SQL injection)
        ↓
Oracle Database
```

> **This guide is organized by difficulty.** Start from the top. Each section builds on the previous one.
>
> **Upgrading from 2.x?** See [docs/MIGRATION-3.0.md](docs/MIGRATION-3.0.md).

---

## Table of Contents

- [Setup](#setup)
    - [Install](#install)
    - [Connect](#connect)
    - [Pool options](#pool-options)
    - [Several pools](#several-pools)
    - [Health and readiness](#health-and-readiness)
    - [Config from environment variables](#config-from-environment-variables)
    - [Thin or Thick mode](#thin-or-thick-mode)
    - [Logging](#logging)
    - [Typed Tables (2.1)](#typed-tables-21)
    - [Relations and include (2.1)](#relations-and-include-21)
    - [JSON Columns (2.1)](#json-columns-21)
    - [Timestamps, Soft Delete, Hooks and Validation (2.1)](#timestamps-soft-delete-hooks-and-validation-21)
    - [Optimistic Locking (2.1)](#optimistic-locking-21)
    - [Keyset Paging, Streaming, Raw SQL and Query Events (2.1)](#keyset-paging-streaming-raw-sql-and-query-events-21)
    - [Migrations (2.1)](#migrations-21)
- [Basic — Your First Queries](#-basic--your-first-queries)
- [Medium — Filtering, Updating & Chaining](#-medium--filtering-updating--chaining)
- [Hard — Aggregation, Transactions & Joins](#-hard--aggregation-transactions--joins)
- [Advanced — Window Functions, CTEs, Hierarchies & More](#-advanced--window-functions-ctes-hierarchies--more)
- [Operator Reference](#operator-reference)
- [Testing](#testing)
- [Simulation](#simulation)

---

## Setup

### Install

Mira runs on **Node.js 20+** and on **Bun 1.4+**. Install it from npm (it brings `oracledb`):

```bash
npm install @jm-paunlagui/mira    # or: bun add @jm-paunlagui/mira
```

The package ships compiled CommonJS with `.d.ts` types, so editors and `tsc` type-check your calls. `import { … } from "@jm-paunlagui/mira"` and `require("@jm-paunlagui/mira")` both work; everything public is on the package root.

### Connect

Pass your pools to `createMira()`. Mira reads no environment variable, writes no file and initialises no driver until you use it, so the credentials can come from anywhere: `.env`, a secrets manager, a config file.

```ts
import { createMira } from "@jm-paunlagui/mira";

const mira = createMira({
    pools: {
        appDb: { user: "APP", password: secret, connectString: "db-host:1521/ORCLPDB1", poolMin: 2, poolMax: 10 },
    },
});

const db = mira.db();                    // the db handle every example in this guide uses
const users = mira.collection("USERS");  // same as new OracleCollection("USERS", db)
const schema = mira.schema();            // also: mira.dcl(), mira.transaction()

// On shutdown: close this instance's pools.
process.on("SIGTERM", () => void mira.close());
```

- Pools open on first use. Call `await mira.db().withConnection((c) => c.ping())` at startup to fail fast.
- `connectString` takes Easy Connect (`host:port/service_name`), a TNS descriptor, or a tnsnames alias. `buildSimpleConnectString(host, port, service)` and `buildTNSConnectString(host, port, sid)` (two addresses, load balancing, SELECT failover) build the common forms.
- `mira.db()` is the handle the rest of the API takes: `new OracleCollection(name, db)`, `Orders.on(db)`, `new Transaction(db)`, `createPerformance(db)`, `createMigrator(db)` …. Its type is exported as `MiraDb`. After `mira.close()` a kept handle reports `isHealthy() === false` and refuses work.

### Pool options

| Option | Default | |
| --- | --- | --- |
| `user`, `password`, `connectString` | required | |
| `poolMin` | 10 | Connections kept open. Oracle holds a server process for each, idle or not: keep it small. |
| `poolMax` | 50 | Most connections. Size it by concurrent operations: each `withConnection` call borrows one. |
| `poolIncrement` | 5 | Connections opened at a time when the pool grows. |
| `queueMax` | 40 | Most callers waiting for a connection; one more fails at once with NJS-076. `0` disables queuing. |
| `queueTimeout` | 15000 | Milliseconds a caller waits in the queue (NJS-040). `0` waits forever. |
| `poolTimeout` | 30 | Seconds an idle connection above `poolMin` stays open. `0` keeps it. |
| `connectTimeout` | 15000 | Milliseconds to open one connection (Thin mode). |
| `poolPingInterval` | 30 | Seconds idle before a connection is pinged on checkout; negative never pings. |
| `stmtCacheSize` | 50 | Statements cached per connection. |

A config that cannot work throws one `MiraConfigError` listing every problem (`err.issues`), before anything connects. Unknown keys are refused, so a typo such as `poolmax` is not silently ignored. Messages name keys, never values. `defineConfig(config)` runs the same checks and returns the config frozen, for apps that build it in one place and use it in another.

### Several pools

Name as many pools as you need; with more than one, say which is the default. Pool names are type-checked from the config's keys.

```ts
const mira = createMira({
    pools: {
        appDb:     { user: "APP", password: appSecret, connectString: "db-host:1521/APP", poolMax: 20, queueMax: 40 },
        appDbBulk: { user: "APP", password: appSecret, connectString: "db-host:1521/APP", poolMin: 1, poolMax: 6, queueTimeout: 30000 },
        reporting: { user: "RPT", password: rptSecret, connectString: "rpt-host:1521/RPT", poolMax: 10 },
    },
    defaultPool: "appDb",
});

mira.collection("ORDERS");                 // appDb
mira.collection("SALES", "reporting");     // reporting
await mira.transaction("appDbBulk").withReadOnlyTransaction(async (s) => s.collection("ORDERS").countDocuments());
```

A separate pool for long-held work (exports, bulk loads) keeps it from starving interactive traffic. Several `createMira()` instances can live in one process, each closing only its own pools; two live instances cannot use the same pool name.

### Health and readiness

Each open pool is pinged by a health monitor (every 30 s; every 5 s while one is failing, or while watched). Three failed checks open that pool's circuit breaker: `withConnection` then fails fast with `NJS-503` until a check, or your own probe, succeeds. A Mira instance sees only its own pools:

```ts
const results = await mira.open();          // open every pool now: [{ name, success, error? }]; a pool that fails is reported, not thrown
const ready = mira.health.allHealthy();      // or mira.health.isHealthy("reporting")
const usage = await mira.stats();            // { pools: { appDb: { connectionsOpen, connectionsInUse, queueLength, … } }, healthMetrics }

const off = mira.health.onChange(({ name, healthy }) => notify(name, healthy));   // breaker flips
mira.health.onCheck(({ name, ok }) => record(name, ok));                       // every check
mira.health.watch(true);                     // check every 5 s while, say, a readiness stream has listeners
mira.health.recordProbeSuccess("appDb");     // your own probe reached the pool: close its breaker now
mira.health.nudge("appDb");                  // check soon, outside the cadence
```

`close()` removes the listeners an instance added and turns off a watch it started.

### Config from environment variables

`fromEnv()` reads a config from variables, if you want them. One pool, `appDb`, under the prefix `MIRA_DB`:

| Variable | |
| --- | --- |
| `MIRA_DB_USER`, `MIRA_DB_PASSWORD` | required |
| `MIRA_DB_CONNECT_STRING` | or `MIRA_DB_HOST` + `MIRA_DB_SERVICE` (+ `MIRA_DB_PORT`, default 1521) |
| `MIRA_DB_POOL_MIN`, `_POOL_MAX`, `_POOL_INCREMENT`, `_QUEUE_MAX`, `_QUEUE_TIMEOUT`, `_POOL_TIMEOUT`, `_CONNECT_TIMEOUT`, `_POOL_PING_INTERVAL`, `_STMT_CACHE_SIZE` | optional whole numbers |
| `MIRA_DRIVER_MODE`, `MIRA_DRIVER_LIB_DIR` | optional, see [Thin or Thick mode](#thin-or-thick-mode) |

```ts
import { createMira, fromEnv } from "@jm-paunlagui/mira";

const mira = createMira(fromEnv());   // MIRA_DB_* → appDb
const both = createMira(fromEnv({ pools: { appDb: "MIRA_DB", reporting: "MIRA_RPT" }, defaultPool: "appDb" }));
const fromFile = createMira(fromEnv({ env: parsedSecrets }));   // any object, not only process.env
```

A missing variable or a number that does not parse throws, naming the variable. Bun reads `.env` by itself; Node does not: start it with `node --env-file=.env app.js` (Node 20.6+), or load it yourself first. `.env.example` lists every variable.

### Thin or Thick mode

node-oracledb runs in Thin mode (pure JavaScript) or Thick mode (through an Oracle Client). The mode is process-wide and fixed when the first pool opens.

```ts
createMira({ pools, driver: { mode: "thick", libDir: "/opt/oracle/instantclient_23" } });
// or, before any pool opens: configureDriver({ mode: "thin" });
const { mode, clientVersion } = initDriver();   // set the driver up now; returns what loaded
```

- `"auto"` (default): try Thick mode from `libDir` or the system library path, fall back to Thin. Without a client this is an ordinary Thin start.
- `"thin"`: never load an Oracle Client.
- `"thick"`: load the Oracle Client or throw. Thick mode supports every password verifier; Thin mode rejects some older ones (e.g. 0x939).
- `binaryDir`: where node-oracledb's Thick binary is, when it is not beside the installed package, e.g. staged next to a `bun build --compile` executable.
- Once the driver is up, a setting compatible with it is accepted and a different one throws.

> ⚠️ **Thick mode needs enough worker threads.** In Thick mode every database call runs on a native worker thread from a small pool (`UV_THREADPOOL_SIZE`; Node's default is 4, and Bun's depends on the machine: a 4-core GitHub runner hung where a 12-core PC did not). A call waiting on a row lock keeps its thread. If more calls wait at once than there are threads, the transaction holding the lock never gets a thread to commit, and the process hangs with no error. Set `UV_THREADPOOL_SIZE` to at least your largest `poolMax` **in the environment before the process starts**, e.g. `UV_THREADPOOL_SIZE=24 node app.js`. Setting it in code after startup has no effect. Thin mode does not use these threads. When Thick mode creates a pool whose `poolMax` is above the thread count, Mira logs a warning naming both numbers.

**Session time zone.** node-oracledb writes a JS `Date` in the process's time zone and Oracle reads it in the session's, so Mira opens every pooled session in the process's zone: its region (e.g. `Asia/Manila`) in Thin mode, its UTC offset in Thick mode. A `Date` then keeps its instant in every date column type, under Node and Bun. `CURRENT_TIMESTAMP` and `LOCALTIMESTAMP` in your own SQL are in that zone; `SYSTIMESTAMP` / `SYSDATE` (the database server's clock) are unchanged. To choose another session zone, set `ORA_SDTZ` yourself, to the same zone as the process (`TZ`), or Dates move by the difference; a value that is not an offset, a region, `LOCAL` or `DBTIMEZONE` is refused with a warning. **Thick mode in a zone with daylight saving:** the session takes the offset in force when it opens (a region would make the client fetch with its own time-zone file, which fails with `ORA-01805` when it differs from the server's), so a `Date` from the other season moves by an hour. Run such a process on UTC (`TZ=UTC`).

### Logging

By default Mira writes only warnings (`console.warn`) and errors (`console.error`), prefixed `[mira]`, and never a file. Send its lines to your own logger, or silence them:

```ts
createMira({ pools, logger: console });   // everything: pool lifecycle notices too
createMira({ pools, logger: pino() });    // any object with info, warn and error (debug optional)
createMira({ pools, logger: false });     // nothing
setLogger(myLogger);                      // the same, process-wide, without an instance
```

Mira's levels map onto yours: pool-lifecycle detail → `debug`, notices → `info`, warnings → `warn`, failures → `error`. The logger is process-wide; a second, different logger is refused while another instance's is set, and `close()` puts the default back.

Working from a clone of this repository instead, `bun run build` writes the same package to `dist/`.

### Typed Tables (2.1)

Describe a table once and TypeScript checks every query on it: filter keys and values, inserts, updates, sorts and projections. The row types follow what Mira really returns.

```ts
import { defineTable, t, Transaction } from "@jm-paunlagui/mira";

export const Orders = defineTable("ORDERS", {
    ID: t.id(),                                   // NUMBER identity PK: Oracle assigns it
    CUSTOMER_ID: t.number().references("CUSTOMERS", "ID"),
    TOTAL: t.money(),                             // NUMBER(19,4): read as an exact string
    NOTE: t.text(400).nullable(),
    STATUS: t.text(10).default("'open'"),
    CREATED_AT: t.timestamp().default("SYSTIMESTAMP"),
});
export type Order = typeof Orders.$row;          // { ID: number; TOTAL: string; NOTE: string | null; … }

const db = mira.db();                            // from Setup → Connect
const orders = Orders.on(db);                    // a typed collection (the same OracleCollection underneath)

await orders.insertOne({ CUSTOMER_ID: 7, TOTAL: 9.5 });      // ID, NOTE, STATUS, CREATED_AT may be left out
const big = await orders.find({ TOTAL: { $gt: 100 }, NOTE: null })
    .sort({ CREATED_AT: -1 })
    .project({ ID: 1, TOTAL: 1 })                // → { ID: number; TOTAL: string }[]
    .toArray();
await orders.updateOne({ ID: 1 }, { $set: { STATUS: "paid" } });

// orders.find({ TOTL: 1 })                      ✗ compile error: no column TOTL
// orders.insertOne({ ID: 5, … })                ✗ compile error: ID is an identity column

await new Transaction(db).withTransaction(async (session) => {
    await Orders.on(session).insertOne({ CUSTOMER_ID: 7, TOTAL: "12.00" }); // typed inside a transaction too
});

await Orders.create(db);                         // CREATE TABLE from the definition (Orders.ddl() is the column spec)
```

**Column builders (`t`):**

| Builder | Oracle type | Read as | Write takes |
| --- | --- | --- | --- |
| `t.id()` | `NUMBER` identity primary key | `number` | — (Oracle assigns it) |
| `t.number()`, `t.number(p)` | `NUMBER`, `NUMBER(p)` | `number` | `number` |
| `t.money()`, `t.decimal(p, s)`, `t.number(p, s)` with `s > 0` | `NUMBER(19,4)`, `NUMBER(p,s)` | exact `string` | `string \| number` |
| `t.text(n)`, `t.text(n, "char")`, `t.char(n)` | `VARCHAR2(n [CHAR])`, `CHAR(n)` | `string` | `string` |
| `t.clob()`, `t.blob()` | `CLOB`, `BLOB` | `string`, `Buffer` | same |
| `t.date()`, `t.timestamp(p?)`, `t.timestampTz(p?)` | `DATE`, `TIMESTAMP`, `TIMESTAMP WITH TIME ZONE` | `Date` | `Date` |
| `t.raw<T>("BINARY_DOUBLE")` | any type text | `T` | `T` |

Modifiers: `.nullable()` (reads may be `null`, inserts may leave it out), `.default(sql)` (inserts may leave it out), `.primaryKey()`, `.check(sql)`, `.references(table, column)`, `.identity()` / `.identityByDefault()`. `default`, `check` and `raw` take SQL text: trusted code only, as with `createTable`. Oracle allows one identity column per table, and `defineTable` checks it.

**The typed layer is compile-time only.** `on()` returns the ordinary `OracleCollection`, so every behaviour and error is exactly the untyped API's. Pipelines (`aggregate`) have their own output shape: name it, `orders.aggregate<{ STATUS: string; N: number }>([…])`. For anything the typed signatures do not cover, `.untyped` gives the 2.0 signatures: `orders.untyped.find({ … })`, `orders.find().untyped.project({ X: { $subquery: … } })`.

**Generate definitions for existing tables** from Oracle's catalogue (column types, NOT NULL, defaults, identity columns, primary keys, single-column foreign keys):

```bash
npx mira generate types --out src/db/tables.ts                 # every table in the schema
npx mira generate types --tables ORDERS,CUSTOMERS,SIM_%         # names, or LIKE patterns with %
bun run mira generate types --import ../my-mira-path            # in this repository
```

The command connects with `MIRA_DB_*` (see [Config from environment variables](#config-from-environment-variables)) from the environment or from `.env` (`--env <file>` to pick another), and writes one `defineTable()` and one `…Row` type per table. In code: `await generateTableTypes(db, { tables, importFrom })` returns the same source text. CHECK constraints and multi-column keys are not written; they do not change the row types.

### Relations and include (2.1)

Declare how typed tables relate, once every table exists, then fetch related rows **in the same statement**: no extra query per row.

```ts
import { defineTable, t, relations, hasMany, hasOne, belongsTo } from "@jm-paunlagui/mira";

export const Customers = defineTable("CUSTOMERS", { ID: t.id(), NAME: t.text(60) });
export const Orders = defineTable("ORDERS", { ID: t.id(), CUSTOMER_ID: t.number(), TOTAL: t.money() });

export const CustomersR = relations(Customers, {
    orders: hasMany(Orders, { foreignKey: "CUSTOMER_ID" }),   // ORDERS.CUSTOMER_ID = CUSTOMERS.ID
    biggest: hasOne(Orders, { foreignKey: "CUSTOMER_ID" }),
});
export const OrdersR = relations(Orders, {
    customer: belongsTo(Customers, { foreignKey: "CUSTOMER_ID" }), // ORDERS.CUSTOMER_ID = CUSTOMERS.ID
});

const rows = await CustomersR.on(db)
    .find({ NAME: { $like: "A%" } })
    .include("orders", { where: { TOTAL: { $gt: 100 } }, sort: { TOTAL: -1 }, limit: 5 })
    .include("biggest", { sort: { TOTAL: -1 } })
    .toArray();
// rows[0].orders:  { ID: number; CUSTOMER_ID: number; TOTAL: string }[]
// rows[0].biggest: { ID: number; CUSTOMER_ID: number; TOTAL: string } | null

const o = await OrdersR.on(db).find({ ID: 7 }).project({ ID: 1 }).include("customer").next();
// o.customer: { ID: number; NAME: string } | null
```

| Relation | Key | `include()` gives | Options |
| --- | --- | --- | --- |
| `hasMany(Target, { foreignKey, localKey? })` | `Target.foreignKey = this.localKey` (default: this table's primary key) | an array (`[]` when none) | `where`, `sort`, `limit` |
| `hasOne(Target, { foreignKey, localKey? })` | same | the first row by `sort`, or `null` | `where`, `sort` |
| `belongsTo(Target, { foreignKey, references? })` | `this.foreignKey = Target.references` (default: its primary key) | the row, or `null` | `where` |

- **One statement.** Each included relation is a correlated subquery in the SELECT list, built with `JSON_ARRAYAGG` / `JSON_OBJECT`. `limit` keeps the first n related rows **per parent row**.
- **Related rows keep Mira's types.** Money and decimals are the same exact text as at top level, `DATE` / `TIMESTAMP` columns are `Date`, and CLOB is a string. BLOB and RAW columns are left out, because JSON has no binary type. Read them with a separate query.
- **It combines** with filters, `sort`, `skip`, `limit`, `project` (on the parent's columns), `forEach`, `next`, `await`, and `on(session)` in transactions.
- `relations()` returns the same table with relations attached: `name`, `columns`, `ddl()`, `create()` and `on()` are unchanged. Declaring relations apart from the tables lets two tables point at each other, and keeps generated table files as they are.
- Only one level of nesting is supported: an included row cannot include further relations yet.

### JSON Columns (2.1)

Store documents in Oracle and query them the MongoDB way: dotted paths, `$elemMatch`, `$push` / `$pull`.

```ts
type Prefs = { lounge: boolean; drinks: string[]; addr?: { city: string } };
export const Members = defineTable("MEMBERS", {
    ID: t.id(),
    NAME: t.text(60),
    PREFS: t.json<Prefs>(),                       // CLOB with an IS JSON check (Oracle 19c+)
    // or t.json<Prefs>({ native: true })          // the JSON type (Oracle 23ai; Thin mode or Oracle Client 21c+)
});
const members = Members.on(db);

await members.insertOne({ NAME: "Ana", PREFS: { lounge: true, drinks: ["tea"] } }); // written as JSON
const vips = await members.find({ "PREFS.lounge": true, "PREFS.addr.city": { $in: ["Cebu", "Davao"] } }).toArray();
vips[0].PREFS.drinks;                                                                 // read back as a document: string[]

await members.find({ "PREFS.drinks": { $elemMatch: { $eq: "tea" } } });             // an element that matches
await members.updateOne({ ID: 1 }, {
    $set: { "PREFS.addr.city": "Cebu" },                                              // missing objects are created
    $unset: { "PREFS.lounge": 1 },
    $push: { "PREFS.drinks": { $each: ["water", "coffee"] } },
});
await members.updateOne({ ID: 1 }, { $pull: { "PREFS.drinks": { $in: ["coffee"] } } });

// One row per array element, joined to its row
await members.aggregate([
    { $jsonTable: { column: "PREFS", path: "drinks", ordinality: "POS", columns: { DRINK: "$" } } },
    { $group: { _id: "$DRINK", N: { $count: "*" } } },
]);
```

**Filters on a path** (`"COL.a.b"`, `"COL.items.0.sku"`): `$eq` `$ne` `$gt` `$gte` `$lt` `$lte` `$in` `$nin` `$between` `$exists`, `null` (missing or null), and `$elemMatch`.
- A path compares as a number, a date or text depending on the value you give: `JSON_VALUE(… RETURNING NUMBER | TIMESTAMP WITH TIME ZONE | VARCHAR2)`.
- `$elemMatch` takes element fields (`{ sku: "X", qty: { $gt: 2 } }`) or, for arrays of plain values, operators on the element itself (`{ $eq: "tea" }`). It becomes `JSON_EXISTS` with every value bound.

**Updates on a path:**
- `$set` and `$unset` on paths become one `JSON_MERGEPATCH` per column, and missing objects are created.
- `$push` (a value, or `{ $each: [...] }`) and `$pull` (a value, or `{ $in: [...] }`) rebuild the array with `JSON_TABLE`; pulling every element leaves `[]`.
- A key without a dot (`{ $push: { TAGS: "x" } }`) works on a column that holds an array.
- `$set` of `null` on a path is refused: under merge-patch rules it would delete the key, so use `$unset`. Paths through an array index (`"COL.items.0.qty"`) can't be updated; replace the array, or `$push` / `$pull` it.

**`$jsonTable`** `{ column, path, columns: { NAME: "path" | { path, type } }, ordinality?, outer? }`: one row per element of the array at `path`, joined to its source row.
- `"$"` as a column's path is the element itself.
- `type` is `NUMBER[(p[,s])]`, `VARCHAR2(n)` (the default is `VARCHAR2(4000)`), `DATE`, `TIMESTAMP[(n)] [WITH TIME ZONE]`, `CLOB` or `JSON`.
- `outer: true` keeps rows whose array is empty or missing.

**Typed tables:**
- A `t.json<T>()` column is read and written as `T`: `find`, `findOne`, `next`, `forEach`, `await`, and inside `include()`.
- Dotted paths must start with a known column (the rest of the path isn't checked), and `$elemMatch` is only accepted on JSON columns.
- `mira generate types` writes `t.json()` for a CLOB with an `IS JSON` check, and `t.json({ native: true })` for the JSON type.

**Notes:**
- Filters and updates on paths also work through the untyped API.
- The untyped API keeps returning JSON columns as the **stored text**, as in 2.0, so code written for 2.0 is unaffected.
- All the SQL uses functions Oracle 19c has (no `JSON_TRANSFORM`), so it runs on 19c and 23ai, for JSON text and for the JSON type.
- **The native JSON type needs Thin mode or Oracle Client 21c+.** A 19c client can't read it (`ORA-40569`), and a write can break the session (`ORA-03106`). `Table.on(db)` refuses a native column on a 19.x Thick client, and says so. The JSON type itself needs Oracle Database 21c+: on 19c, `create()` refuses it before Oracle answers `ORA-00902`.
- A filter key containing a dot is now always a JSON path. A column whose name itself contains a dot can't be filtered by name.

### Timestamps, Soft Delete, Hooks and Validation (2.1)

A typed table can ask Mira to maintain timestamps, delete softly, run hooks around writes, and check writes against its columns:

```ts
import { defineTable, t, MiraValidationError } from "@jm-paunlagui/mira";

const AuditLog = defineTable("AUDIT_LOG", { ID: t.id(), WHAT: t.text(200) });
const Members = defineTable("MEMBERS", {
  ID: t.number(10).primaryKey(),
  NAME: t.text(40),
  POINTS: t.number(9),
  JOINED_AT: t.createdAt(),     // TIMESTAMP(6) WITH TIME ZONE DEFAULT SYSTIMESTAMP
  CHANGED_AT: t.updatedAt(),    // the same, and every update sets it
  REMOVED_AT: t.deletedAt(),    // soft delete
}, {
  validate: true,
  hooks: {
    beforeInsert: (doc) => ({ ...doc, NAME: doc.NAME.trim() }),
    afterDelete: async (result, filter, ctx) => {
      await AuditLog.on(ctx).insertOne({ WHAT: `removed ${JSON.stringify(filter)}` }); // same transaction
    },
  },
});

const members = Members.on(db);
await members.insertOne({ ID: 1, NAME: " Ana ", POINTS: 0 });   // NAME "Ana"; JOINED_AT and CHANGED_AT stamped by Oracle
await members.updateOne({ ID: 1 }, { $inc: { POINTS: 10 } });     // CHANGED_AT = SYSTIMESTAMP
await members.deleteOne({ ID: 1 });                               // sets REMOVED_AT; the row stays
await members.find().toArray();                                   // skips removed members
await members.withDeleted().find().toArray();                     // sees them
await members.restore({ ID: 1 });                                 // clears REMOVED_AT
await members.deleteOne({ ID: 1 }, { force: true });              // a real DELETE
await members.insertOne({ ID: 2, NAME: "x".repeat(50), POINTS: 1.5 });
// MiraValidationError: [MEMBERS] insert is not valid: NAME is 50 bytes long; VARCHAR2(40) allows 40; POINTS must be a whole number, got 1.5.
```

**Timestamps:** `t.createdAt()` and `t.updatedAt()` are `TIMESTAMP(6) WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL`, so Oracle's clock stamps them and they read back as the exact instant. An insert may still give a value (an import, for example). Every update through the collection sets the `t.updatedAt()` column with `$currentDate`, unless the update sets that column itself.

**Soft delete:** with a `t.deletedAt()` column (nullable, one per table):
- `deleteOne`, `deleteMany` and `findOneAndDelete` set the column to `SYSTIMESTAMP`. `deletedCount` counts the rows marked, and a row already marked is not counted again.
- `find`, `findOne`, `countDocuments`, `distinct`, `aggregate`, the updates and the deletes skip marked rows. A filter that names the column itself (`{ REMOVED_AT: { $ne: null } }`) is left as it is.
- `include()` leaves out marked rows of a soft-deleting related table.
- `withDeleted()` gives the same collection with marked rows visible. `restore(filter)` clears the mark; it is an update, so `updatedAt` and the update hooks apply.
- `{ force: true }` on a delete removes rows for real. A soft `deleteMany` has no `limit`.

**Hooks** run around writes through the collection: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`.
- A before-hook may return a changed document or update (or nothing, to keep it) and may throw to stop the write. It runs before validation, so it can fill in a column.
- The last argument, `ctx`, works like a transaction session: `Table.on(ctx)` or `ctx.collection(name)` is a table on the same connection, so inside `withTransaction` the hook's writes commit or roll back with the rest. `ctx.self` is the collection itself.
- `insertMany` calls the insert hooks once per document. `bulkWrite` runs each operation through the wrapped methods, so their hooks run too.

**Validation** (`validate: true`) checks every insert and update before any SQL and lists every problem in one `MiraValidationError` (`err.issues` is `{ column, message }[]`):
- unknown columns, values for identity columns, required columns left out, `null` (or `$unset`) for a column that is not nullable
- numbers for `NUMBER` (whole numbers when the scale is 0), a decimal string or number for money and decimals, and the digits before the decimal point within the precision
- strings within `VARCHAR2(n)` / `CHAR(n)` in UTF-8 bytes, or in characters for `t.text(n, "char")`
- `Date` for dates and timestamps, `Buffer` for BLOB and RAW
- JSON documents and `t.raw()` types are left to Oracle.

**Notes:**
- `replaceOne` and `findOneAndReplace` on such a table become a `$set` of every given column except the primary key, so `updatedAt`, hooks and validation apply.
- These behaviours belong to the collection's `find`, `findOne`, `countDocuments`, `distinct`, `aggregate`, inserts, updates, replaces, deletes and `findOneAnd*`. Statements that work on many rows at once or on other tables (`merge`, `mergeFrom`, `bulkUpdateByKeys`, `updateFromJoin`, `insertFromQuery`, `connectBy`, `pivot`, raw SQL) are 2.0's and do none of this.
- A typed table without any of these features still gets a plain `OracleCollection` from `on()`.

### Optimistic Locking (2.1)

A `t.version()` column stops two people who read the same row from silently overwriting each other:

```ts
import { defineTable, t, MiraConcurrencyError } from "@jm-paunlagui/mira";

const Docs = defineTable("DOCS", { ID: t.number(10).primaryKey(), TITLE: t.text(80), VERSION: t.version() });
const docs = Docs.on(db);

const doc = await docs.findOne({ ID: 1 });                        // { ID: 1, TITLE: "…", VERSION: 3 }
try {
  await docs.updateOne({ ID: doc.ID, VERSION: doc.VERSION }, { $set: { TITLE: "New title" } }); // VERSION becomes 4
} catch (err) {
  if (err instanceof MiraConcurrencyError) {
    // Someone saved in between: err.expectedVersion 3, err.currentVersion 4. Re-read and try again.
  }
}
```

- `t.version()` is `NUMBER(10) DEFAULT 1 NOT NULL`. Every update through the collection adds 1 (`$inc`), unless the update sets the column itself. A replacement never sets it.
- **The check:** `updateOne`, `findOneAndUpdate`, `replaceOne`, `findOneAndReplace`, `deleteOne` and `findOneAndDelete` with a filter that gives the version as a plain number. When such a write matches nothing but the row (the filter without the version) is still there, it changed since it was read, so Mira throws `MiraConcurrencyError` instead of returning a count of 0. When the row is gone, the result is the usual 0.
- `updateMany` / `deleteMany` are not checked: they are not about one row read earlier.
- `upsert` with a version in the filter is refused, since a stale version would insert a second row.

**Errors in transactions:** `MiraConcurrencyError` and `MiraValidationError` are *operational* (`isOperational: true`, `statusCode` 409 and 422). Inside `withTransaction` they reach your code with their own class instead of being wrapped as a database failure, and they aren't logged as critical.

### Keyset Paging, Streaming, Raw SQL and Query Events (2.1)

**Keyset pagination: `after()`.** Continue after the previous page's last row, in the order of `sort()`. Unlike `skip()`, Oracle seeks straight to the page, and rows added or removed meanwhile don't shift it.

```ts
const page1 = await orders.find().sort({ TOTAL: -1, ID: 1 }).limit(20).toArray();
const page2 = await orders.find().sort({ TOTAL: -1, ID: 1 }).after(page1.at(-1)).limit(20).toArray();
// … WHERE ((t0."TOTAL" < :after_0) OR (t0."TOTAL" = :after_0 AND t0."ID" > :after_1)) ORDER BY … FETCH FIRST 20 ROWS ONLY
```
- The cursor is the last row, or just its sort-key values. Every sort key must be present and not null.
- End the sort with a unique column (the primary key) so no two rows tie.
- Without a `sort()` it throws, since there is no order to continue in.

**Streaming: `for await`.** A query can be iterated directly. Rows are streamed (constant memory, like `forEach`) on one connection, which goes back to the pool when the loop ends, `break`s or throws. Inside a transaction, the session's connection is used.

```ts
for await (const order of orders.find({ STATUS: "open" }).sort({ ID: 1 })) {
  if (!(await ship(order))) break;
}
```

**Raw SQL: the ``sql`…` `` tag.** For the statement the API doesn't cover. Every interpolated value becomes a bind, so a value can never change the statement:

```ts
import { sql } from "@jm-paunlagui/mira";

const rows = await sql`
  SELECT STORE_ID, SUM(TOTAL) AS TOTAL FROM ${sql.ident("ORDERS")}
   WHERE STORE_ID IN (${storeIds}) AND TOTAL >= ${min}
   GROUP BY STORE_ID`.rows<{ STORE_ID: number; TOTAL: string }>(db);
// … WHERE STORE_ID IN (:p0, :p1) AND TOTAL >= :p2 …

const { rowsAffected } = await sql`UPDATE ORDERS SET STATUS = ${"closed"} WHERE ID = ${id}`.execute(session);
```
- An array becomes a list of binds (for `IN`). An empty array is refused, because `IN ()` is not SQL.
- `sql.ident("T")` / `sql.ident("t", "COL")` splices a quoted identifier, after checking it is a plain name.
- A nested ``sql`…` `` fragment is spliced from its parts and its binds join the statement. Its text is never re-parsed.
- `undefined`, functions and plain objects are refused (pass `null` for SQL NULL).
- `.rows(target)` returns the rows. `.execute(target)` returns `{ rows, rowsAffected }` and commits outside a transaction. `target` is the db handle, a transaction session, or a hook's `ctx`.

**Query events: `onQuery()`.** A callback after every statement, for slow-query logs or metrics:

```ts
import { onQuery } from "@jm-paunlagui/mira";

const stop = onQuery((e) => {
  if (e.durationMs > 500) logger.warning(`slow ${e.operation} (${e.durationMs} ms, ${e.bindCount} binds): ${e.sql}`);
});
stop(); // unsubscribe
```
- It is built on node-oracledb's trace handler, so it sees every `execute` / `executeMany`: Mira's own statements, ``sql`…` ``, and your own `conn.execute()` calls.
- Each event has `operation`, `sql`, `bindCount`, `batchSize` (executeMany), `durationMs`, `rowCount`, `rowsAffected` and `error`. **Bind values are never included**, since they may hold passwords or personal data.
- oracledb allows one trace handler per process. If one is already installed (for example OpenTelemetry's oracledb instrumentation), Mira's handler passes every hook on to it, so spans keep working. When the last listener unsubscribes, the earlier handler is put back.
- A listener that throws is ignored, so an event never breaks a query.

### Migrations (2.1)

Versioned schema changes, one file each, applied in name order and recorded in a history table.

```bash
npx mira migrate new create_orders      # → migrations/20261125070809_create_orders.ts
npx mira migrate status                 # applied / pending / changed / missing
npx mira migrate up --dry-run           # print the SQL each pending migration would run; change nothing
npx mira migrate up                     # apply every pending migration (or --to <name>)
npx mira migrate down                   # roll back the newest one (--steps n, --to <name>, --all)
```

```ts
// migrations/20261125070809_create_orders.ts
import type { MigrationContext } from "@jm-paunlagui/mira";
import { Orders } from "../src/db/tables";        // a defineTable() definition

export async function up({ createTable, collection, schema, execute }: MigrationContext) {
    await createTable(Orders);
    await collection("ORDERS").createIndex({ CUSTOMER_ID: 1 });
}

export async function down({ schema }: MigrationContext) {
    await schema.dropTable("ORDERS");
}
```

The context gives `schema` (an `OracleSchema`: `createTable`, `alterTable`, `dropTable`, `createView`, `createSequence` …), `collection(name)` (indexes, seed data), `createTable(definition)`, `execute(sql, binds)` for anything else, `db`, and `dryRun`.

- **History.** Each applied migration is a row in `MIRA_MIGRATIONS`: name, SHA-256 checksum of the file, batch (one per `up` run), applied-at time and duration. If an applied file **changes** or is **deleted**, `status` reports it (and exits 1) and `up` refuses to run. The code no longer describes the database, so restore the file or fix the history by hand.
- **Order.** Pending migrations run in name order, which is why file names start with a UTC timestamp. One merged from another branch that sorts before already-applied ones still runs.
- **Lock.** A run holds a row lock on `MIRA_MIGRATIONS_LOCK` for its whole length, so a second deployment migrating at the same time fails at once with "another migration run holds the lock". Oracle frees the lock if the process dies; no extra grant is needed.
- **⚠️ Oracle DDL is not transactional.** Every DDL statement commits by itself, so a migration that fails halfway cannot be undone automatically. Its history row is written only when it succeeds, and the error names it and says so. Fix the schema by hand, then run `up` again. Keep each migration small.
- **Dry run.** `--dry-run` runs every migration against a recording connection: the SQL is printed and nothing reaches the database (reads inside a migration see no rows).
- **In code.** `createMigrator(db, { dir: "migrations" })` (or `{ migrations: [{ name, up, down }] }`) returns `{ up, down, status, list }`; `{ table }` renames the history table.
- **Node.** `.ts` migration files load under Bun, and under Node where it strips types (22.18+, 23.6+). Otherwise write them as `.js` / `.mjs`. Migrations live in your repository, so the command reads them from `--dir` (default `./migrations`).

---

## Basic — Your First Queries

> Things you'll use every day: creating tables, inserting data, finding rows, simple updates, and deletes.

### Create a Table

```js
const schema = new OracleSchema(db);

await schema.createTable("users", {
    id: { type: "NUMBER", primaryKey: true, autoIncrement: true },
    name: { type: "VARCHAR2(200)", notNull: true },
    email: { type: "VARCHAR2(300)", notNull: true },
    status: { type: "VARCHAR2(20)", default: "'active'" },
});
```

### Get a Collection (Table Reference)

```js
const users = new OracleCollection("users", db);
```

This doesn't query anything yet — it just creates a reference to the `users` table.

### Insert Data

```js
// Insert one row
const { insertedId } = await users.insertOne({
    name: "Juan",
    email: "juan@email.com",
});

// Insert many rows at once (bulk insert — much faster than looping insertOne)
await users.insertMany([
    { name: "Maria", email: "maria@email.com" },
    { name: "Pedro", email: "pedro@email.com" },
]);
```

`insertMany` returns `insertedIds`. By default it reads each new `ID` back with `RETURNING`, which costs out-binds on every row. When every document already carries its own integer `ID`, the table is your schema's own, its `ID` is a `NUMBER` with no scale, and no trigger fires on insert, Mira reports the IDs you supplied and skips `RETURNING` (about 2.4× faster for 1,000 rows). It checks the dictionary once per table per minute. Pass `returning: ["ID"]` to always read the stored values back, or `returning: []` when you need no IDs.

### Find Data

```js
// Find one row
const user = await users.findOne({ name: "Juan" });
// → { ID: 1, NAME: "Juan", EMAIL: "juan@email.com", STATUS: "active" }

// Find all rows (returns an array)
const allUsers = await users.find({}).toArray();

// Find with a simple filter
const activeUsers = await users.find({ status: "active" }).toArray();
```

> **Important:** `find()` returns a chainable query — it doesn't run until you call `.toArray()`, `.next()`, or `await` it.

### Update Data

```js
// Update one row — set the status field
await users.updateOne(
    { name: "Juan" }, // filter: find the row
    { $set: { status: "premium" } }, // update: what to change
);

// Update all rows matching a filter
await users.updateMany({ status: "trial" }, { $set: { status: "expired" } });
```

### Delete Data

```js
// Delete one row
await users.deleteOne({ name: "Pedro" });

// Delete all rows matching a filter
await users.deleteMany({ status: "banned" });
```

### Count Rows

```js
const total = await users.countDocuments({}); // count all
const active = await users.countDocuments({ status: "active" }); // count with filter
```

### Drop a Table

```js
await users.drop(); // ⚠️ Permanent! Deletes the table and all its data
```

---

## Medium — Filtering, Updating & Chaining

> Comparison operators, chaining find queries, pagination, projections, and advanced update operators.

### Filters from request input

A filter is a small query language, so a request body or query string must never become one as is. `?name[$ne]=x` arrives as `{ name: { $ne: "x" } }`. `sanitizeFilter()` keeps plain values (string, number, boolean, null, Date) as equality and refuses every operator, nested object and list:

```js
import { sanitizeFilter } from "@jm-paunlagui/mira";

// GET /users?city=Cebu&status=active
await users.find({ ...sanitizeFilter(req.query), tenantId: user.tenantId }).toArray();
```

Add operators in code, from values you took out of the input. See [SECURITY.md](SECURITY.md) for what Mira binds and which inputs are SQL by design.

### Filter Operators

Instead of just `{ field: value }`, you can use `$operators` for comparisons:

```js
// Greater than / less than
await users.find({ age: { $gt: 18 } }).toArray(); // age > 18
await users.find({ age: { $gte: 18 } }).toArray(); // age >= 18
await users.find({ price: { $lt: 100 } }).toArray(); // price < 100
await users.find({ price: { $lte: 100 } }).toArray(); // price <= 100

// Not equal
await users.find({ status: { $ne: "inactive" } }).toArray();

// In a list / not in a list
await users.find({ status: { $in: ["active", "premium"] } }).toArray();
await users.find({ role: { $nin: ["banned", "deleted"] } }).toArray();

// Between a range
await users.find({ age: { $between: [18, 65] } }).toArray();

// Check if a field is NOT null
await users.find({ email: { $exists: true } }).toArray();
await users.find({ email: { $ne: null } }).toArray(); // same: IS NOT NULL ({ $eq: null } is IS NULL)

// Compare with the database clock (never the app's)
await sessions.find({ last_seen: { $gte: { $now: { minus: { minutes: 30 } } } } }).toArray();
// $now is the database server's wall-clock time as a plain TIMESTAMP, the same value
// $currentDate stores, so DATE / TIMESTAMP columns compare correctly whatever the app's
// time zone. For a TIMESTAMP WITH TIME ZONE column add withTimeZone: true.
await events.find({ at_tz: { $lt: { $now: { withTimeZone: true } } } }).toArray();

// Pattern matching
await users.find({ name: { $like: "J%" } }).toArray(); // SQL LIKE
await users.find({ name: { $regex: "^J" } }).toArray(); // Regular expression

// Combine multiple conditions on the same field
await users.find({ age: { $gte: 18, $lte: 65 } }).toArray();
```

### Logical Operators (OR, AND, NOR, NOT)

```js
// OR — either condition matches
await users
    .find({
        $or: [{ city: "Manila" }, { city: "Cebu" }],
    })
    .toArray();

// AND — all conditions match (explicit)
await users
    .find({
        $and: [{ age: { $gte: 18 } }, { status: "active" }],
    })
    .toArray();

// NOR — none of the conditions match
await users
    .find({
        $nor: [{ status: "banned" }, { status: "deleted" }],
    })
    .toArray();

// NOT — negate a condition
await users
    .find({
        $not: { status: "inactive" },
    })
    .toArray();
```

### Chaining: Sort, Limit, Skip, Project

`find()` is lazy — it builds the query piece by piece. SQL only runs when you call a terminal method.

```js
const results = await users
    .find({ status: "active" }) // WHERE status = 'active'
    .sort({ name: 1 }) // ORDER BY name ASC (use -1 for DESC)
    .skip(20) // OFFSET 20 ROWS (skip first 20)
    .limit(10) // FETCH FIRST 10 ROWS ONLY
    .project({ name: 1, email: 1 }) // SELECT name, email (only these columns)
    .toArray(); // Execute and return rows
```

**Sort direction:** `1` = ascending (A→Z, 0→9), `-1` = descending (Z→A, 9→0). To place NULLs, give an object: `{ city: { order: 1, nulls: "first" } }` → `ORDER BY "city" ASC NULLS FIRST` (`nulls`: `"first"` or `"last"`). The same form works in a pipeline `$sort`, a window's `orderBy` and an accumulator's `orderBy`.

**Ties:** `.sort({ score: -1 }).limit(3, { withTies: true })` → `FETCH FIRST 3 ROWS WITH TIES`: rows tied with the third on the sort keys are kept too. It needs a `sort()`; without one Oracle would silently return exactly 3 rows, so Mira throws.

**Projection:** `{ name: 1, email: 1 }` = include only name and email. `{ password: 0 }` = exclude password, include everything else.

### Terminal Methods (What Actually Runs the Query)

| Method         | What it does                                             |
| -------------- | -------------------------------------------------------- |
| `.toArray()`   | Returns all matching rows as an array                    |
| `.next()`      | Returns the first row only                               |
| `.hasNext()`   | Returns `true` if any row exists                         |
| `.count()`     | Returns the count of matching rows                       |
| `.forEach(fn)` | Streams rows one at a time (O(1) memory — huge datasets) |
| `.explain()`   | Returns the SQL string without running it (debug)        |

```js
// You can also just await find() directly — same as .toArray()
const rows = await users.find({ status: "active" });
```

### Update Operators

```js
// $set — set specific fields
await users.updateOne({ id: 1 }, { $set: { status: "premium", tier: "gold" } });

// $inc — increment a number
await users.updateOne({ id: 1 }, { $inc: { loginCount: 1 } });

// $mul — multiply a number
await products.updateMany(
    { category: "electronics" },
    { $mul: { price: 0.9 } },
); // 10% off

// $min / $max — set to the lesser/greater value
await users.updateOne({ id: 1 }, { $min: { lowScore: 50 } }); // LEAST(lowScore, 50)
await users.updateOne({ id: 1 }, { $max: { highScore: 99 } }); // GREATEST(highScore, 99)

// $currentDate — set to current timestamp
await users.updateOne({ id: 1 }, { $currentDate: { lastLogin: true } }); // SYSDATE

// $unset — set a field to NULL
await users.updateOne({ id: 1 }, { $unset: { temporaryNote: "" } });

// Combine multiple operators in one call
await users.updateOne(
    { id: 1 },
    {
        $set: { status: "premium" },
        $inc: { loginCount: 1 },
        $currentDate: { updatedAt: true },
    },
);
```

### Find-and-Modify Methods

```js
// Find a row, update it, and return the original (or updated) document
const original = await users.findOneAndUpdate(
    { id: 1 },
    { $set: { status: "premium" } },
    { returnDocument: "before" }, // "before" = return old value, "after" = return new value
);

// Find and delete — returns the deleted document
const deleted = await users.findOneAndDelete({ status: "inactive" });

// Find and replace — replace the entire row (except the ID)
await users.findOneAndReplace(
    { id: 1 },
    { name: "New Name", email: "new@email.com", status: "active" },
);
```

### Distinct Values

```js
const cities = await users.distinct("city"); // All unique city values
const activeCities = await users.distinct("city", { status: "active" }); // With filter
```

### Indexes

```js
// Create an index (speeds up queries on that column)
await users.createIndex({ email: 1 }, { unique: true }); // unique index
await users.createIndex({ name: 1, status: 1 }); // compound index

// List all indexes
const indexes = await users.getIndexes();

// Drop an index
await users.dropIndex("IDX_users_email");
```

---

## Hard — Aggregation, Transactions & Joins

> Aggregation pipelines, grouping, joining tables, transactions with savepoints, MERGE/UPSERT, and set operations.

### Aggregation Pipeline

An aggregation pipeline is an **ordered array of stages**. Data flows through each stage like a conveyor belt:

```
[raw data] → $match → $group → $sort → $limit → [result]
```

```js
// "Top 5 regions by total completed sales"
const report = await orders.aggregate([
    { $match: { status: "completed" } }, // Step 1: filter
    { $group: { _id: "$region", total: { $sum: "$amount" } } }, // Step 2: group & sum
    { $sort: { total: -1 } }, // Step 3: sort descending
    { $limit: 5 }, // Step 4: top 5 only
]);
```

> **The `$` prefix rule:** `"$region"` means "the value of the region column." Without `$`, it's a literal string.

### Pipeline Stages

| Stage        | SQL Equivalent            | What it does                            |
| ------------ | ------------------------- | --------------------------------------- |
| `$match`     | `WHERE`                   | Filter rows                             |
| `$group`     | `GROUP BY` + aggregates   | Group rows and compute SUM, COUNT, etc. |
| `$project`   | `SELECT col1, col2`       | Pick/rename/compute columns             |
| `$addFields` | `SELECT *, newCol`        | Add new columns, keep existing ones     |
| `$sort`      | `ORDER BY`                | Sort results                            |
| `$limit`     | `FETCH FIRST N ROWS ONLY` | Limit row count. `{ $limit: { n: 3, withTies: true } }` right after a `$sort` keeps ties (`WITH TIES`) |
| `$skip`      | `OFFSET N ROWS`           | Skip rows                               |
| `$count`     | `SELECT COUNT(*) AS name` | Count rows                              |
| `$lookup`    | `JOIN`                    | Join another table                      |
| `$having`    | `HAVING`                  | Filter AFTER grouping                   |
| `$out`       | `INSERT INTO ... SELECT`  | Write results to another table          |
| `$merge`     | `MERGE INTO`              | Upsert results into another table       |
| `$bucket`    | `CASE WHEN` ranges        | Group values into defined ranges        |

### Aggregate Expressions

Used inside `$group`, `$project`, and `$addFields`:

```js
await orders.aggregate([
    {
        $group: {
            _id: "$customerId", // GROUP BY customerId
            totalSpent: { $sum: "$amount" }, // SUM(amount)
            orderCount: { $count: "*" }, // COUNT(*)
            avgOrder: { $avg: "$amount" }, // AVG(amount)
            biggest: { $max: "$amount" }, // MAX(amount)
            smallest: { $min: "$amount" }, // MIN(amount)
        },
    },
    { $sort: { totalSpent: -1 } },
]);
```

**Statistics and lists (2.1).** Each takes a column (`"$amount"`), an expression, or an options object with `input`:

```js
await orders.aggregate([
    {
        $group: {
            _id: "$region",
            customers: { $countDistinct: "$customerId" }, // COUNT(DISTINCT customerId)
            medianTicket: { $median: "$amount" }, // MEDIAN(amount)
            spread: { $stdDevSamp: "$amount" }, // STDDEV_SAMP (also $stdDevPop)
            p90: { $percentile: { input: "$amount", p: 0.9 } }, // PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY amount)
            p10p90: { $percentile: { input: "$amount", p: [0.1, 0.9] } }, // a list of p → a JS array [p10, p90]
            p90disc: { $percentile: { input: "$amount", p: 0.9, method: "discrete" } }, // PERCENTILE_DISC
            receipts: { $push: { input: "$receiptNo", orderBy: { receiptNo: 1 } } }, // JS array, NULLs kept
            products: { $addToSet: "$product" }, // JS array, each value once
            productList: { $listAgg: { input: "$product", separator: ", ", distinct: true } }, // one string (LISTAGG)
        },
    },
]);
```

- `$push` / `$addToSet` are built with `JSON_ARRAYAGG(… RETURNING CLOB)` and come back from `aggregate()` as **JS arrays**, like MongoDB. `$push` keeps NULLs; `$addToSet` keeps the first of each value (19c's `JSON_ARRAYAGG` has no `DISTINCT`). Numbers in them are JS numbers, so money in an array is not the exact string a money column gives.
- The arrays are parsed for the pipeline's final output. A later stage that renames or recomputes the column gets the JSON text.
- `$listAgg` options: `separator` (default `","`, bound), `distinct`, `orderBy` (default: the value). The result is one string, limited by Oracle's VARCHAR2 size (4000 bytes unless `MAX_STRING_SIZE = EXTENDED`).
- `$percentile`: `p` is a number from 0 to 1 or a list of them; `method` is `"continuous"` (default, interpolated) or `"discrete"` (an actual value).

### $having — Filter After Grouping

```js
// Only show regions with total sales over 10,000
await sales.aggregate([
    { $group: { _id: "$region", total: { $sum: "$amount" } } },
    { $having: { total: { $gt: 10000 } } }, // filters AFTER the GROUP BY
    { $sort: { total: -1 } },
]);
```

### $project — Computed Fields

```js
await users.aggregate([
    {
        $project: {
            name: 1, // include as-is
            upperName: { $toUpper: "$name" }, // UPPER(name)
            displayName: { $ifNull: ["$nickname", "$name"] }, // COALESCE(nickname, name)
            fullName: { $concat: ["$firstName", "$lastName"] }, // firstName || lastName
            tier: {
                $cond: {
                    // CASE WHEN ... THEN ... ELSE ... END
                    if: { totalSpent: { $gte: 10000 } },
                    then: "VIP",
                    else: "Regular",
                },
            },
        },
    },
]);
```

### $lookup — JOIN Tables

```js
// Left join: all orders, with customer info if available
await orders.aggregate([
    {
        $lookup: {
            from: "customers", // table to join
            localField: "customerId", // column in orders
            foreignField: "id", // column in customers
            as: "cust", // alias
            joinType: "left", // left | right | inner | full | cross | self | natural
        },
    },
    { $project: { orderId: 1, amount: 1, "cust.name": 1 } },
]);

// Multi-condition join
await orders.aggregate([
    {
        $lookup: {
            from: "inventory",
            as: "stock",
            joinType: "inner",
            on: [
                { localField: "productId", foreignField: "id" },
                { localField: "warehouseId", foreignField: "warehouseId" },
            ],
        },
    },
]);

// Self-join: employees with their managers
await employees.aggregate([
    {
        $lookup: {
            from: "employees",
            localField: "managerId",
            foreignField: "id",
            as: "manager",
            joinType: "self",
        },
    },
]);
```

#### `select` — Avoid ORA-00918 When Tables Share Column Names

When two tables have a column with the same name (e.g. both have `USERID`), the default
`SELECT left.*, right.*` produces a duplicate column in the result set. Oracle then raises
**ORA-00918: column ambiguously defined** when a later `$project` references that column.

Use `select` to list only the columns you need from the **right-hand (joined) table**.
The left table is always included in full.

```js
// Without select — raises ORA-00918 if T_USERS and T_USER_PROFILES both have USERID
await users.aggregate([
    { $match: { USERID: "48022603" } },
    {
        $lookup: {
            from: "T_USER_PROFILES",
            localField: "USERID",
            foreignField: "USERID",
            as: "pi",
            joinType: "left",
            // ← no select: both tables expose USERID → ambiguous
        },
    },
    { $project: { USERID: 1, EMAILADDRESS: 1 } }, // ORA-00918 ❌
]);

// With select — only EMAILADDRESS is pulled from T_USER_PROFILES
await users.aggregate([
    { $match: { USERID: "48022603" } },
    {
        $lookup: {
            from: "T_USER_PROFILES",
            localField: "USERID",
            foreignField: "USERID",
            as: "pi",
            joinType: "left",
            select: ["EMAILADDRESS"], // ← pull only this column from the right side
        },
    },
    { $project: { USERID: 1, EMAILADDRESS: 1 } }, // unambiguous
]);
```

Generated SQL comparison:

```sql
-- Without select (ambiguous USERID):
SELECT "stage_0".*, "pi".*
FROM "stage_0" LEFT OUTER JOIN "T_USER_PROFILES" "pi" ON "stage_0"."USERID" = "pi"."USERID"

-- With select: ["EMAILADDRESS"] (no duplicate columns):
SELECT "stage_0".*, "pi"."EMAILADDRESS"
FROM "stage_0" LEFT OUTER JOIN "T_USER_PROFILES" "pi" ON "stage_0"."USERID" = "pi"."USERID"
```

> **Rule of thumb:** Any time the joined table shares a column name with the left table,
> use `select` to list only the columns you actually need from the right side.

### Transactions with Savepoints

Transactions ensure **all-or-nothing** execution. If anything fails, everything rolls back.

```js
const txManager = new Transaction(db);

await txManager.withTransaction(async (session) => {
    // Everything inside here uses the SAME database connection
    const orders = session.collection("orders");
    const payments = session.collection("payments");

    await orders.insertOne({ item: "laptop", qty: 1, total: 50000 });

    // Create a savepoint — a checkpoint you can roll back to
    await session.savepoint("after_order");

    try {
        await payments.insertOne({ amount: -999 }); // this might fail
    } catch (err) {
        // Roll back to the savepoint — the order insert is preserved
        await session.rollbackTo("after_order");
    }

    // If we reach here without errors, everything is committed automatically
});
```

### MERGE / UPSERT

Insert if the row doesn't exist, update if it does:

```js
// Match on id — update salary if found, insert if not
await employees.merge(
    { id: 10, name: "Ana", salary: 60000 },
    { localField: "id", foreignField: "id" },
    {
        whenMatched: { $set: { salary: 60000 } },
        whenNotMatched: "insert",
    },
);

// Merge from another table
await employees.mergeFrom({
    sourceTable: "temp_employees",
    on: { id: "$src.id" },
    whenMatched: { $set: { salary: "$src.salary" } },
    whenNotMatched: "insert",
});
```

### Set Operations (UNION, INTERSECT, MINUS)

Combine results from two queries:

```js
// UNION — combine and remove duplicates
const allVip = await OracleCollection.union(
    users.find({ tier: "gold" }).project({ name: 1, email: 1 }),
    users.find({ tier: "platinum" }).project({ name: 1, email: 1 }),
);

// INTERSECT — only rows appearing in BOTH queries
const overlap = await OracleCollection.intersect(
    users.find({ dept: "A" }).project({ name: 1 }),
    users.find({ status: "premium" }).project({ name: 1 }),
);

// MINUS — rows in first query but NOT in second
const aOnly = await OracleCollection.minus(
    users.find({ dept: "A" }).project({ name: 1 }),
    users.find({ dept: "B" }).project({ name: 1 }),
);
```

> Both queries MUST return the same number of columns.

### Bulk Write

Execute multiple operations in a single transaction:

```js
await users.bulkWrite([
    { insertOne: { document: { name: "Alex", status: "active" } } },
    {
        updateOne: {
            filter: { name: "Juan" },
            update: { $set: { status: "premium" } },
        },
    },
    { deleteOne: { filter: { name: "Pedro" } } },
]);
```

### DDL Operations

```js
const schema = new OracleSchema(db);

// Alter table
await schema.alterTable("users", { addColumn: { phone: "VARCHAR2(20)" } });
await schema.alterTable("users", { dropColumn: "phone" });
await schema.alterTable("users", {
    renameColumn: { from: "phone", to: "mobile" },
});
await schema.alterTable("users", {
    addConstraint: { type: "UNIQUE", columns: ["email"], name: "UQ_email" },
});

// Other table operations
await schema.truncateTable("temp_data"); // Remove all rows (faster than DELETE)
await schema.renameTable("old_name", "new_name");
await schema.dropTable("temp_data", { cascade: true, ifExists: true });

// Sequences
await schema.createSequence("order_seq", { startWith: 1000, incrementBy: 1 });

// Views
await schema.createView(
    "active_users",
    users.find({ status: "active" }).project({ id: 1, name: 1, email: 1 }),
    { orReplace: true },
);
await schema.dropView("active_users", { ifExists: true });
```

### DCL — Permissions

```js
const dcl = new OracleDCL(db);

await dcl.grant(["SELECT", "INSERT"], "orders", "app_user");
await dcl.revoke(["DELETE"], "orders", "app_user");
```

---

## ⚫ Advanced — Window Functions, CTEs, Hierarchies & More

> Analytic functions, recursive CTEs, CONNECT BY, PIVOT/UNPIVOT, subqueries, performance tools, and special grouping.

### Window / Analytic Functions

Unlike `$group` (which collapses rows), window functions **add computed columns without removing any rows**.

```js
await orders.aggregate([
    {
        $addFields: {
            // Rank orders by amount within each region (highest first)
            rank: {
                $window: {
                    fn: "RANK",
                    partitionBy: "region",
                    orderBy: { amount: -1 },
                },
            },

            // Get the previous order's amount for the same customer
            prevAmount: {
                $window: {
                    fn: "LAG",
                    field: "amount",
                    offset: 1,
                    partitionBy: "customerId",
                },
            },

            // Running total per customer, ordered by date
            runningTotal: {
                $window: {
                    fn: "SUM",
                    field: "amount",
                    partitionBy: "customerId",
                    orderBy: { date: 1 },
                },
            },

            // 3-row moving average
            movingAvg: {
                $window: {
                    fn: "AVG",
                    field: "amount",
                    orderBy: { date: 1 },
                    frame: "ROWS BETWEEN 2 PRECEDING AND CURRENT ROW",
                },
            },
        },
    },
]);
```

**Available window functions:**

| Function                        | What it does                         |
| ------------------------------- | ------------------------------------ |
| `ROW_NUMBER`                    | Sequential number within partition   |
| `RANK`                          | Rank with gaps for ties (1, 2, 2, 4) |
| `DENSE_RANK`                    | Rank without gaps (1, 2, 2, 3)       |
| `NTILE`                         | Split into N equal buckets           |
| `LAG`                           | Value from a previous row            |
| `LEAD`                          | Value from a following row           |
| `FIRST_VALUE`                   | First value in the window            |
| `LAST_VALUE`                    | Last value in the window             |
| `NTH_VALUE`                     | Nth value in the window              |
| `SUM`/`AVG`/`COUNT`/`MIN`/`MAX` | Running aggregates                   |
| `RATIO_TO_REPORT`               | A value's share of its partition total (`partitionBy` only, no `orderBy` or `frame`) |
| `CUME_DIST` / `PERCENT_RANK`    | Cumulative distribution / percent rank |

**Parameters:** `fn`, `field`, `partitionBy`, `orderBy`, `offset` (for LAG/LEAD), `n` (for NTILE/NTH_VALUE), `frame`, and (2.1):

- `default` (LAG / LEAD): the value for rows whose offset falls outside the partition, instead of NULL. Numbers and `null` are written as literals; strings and dates are bound.
- `ignoreNulls: true` (LAG / LEAD / FIRST_VALUE / LAST_VALUE / NTH_VALUE): skip NULL values.
- `orderBy` takes `{ col: { order, nulls } }` for NULLS FIRST / LAST.

```js
// Previous month's revenue, 0 for the first month; next customer with a known city
{ $addFields: {
    prevRev: { $window: { fn: "LAG", field: "rev", orderBy: { month: 1 }, default: 0 } },
    nextCity: { $window: { fn: "LEAD", field: "city", orderBy: { id: 1 }, ignoreNulls: true, default: "-" } },
    share: { $window: { fn: "RATIO_TO_REPORT", field: "rev", partitionBy: "region" } },
} }
```

### CTEs (Common Table Expressions)

Name a query, then reference it — like SQL variables.

```js
const { withCTE } = require("@jm-paunlagui/mira");

const result = await withCTE(db, {
    activeUsers: users.find({ status: "active" }).project({ id: 1, name: 1 }),
    recentOrders: orders.find({ year: 2024 }).project({ userId: 1, total: 1 }),
})
    .from("activeUsers")
    .join({
        from: "recentOrders",
        localField: "id",
        foreignField: "userId",
        joinType: "inner",
    })
    .sort({ total: -1 })
    .limit(10)
    .toArray();
```

### Recursive CTEs (Tree Traversal)

For parent-child hierarchical data (org charts, categories, file trees):

```js
const { withRecursiveCTE } = require("@jm-paunlagui/mira");

const orgChart = await withRecursiveCTE(db, "org", {
    anchor: employees.find({ managerId: null }), // Start: employees with no manager (root nodes)
    recursive: {
        collection: "employees",
        joinOn: { managerId: "$org.id" }, // child.managerId = parent.id
    },
})
    .sort({ LVL: 1, name: 1 }) // LVL is added automatically (1 = root, 2 = direct report, etc.)
    .toArray();
```

**Carrying a calculation down the levels.** `set` computes columns on each level, with `"$prior.X"` for the parent row and `"$X"` for the child row; `while` keeps recursing only while a condition holds; `.aggregate(pipeline)` runs a pipeline over the result:

```js
// Raw material per dish, quantities multiplied through every recipe level
await withRecursiveCTE(db, "x", {
    anchor: bom.find({ parent: { $in: ["CAKE", "PIE"] } }),
    recursive: {
        collection: "bom",
        joinOn: { parent: "$x.child" },
        set: { parent: "$prior.parent", qty: { $mul: ["$prior.qty", "$qty"] } }, // keep the dish, multiply the quantity
    },
}).aggregate([{ $group: { _id: { dish: "$parent", item: "$child" }, qty: { $sum: "$qty" } } }]);

// A loan schedule from a one-row table of terms: each instalment from the previous balance
await withRecursiveCTE(db, "a", {
    anchor: terms.find({}),
    recursive: {
        collection: "terms",
        joinOn: {}, // no join: the row recurses on itself — needs `while`
        set: { n: { $add: ["$prior.n", 1] }, bal: { $subtract: ["$prior.bal", { $subtract: ["$pmt", { $round: { $mul: ["$prior.bal", 0.0075] } }] }] } },
        while: { $lt: ["$prior.n", 12] },
    },
}).toArray();
```

`set` can only compute the anchor table's own columns. An empty `joinOn` must have a `while`; a `joinOn` recursion keeps Oracle's own cycle check, so looping data stops with ORA-32044 instead of running forever.

### Series (Row Generator)

`series(db, { start, end, step?, unit?, as? })` gives one row per value from `start` to `end` inclusive: numbers, or dates by `day` / `week` / `month` / `quarter` / `year`. Use `.toArray()` or `.aggregate(pipeline)`:

```js
const { series } = require("@jm-paunlagui/mira");

// Month-ends of 2026 (a depreciation schedule)
await series(db, { start: new Date(2026, 0, 1), end: new Date(2026, 11, 1), unit: "month", as: "m" })
    .aggregate([{ $project: { d: { $lastDayOfMonth: "$m" } } }]);

// A calendar with daily sales, zero on days without a sale
await series(db, { start: new Date(2026, 9, 1), end: new Date(2026, 11, 31), unit: "day", as: "d" }).aggregate([
    { $lookup: { from: "sales", pipeline: [{ $group: { _id: "$day", q: { $sum: "$qty" } } }], localField: "d", foreignField: "day", as: "s", joinType: "left", select: ["Q"] } },
    { $project: { d: 1, sold: { $ifNull: ["$Q", 0] } } },
]);
```

### CONNECT BY (Oracle Hierarchical Queries)

Oracle's native syntax for tree traversal (alternative to recursive CTEs):

```js
const orgTree = await employees.connectBy({
    startWith: { managerId: null }, // Root nodes
    connectBy: { managerId: "$PRIOR id" }, // PRIOR id = parent's ID
    includeLevel: true, // Add LEVEL pseudo-column
    includePath: true, // Add SYS_CONNECT_BY_PATH
    orderSiblings: { name: 1 }, // Sort siblings alphabetically
    maxLevel: 5, // Maximum depth
});
```


Extra hierarchy columns: `root: "NAME"` adds `ROOT_NAME` (CONNECT_BY_ROOT, the top row's value on every row), `includeIsLeaf: true` adds `IS_LEAF`, `includeIsCycle: true` adds `IS_CYCLE` (NOCYCLE is always on, so a loop is cut; `IS_CYCLE = 1` marks the row that would close it), and `pathColumn` chooses the column `includePath` builds the path from.

### Joins and Trees Inside the Pipeline

```js
// Join a GROUPED result, not rows: each customer's total receipts next to every invoice
await invoices.aggregate([
    {
        $lookup: {
            from: "receipts",
            pipeline: [{ $group: { _id: "$customer", paid: { $sum: "$amount" } } }],
            localField: "customer",
            foreignField: "customer",
            as: "p",
            joinType: "left",
            select: ["PAID"],
        },
    },
]);

// The latest rate on or before each invoice date; outer: true keeps invoices with no rate (OUTER APPLY)
await invoices.aggregate([
    {
        $lateralJoin: {
            subquery: rates.find({ ccy: "$outer.ccy", rdate: { $lte: "$outer.idate" } }).sort({ rdate: -1 }).limit(1),
            as: "r",
            outer: true,
        },
    },
]);

// A tree as a stage: every manager with the salary of their whole team
await employees.aggregate([
    { $connectBy: { connectBy: { manager_id: "$PRIOR id" }, root: "id" } },
    { $group: { _id: "$ROOT_ID", team: { $sum: "$salary" } } },
]);
```

A `$lookup` or `$facet` pipeline can have several stages and come after other stages: its steps are written into the outer `WITH` (Oracle refuses a `WITH` nested inside another, ORA-32034). `$merge` / `$out` are not allowed inside them.

### Row Pattern Matching (MATCH_RECOGNIZE)

The `$matchRecognize` stage finds runs of rows that match a pattern: stock-outs, split payments, price streaks.

```js
// Every run of consecutive zero-stock days, per item
await daily.aggregate([
    {
        $matchRecognize: {
            partitionBy: ["SKU"],
            orderBy: { D: 1 },
            measures: { START_D: { $first: "$D" }, DAYS: { $count: "*" } },
            pattern: "Z+",
            define: { Z: { QTY: 0 } },
        },
    },
]);

// Payments to one supplier, each under the limit and ≤ 3 days apart, that together pass it
await payments.aggregate([
    {
        $matchRecognize: {
            partitionBy: ["SUPPLIER"],
            orderBy: { PDATE: 1 },
            measures: { FIRST_ID: { $first: "$ID" }, TOTAL: { $sum: "$AMOUNT" } },
            pattern: "A B+",
            define: {
                A: { $lt: ["$AMOUNT", 10000] },
                B: { $and: [{ $lt: ["$AMOUNT", 10000] }, { $lte: [{ $subtract: ["$PDATE", { $prev: "$PDATE" }] }, 3] }] },
            },
        },
    },
    { $match: { TOTAL: { $gt: 10000 } } },
]);
```

- `pattern`: variable names with quantifiers (`* + ? {n,m}`), `( )`, `|`, `^`, `$`. Every variable must be defined; anything else is refused before SQL is built.
- `define`: one condition per variable, written like a `$cond` condition (values bound). `$prev` / `$next` (optionally `["$COL", n]`) look at neighbouring rows; `true` matches any row.
- `measures`: `$first` / `$last` / `$sum` / `$min` / `$max` / `$avg` / `$count` of `"$COL"` or `"$VAR.COL"`, plus `$classifier` and `$matchNumber`.
- `rowsPerMatch`: `"one"` (default) or `"all"`; `afterMatch`: `"pastLastRow"` (default) or `"nextRow"`.

### PIVOT (Rows → Columns)

Turn row values into column headers:

```js
// Before: { region: "East", quarter: "Q1", amount: 100 }, { region: "East", quarter: "Q2", amount: 200 }
// After:  { region: "East", Q1: 100, Q2: 200, Q3: ..., Q4: ... }

const pivotResult = await sales.pivot({
    value: { $sum: "$amount" },
    pivotOn: "quarter",
    pivotValues: ["Q1", "Q2", "Q3", "Q4"],
    groupBy: "region",
});
```

### UNPIVOT (Columns → Rows)

The reverse — turn column headers into row values:

```js
// Before: { region: "East", Q1: 100, Q2: 200, Q3: 150, Q4: 300 }
// After:  { region: "East", quarter: "Q1", revenue: 100 }, { region: "East", quarter: "Q2", revenue: 200 }, ...

const unpivotResult = await quarterly.unpivot({
    valueColumn: "revenue",
    nameColumn: "quarter",
    columns: ["Q1", "Q2", "Q3", "Q4"],
});
```

### Advanced Grouping (ROLLUP, CUBE, GROUPING SETS)

```js
// ROLLUP — subtotals + grand total
await sales.aggregate([
    {
        $group: {
            _id: { $rollup: ["region", "product"] },
            total: { $sum: "$amount" },
        },
    },
]);
// Result includes: per product per region, per region subtotal, grand total

// CUBE — all possible combination subtotals
await sales.aggregate([
    {
        $group: {
            _id: { $cube: ["region", "product"] },
            total: { $sum: "$amount" },
        },
    },
]);

// GROUPING SETS — custom combos
await sales.aggregate([
    {
        $group: {
            _id: { $groupingSets: [["region"], ["product"], []] },
            total: { $sum: "$amount" },
        },
    },
]);
```

### Subquery Operators (in Filters)

```js
// EXISTS — find users who have at least one order
await users
    .find({
        $exists: { collection: "orders", match: { userId: "$id" } },
    })
    .toArray();

// NOT EXISTS — find users with NO orders
await users
    .find({
        $notExists: { collection: "orders", match: { userId: "$id" } },
    })
    .toArray();

// IN subquery — find users whose IDs are in the orders table
await users
    .find({
        id: { $inSelect: orders.find({}).project({ userId: 1 }) },
    })
    .toArray();

// …or a hand-written subquery: sql`…` binds every value. A plain string is refused.
await users
    .find({ id: { $inSelect: sql`SELECT USER_ID FROM ORDERS WHERE TOTAL > ${minTotal}` } })
    .toArray();

// Scalar subquery — add a computed column
await users
    .find({})
    .project({
        name: 1,
        orderCount: {
            $subquery: {
                collection: "orders",
                fn: "count",
                filter: { userId: "$id" },
            },
        },
    })
    .toArray();
```

### Special Filter Operators

```js
// CASE expression
await users
    .find({
        tier: {
            $case: [
                { when: { totalSpent: { $gte: 10000 } }, then: "VIP" },
                { when: { totalSpent: { $gte: 5000 } }, then: "Gold" },
            ],
            $else: "Regular",
        },
    })
    .toArray();

// COALESCE — the field equals the first non-null value ("$col" is a column, anything else a value)
await users
    .find({ displayName: { $coalesce: ["$nickname", "$name", "Anonymous"] } })
    .toArray();

// NULLIF — the field equals NULLIF(column, value)
await users
    .find({ discount: { $nullif: ["base_discount", 0] } })
    .toArray();
```

### Performance Utilities

```js
const perf = createPerformance(db);

// See how Oracle will execute a query (execution plan)
const plan = await perf.explainPlan(users.find({ status: "active" }));
console.log(plan);

// Gather fresh table statistics for the optimizer
await perf.analyze("orders");

// Create a materialized view (pre-computed query — cached on disk)
await perf.createMaterializedView(
    "monthly_sales_mv",
    "SELECT region, SUM(amount) AS total FROM orders GROUP BY region",
    { refreshMode: "force", refreshOn: "demand" },
);

// Refresh the materialized view
await perf.refreshMaterializedView("monthly_sales_mv", "complete");

// Drop when no longer needed
await perf.dropMaterializedView("monthly_sales_mv");
```

### Debug: See the Generated SQL

```js
// Use .explain() to see the SQL without running it
const sql = await users
    .find({ status: "active", age: { $gte: 18 } })
    .sort({ name: 1 })
    .project({ name: 1, email: 1 })
    .explain();

console.log(sql);
// → SELECT "name", "email" FROM "users" t0 WHERE "status" = :where_status_0 AND "age" >= :where_age_1 ORDER BY "name" ASC
```

---

## Operator Reference

### The `$` Prefix Rule

| Syntax                      | Meaning                          | Example                             |
| --------------------------- | -------------------------------- | ----------------------------------- |
| `'$amount'` (string)        | Reference a column's value       | `{ $sum: '$amount' }` → SUM(amount) |
| `$set`, `$gte` (object key) | A MongoDB-style operator keyword | `{ $set: { name: 'Ana' } }`         |
| `'N/A'` (plain string)      | A literal string value           | `{ $ifNull: ['$nick', 'N/A'] }`     |
| `'$outer.col'` (string)     | Reference to the outer table     | Used in correlated subqueries       |

### Filter Operators

| Operator      | SQL                | Example                                      |
| ------------- | ------------------ | -------------------------------------------- |
| `$eq`         | `=`                | `{ age: { $eq: 25 } }`                       |
| `$ne`         | `<>`               | `{ status: { $ne: 'inactive' } }`            |
| `$gt`         | `>`                | `{ age: { $gt: 18 } }`                       |
| `$gte`        | `>=`               | `{ age: { $gte: 18 } }`                      |
| `$lt`         | `<`                | `{ price: { $lt: 100 } }`                    |
| `$lte`        | `<=`               | `{ price: { $lte: 100 } }`                   |
| `$in`         | `IN (...)`         | `{ status: { $in: ['active', 'pending'] } }` |
| `$nin`        | `NOT IN (...)`     | `{ role: { $nin: ['banned'] } }`             |
| `$between`    | `BETWEEN`          | `{ age: { $between: [18, 65] } }`            |
| `$notBetween` | `NOT BETWEEN`      | `{ score: { $notBetween: [0, 50] } }`        |
| `$exists`     | `IS [NOT] NULL`    | `{ email: { $exists: true } }`               |
| `$regex`      | `REGEXP_LIKE`      | `{ name: { $regex: '^J' } }`                 |
| `$like`       | `LIKE`             | `{ name: { $like: 'J%' } }`                  |
| `$and`        | `AND`              | `{ $and: [{...}, {...}] }`                   |
| `$or`         | `OR`               | `{ $or: [{...}, {...}] }`                    |
| `$nor`        | `NOT (... OR ...)` | `{ $nor: [{...}, {...}] }`                   |
| `$not`        | `NOT (...)`        | `{ $not: { status: 'inactive' } }`           |

### Update Operators

| Operator       | SQL                          | Example                                 |
| -------------- | ---------------------------- | --------------------------------------- |
| `$set`         | `SET col = val`              | `{ $set: { name: 'Ana' } }`             |
| `$unset`       | `SET col = NULL`             | `{ $unset: { nickname: '' } }`          |
| `$inc`         | `SET col = col + N`          | `{ $inc: { loginCount: 1 } }`           |
| `$mul`         | `SET col = col * N`          | `{ $mul: { price: 1.1 } }`              |
| `$min`         | `SET col = LEAST(col, N)`    | `{ $min: { lowScore: 50 } }`            |
| `$max`         | `SET col = GREATEST(col, N)` | `{ $max: { highScore: 99 } }`           |
| `$currentDate` | `SET col = SYSDATE`          | `{ $currentDate: { updatedAt: true } }` |

### Aggregate Expressions

| Operator        | SQL                                   | Example                                                     |
| --------------- | ------------------------------------- | ----------------------------------------------------------- |
| `$sum`          | `SUM(col)`                            | `{ total: { $sum: '$amount' } }`                            |
| `$avg`          | `AVG(col)`                            | `{ avg: { $avg: '$price' } }`                               |
| `$min`          | `MIN(col)`                            | `{ cheapest: { $min: '$price' } }`                          |
| `$max`          | `MAX(col)`                            | `{ highest: { $max: '$price' } }`                           |
| `$count`        | `COUNT(*)`                            | `{ total: { $count: '*' } }`                                |
| `$first`        | `MIN(col)` (first in group)           | `{ first: { $first: '$name' } }`                            |
| `$last`         | `MAX(col)` (last in group)            | `{ last: { $last: '$name' } }`                              |
| `$countDistinct` | `COUNT(DISTINCT col)`                | `{ n: { $countDistinct: '$customerId' } }`                  |
| `$median`       | `MEDIAN(col)`                         | `{ med: { $median: '$amount' } }`                           |
| `$stdDevPop` / `$stdDevSamp` | `STDDEV_POP` / `STDDEV_SAMP` | `{ sd: { $stdDevSamp: '$amount' } }`                        |
| `$percentile`   | `PERCENTILE_CONT` / `PERCENTILE_DISC` | `{ p90: { $percentile: { input: '$amount', p: 0.9 } } }`    |
| `$push`         | `JSON_ARRAYAGG` → JS array            | `{ ids: { $push: { input: '$id', orderBy: { id: 1 } } } }`  |
| `$addToSet`     | `JSON_ARRAYAGG` → JS array, de-duplicated | `{ tags: { $addToSet: '$tag' } }`                       |
| `$listAgg`      | `LISTAGG(col, sep) WITHIN GROUP (…)`  | `{ names: { $listAgg: { input: '$name', separator: ', ' } } }` |
| `$concat`       | `col1 \|\| col2`                      | `{ full: { $concat: ['$first', '$last'] } }`                |
| `$toUpper`      | `UPPER(col)`                          | `{ name: { $toUpper: '$name' } }`                           |
| `$toLower`      | `LOWER(col)`                          | `{ name: { $toLower: '$name' } }`                           |
| `$substr`       | `SUBSTR(col, start, len)`             | `{ code: { $substr: ['$name', 1, 3] } }`                    |
| `$cond`         | `CASE WHEN ... THEN ... ELSE ... END` | `{ tier: { $cond: { if: ..., then: ..., else: ... } } }`    |
| `$ifNull`       | `COALESCE(col, fallback)`             | `{ name: { $ifNull: ['$nickname', 'N/A'] } }`               |
| `$dateToString` | `TO_CHAR(col, format)`                | `{ d: { $dateToString: { format: '...', date: '$col' } } }` |
| `$max` / `$min` with a list | `GREATEST(...)` / `LEAST(...)` (values in the row) | `{ hi: { $max: ['$a', '$b', 0] } }` |
| `$abs` `$ceil` `$floor` | `ABS` / `CEIL` / `FLOOR` | `{ whole: { $floor: '$qty' } }` |
| `$round` / `$trunc` | `ROUND(x[, places])` / `TRUNC(x[, places])` | `{ r: { $round: ['$amount', 2] } }` |
| `$mod` | `MOD(a, b)` | `{ m: { $mod: ['$n', 7] } }` |
| `$switch` | `CASE WHEN … WHEN … ELSE … END` | `{ g: { $switch: { branches: [{ case: …, then: 'A' }], default: 'C' } } }` |
| `$literal` | a bound value, never a column | `{ k: { $literal: '$not-a-column' } }` |
| `$dateDiff` | calendar boundaries between two dates (`day` `week` `month` `quarter` `year`) | `{ late: { $dateDiff: { startDate: '$due', endDate: asOf, unit: 'day' } } }` |
| `$dateAdd` | `+ n` days / weeks, `ADD_MONTHS`, `NUMTODSINTERVAL` (`second` … `year`) | `{ due: { $dateAdd: { startDate: '$inv', unit: 'day', amount: 30 } } }` |
| `$dateTrunc` | `TRUNC(date, 'MM')` (`year` `quarter` `month` `week` `day` `hour` `minute`) | `{ m: { $dateTrunc: { date: '$at', unit: 'month' } } }` |
| `$lastDayOfMonth` `$year` `$month` `$dayOfMonth` | `LAST_DAY`, `EXTRACT(...)` | `{ y: { $year: '$at' } }` |

**Nesting.** Any argument can itself be an expression, a column (`'$col'`) or a literal (always bound), and aggregates accept expressions: `{ $sum: { $mul: ['$qty', '$price'] } }`, `{ $round: [{ $divide: ['$a', '$b'] }, 2] }`.

**Conditions** in `$cond` and `$switch` can compare two operands, either side a column, expression or literal: `{ $gt: ['$score', '$age'] }`, combined with `$and` / `$or` / `$not`. `{ $eq: ['$x', null] }` is `IS NULL`. The older filter form `{ score: { $gte: 90 } }` still works.

**Subtotal flags.** `_id: { $rollup: [...], grouping: true }` (also `$cube` / `$groupingSets`) adds `GROUPING_<col>`, which is 1 on subtotal rows, so a subtotal can be told from a group whose key is NULL.

### Quick Cheat Sheet

```js
// FIND: "Active users over 18, sorted by name, page 2 (10 per page)"
await users
    .find({ status: "active", age: { $gt: 18 } })
    .sort({ name: 1 })
    .skip(10)
    .limit(10)
    .toArray();

// UPDATE: "Increment login count and mark last login for user 5"
await users.updateOne(
    { id: 5 },
    {
        $inc: { loginCount: 1 },
        $currentDate: { lastLogin: true },
    },
);

// AGGREGATE: "Total sales per region, only regions over 10000"
await sales.aggregate([
    { $group: { _id: "$region", total: { $sum: "$amount" } } },
    { $having: { total: { $gt: 10000 } } },
    { $sort: { total: -1 } },
]);

// JOIN: "Orders with customer names"
await orders.aggregate([
    {
        $lookup: {
            from: "customers",
            localField: "customerId",
            foreignField: "id",
            as: "cust",
            joinType: "left",
        },
    },
    { $project: { orderId: 1, amount: 1, "cust.name": 1 } },
]);

// WINDOW: "Rank employees by salary within each department"
await employees.aggregate([
    {
        $addFields: {
            rank: {
                $window: {
                    fn: "RANK",
                    partitionBy: "deptId",
                    orderBy: { salary: -1 },
                },
            },
        },
    },
]);

// MERGE/UPSERT: "Insert or update employee"
await employees.merge(
    { id: 10, name: "Ana", salary: 60000 },
    { localField: "id", foreignField: "id" },
    { whenMatched: { $set: { salary: 60000 } }, whenNotMatched: "insert" },
);
```

## Testing

The suite runs on `bun test` against a real Oracle schema: the `appDb` pool that `test/helpers/db.ts` builds with `createMira(fromEnv())`, so set `MIRA_DB_*` in `.env`. It is split into six categories, one folder each under `test/`:

| Category | What it proves |
| --- | --- |
| `unit` | SQL builders, error paths (stub connections), config validation, `fromEnv`, the pool registry, the log sink, and the adapter (stub driver: pool lifecycle, retries, health monitor, shutdown) |
| `integration` | Every collection, query, transaction, DDL, DCL and performance-utility method against the live schema |
| `performance` | Throughput / latency floors; numbers recorded per run |
| `chaos` | Dead host, bad credentials, pool exhaustion, cancelled calls, dropped connections, deadlocks, injected mid-transaction crashes, fuzzed filters |
| `security` | Injection payloads (values, identifiers, raw-SQL splice points), secret redaction in errors, least privilege, resource abuse |
| `reliability` | No lost updates or leaked connections, idempotent upserts, exact data round-trips, soak stability |

```bash
bun run test            # all six categories
bun run test:coverage   # + coverage (threshold 100% lines and functions for everything under src/)
bun run test:unit       # or :integration / :performance / :chaos / :security / :reliability
```

**Database prerequisites.** The schema user needs `CREATE TABLE`, `CREATE VIEW`, `CREATE SEQUENCE`, `CREATE SYNONYM`, `CREATE MATERIALIZED VIEW` and a tablespace quota (`ALTER USER <user> QUOTA UNLIMITED ON USERS;`). Every suite creates its own `MIRA_<suite>_*` tables and drops them afterwards.

**Results.** The runner prints a scorecard per category. Tests named `DEFECT:` / `SECURITY:` assert the *fixed* behaviour of a known open issue and are reported separately from unexpected failures. Each run is stored under one `RUN_ID` in two tables that are kept between runs: `MIRA_TEST_RESULTS` (one row per test) and `MIRA_TEST_METRICS` (latencies, throughput, counts). Set `MIRA_SKIP_PERSIST=1` to skip writing them; performance budgets can be tightened with `MIRA_PERF_*` env vars (see `test/performance/perf.test.ts`).

**Continuous integration.** `.github/workflows/ci.yml` runs on every push and pull request:
- **Build:** type-check, `bun run build`, and `npm pack --dry-run`.
- **Live tests:** against an Oracle Database Free 23ai container (`gvenzl/oracle-free`), once in **Thin** mode and once in **Thick** mode (Instant Client installed on the runner). Each run does the full suite with coverage, the simulation, `test/node/smoke.cjs` (the built package under plain Node), and the package check below.
- **Package check** (`bun run test:package`): packs the tarball, installs it into an empty project with no `.env` and no `MIRA_*` variables, type-checks a TypeScript app strictly (the published `.d.ts` files included), runs it under Bun, runs a CommonJS and an ES-module app under Node, and runs the `mira` CLI. It needs `PKG_DB_USER` / `PKG_DB_PASSWORD` / `PKG_DB_CONNECT_STRING`, or copies them from `MIRA_DB_*`.
- **Setup:** the job creates the `MIRA` and `MIRA_SIM` schemas with `.github/oracle/setup-users.sql`.

To run the Node smoke test yourself: `bun run build && node --env-file=.env test/node/smoke.cjs`.

## Simulation

`bun run sim` plays out a three-branch canteen, and the small enterprise behind it, end to end through Mira, in an Oracle schema that belongs to the simulation alone. It covers:

1. **Schema:** DDL and grants
2. **Opening stock and menu:** inserts, batch errors, `bulkWrite`, indexes and views
3. **A trading day:** 36 till sales, each one transaction with row locks, a savepoint for an add-on dessert, check constraints that refuse an oversell, and payment from credit
4. **Back office:** price feed `MERGE`, upserts, replace, find-and-modify, deletes, `UPDATE … FROM JOIN`, `INSERT … SELECT`, `PIVOT` / `UNPIVOT`
5. **Reports:** every filter operator and pipeline stage, set operations, CTEs, `CONNECT BY`, flashback and `SAMPLE`
6. **The standalone SQL builders:** each one is run and compared with the method it backs
7. **Statistics, plans and materialized views**
8. **Hostile input:** against every option that reaches SQL
9. **General ledger:** every event of the year posted as double-entry journals; trial balance, account-tree roll-up, cash ledger card (running balance), budget vs actual, `ROLLUP`, quarterly P&L (`PIVOT`), month-on-month (`LAG`), year-end close into retained earnings
10. **Receivables and payables:** FIFO cash application, aging, invoice-number gaps, duplicate payments
11. **Inventory:** a movement ledger reconciled to the stock table, weighted average and FIFO cost, FEFO lot picking by two workers at once (`SKIP LOCKED`), ABC analysis, reorder alerts, stock-out runs, zero-sales days
12. **Kitchen production:** multi-level recipes (bill of materials): explosion, where-used, MRP net requirements, cost roll-up, cycle detection
13. **Finance:** FX at the rate in force, loan and depreciation schedules checked against the ledger, `CUBE` / `GROUPING SETS`, an allocation exact to the cent
14. **Audit:** Benford, journals without lines, split payments
15. **Members:** a typed model table: timestamps, soft delete and restore, audit hooks, validation, optimistic locking
16. **Exports:** keyset-paged and streamed exports, raw SQL, query events
17. **Config:** a second service with its own pool: `createMira`, `fromEnv`, `defineConfig`, the driver mode, its own logger
18. **Operations:** pool stats, health, shutdown

Every business query runs through Mira's API (50 of 50 today). A query Mira could not express would run as hand-written SQL, still be checked, and be listed at the end as a **coverage gap** with the reason, so any new gap shows up as a measured item for what Mira should support next.

Every result is checked against an in-memory model of the business or a hand-written SQL read. Then the run proves that **every public Mira function was called** (`sim/lib/tracker.ts`), and lists any that were not.

**One-time setup (DBA).** Create the schema with `sim/setup-schema.sql`, then add its credentials to `.env`:

```bash
docker cp sim/setup-schema.sql oracle19c:/tmp/s.sql
docker exec oracle19c sqlplus -s / as sysdba @/tmp/s.sql '<password>'
# .env
MIRA_SIM_DB_USERNAME=MIRA_SIM
MIRA_SIM_DB_PASSWORD=<password>
```

The simulation drops and rebuilds its `SIM_*` objects on every run. It refuses to start when `MIRA_SIM_DB_USERNAME` is the test schema (`MIRA_DB_USER`), or when the connection is not that user.

- **Connection:** `MIRA_SIM_DB_CONNECT_STRING`, else a TNS descriptor from `MIRA_SIM_DB_HOST` / `_PORT` / `_SID`, else the main `MIRA_DB_*` connection.
- **`MIRA_SIM_GRANTEE`:** the schema the DCL checks grant to (default `MIRA_DB_USER`).
- **`MIRA_SIM_KEEP=1`:** leaves the `SIM_*` objects in place for inspection.
- **`MIRA_LOGS=1`:** shows Mira's own logs.

**Results.** The run prints a table per stage, then any failed checks. Checks named `DEFECT:` assert the correct behaviour of a known open defect and are listed separately, as in the test suite. The exit code is 0 only when every check passed and no public function went unused.

Unlike `bun test`, which always runs with `TZ=UTC`, the simulation runs in the machine's real time zone, so time-zone bugs show up here.

`sim/RESEARCH.md` collects the Oracle 19c query research (a catalog from basic to expert, plus accounting and inventory patterns), a map of what SQL Mira's API can express, the defects confirmed so far, and the plan for growing the simulation.

## Apache License 2.0 © 2026 John Moises Paunlagui. All rights reserved. See LICENSE for details.
