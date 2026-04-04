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
- [🟢 Basic — Your First Queries](#-basic--your-first-queries)
- [🟡 Medium — Filtering, Updating & Chaining](#-medium--filtering-updating--chaining)
- [🔴 Hard — Aggregation, Transactions & Joins](#-hard--aggregation-transactions--joins)
- [⚫ Advanced — Window Functions, CTEs, Hierarchies & More](#-advanced--window-functions-ctes-hierarchies--more)
- [Operator Reference](#operator-reference)

---

## Setup

```bash
npm install oracledb  # peer dependency — should already be in parent project
```

### Prerequisites — Database Configuration

Before using `oracle-mongo-wrapper`, you need 3 config files and a `.env` file. These handle connection pooling, credentials, and adapter selection so the wrapper can talk to Oracle.

```
src/config/
├── adapters/
│   └── oracle.js       ← Pool management: creates/reuses connection pools,
│                          withConnection(), withTransaction(), health monitoring
├── database.js          ← Connection registry: maps names like "userAccount"
│                          to { user, password, connectString } credentials
└── index.js             ← Adapter factory: exports everything from the active
                           adapter + database.js as one unified import
```

**How it flows:**

```
.env  →  database.js (reads credentials)  →  oracle.js (creates pools)  →  config/index.js (exports API)
                                                                                    ↓
                                                                           oracle-mongo-wrapper/db.js
                                                                           createDb("userAccount")
```

#### Step 1 — Set Up Your `.env` File

Create a `.env` file in your project root with your Oracle database credentials:

```env
# ── Database connection ──────────────────────────────────────
NODE_ENV=development
DB_TYPE=oracle

# Connection details (used by database.js to build connect strings)
DB_HOST=your-oracle-host.example.com
DB_PORT=1521
DB_SERVICE_NAME=ORCL

# "userAccount" connection credentials
UA_DB_USERNAME=your_username
UA_DB_PASSWORD=your_password

# Add more connections as needed — just follow the pattern
# for environment-specific configs, you can do:
SI_DB_USERNAME=inventory_user
SI_DB_PASSWORD=inventory_pass
SI_TEST_DB_USERNAME=test_user
SI_TEST_DB_PASSWORD=test_pass
DB_TEST_HOST=test-oracle-host.example.com
DB_TEST_PORT=1521
DB_TEST_SID=TESTDB

# ── Oracle Instant Client (optional) ────────────────────────
# Path to Oracle Instant Client directory. If not set, the system PATH is used.
ORACLE_INSTANT_CLIENT=C:\oracle\instantclient_23_0
```

#### Step 2 — Register Connections in `database.js`

Each connection gets a name (like `"userAccount"`) and its credentials from `.env`. You never hardcode passwords here — only `process.env` references.

```js
// src/config/database.js (already set up — add new connections as needed)

const connections = {
    // This is called with: createDb("userAccount")
    userAccount: {
        user: process.env.UA_DB_USERNAME,
        password: process.env.UA_DB_PASSWORD,
        connectString: `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_SERVICE_NAME}`,
    },

    // Add more connections as needed:
    // reportingDb: {
    //     user:          process.env.RPT_DB_USERNAME,
    //     password:      process.env.RPT_DB_PASSWORD,
    //     connectString: `${process.env.RPT_DB_HOST}:${process.env.RPT_DB_PORT}/${process.env.RPT_DB_SERVICE}`,
    //     poolMax:       10,   // optional — override default pool size
    // },
};
```

> **To add a new connection:** Add env vars to `.env`, add one entry to `connections`, then use `createDb("yourNewName")`. No other file needs to change.

#### Step 3 — The Adapter (`oracle.js`) Handles the Rest

You don't need to edit `oracle.js` — it automatically:

- Creates connection pools on first use (lazy initialization)
- Retries failed connections up to 3 times with exponential backoff
- Monitors pool health in the background
- Releases connections automatically after each operation
- Handles graceful shutdown

**Key pool defaults** (configurable per-connection in `database.js`):

| Setting          | Default | What it means                          |
| ---------------- | ------- | -------------------------------------- |
| `poolMin`        | 10      | Minimum connections kept open          |
| `poolMax`        | 50      | Maximum connections allowed            |
| `poolIncrement`  | 5       | How many to add when pool is exhausted |
| `poolTimeout`    | 30s     | Idle connection timeout                |
| `connectTimeout` | 15s     | Max wait to establish a connection     |
| `callTimeout`    | 60s     | Max wait for a query to return         |
| `stmtCacheSize`  | 50      | Cached prepared statements per conn    |

#### Step 4 — `config/index.js` Ties It Together

This file auto-detects the adapter from `DB_TYPE` env var (defaults to `"oracle"`) and exports everything:

```js
// src/config/index.js — you usually don't need to edit this
// It exports: withConnection, withTransaction, withBatchConnection,
//             closeAll, getPoolStats, isPoolHealthy, getConnectionConfig,
//             oracledb, and more.
```

The wrapper's `db.js` imports from this file, so when you call `createDb("userAccount")`, it flows through:
`createDb() → config/index.js → config/adapters/oracle.js → database.js credentials → Oracle pool`

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

// Connect to your database pool (configured in src/config/database.js)
const db = createDb("userAccount");
```

That's it. `db` is your gateway to everything.

---

## 🟢 Basic — Your First Queries

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

## 🟡 Medium — Filtering, Updating & Chaining

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

## 🔴 Hard — Aggregation, Transactions & Joins

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

// COALESCE — first non-null value
await users
    .find({})
    .project({
        displayName: { $coalesce: ["$nickname", "$name", "Anonymous"] },
    })
    .toArray();

// NULLIF — returns NULL if two values are equal
await users
    .find({})
    .project({
        effectiveDiscount: { $nullif: ["$discount", 0] },
    })
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

## Apache License 2.0 © 2026 John Moises Paunlagui. All rights reserved. See LICENSE.txt for details.
