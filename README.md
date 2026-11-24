# Oracle MongoDB-Style Wrapper Library

Write MongoDB-style JavaScript. Get Oracle SQL. Never write raw SQL again.

```
Your JavaScript Code (MongoDB-style)
        ↓
oracle-mongo-wrapper (this library)
        ↓
Oracle SQL with bind variables (safe from SQL injection)
        ↓
Oracle Database
```

> **This guide is organized by difficulty.** Start from the top. Each section builds on the previous one.

---

## Table of Contents

- [Setup](#setup)
    - [Prerequisites — Database Configuration](#prerequisites--database-configuration)
    - [Imports & Connection](#imports--connection)
- [Basic — Your First Queries](#-basic--your-first-queries)
- [Medium — Filtering, Updating & Chaining](#-medium--filtering-updating--chaining)
- [Hard — Aggregation, Transactions & Joins](#-hard--aggregation-transactions--joins)
- [Advanced — Window Functions, CTEs, Hierarchies & More](#-advanced--window-functions-ctes-hierarchies--more)
- [Operator Reference](#operator-reference)
- [Testing](#testing)
- [Simulation](#simulation)

---

## Setup

```bash
bun add oracledb  # peer dependency — should already be in parent project
```

### Prerequisites — Database Configuration

Before using `oracle-mongo-wrapper`, you need 3 config files and a `.env` file. These handle connection pooling, credentials, and adapter selection so the wrapper can talk to Oracle.

```
src/config/
├── adapters/
│   └── oracle.ts       ← Pool management: creates/reuses connection pools,
│                          withConnection(), withTransaction(), health monitoring
├── database.ts          ← Connection registry: maps names like "appDb"
│                          to { user, password, connectString } credentials
└── index.ts             ← Adapter factory: exports everything from the active
                           adapter + database.ts as one unified import
```

**How it flows:**

```
.env  →  database.ts (reads credentials)  →  oracle.ts (creates pools)  →  config/index.ts (exports API)
                                                                                    ↓
                                                                           oracle-mongo-wrapper/db.ts
                                                                           createDb("appDb")
```

#### Step 1 — Set Up Your `.env` File

Copy `.env.example` to `.env` and fill in your Oracle details. The essentials:

```env
DB_TYPE=oracle
DB_HOST=your-oracle-host.example.com
DB_PORT=1521
# Used as the Oracle SID: (CONNECT_DATA=(SID=<value>)). Typical SIDs: XE, ORCL.
DB_APP_SERVICE_NAME=ORCL

# Credentials shared by the appDb and appDbBulk pools
APP_DB_USERNAME=your_schema_user
APP_DB_PASSWORD=your_schema_password

# Optional: Instant Client directory enables Thick mode; blank = Thin mode
ORACLE_INSTANT_CLIENT=
```

Pool sizing (`APP_POOL_*`, `APP_BULK_*`) and logging (`LOG_*`) are documented in `.env.example`.

**Test database (optional):** with `NODE_ENV=development` and `APP_TEST_DB_USERNAME` set, both pools connect with `APP_TEST_DB_USERNAME` / `APP_TEST_DB_PASSWORD` instead. `DB_TEST_HOST` / `DB_TEST_PORT` / `DB_TEST_SID` fall back to the main values, so a test schema on the same server needs only its credentials.

#### Step 2 — Register Connections in `database.ts`

Each connection gets a name and its credentials from `.env`. You never hardcode passwords here — only `process.env` references. Two pools ship, on the same credentials:

- **`appDb`** — interactive work; the default for `createDb("appDb")`.
- **`appDbBulk`** — long-held work (exports, backups, bulk loads) so it cannot starve `appDb`.

```ts
// src/config/database.ts (already set up — add new connections as needed)

const connections = {
    appDb: {
        ...appDbCredentials, // APP_DB_USERNAME / APP_DB_PASSWORD / DB_HOST:DB_PORT, SID DB_APP_SERVICE_NAME
        poolMin: parseInt(process.env.APP_POOL_MIN ?? "", 10) || 5,
        poolMax: parseInt(process.env.APP_POOL_MAX ?? "", 10) || 20,
        queueMax: parseInt(process.env.APP_QUEUE_MAX ?? "", 10) || 40,
        poolTimeout: nonNegativeInt(process.env.APP_POOL_TIMEOUT, 30),
    },

    appDbBulk: { ...appDbCredentials, poolMin: 1, poolMax: 6 /* APP_BULK_* in .env */ },

    // Add more connections as needed:
    // reportingDb: {
    //     user:          process.env.RPT_DB_USERNAME,
    //     password:      process.env.RPT_DB_PASSWORD,
    //     connectString: buildSimpleConnectString(
    //         process.env.RPT_DB_HOST,
    //         process.env.RPT_DB_PORT,
    //         process.env.RPT_DB_SERVICE_NAME,
    //     ),
    //     poolMax: 10, // optional — override default pool size
    // },
};
```

> **To add a new connection:** Add env vars to `.env`, add one entry to `connections`, then use `createDb("yourNewName")`. No other file needs to change.

#### Step 3 — The Adapter (`oracle.ts`) Handles the Rest

You don't need to edit `oracle.ts` — it automatically:

- Creates connection pools on first use (lazy initialization)
- Retries failed connections up to 3 times with exponential backoff
- Monitors pool health in the background
- Releases connections automatically after each operation
- Handles graceful shutdown

**Key pool defaults** (configurable per-connection in `database.ts`):

| Setting          | Default | What it means                          |
| ---------------- | ------- | -------------------------------------- |
| `poolMin`        | 10      | Minimum connections kept open          |
| `poolMax`        | 50      | Maximum connections allowed            |
| `poolIncrement`  | 5       | How many to add when pool is exhausted |
| `poolTimeout`    | 30s     | Idle connection timeout                |
| `connectTimeout` | 15s     | Max wait to establish a connection     |
| `queueMax`       | 40      | Acquire-queue depth before NJS-076     |
| `callTimeout`    | 60s     | Documentation only: node-oracledb ignores it at pool level; set `conn.callTimeout` per connection |
| `stmtCacheSize`  | 50      | Cached prepared statements per conn    |

#### Step 4 — `config/index.ts` Ties It Together

This file auto-detects the adapter from `DB_TYPE` env var (defaults to `"oracle"`) and exports everything:

```js
// src/config/index.ts — you usually don't need to edit this
// It exports: withConnection, withTransaction, withBatchConnection,
//             closeAll, getPoolStats, isPoolHealthy, getConnectionConfig,
//             oracledb, and more.
```

The wrapper's `db.ts` imports from this file, so when you call `createDb("appDb")`, it flows through:
`createDb() → config/index.ts → config/adapters/oracle.ts → database.ts credentials → Oracle pool`

### Imports & Connection

```js
// Import what you need
const {
    createDb,
    OracleCollection,
    OracleSchema,
    OracleDCL,
    Transaction,
    withCTE,
    withRecursiveCTE,
    createPerformance,
} = require("./oracle-mongo-wrapper");

// Connect to your database pool (configured in src/config/database.ts)
const db = createDb("appDb");
```

That's it. `db` is your gateway to everything.

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

**Sort direction:** `1` = ascending (A→Z, 0→9), `-1` = descending (Z→A, 9→0)

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
| `$limit`     | `FETCH FIRST N ROWS ONLY` | Limit row count                         |
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

**Parameters:** `fn`, `field`, `partitionBy`, `orderBy`, `offset` (for LAG/LEAD), `n` (for NTILE/NTH_VALUE), `frame`

### CTEs (Common Table Expressions)

Name a query, then reference it — like SQL variables.

```js
const { withCTE } = require("./oracle-mongo-wrapper");

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
const { withRecursiveCTE } = require("./oracle-mongo-wrapper");

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
const { series } = require("./oracle-mongo-wrapper");

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

The suite runs on `bun test` against a real Oracle schema (the `appDb` connection in `.env`). It is split into six categories, one folder each under `test/`:

| Category | What it proves |
| --- | --- |
| `unit` | SQL builders, error paths (stub connections), config, and the adapter (stub driver: pool lifecycle, retries, health monitor, shutdown) |
| `integration` | Every collection, query, transaction, DDL, DCL and performance-utility method against the live schema |
| `performance` | Throughput / latency floors; numbers recorded per run |
| `chaos` | Dead host, bad credentials, pool exhaustion, cancelled calls, dropped connections, deadlocks, injected mid-transaction crashes, fuzzed filters |
| `security` | Injection payloads (values, identifiers, raw-SQL splice points), secret redaction in errors, least privilege, resource abuse |
| `reliability` | No lost updates or leaked connections, idempotent upserts, exact data round-trips, soak stability |

```bash
bun run test            # all six categories
bun run test:coverage   # + coverage (threshold 100% lines/functions for src/config and the wrapper)
bun run test:unit       # or :integration / :performance / :chaos / :security / :reliability
```

**Database prerequisites.** The schema user needs `CREATE TABLE`, `CREATE VIEW`, `CREATE SEQUENCE`, `CREATE SYNONYM`, `CREATE MATERIALIZED VIEW` and a tablespace quota (`ALTER USER <user> QUOTA UNLIMITED ON USERS;`). Every suite creates its own `MIRA_<suite>_*` tables and drops them afterwards.

**Results.** The runner prints a scorecard per category. Tests named `DEFECT:` / `SECURITY:` assert the *fixed* behaviour of a known open issue and are reported separately from unexpected failures. Each run is stored under one `RUN_ID` in two tables that are kept between runs: `MIRA_TEST_RESULTS` (one row per test) and `MIRA_TEST_METRICS` (latencies, throughput, counts). Set `MIRA_SKIP_PERSIST=1` to skip writing them; performance budgets can be tightened with `MIRA_PERF_*` env vars (see `test/performance/perf.test.ts`).

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
15. **Operations:** pool stats, health, shutdown

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

The simulation drops and rebuilds its `SIM_*` objects on every run. It refuses to start when `MIRA_SIM_DB_USERNAME` is the app or test schema, or when the connection is not that user.

- **`MIRA_SIM_DB_HOST` / `_PORT` / `_SID`:** default to the main `DB_*` values.
- **`MIRA_SIM_GRANTEE`:** the schema the DCL checks grant to (default `APP_DB_USERNAME`).
- **`MIRA_SIM_KEEP=1`:** leaves the `SIM_*` objects in place for inspection.
- **`MIRA_LOGS=1`:** shows Mira's own logs.

**Results.** The run prints a table per stage, then any failed checks. Checks named `DEFECT:` assert the correct behaviour of a known open defect and are listed separately, as in the test suite. The exit code is 0 only when every check passed and no public function went unused.

Unlike `bun test`, which always runs with `TZ=UTC`, the simulation runs in the machine's real time zone, so time-zone bugs show up here.

`sim/RESEARCH.md` collects the Oracle 19c query research (a catalog from basic to expert, plus accounting and inventory patterns), a map of what SQL Mira's API can express, the defects confirmed so far, and the plan for growing the simulation.

## Apache License 2.0 © 2026 John Moises Paunlagui. All rights reserved. See LICENSE.txt for details.
