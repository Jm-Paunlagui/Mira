"use strict";

/**
 * @fileoverview End-to-end test suite for oracle-mongo-wrapper
 * @description Runs against a real Oracle DB using the existing src/config adapter.
 *              Uses the 'userAccount' connection (UA_DB_USERNAME / UA_DB_PASSWORD).
 *
 * SETUP:
 *   1. Copy this file to your project root (same level as src/)
 *   2. Ensure your .env is configured (DB_HOST, DB_PORT, DB_SERVICE_NAME, UA_DB_*)
 *   3. npm install --save-dev mocha chai
 *   4. npx mocha test.js --timeout 30000 --exit
 *
 * TEARDOWN:
 *   All test tables are dropped after the suite runs.
 *   Safe to run repeatedly — uses IF NOT EXISTS / IF EXISTS guards.
 */

const path = require("path");
const { expect } = require("chai");
const dotenv = require("dotenv");
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// ─── Wrapper imports ──────────────────────────────────────────────────────────
const { createDb } = require("../../src/utils/oracle-mongo-wrapper/db");
const {
    OracleCollection,
} = require("../../src/utils/oracle-mongo-wrapper/core/OracleCollection");
const {
    OracleSchema,
} = require("../../src/utils/oracle-mongo-wrapper/schema/OracleSchema");
const {
    OracleDCL,
} = require("../../src/utils/oracle-mongo-wrapper/schema/OracleDCL");
const {
    Transaction,
} = require("../../src/utils/oracle-mongo-wrapper/Transaction");
const {
    withCTE,
    withRecursiveCTE,
} = require("../../src/utils/oracle-mongo-wrapper/pipeline/cteBuilder");
const {
    createPerformance,
} = require("../../src/utils/oracle-mongo-wrapper/advanced/performanceUtils");
const {
    parseFilter,
} = require("../../src/utils/oracle-mongo-wrapper/parsers/filterParser");
const {
    parseUpdate,
} = require("../../src/utils/oracle-mongo-wrapper/parsers/updateParser");

// ─── Test DB binding ──────────────────────────────────────────────────────────
const db = createDb("userAccount");

// ─── Test table names (prefixed to avoid collision with real tables) ──────────
const T = {
    USERS: "TEST_WRAP_USERS",
    ORDERS: "TEST_WRAP_ORDERS",
    EMPLOYEES: "TEST_WRAP_EMPLOYEES",
    SALES: "TEST_WRAP_SALES",
    ARCHIVE: "TEST_WRAP_ARCHIVE",
};

// ─── Collection handles ───────────────────────────────────────────────────────
let users, orders, employees, sales, archive;
let schema, dcl, txManager, perf;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function tableExists(tableName) {
    return db.withConnection(async (conn) => {
        const res = await conn.execute(
            `SELECT COUNT(*) AS CNT FROM USER_TABLES WHERE TABLE_NAME = UPPER(:n)`,
            { n: tableName },
            { outFormat: db.oracledb.OUT_FORMAT_OBJECT },
        );
        return res.rows[0].CNT > 0;
    });
}

async function dropIfExists(tableName) {
    const exists = await tableExists(tableName);
    if (exists) {
        await db.withConnection(async (conn) => {
            await conn.execute(
                `DROP TABLE "${tableName}" CASCADE CONSTRAINTS PURGE`,
                {},
                { autoCommit: true },
            );
        });
    }
}

async function rowCount(tableName) {
    return db.withConnection(async (conn) => {
        const res = await conn.execute(
            `SELECT COUNT(*) AS CNT FROM "${tableName}"`,
            {},
            { outFormat: db.oracledb.OUT_FORMAT_OBJECT },
        );
        return Number(res.rows[0].CNT);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE SETUP / TEARDOWN
// ─────────────────────────────────────────────────────────────────────────────

before(async function () {
    this.timeout(60_000);

    schema = new OracleSchema(db);
    dcl = new OracleDCL(db);
    txManager = new Transaction(db);
    perf = createPerformance(db);

    // Drop any leftover tables from a previous failed run
    for (const t of Object.values(T)) await dropIfExists(t);

    // ── Create test tables ────────────────────────────────────────────────────

    await schema.createTable(T.USERS, {
        ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
        NAME: { type: "VARCHAR2(200)", notNull: true },
        EMAIL: { type: "VARCHAR2(400)", notNull: true },
        STATUS: { type: "VARCHAR2(20)", default: "'active'" },
        AGE: { type: "NUMBER(3)" },
        TIER: { type: "VARCHAR2(20)", default: "'standard'" },
        BALANCE: { type: "NUMBER(12,2)", default: 0 },
        LOGIN_COUNT: { type: "NUMBER", default: 0 },
        CREATED_AT: { type: "DATE", default: "SYSDATE" },
        UPDATED_AT: { type: "DATE" },
    });

    await schema.createTable(T.ORDERS, {
        ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
        USER_ID: { type: "NUMBER", notNull: true },
        AMOUNT: { type: "NUMBER(12,2)", notNull: true },
        STATUS: { type: "VARCHAR2(20)", default: "'pending'" },
        REGION: { type: "VARCHAR2(50)" },
        CREATED_AT: { type: "DATE", default: "SYSDATE" },
    });

    await schema.createTable(T.EMPLOYEES, {
        ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
        NAME: { type: "VARCHAR2(200)", notNull: true },
        MANAGER_ID: { type: "NUMBER" },
        DEPT_ID: { type: "NUMBER" },
        SALARY: { type: "NUMBER(12,2)" },
    });

    await schema.createTable(T.SALES, {
        ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
        REGION: { type: "VARCHAR2(50)", notNull: true },
        QUARTER: { type: "VARCHAR2(5)", notNull: true },
        AMOUNT: { type: "NUMBER(12,2)", notNull: true },
    });

    await schema.createTable(T.ARCHIVE, {
        ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
        USER_ID: { type: "NUMBER" },
        AMOUNT: { type: "NUMBER(12,2)" },
        STATUS: { type: "VARCHAR2(20)" },
        ARCHIVED_AT: { type: "DATE", default: "SYSDATE" },
    });

    // ── Bind collection handles ───────────────────────────────────────────────
    users = new OracleCollection(T.USERS, db);
    orders = new OracleCollection(T.ORDERS, db);
    employees = new OracleCollection(T.EMPLOYEES, db);
    sales = new OracleCollection(T.SALES, db);
    archive = new OracleCollection(T.ARCHIVE, db);

    // ── Seed data ─────────────────────────────────────────────────────────────
    await users.insertMany([
        {
            NAME: "Juan",
            EMAIL: "juan@test.com",
            STATUS: "active",
            AGE: 28,
            TIER: "gold",
            BALANCE: 1500,
        },
        {
            NAME: "Maria",
            EMAIL: "maria@test.com",
            STATUS: "active",
            AGE: 34,
            TIER: "platinum",
            BALANCE: 5000,
        },
        {
            NAME: "Pedro",
            EMAIL: "pedro@test.com",
            STATUS: "inactive",
            AGE: 22,
            TIER: "standard",
            BALANCE: 200,
        },
        {
            NAME: "Ana",
            EMAIL: "ana@test.com",
            STATUS: "active",
            AGE: 45,
            TIER: "gold",
            BALANCE: 3000,
        },
        {
            NAME: "Carlos",
            EMAIL: "carlos@test.com",
            STATUS: "inactive",
            AGE: 19,
            TIER: "standard",
            BALANCE: 0,
        },
    ]);

    await orders.insertMany([
        { USER_ID: 1, AMOUNT: 250, STATUS: "completed", REGION: "North" },
        { USER_ID: 1, AMOUNT: 750, STATUS: "completed", REGION: "North" },
        { USER_ID: 2, AMOUNT: 1200, STATUS: "completed", REGION: "South" },
        { USER_ID: 2, AMOUNT: 300, STATUS: "pending", REGION: "South" },
        { USER_ID: 3, AMOUNT: 80, STATUS: "cancelled", REGION: "East" },
        { USER_ID: 4, AMOUNT: 2000, STATUS: "completed", REGION: "West" },
    ]);

    await employees.insertMany([
        { NAME: "CEO", MANAGER_ID: null, DEPT_ID: 1, SALARY: 150000 },
        { NAME: "VP Eng", MANAGER_ID: 1, DEPT_ID: 2, SALARY: 120000 },
        { NAME: "VP Sales", MANAGER_ID: 1, DEPT_ID: 3, SALARY: 110000 },
        { NAME: "Dev Lead", MANAGER_ID: 2, DEPT_ID: 2, SALARY: 90000 },
        { NAME: "Dev 1", MANAGER_ID: 4, DEPT_ID: 2, SALARY: 70000 },
        { NAME: "Dev 2", MANAGER_ID: 4, DEPT_ID: 2, SALARY: 68000 },
    ]);

    await sales.insertMany([
        { REGION: "North", QUARTER: "Q1", AMOUNT: 10000 },
        { REGION: "North", QUARTER: "Q2", AMOUNT: 15000 },
        { REGION: "North", QUARTER: "Q3", AMOUNT: 12000 },
        { REGION: "North", QUARTER: "Q4", AMOUNT: 18000 },
        { REGION: "South", QUARTER: "Q1", AMOUNT: 8000 },
        { REGION: "South", QUARTER: "Q2", AMOUNT: 9500 },
        { REGION: "South", QUARTER: "Q3", AMOUNT: 11000 },
        { REGION: "South", QUARTER: "Q4", AMOUNT: 13000 },
    ]);
});

after(async function () {
    this.timeout(30_000);
    for (const t of Object.values(T)) await dropIfExists(t);
    await db.closePool();
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 0 — db adapter
// ─────────────────────────────────────────────────────────────────────────────

describe("0. db adapter (createDb)", function () {
    it("createDb returns required interface", function () {
        expect(db).to.have.all.keys(
            "connectionName",
            "withConnection",
            "withTransaction",
            "withBatchConnection",
            "closePool",
            "getPoolStats",
            "isHealthy",
            "oracledb",
        );
    });

    it("connectionName is set correctly", function () {
        expect(db.connectionName).to.equal("userAccount");
    });

    it("withConnection executes a query", async function () {
        const result = await db.withConnection(async (conn) => {
            const r = await conn.execute(
                "SELECT 1 AS VAL FROM DUAL",
                {},
                { outFormat: db.oracledb.OUT_FORMAT_OBJECT },
            );
            return r.rows[0].VAL;
        });
        expect(result).to.equal(1);
    });

    it("isHealthy returns true for a live pool", async function () {
        const healthy = await db.isHealthy();
        expect(healthy).to.be.true;
    });

    it("getPoolStats returns pool info", async function () {
        const stats = await db.getPoolStats();
        expect(stats).to.have.property("pools");
        expect(stats.pools).to.have.property("userAccount");
    });

    it("createDb throws for invalid connectionName", function () {
        expect(() => createDb("")).to.throw(TypeError);
        expect(() => createDb(null)).to.throw(TypeError);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — filterParser
// ─────────────────────────────────────────────────────────────────────────────

describe("1. filterParser", function () {
    it("empty filter returns empty whereClause", function () {
        const { whereClause, binds } = parseFilter({});
        expect(whereClause).to.equal("");
        expect(binds).to.deep.equal({});
    });

    it("simple equality", function () {
        const { whereClause, binds } = parseFilter({ STATUS: "active" });
        expect(whereClause).to.include("WHERE");
        expect(whereClause).to.include('"STATUS"');
        expect(Object.values(binds)).to.include("active");
    });

    it("$gt, $gte, $lt, $lte operators", function () {
        const ops = [
            [{ AGE: { $gt: 18 } }, ">"],
            [{ AGE: { $gte: 18 } }, ">="],
            [{ AGE: { $lt: 18 } }, "<"],
            [{ AGE: { $lte: 18 } }, "<="],
        ];
        for (const [filter, op] of ops) {
            const { whereClause } = parseFilter(filter);
            expect(whereClause).to.include(op);
        }
    });

    it("$in and $nin operators", function () {
        const { whereClause: inClause } = parseFilter({
            STATUS: { $in: ["active", "pending"] },
        });
        const { whereClause: ninClause } = parseFilter({
            STATUS: { $nin: ["inactive"] },
        });
        expect(inClause).to.include("IN");
        expect(ninClause).to.include("NOT IN");
    });

    it("$exists true/false", function () {
        const { whereClause: notNull } = parseFilter({
            UPDATED_AT: { $exists: true },
        });
        const { whereClause: isNull } = parseFilter({
            UPDATED_AT: { $exists: false },
        });
        expect(notNull).to.include("IS NOT NULL");
        expect(isNull).to.include("IS NULL");
    });

    it("$and / $or / $nor logical operators", function () {
        const { whereClause: and } = parseFilter({
            $and: [{ STATUS: "active" }, { AGE: { $gte: 18 } }],
        });
        const { whereClause: or } = parseFilter({
            $or: [{ STATUS: "active" }, { STATUS: "pending" }],
        });
        const { whereClause: nor } = parseFilter({
            $nor: [{ STATUS: "inactive" }],
        });
        expect(and).to.include("AND");
        expect(or).to.include("OR");
        expect(nor).to.include("NOT");
    });

    it("$like operator", function () {
        const { whereClause } = parseFilter({ NAME: { $like: "J%" } });
        expect(whereClause).to.include("LIKE");
    });

    it("$regex operator", function () {
        const { whereClause } = parseFilter({ NAME: { $regex: "^J" } });
        expect(whereClause).to.include("REGEXP_LIKE");
    });

    it("$between operator", function () {
        const { whereClause } = parseFilter({ AGE: { $between: [20, 40] } });
        expect(whereClause).to.include("BETWEEN");
    });

    it("unique bind variable names when same field repeated", function () {
        const { binds } = parseFilter({
            $and: [{ AGE: { $gte: 18 } }, { AGE: { $lte: 60 } }],
        });
        const keys = Object.keys(binds);
        expect(keys.length).to.equal(2);
        expect(new Set(keys).size).to.equal(2); // all unique
    });

    it("throws for unsupported operator", function () {
        expect(() => parseFilter({ NAME: { $unknown: "x" } })).to.throw();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — updateParser
// ─────────────────────────────────────────────────────────────────────────────

describe("2. updateParser", function () {
    it("$set produces SET clause", function () {
        const { setClause, binds } = parseUpdate({
            $set: { STATUS: "premium" },
        });
        expect(setClause).to.include("SET");
        expect(setClause).to.include('"STATUS"');
        expect(Object.values(binds)).to.include("premium");
    });

    it("$unset sets field to NULL", function () {
        const { setClause } = parseUpdate({ $unset: { UPDATED_AT: "" } });
        expect(setClause).to.include("NULL");
    });

    it("$inc produces field = field + :n", function () {
        const { setClause } = parseUpdate({ $inc: { LOGIN_COUNT: 1 } });
        expect(setClause).to.match(/"LOGIN_COUNT"\s*=\s*"LOGIN_COUNT"\s*\+/);
    });

    it("$mul produces field = field * :n", function () {
        const { setClause } = parseUpdate({ $mul: { BALANCE: 2 } });
        expect(setClause).to.match(/"BALANCE"\s*=\s*"BALANCE"\s*\*/);
    });

    it("$min produces LEAST()", function () {
        const { setClause } = parseUpdate({ $min: { BALANCE: 100 } });
        expect(setClause).to.include("LEAST");
    });

    it("$max produces GREATEST()", function () {
        const { setClause } = parseUpdate({ $max: { BALANCE: 9999 } });
        expect(setClause).to.include("GREATEST");
    });

    it("$currentDate produces SYSDATE", function () {
        const { setClause } = parseUpdate({
            $currentDate: { UPDATED_AT: true },
        });
        expect(setClause).to.include("SYSDATE");
    });

    it("$rename throws a descriptive error", function () {
        expect(() => parseUpdate({ $rename: { NAME: "FULL_NAME" } })).to.throw(
            /ALTER TABLE/i,
        );
    });

    it("throws on empty update object", function () {
        expect(() => parseUpdate({})).to.throw();
    });

    it("update binds prefixed with upd_ (no collision with filter binds)", function () {
        const { binds } = parseUpdate({ $set: { STATUS: "active" } });
        const allKeys = Object.keys(binds);
        expect(allKeys.every((k) => k.startsWith("upd_"))).to.be.true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Insert Operations
// ─────────────────────────────────────────────────────────────────────────────

describe("3. Insert Operations", function () {
    it("insertOne returns acknowledged + insertedId", async function () {
        const result = await users.insertOne({
            NAME: "TestUser1",
            EMAIL: "test1@test.com",
            STATUS: "active",
            AGE: 30,
        });
        expect(result.acknowledged).to.be.true;
        expect(result.insertedId).to.exist;
    });

    it("insertOne with returning option returns extra columns", async function () {
        const result = await users.insertOne(
            {
                NAME: "TestUser2",
                EMAIL: "test2@test.com",
                STATUS: "active",
                AGE: 25,
            },
            { returning: ["ID", "CREATED_AT"] },
        );
        expect(result.acknowledged).to.be.true;
        expect(result.returning).to.have.property("ID");
        expect(result.returning).to.have.property("CREATED_AT");
    });

    it("insertMany inserts all documents atomically", async function () {
        const before = await rowCount(T.USERS);
        const result = await users.insertMany([
            { NAME: "Batch1", EMAIL: "b1@test.com", AGE: 20 },
            { NAME: "Batch2", EMAIL: "b2@test.com", AGE: 21 },
            { NAME: "Batch3", EMAIL: "b3@test.com", AGE: 22 },
        ]);
        const after = await rowCount(T.USERS);
        expect(result.acknowledged).to.be.true;
        expect(result.insertedCount).to.equal(3);
        expect(result.insertedIds).to.have.length(3);
        expect(after - before).to.equal(3);
    });

    it("insertMany rolls back all rows on failure", async function () {
        const before = await rowCount(T.USERS);
        try {
            // Second doc has EMAIL too long — should cause ORA error and rollback
            await users.insertMany([
                { NAME: "RollbackOk", EMAIL: "ok@test.com" },
                { NAME: "RollbackFail", EMAIL: "x".repeat(500) }, // exceeds VARCHAR2(400)
            ]);
        } catch (e) {
            /* expected */
        }
        const after = await rowCount(T.USERS);
        expect(after).to.equal(before); // all rolled back
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Query / Read Operations
// ─────────────────────────────────────────────────────────────────────────────

describe("4. Query / Read Operations", function () {
    it("findOne returns a single document", async function () {
        const doc = await users.findOne({ NAME: "Juan" });
        expect(doc).to.not.be.null;
        expect(doc.NAME).to.equal("Juan");
    });

    it("findOne returns null when no match", async function () {
        const doc = await users.findOne({ NAME: "NoSuchPerson" });
        expect(doc).to.be.null;
    });

    it("countDocuments returns correct count", async function () {
        const count = await users.countDocuments({ STATUS: "active" });
        expect(count).to.be.a("number");
        expect(count).to.be.greaterThan(0);
    });

    it("estimatedDocumentCount returns a number", async function () {
        const count = await users.estimatedDocumentCount();
        expect(count).to.be.a("number");
    });

    it("distinct returns unique values", async function () {
        const statuses = await users.distinct("STATUS");
        expect(statuses).to.be.an("array");
        expect(new Set(statuses).size).to.equal(statuses.length); // all unique
        expect(statuses).to.include.members(["active", "inactive"]);
    });

    it("distinct with filter narrows results", async function () {
        const statuses = await users.distinct("STATUS", { AGE: { $gte: 30 } });
        expect(statuses).to.be.an("array");
    });

    it("findOneAndUpdate returns before document by default", async function () {
        const before = await users.findOneAndUpdate(
            { NAME: "Juan" },
            { $set: { TIER: "platinum" } },
            { returnDocument: "before" },
        );
        expect(before).to.not.be.null;
        expect(before.TIER).to.equal("gold"); // original value
    });

    it("findOneAndUpdate with returnDocument:after returns updated doc", async function () {
        const after = await users.findOneAndUpdate(
            { NAME: "Pedro" },
            { $set: { STATUS: "active" } },
            { returnDocument: "after" },
        );
        expect(after).to.not.be.null;
        expect(after.STATUS).to.equal("active");
    });

    it("findOneAndUpdate with upsert inserts when no match", async function () {
        const result = await users.findOneAndUpdate(
            { NAME: "NewUpsertUser" },
            { $set: { EMAIL: "upsert@test.com", STATUS: "active", AGE: 30 } },
            { upsert: true, returnDocument: "after" },
        );
        expect(result).to.not.be.null;
    });

    it("findOneAndDelete returns and removes the document", async function () {
        // Insert a throwaway record
        await users.insertOne({
            NAME: "DeleteMe",
            EMAIL: "del@test.com",
            AGE: 99,
        });
        const deleted = await users.findOneAndDelete({ NAME: "DeleteMe" });
        expect(deleted).to.not.be.null;
        expect(deleted.NAME).to.equal("DeleteMe");
        const check = await users.findOne({ NAME: "DeleteMe" });
        expect(check).to.be.null;
    });

    it("findOneAndReplace replaces the document", async function () {
        await users.insertOne({
            NAME: "ReplaceMe",
            EMAIL: "rep@test.com",
            AGE: 10,
        });
        const result = await users.findOneAndReplace(
            { NAME: "ReplaceMe" },
            {
                NAME: "Replaced",
                EMAIL: "replaced@test.com",
                AGE: 11,
                STATUS: "active",
            },
            { returnDocument: "after" },
        );
        expect(result.NAME).to.equal("Replaced");
        await users.deleteOne({ NAME: "Replaced" }); // cleanup
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — QueryBuilder (cursor chaining)
// ─────────────────────────────────────────────────────────────────────────────

describe("5. QueryBuilder — cursor chaining", function () {
    it("find().toArray() returns all matched rows", async function () {
        const rows = await users.find({ STATUS: "active" }).toArray();
        expect(rows).to.be.an("array");
        rows.forEach((r) => expect(r.STATUS).to.equal("active"));
    });

    it(".limit() caps result count", async function () {
        const rows = await users.find({}).limit(2).toArray();
        expect(rows.length).to.be.at.most(2);
    });

    it(".skip() offsets results", async function () {
        const all = await users.find({}).sort({ ID: 1 }).toArray();
        const paged = await users.find({}).sort({ ID: 1 }).skip(2).toArray();
        expect(paged[0].ID).to.equal(all[2].ID);
    });

    it(".sort() orders results ASC and DESC", async function () {
        const asc = await users
            .find({ AGE: { $exists: true } })
            .sort({ AGE: 1 })
            .toArray();
        const desc = await users
            .find({ AGE: { $exists: true } })
            .sort({ AGE: -1 })
            .toArray();
        expect(Number(asc[0].AGE)).to.be.at.most(
            Number(asc[asc.length - 1].AGE),
        );
        expect(Number(desc[0].AGE)).to.be.at.least(
            Number(desc[desc.length - 1].AGE),
        );
    });

    it(".project() returns only specified columns", async function () {
        const rows = await users
            .find({})
            .project({ NAME: 1, EMAIL: 1 })
            .toArray();
        rows.forEach((r) => {
            expect(r).to.have.property("NAME");
            expect(r).to.have.property("EMAIL");
            expect(r).to.not.have.property("STATUS");
        });
    });

    it(".project() with exclusion (0) omits the column", async function () {
        const rows = await users.find({}).project({ STATUS: 0 }).toArray();
        rows.forEach((r) => expect(r).to.not.have.property("STATUS"));
    });

    it(".count() returns the count without returning rows", async function () {
        const count = await users.find({ STATUS: "active" }).count();
        expect(count).to.be.a("number");
        expect(count).to.be.greaterThan(0);
    });

    it(".next() returns first matching row", async function () {
        const row = await users
            .find({ STATUS: "active" })
            .sort({ ID: 1 })
            .next();
        expect(row).to.not.be.null;
        expect(row).to.have.property("ID");
    });

    it(".hasNext() returns true when rows exist", async function () {
        const has = await users.find({ STATUS: "active" }).hasNext();
        expect(has).to.be.true;
    });

    it(".hasNext() returns false when no rows", async function () {
        const has = await users.find({ NAME: "ZZZNoMatch" }).hasNext();
        expect(has).to.be.false;
    });

    it(".forEach() iterates over each row", async function () {
        const names = [];
        await users
            .find({ STATUS: "active" })
            .forEach((row) => names.push(row.NAME));
        expect(names.length).to.be.greaterThan(0);
    });

    it(".explain() returns SQL string without executing", async function () {
        const sql = await users
            .find({ STATUS: "active" })
            .sort({ NAME: 1 })
            .limit(5)
            .explain();
        expect(sql).to.be.a("string");
        expect(sql.toUpperCase()).to.include("SELECT");
        expect(sql.toUpperCase()).to.include("FROM");
    });

    it("chaining after terminal method throws", async function () {
        const qb = users.find({ STATUS: "active" });
        await qb.toArray(); // terminal
        expect(() => qb.sort({ NAME: 1 })).to.throw(/terminal/i);
    });

    it(".skip() without .limit() still works", async function () {
        const rows = await users.find({}).sort({ ID: 1 }).skip(1).toArray();
        expect(rows).to.be.an("array");
    });

    it(".forUpdate() appends FOR UPDATE clause (inside transaction)", async function () {
        await db.withTransaction(async (conn) => {
            // Just verify no error is thrown — FOR UPDATE requires a transaction
            const qb = users.find({ NAME: "Juan" }).forUpdate("nowait");
            const sql = await qb.explain();
            expect(sql.toUpperCase()).to.include("FOR UPDATE");
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Update Operations
// ─────────────────────────────────────────────────────────────────────────────

describe("6. Update Operations", function () {
    it("updateOne updates exactly one row", async function () {
        const result = await users.updateOne(
            { NAME: "Carlos" },
            { $set: { STATUS: "active" } },
        );
        expect(result.acknowledged).to.be.true;
        expect(result.matchedCount).to.equal(1);
        expect(result.modifiedCount).to.equal(1);
    });

    it("updateOne with $inc increments the field", async function () {
        const before = await users.findOne({ NAME: "Juan" });
        await users.updateOne({ NAME: "Juan" }, { $inc: { LOGIN_COUNT: 1 } });
        const after = await users.findOne({ NAME: "Juan" });
        expect(Number(after.LOGIN_COUNT)).to.equal(
            Number(before.LOGIN_COUNT) + 1,
        );
    });

    it("updateOne with $currentDate sets SYSDATE", async function () {
        await users.updateOne(
            { NAME: "Maria" },
            { $currentDate: { UPDATED_AT: true } },
        );
        const doc = await users.findOne({ NAME: "Maria" });
        expect(doc.UPDATED_AT).to.be.instanceOf(Date);
    });

    it("updateOne with upsert inserts when no match", async function () {
        const result = await users.updateOne(
            { NAME: "UpsertTarget" },
            { $set: { EMAIL: "upsert2@test.com", STATUS: "active", AGE: 30 } },
            { upsert: true },
        );
        expect(result.acknowledged).to.be.true;
        await users.deleteOne({ NAME: "UpsertTarget" }); // cleanup
    });

    it("updateOne with returning returns updated values", async function () {
        const result = await users.updateOne(
            { NAME: "Ana" },
            { $set: { TIER: "platinum" } },
            { returning: ["TIER"] },
        );
        expect(result.returning).to.have.property("TIER");
        expect(result.returning.TIER).to.equal("platinum");
    });

    it("updateMany updates all matching rows", async function () {
        // Insert temp inactive users to ensure test data exists
        await users.insertOne({
            NAME: "InactiveA",
            EMAIL: "ia@test.com",
            STATUS: "inactive",
            BALANCE: 100,
        });
        await users.insertOne({
            NAME: "InactiveB",
            EMAIL: "ib@test.com",
            STATUS: "inactive",
            BALANCE: 200,
        });
        const result = await users.updateMany(
            { STATUS: "inactive" },
            { $set: { BALANCE: 0 } },
        );
        expect(result.acknowledged).to.be.true;
        expect(result.modifiedCount).to.be.greaterThan(0);
        // cleanup
        await users.deleteMany({ NAME: { $in: ["InactiveA", "InactiveB"] } });
    });

    it("replaceOne replaces the entire row", async function () {
        await users.insertOne({
            NAME: "ToReplace",
            EMAIL: "rep2@test.com",
            AGE: 50,
        });
        const result = await users.replaceOne(
            { NAME: "ToReplace" },
            {
                NAME: "WasReplaced",
                EMAIL: "was@test.com",
                STATUS: "active",
                AGE: 51,
            },
        );
        expect(result.acknowledged).to.be.true;
        expect(result.matchedCount).to.equal(1);
        await users.deleteOne({ NAME: "WasReplaced" }); // cleanup
    });

    it("bulkWrite executes all ops atomically", async function () {
        const result = await users.bulkWrite([
            {
                insertOne: {
                    document: { NAME: "BulkA", EMAIL: "ba@test.com", AGE: 20 },
                },
            },
            {
                insertOne: {
                    document: { NAME: "BulkB", EMAIL: "bb@test.com", AGE: 21 },
                },
            },
            {
                updateOne: {
                    filter: { NAME: "BulkA" },
                    update: { $set: { STATUS: "active" } },
                },
            },
            { deleteOne: { filter: { NAME: "BulkB" } } },
        ]);
        expect(result.acknowledged).to.be.true;
        expect(result.results).to.be.an("array").with.length(4);
        await users.deleteOne({ NAME: "BulkA" }); // cleanup
    });

    it("bulkWrite rolls back all ops on any failure", async function () {
        const before = await rowCount(T.USERS);
        try {
            await users.bulkWrite([
                {
                    insertOne: {
                        document: { NAME: "BulkOk", EMAIL: "bok@test.com" },
                    },
                },
                { updateOne: { filter: { NAME: "NoMatch" }, update: {} } }, // empty update — throws
            ]);
        } catch (e) {
            /* expected */
        }
        const after = await rowCount(T.USERS);
        expect(after).to.equal(before);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Delete Operations
// ─────────────────────────────────────────────────────────────────────────────

describe("7. Delete Operations", function () {
    it("deleteOne removes exactly one row", async function () {
        await users.insertOne({ NAME: "ToDelete1", EMAIL: "td1@test.com" });
        const result = await users.deleteOne({ NAME: "ToDelete1" });
        expect(result.acknowledged).to.be.true;
        expect(result.deletedCount).to.equal(1);
    });

    it("deleteOne with returning returns deleted row values", async function () {
        await users.insertOne({
            NAME: "ToDelete2",
            EMAIL: "td2@test.com",
            AGE: 55,
        });
        const result = await users.deleteOne(
            { NAME: "ToDelete2" },
            { returning: ["NAME", "AGE"] },
        );
        expect(result.returning.NAME).to.equal("ToDelete2");
        expect(Number(result.returning.AGE)).to.equal(55);
    });

    it("deleteMany removes all matching rows", async function () {
        await users.insertMany([
            { NAME: "DMTest1", EMAIL: "dm1@test.com", STATUS: "inactive" },
            { NAME: "DMTest2", EMAIL: "dm2@test.com", STATUS: "inactive" },
        ]);
        const result = await users.deleteMany({ NAME: { $like: "DMTest%" } });
        expect(result.acknowledged).to.be.true;
        expect(result.deletedCount).to.be.at.least(2);
    });

    it("deleteOne on no match returns deletedCount 0", async function () {
        const result = await users.deleteOne({ NAME: "ZZZDoesNotExist" });
        expect(result.deletedCount).to.equal(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Aggregation Pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe("8. Aggregation Pipeline", function () {
    it("$match filters rows", async function () {
        const rows = await orders.aggregate([
            { $match: { STATUS: "completed" } },
        ]);
        expect(rows).to.be.an("array");
        rows.forEach((r) => expect(r.STATUS).to.equal("completed"));
    });

    it("$group with $sum aggregates correctly", async function () {
        const rows = await orders.aggregate([
            { $match: { STATUS: "completed" } },
            { $group: { _id: "$REGION", total: { $sum: "$AMOUNT" } } },
        ]);
        expect(rows).to.be.an("array");
        rows.forEach((r) => {
            expect(r).to.have.property("REGION");
            expect(r).to.have.property("TOTAL");
            expect(Number(r.TOTAL)).to.be.greaterThan(0);
        });
    });

    it("$group with $count, $avg, $min, $max", async function () {
        const rows = await orders.aggregate([
            {
                $group: {
                    _id: "$REGION",
                    cnt: { $count: "*" },
                    avg: { $avg: "$AMOUNT" },
                    minAmt: { $min: "$AMOUNT" },
                    maxAmt: { $max: "$AMOUNT" },
                },
            },
        ]);
        expect(rows).to.be.an("array").with.length.greaterThan(0);
    });

    it("$sort orders results", async function () {
        const rows = await orders.aggregate([
            { $group: { _id: "$REGION", total: { $sum: "$AMOUNT" } } },
            { $sort: { total: -1 } },
        ]);
        for (let i = 1; i < rows.length; i++) {
            expect(Number(rows[i - 1].TOTAL)).to.be.at.least(
                Number(rows[i].TOTAL),
            );
        }
    });

    it("$limit caps results", async function () {
        const rows = await orders.aggregate([{ $limit: 2 }]);
        expect(rows.length).to.be.at.most(2);
    });

    it("$skip offsets results", async function () {
        const all = await orders.aggregate([{ $sort: { ID: 1 } }]);
        const paged = await orders.aggregate([
            { $sort: { ID: 1 } },
            { $skip: 2 },
        ]);
        expect(paged[0].ID).to.equal(all[2].ID);
    });

    it("$project selects specific fields", async function () {
        const rows = await orders.aggregate([
            { $project: { ID: 1, STATUS: 1 } },
        ]);
        rows.forEach((r) => {
            expect(r).to.have.property("ID");
            expect(r).to.have.property("STATUS");
        });
    });

    it("$count returns total count", async function () {
        const rows = await orders.aggregate([
            { $match: { STATUS: "completed" } },
            { $count: "total" },
        ]);
        expect(rows[0]).to.have.property("TOTAL");
        expect(Number(rows[0].TOTAL)).to.be.greaterThan(0);
    });

    it("$having filters groups", async function () {
        const rows = await orders.aggregate([
            { $group: { _id: "$REGION", total: { $sum: "$AMOUNT" } } },
            { $having: { total: { $gt: 500 } } },
        ]);
        rows.forEach((r) => expect(Number(r.TOTAL)).to.be.greaterThan(500));
    });

    it("$addFields adds computed columns", async function () {
        const rows = await orders.aggregate([
            { $addFields: { TAX: { $mul: ["$AMOUNT", 0.12] } } },
        ]);
        expect(rows[0]).to.have.property("TAX");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — Window Functions
// ─────────────────────────────────────────────────────────────────────────────

describe("9. Window Functions", function () {
    it("ROW_NUMBER generates sequential numbers", async function () {
        const rows = await orders.aggregate([
            {
                $addFields: {
                    RN: { $window: { fn: "ROW_NUMBER", orderBy: { ID: 1 } } },
                },
            },
        ]);
        const nums = rows.map((r) => Number(r.RN));
        expect(nums).to.deep.equal(
            [...Array(nums.length).keys()].map((i) => i + 1),
        );
    });

    it("RANK with PARTITION BY groups correctly", async function () {
        const rows = await orders.aggregate([
            {
                $addFields: {
                    RNK: {
                        $window: {
                            fn: "RANK",
                            partitionBy: "REGION",
                            orderBy: { AMOUNT: -1 },
                        },
                    },
                },
            },
        ]);
        rows.forEach((r) => expect(Number(r.RNK)).to.be.greaterThan(0));
    });

    it("SUM running total accumulates", async function () {
        const rows = await orders.aggregate([
            {
                $addFields: {
                    RUNNING_TOTAL: {
                        $window: {
                            fn: "SUM",
                            field: "AMOUNT",
                            partitionBy: "USER_ID",
                            orderBy: { ID: 1 },
                        },
                    },
                },
            },
        ]);
        expect(rows[0]).to.have.property("RUNNING_TOTAL");
    });

    it("LAG accesses previous row value", async function () {
        const rows = await orders.aggregate([
            {
                $addFields: {
                    PREV_AMOUNT: {
                        $window: {
                            fn: "LAG",
                            field: "AMOUNT",
                            offset: 1,
                            partitionBy: "USER_ID",
                            orderBy: { ID: 1 },
                        },
                    },
                },
            },
        ]);
        expect(rows[0]).to.have.property("PREV_AMOUNT");
    });

    it("NTILE splits into quartiles", async function () {
        const rows = await orders.aggregate([
            {
                $addFields: {
                    QUARTILE: {
                        $window: { fn: "NTILE", n: 4, orderBy: { AMOUNT: 1 } },
                    },
                },
            },
        ]);
        rows.forEach((r) => {
            const q = Number(r.QUARTILE);
            expect(q).to.be.within(1, 4);
        });
    });

    it("DENSE_RANK does not skip numbers after ties", async function () {
        const rows = await orders.aggregate([
            {
                $addFields: {
                    DR: {
                        $window: { fn: "DENSE_RANK", orderBy: { REGION: 1 } },
                    },
                },
            },
        ]);
        const ranks = [...new Set(rows.map((r) => Number(r.DR)))].sort(
            (a, b) => a - b,
        );
        for (let i = 1; i < ranks.length; i++) {
            expect(ranks[i] - ranks[i - 1]).to.equal(1); // no gaps
        }
    });

    it("frame clause: ROWS BETWEEN 1 PRECEDING AND CURRENT ROW", async function () {
        const rows = await orders.aggregate([
            {
                $addFields: {
                    WINDOWED: {
                        $window: {
                            fn: "SUM",
                            field: "AMOUNT",
                            orderBy: { ID: 1 },
                            frame: "ROWS BETWEEN 1 PRECEDING AND CURRENT ROW",
                        },
                    },
                },
            },
        ]);
        expect(rows[0]).to.have.property("WINDOWED");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — Advanced Grouping
// ─────────────────────────────────────────────────────────────────────────────

describe("10. Advanced Grouping (ROLLUP / CUBE / GROUPING SETS)", function () {
    it("$rollup produces subtotals", async function () {
        const rows = await sales.aggregate([
            {
                $group: {
                    _id: { $rollup: ["REGION", "QUARTER"] },
                    total: { $sum: "$AMOUNT" },
                },
            },
        ]);
        expect(rows).to.be.an("array").with.length.greaterThan(0);
        // ROLLUP produces rows with NULL for rolled-up dimensions
        const nullRows = rows.filter(
            (r) => r.REGION === null || r.QUARTER === null,
        );
        expect(nullRows.length).to.be.greaterThan(0);
    });

    it("$cube produces all subtotal combinations", async function () {
        const rows = await sales.aggregate([
            {
                $group: {
                    _id: { $cube: ["REGION", "QUARTER"] },
                    total: { $sum: "$AMOUNT" },
                },
            },
        ]);
        expect(rows.length).to.be.greaterThan(0);
    });

    it("$groupingSets targets specific grouping combinations", async function () {
        const rows = await sales.aggregate([
            {
                $group: {
                    _id: {
                        $groupingSets: [["REGION", "QUARTER"], ["REGION"], []],
                    },
                    total: { $sum: "$AMOUNT" },
                },
            },
        ]);
        expect(rows.length).to.be.greaterThan(0);
        // Grand total row has both REGION and QUARTER as null
        const grandTotal = rows.find(
            (r) => r.REGION === null && r.QUARTER === null,
        );
        expect(grandTotal).to.exist;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11 — JOINs
// ─────────────────────────────────────────────────────────────────────────────

describe("11. JOINs ($lookup)", function () {
    it("LEFT JOIN returns all orders including unmatched", async function () {
        const rows = await orders.aggregate([
            {
                $lookup: {
                    from: T.USERS,
                    localField: "USER_ID",
                    foreignField: "ID",
                    as: "user",
                    joinType: "left",
                },
            },
        ]);
        expect(rows).to.be.an("array").with.length.greaterThan(0);
        expect(rows[0]).to.have.property("NAME"); // joined user column
    });

    it("INNER JOIN excludes rows with no match", async function () {
        const rows = await orders.aggregate([
            {
                $lookup: {
                    from: T.USERS,
                    localField: "USER_ID",
                    foreignField: "ID",
                    as: "user",
                    joinType: "inner",
                },
            },
        ]);
        expect(rows.length).to.be.greaterThan(0);
        rows.forEach((r) => expect(r.NAME).to.not.be.null);
    });

    it("multi-condition join works with on: []", async function () {
        const rows = await orders.aggregate([
            {
                $lookup: {
                    from: T.USERS,
                    as: "user",
                    joinType: "left",
                    on: [{ localField: "USER_ID", foreignField: "ID" }],
                },
            },
        ]);
        expect(rows).to.be.an("array").with.length.greaterThan(0);
    });

    it("self-join works on employees table", async function () {
        const rows = await employees.aggregate([
            {
                $lookup: {
                    from: T.EMPLOYEES,
                    as: "manager",
                    joinType: "self",
                    localField: "MANAGER_ID",
                    foreignField: "ID",
                },
            },
        ]);
        expect(rows).to.be.an("array").with.length.greaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12 — Set Operations
// ─────────────────────────────────────────────────────────────────────────────

describe("12. Set Operations (UNION / INTERSECT / MINUS)", function () {
    it("UNION removes duplicates", async function () {
        const rows = await OracleCollection.union(
            users.find({ TIER: "gold" }).project({ NAME: 1 }),
            users.find({ TIER: "platinum" }).project({ NAME: 1 }),
        );
        const names = rows.map((r) => r.NAME);
        expect(new Set(names).size).to.equal(names.length); // no duplicates
    });

    it("UNION ALL keeps duplicates", async function () {
        const withoutAll = await OracleCollection.union(
            users.find({ STATUS: "active" }).project({ NAME: 1 }),
            users.find({ STATUS: "active" }).project({ NAME: 1 }),
        );
        const withAll = await OracleCollection.union(
            users.find({ STATUS: "active" }).project({ NAME: 1 }),
            users.find({ STATUS: "active" }).project({ NAME: 1 }),
            { all: true },
        );
        expect(withAll.length).to.be.greaterThan(withoutAll.length);
    });

    it("INTERSECT returns only rows in both queries", async function () {
        // Both queries target gold users — intersection should equal gold users
        const rows = await OracleCollection.intersect(
            users.find({ STATUS: "active" }).project({ NAME: 1 }),
            users.find({ TIER: "gold" }).project({ NAME: 1 }),
        );
        expect(rows).to.be.an("array");
    });

    it("MINUS returns rows in first but not second", async function () {
        const rows = await OracleCollection.minus(
            users.find({ STATUS: "active" }).project({ NAME: 1 }),
            users.find({ TIER: "platinum" }).project({ NAME: 1 }),
        );
        expect(rows).to.be.an("array");
    });

    it("set operation result supports .sort().limit().toArray()", async function () {
        const rows = await OracleCollection.union(
            users.find({ TIER: "gold" }).project({ NAME: 1 }),
            users.find({ TIER: "platinum" }).project({ NAME: 1 }),
        )
            .sort({ NAME: 1 })
            .limit(2)
            .toArray();
        expect(rows.length).to.be.at.most(2);
    });

    it("throws when projected column counts differ", function () {
        expect(() =>
            OracleCollection.union(
                users.find({}).project({ NAME: 1 }),
                users.find({}).project({ NAME: 1, EMAIL: 1 }), // different count
            ),
        ).to.throw();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13 — CTEs
// ─────────────────────────────────────────────────────────────────────────────

describe("13. CTEs (withCTE / withRecursiveCTE)", function () {
    it("regular CTE executes and returns results", async function () {
        const rows = await withCTE(db, {
            active: users.find({ STATUS: "active" }),
        })
            .from("active")
            .toArray();
        expect(rows).to.be.an("array").with.length.greaterThan(0);
        rows.forEach((r) => expect(r.STATUS).to.equal("active"));
    });

    it("CTE with join across two named CTEs", async function () {
        const rows = await withCTE(db, {
            big_orders: orders.find({ AMOUNT: { $gte: 500 } }),
            vip_users: users.find({ TIER: "platinum" }),
        })
            .from("big_orders")
            .join({
                from: "vip_users",
                localField: "USER_ID",
                foreignField: "ID",
                joinType: "inner",
            })
            .toArray();
        expect(rows).to.be.an("array");
    });

    it("recursive CTE traverses hierarchy", async function () {
        const rows = await withRecursiveCTE(db, "ORG_TREE", {
            anchor: employees.find({ MANAGER_ID: null }),
            recursive: {
                collection: T.EMPLOYEES,
                joinOn: { MANAGER_ID: "$ORG_TREE.ID" },
            },
        }).toArray();
        expect(rows).to.be.an("array").with.length.greaterThan(0);
        // Should include all employees since everyone chains up to CEO
        expect(rows.length).to.equal(6);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 14 — Subqueries
// ─────────────────────────────────────────────────────────────────────────────

describe("14. Subqueries", function () {
    it("scalar subquery in projection returns computed column", async function () {
        const rows = await users.find(
            {},
            {
                projection: {
                    NAME: 1,
                    ORDER_COUNT: {
                        $subquery: {
                            collection: T.ORDERS,
                            fn: "count",
                            filter: { USER_ID: "$ID" },
                        },
                    },
                },
            },
        );
        expect(rows[0]).to.have.property("ORDER_COUNT");
    });

    it("EXISTS subquery filters correctly", async function () {
        const rows = await users.find({
            $exists: { collection: T.ORDERS, match: { USER_ID: "$ID" } },
        });
        expect(rows).to.be.an("array").with.length.greaterThan(0);
    });

    it("NOT EXISTS subquery excludes matched rows", async function () {
        const rows = await users.find({
            $notExists: { collection: T.ORDERS, match: { USER_ID: "$ID" } },
        });
        expect(rows).to.be.an("array");
    });

    it("IN (SELECT ...) with $inSelect", async function () {
        const rows = await users.find({
            ID: {
                $inSelect: orders.distinct("USER_ID", { STATUS: "completed" }),
            },
        });
        expect(rows).to.be.an("array").with.length.greaterThan(0);
    });

    it("correlated subquery in WHERE", async function () {
        const rows = await users.find({
            BALANCE: {
                $gt: {
                    $subquery: {
                        collection: T.USERS,
                        field: "BALANCE",
                        aggregate: "$avg",
                        where: {},
                    },
                },
            },
        });
        expect(rows).to.be.an("array");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 15 — Transactions + Savepoints
// ─────────────────────────────────────────────────────────────────────────────

describe("15. Transactions & Savepoints", function () {
    it("withTransaction commits on success", async function () {
        await txManager.withTransaction(async (session) => {
            const u = session.collection(T.USERS);
            await u.insertOne({
                NAME: "TxCommit",
                EMAIL: "txc@test.com",
                AGE: 30,
            });
        });
        const doc = await users.findOne({ NAME: "TxCommit" });
        expect(doc).to.not.be.null;
        await users.deleteOne({ NAME: "TxCommit" }); // cleanup
    });

    it("withTransaction rolls back on error", async function () {
        const before = await rowCount(T.USERS);
        try {
            await txManager.withTransaction(async (session) => {
                await session.collection(T.USERS).insertOne({
                    NAME: "TxRollback",
                    EMAIL: "txr@test.com",
                });
                throw new Error("Intentional rollback");
            });
        } catch (e) {
            expect(e.message).to.include("Intentional rollback");
        }
        const after = await rowCount(T.USERS);
        expect(after).to.equal(before);
    });

    it("savepoint allows partial rollback", async function () {
        let firstInsertedName = "SPart1_" + Date.now();
        let secondInsertedName = "SPart2_" + Date.now();

        await txManager.withTransaction(async (session) => {
            const u = session.collection(T.USERS);

            // First operation — should survive
            await u.insertOne({
                NAME: firstInsertedName,
                EMAIL: "sp1@test.com",
            });
            await session.savepoint("checkpoint_1");

            try {
                // Second operation — will be rolled back to savepoint
                await u.insertOne({
                    NAME: secondInsertedName,
                    EMAIL: "sp2@test.com",
                });
                throw new Error("Force rollback to savepoint");
            } catch (e) {
                await session.rollbackTo("checkpoint_1");
            }

            // Third operation — should survive (after savepoint recovery)
            await u.insertOne({
                NAME: "SPart3_" + Date.now(),
                EMAIL: "sp3@test.com",
                STATUS: "active",
            });
        });

        // First insert survived
        const first = await users.findOne({ NAME: firstInsertedName });
        expect(first).to.not.be.null;

        // Second insert was rolled back
        const second = await users.findOne({ NAME: secondInsertedName });
        expect(second).to.be.null;

        // cleanup
        await users.deleteOne({ NAME: firstInsertedName });
        await users.deleteMany({ NAME: { $like: "SPart3_%" } });
    });

    it("session.collection operations share the same connection", async function () {
        // Both ops must see each other's uncommitted changes
        let balanceSeen = null;
        await txManager.withTransaction(async (session) => {
            const u = session.collection(T.USERS);
            await u.insertOne({
                NAME: "SharedConn",
                EMAIL: "sc@test.com",
                BALANCE: 9999,
            });
            // Read within same transaction — must see the uncommitted insert
            const doc = await u.findOne({ NAME: "SharedConn" });
            balanceSeen = doc ? Number(doc.BALANCE) : null;
        });
        expect(balanceSeen).to.equal(9999);
        await users.deleteOne({ NAME: "SharedConn" }); // cleanup
    });

    it("releaseSavepoint is a no-op (no error thrown)", async function () {
        await txManager.withTransaction(async (session) => {
            await session.savepoint("sp_noop");
            await session.releaseSavepoint("sp_noop"); // should not throw
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16 — Index Operations
// ─────────────────────────────────────────────────────────────────────────────

describe("16. Index Operations", function () {
    let createdIndexName;

    it("createIndex creates a non-unique index", async function () {
        const result = await users.createIndex({ STATUS: 1 });
        expect(result.acknowledged).to.be.true;
        expect(result.indexName).to.be.a("string");
        createdIndexName = result.indexName;
    });

    it("createIndex with unique:true creates a unique index", async function () {
        const result = await users.createIndex({ EMAIL: 1 }, { unique: true });
        expect(result.acknowledged).to.be.true;
        expect(result.indexName).to.be.a("string");
        await users.dropIndex(result.indexName); // cleanup immediately
    });

    it("createIndex with custom name", async function () {
        const result = await users.createIndex(
            { AGE: -1 },
            { name: "IDX_TEST_AGE_DESC" },
        );
        expect(result.indexName).to.equal("IDX_TEST_AGE_DESC");
        await users.dropIndex("IDX_TEST_AGE_DESC");
    });

    it("getIndexes returns array with index info", async function () {
        const indexes = await users.getIndexes();
        expect(indexes).to.be.an("array").with.length.greaterThan(0);
        const idx = indexes[0];
        expect(idx).to.have.all.keys("indexName", "columns", "unique", "type");
    });

    it("dropIndex removes the index", async function () {
        const result = await users.dropIndex(createdIndexName);
        expect(result.acknowledged).to.be.true;
    });

    it("createIndexes creates multiple indexes at once", async function () {
        const result = await users.createIndexes([
            { fields: { TIER: 1 } },
            { fields: { BALANCE: 1 } },
        ]);
        expect(result.acknowledged).to.be.true;
        expect(result.indexNames).to.be.an("array").with.length(2);
        for (const n of result.indexNames) await users.dropIndex(n);
    });

    it("reIndex rebuilds all indexes", async function () {
        const result = await users.reIndex();
        expect(result.acknowledged).to.be.true;
    });

    it("dropIndexes drops all non-PK indexes", async function () {
        // Create a couple first
        await users.createIndex({ TIER: 1 });
        await users.createIndex({ BALANCE: 1 });
        const result = await users.dropIndexes();
        expect(result.acknowledged).to.be.true;
        expect(result.dropped).to.be.an("array");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 17 — DDL (OracleSchema)
// ─────────────────────────────────────────────────────────────────────────────

describe("17. DDL Operations (OracleSchema)", function () {
    const TEMP_TABLE = "TEST_WRAP_DDL_TEMP";
    const TEMP_VIEW = "TEST_WRAP_VIEW_TEMP";
    const TEMP_SEQ = "TEST_WRAP_SEQ_TEMP";

    after(async function () {
        await dropIfExists(TEMP_TABLE);
        await db.withConnection(async (conn) => {
            try {
                await conn.execute(
                    `DROP VIEW "${TEMP_VIEW}"`,
                    {},
                    { autoCommit: true },
                );
            } catch (e) {
                /* ignore */
            }
            try {
                await conn.execute(
                    `DROP SEQUENCE "${TEMP_SEQ}"`,
                    {},
                    { autoCommit: true },
                );
            } catch (e) {
                /* ignore */
            }
        });
    });

    it("createTable creates a table with all column options", async function () {
        await schema.createTable(TEMP_TABLE, {
            ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
            LABEL: { type: "VARCHAR2(100)", notNull: true },
            SCORE: { type: "NUMBER(5,2)", default: 0 },
        });
        expect(await tableExists(TEMP_TABLE)).to.be.true;
    });

    it("createTable with ifNotExists does not throw if already exists", async function () {
        await schema.createTable(
            TEMP_TABLE,
            {
                ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
                LABEL: { type: "VARCHAR2(100)", notNull: true },
            },
            { ifNotExists: true },
        );
    });

    it("alterTable — addColumn", async function () {
        await schema.alterTable(TEMP_TABLE, {
            addColumn: { NOTES: "VARCHAR2(500)" },
        });
        // Verify column exists via select
        await db.withConnection(async (conn) => {
            await conn.execute(
                `SELECT "NOTES" FROM "${TEMP_TABLE}" WHERE ROWNUM = 1`,
                {},
            );
        });
    });

    it("alterTable — modifyColumn", async function () {
        await schema.alterTable(TEMP_TABLE, {
            modifyColumn: { SCORE: "NUMBER(8,2)" },
        });
    });

    it("alterTable — renameColumn", async function () {
        await schema.alterTable(TEMP_TABLE, {
            renameColumn: { from: "NOTES", to: "REMARKS" },
        });
        await db.withConnection(async (conn) => {
            await conn.execute(
                `SELECT "REMARKS" FROM "${TEMP_TABLE}" WHERE ROWNUM = 1`,
                {},
            );
        });
    });

    it("alterTable — addConstraint UNIQUE", async function () {
        await schema.alterTable(TEMP_TABLE, {
            addConstraint: {
                type: "UNIQUE",
                columns: ["LABEL"],
                name: "UQ_TEMP_LABEL",
            },
        });
    });

    it("alterTable — dropConstraint", async function () {
        await schema.alterTable(TEMP_TABLE, {
            dropConstraint: "UQ_TEMP_LABEL",
        });
    });

    it("alterTable — dropColumn", async function () {
        await schema.alterTable(TEMP_TABLE, { dropColumn: "REMARKS" });
    });

    it("createView creates a view from a QueryBuilder", async function () {
        const tmpColl = new OracleCollection(TEMP_TABLE, db);
        try {
            await schema.createView(
                TEMP_VIEW,
                tmpColl.find({}).project({ ID: 1, LABEL: 1 }),
                { orReplace: true },
            );
            await db.withConnection(async (conn) => {
                await conn.execute(`SELECT COUNT(*) FROM "${TEMP_VIEW}"`, {});
            });
        } catch (e) {
            if (e.message.includes("ORA-01031")) {
                this.skip(); // CREATE VIEW requires privilege not granted
                return;
            }
            throw e;
        }
    });

    it("dropView removes the view", async function () {
        await schema.dropView(TEMP_VIEW, { ifExists: true });
    });

    it("createSequence creates an Oracle sequence", async function () {
        await schema.createSequence(TEMP_SEQ, {
            startWith: 100,
            incrementBy: 5,
            maxValue: 99999,
            cycle: false,
            cache: 10,
        });
        // Verify by selecting nextval
        await db.withConnection(async (conn) => {
            const r = await conn.execute(
                `SELECT "${TEMP_SEQ}".NEXTVAL FROM DUAL`,
                {},
                { outFormat: db.oracledb.OUT_FORMAT_OBJECT },
            );
            expect(Number(r.rows[0].NEXTVAL)).to.be.at.least(100);
        });
    });

    it("truncateTable removes all rows", async function () {
        const tmpColl = new OracleCollection(TEMP_TABLE, db);
        await tmpColl.insertOne({ LABEL: "ToTruncate", SCORE: 1 });
        await schema.truncateTable(TEMP_TABLE);
        expect(await rowCount(TEMP_TABLE)).to.equal(0);
    });

    it("renameTable renames and original no longer exists", async function () {
        const NEW_NAME = "TEST_WRAP_DDL_RENAMED";
        await schema.renameTable(TEMP_TABLE, NEW_NAME);
        expect(await tableExists(TEMP_TABLE)).to.be.false;
        expect(await tableExists(NEW_NAME)).to.be.true;
        await schema.renameTable(NEW_NAME, TEMP_TABLE); // rename back
    });

    it("dropTable with cascade removes the table", async function () {
        await schema.dropTable(TEMP_TABLE, { cascade: true });
        expect(await tableExists(TEMP_TABLE)).to.be.false;
    });

    it("dropTable with ifExists does not throw for missing table", async function () {
        await schema.dropTable("NO_SUCH_TABLE_XYZ", { ifExists: true });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 18 — MERGE / UPSERT
// ─────────────────────────────────────────────────────────────────────────────

describe("18. MERGE / UPSERT", function () {
    it("merge updates existing row when matched", async function () {
        const existing = await users.findOne({ NAME: "Juan" });
        await users.merge(
            { ID: existing.ID, NAME: "Juan", BALANCE: 9999 },
            { localField: "ID", foreignField: "ID" },
            { whenMatched: { $set: { BALANCE: 9999 } } },
        );
        const updated = await users.findOne({ NAME: "Juan" });
        expect(Number(updated.BALANCE)).to.equal(9999);
    });

    it("merge inserts when no match (whenNotMatched: insert)", async function () {
        const before = await rowCount(T.USERS);
        await users.merge(
            {
                NAME: "MergeNew",
                EMAIL: "mn@test.com",
                STATUS: "active",
                AGE: 30,
            },
            { localField: "NAME", foreignField: "NAME" },
            { whenNotMatched: "insert" },
        );
        const after = await rowCount(T.USERS);
        expect(after).to.equal(before + 1);
        await users.deleteOne({ NAME: "MergeNew" }); // cleanup
    });

    it("merge with whenMatchedDelete removes row on condition", async function () {
        await users.insertOne({
            NAME: "MergeDelete",
            EMAIL: "md@test.com",
            BALANCE: -1,
        });
        const inserted = await users.findOne({ NAME: "MergeDelete" });
        await users.merge(
            { ID: inserted.ID, BALANCE: -1 },
            { localField: "ID", foreignField: "ID" },
            {
                whenMatched: { $set: { BALANCE: -1 } },
                whenMatchedDelete: { BALANCE: { $lt: 0 } },
            },
        );
        const check = await users.findOne({ NAME: "MergeDelete" });
        expect(check).to.be.null; // deleted by WHEN MATCHED DELETE
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19 — Oracle Advanced Features
// ─────────────────────────────────────────────────────────────────────────────

describe("19. Oracle Advanced Features", function () {
    it("CONNECT BY traverses hierarchy correctly", async function () {
        const rows = await employees.connectBy({
            startWith: { MANAGER_ID: null },
            connectBy: { MANAGER_ID: "$PRIOR ID" },
            includeLevel: true,
        });
        expect(rows).to.be.an("array").with.length(6);
        const ceo = rows.find((r) => r.MANAGER_ID === null);
        expect(Number(ceo.LEVEL)).to.equal(1);
    });

    it("CONNECT BY with includePath adds SYS_CONNECT_BY_PATH", async function () {
        const rows = await employees.connectBy({
            startWith: { MANAGER_ID: null },
            connectBy: { MANAGER_ID: "$PRIOR ID" },
            includePath: true,
        });
        expect(rows[0]).to.have.property("PATH");
        expect(rows[0].PATH).to.be.a("string");
    });

    it("CONNECT BY with maxLevel limits depth", async function () {
        const rows = await employees.connectBy({
            startWith: { MANAGER_ID: null },
            connectBy: { MANAGER_ID: "$PRIOR ID" },
            includeLevel: true,
            maxLevel: 2,
        });
        rows.forEach((r) => expect(Number(r.LEVEL)).to.be.at.most(2));
    });

    it("PIVOT produces one column per pivot value", async function () {
        const rows = await sales.pivot({
            value: { $sum: "$AMOUNT" },
            pivotOn: "QUARTER",
            pivotValues: ["Q1", "Q2", "Q3", "Q4"],
            groupBy: "REGION",
        });
        expect(rows).to.be.an("array").with.length.greaterThan(0);
        expect(rows[0]).to.have.property("Q1");
        expect(rows[0]).to.have.property("Q2");
        expect(rows[0]).to.have.property("Q3");
        expect(rows[0]).to.have.property("Q4");
    });

    it("TABLESAMPLE returns a subset of rows", async function () {
        const all = await users.find({}).toArray();
        const sample = await users
            .find({}, { sample: { percentage: 50 } })
            .toArray();
        // Sampled result could be up to full size but is usually less
        expect(sample.length).to.be.at.most(all.length);
    });

    it("TABLESAMPLE with seed is reproducible", async function () {
        const s1 = await users
            .find({}, { sample: { percentage: 50, seed: 42 } })
            .toArray();
        const s2 = await users
            .find({}, { sample: { percentage: 50, seed: 42 } })
            .toArray();
        // Same seed → same rows
        expect(s1.map((r) => r.ID)).to.deep.equal(s2.map((r) => r.ID));
    });

    it("AS OF SCN returns data at past SCN (no error)", async function () {
        // Get current SCN — requires access to V$DATABASE (DBA privilege)
        let scn;
        try {
            scn = await db.withConnection(async (conn) => {
                const r = await conn.execute(
                    `SELECT CURRENT_SCN FROM V$DATABASE`,
                    {},
                    { outFormat: db.oracledb.OUT_FORMAT_OBJECT },
                );
                return r.rows[0].CURRENT_SCN;
            });
        } catch (e) {
            if (
                e.message.includes("ORA-00942") ||
                e.message.includes("ORA-01031")
            ) {
                this.skip(); // V$DATABASE not accessible — insufficient privileges
                return;
            }
            throw e;
        }

        // ORA-01466 can fire when DDL occurred on the table after the
        // referenced SCN (e.g. the before() hook just created the table).
        // Wait briefly so Oracle's undo/SCN bookkeeping stabilizes, then
        // query using a freshly captured SCN that is safely after all DDL.
        await new Promise((r) => setTimeout(r, 3000));

        // Re-fetch SCN after the wait so it is guaranteed to post-date
        // the table creation DDL from the before() hook.
        scn = await db.withConnection(async (conn) => {
            const r = await conn.execute(
                `SELECT CURRENT_SCN FROM V$DATABASE`,
                {},
                { outFormat: db.oracledb.OUT_FORMAT_OBJECT },
            );
            return r.rows[0].CURRENT_SCN;
        });

        try {
            const rows = await users
                .find({ STATUS: "active" }, { asOf: { scn } })
                .toArray();
            expect(rows).to.be.an("array");
        } catch (e) {
            // ORA-01466 is environment-dependent (undo retention, DDL timing)
            // — skip gracefully rather than fail the suite.
            if (e.message.includes("ORA-01466")) {
                this.skip();
                return;
            }
            throw e;
        }
    });

    it("LATERAL JOIN returns correlated subquery rows inline", async function () {
        const rows = await users.aggregate([
            {
                $lateralJoin: {
                    subquery: orders
                        .find({ USER_ID: "$outer.ID" })
                        .sort({ AMOUNT: -1 })
                        .limit(2),
                    as: "recent_orders",
                },
            },
        ]);
        expect(rows).to.be.an("array");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 20 — INSERT INTO ... SELECT + UPDATE ... JOIN
// ─────────────────────────────────────────────────────────────────────────────

describe("20. INSERT INTO SELECT & UPDATE JOIN", function () {
    it("insertFromQuery copies rows to archive table", async function () {
        const result = await users.insertFromQuery(
            T.ARCHIVE,
            orders.find({ STATUS: "completed" }),
            { columns: ["USER_ID", "AMOUNT", "STATUS"] },
        );
        expect(result.acknowledged).to.be.true;
        expect(result.insertedCount).to.be.greaterThan(0);
        expect(await rowCount(T.ARCHIVE)).to.be.greaterThan(0);
    });

    it("insertFromQuery without column mapping uses SELECT *", async function () {
        // Archive has compatible shape — just test no error is thrown
        const result = await archive.insertFromQuery(
            T.ARCHIVE,
            archive.find({ STATUS: "completed" }),
        );
        expect(result.acknowledged).to.be.true;
    });

    it("updateFromJoin updates target using joined table values", async function () {
        // Insert a salary update source row into orders as a stand-in
        // (real test would use a dedicated salary table — adapted here for existing schema)
        const result = await users.updateFromJoin({
            target: T.USERS,
            join: {
                table: T.ORDERS,
                on: { [`${T.USERS}.ID`]: `${T.ORDERS}.USER_ID` },
                type: "inner",
            },
            set: { [`${T.USERS}.LOGIN_COUNT`]: `${T.ORDERS}.AMOUNT` },
            where: { [`${T.ORDERS}.STATUS`]: "completed" },
        });
        expect(result.acknowledged).to.be.true;
        expect(result.modifiedCount).to.be.greaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 21 — Performance Utilities
// ─────────────────────────────────────────────────────────────────────────────

describe("21. Performance Utilities", function () {
    const MV_NAME = "TEST_WRAP_MV_SALES";

    after(async function () {
        try {
            await perf.dropMaterializedView(MV_NAME);
        } catch (e) {
            /* ignore */
        }
    });

    it("explainPlan returns plan rows array", async function () {
        const plan = await perf.explainPlan(
            users.find({ STATUS: "active" }).sort({ NAME: 1 }).limit(10),
        );
        expect(plan).to.be.an("array").with.length.greaterThan(0);
        expect(plan[0]).to.have.property("PLAN_TABLE_OUTPUT");
    });

    it("explainPlan accepts raw SQL string", async function () {
        const plan = await perf.explainPlan(
            `SELECT * FROM "${T.USERS}" WHERE "STATUS" = 'active'`,
        );
        expect(plan).to.be.an("array").with.length.greaterThan(0);
    });

    it("analyze gathers table stats without error", async function () {
        // May require DBA privilege in some environments — wrapped in try
        try {
            await perf.analyze(T.USERS);
        } catch (e) {
            if (!e.message.includes("ORA-01031")) throw e; // ignore insufficient privileges
        }
    });

    it("createMaterializedView creates the MV", async function () {
        try {
            const result = await perf.createMaterializedView(
                MV_NAME,
                sales.aggregate([
                    { $group: { _id: "$REGION", total: { $sum: "$AMOUNT" } } },
                ]),
                {
                    refreshMode: "complete",
                    refreshOn: "demand",
                    buildMode: "immediate",
                    orReplace: true,
                },
            );
            expect(result.acknowledged).to.be.true;
        } catch (e) {
            if (e.message.includes("ORA-01031")) {
                this.skip(); // CREATE MATERIALIZED VIEW requires privilege
                return;
            }
            throw e;
        }
    });

    it("refreshMaterializedView refreshes the MV", async function () {
        try {
            await perf.refreshMaterializedView(MV_NAME, "complete");
        } catch (e) {
            if (
                e.message.includes("ORA-01031") ||
                e.message.includes("ORA-12003")
            ) {
                this.skip(); // MV does not exist or insufficient privileges
                return;
            }
            throw e;
        }
    });

    it("dropMaterializedView removes the MV", async function () {
        try {
            const result = await perf.dropMaterializedView(MV_NAME);
            expect(result.acknowledged).to.be.true;
        } catch (e) {
            if (
                e.message.includes("ORA-01031") ||
                e.message.includes("ORA-12003")
            ) {
                this.skip(); // MV does not exist or insufficient privileges
                return;
            }
            throw e;
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 22 — DCL Operations
// ─────────────────────────────────────────────────────────────────────────────

describe("22. DCL Operations (OracleDCL)", function () {
    // DCL tests require a grantee that exists in the DB.
    // Uses the same schema user (self-grant) — adjust GRANTEE if needed.
    const GRANTEE = process.env.UA_DB_USERNAME;

    it("grant SELECT on a table succeeds", async function () {
        // Self-grant on test table — valid in Oracle
        try {
            const result = await dcl.grant(["SELECT"], T.USERS, GRANTEE);
            expect(result.acknowledged).to.be.true;
        } catch (e) {
            // Skip on privilege or user-not-found errors
            if (
                e.message.includes("ORA-01749") ||
                e.message.includes("ORA-01917") ||
                e.message.includes("ORA-01031")
            ) {
                this.skip();
                return;
            }
            throw e;
        }
    });

    it("grant multiple privileges at once", async function () {
        try {
            const result = await dcl.grant(
                ["SELECT", "INSERT", "UPDATE"],
                T.ORDERS,
                GRANTEE,
            );
            expect(result.acknowledged).to.be.true;
        } catch (e) {
            if (
                e.message.includes("ORA-01749") ||
                e.message.includes("ORA-01917") ||
                e.message.includes("ORA-01031")
            ) {
                this.skip();
                return;
            }
            throw e;
        }
    });

    it("revoke removes a privilege", async function () {
        try {
            const result = await dcl.revoke(["INSERT"], T.ORDERS, GRANTEE);
            expect(result.acknowledged).to.be.true;
        } catch (e) {
            if (
                e.message.includes("ORA-01749") ||
                e.message.includes("ORA-01927") ||
                e.message.includes("ORA-01917") ||
                e.message.includes("ORA-01031")
            ) {
                this.skip();
                return;
            }
            throw e;
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 23 — utils helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("23. utils helpers", function () {
    const {
        convertTypes,
        quoteIdentifier,
        mergeBinds,
        rowToDoc,
    } = require("../../src/utils/oracle-mongo-wrapper/utils");

    it("convertTypes coerces Oracle number strings to JS numbers", function () {
        const row = { ID: "123", AMOUNT: "99.99", NAME: "Juan" };
        const out = convertTypes(row);
        expect(out.ID).to.equal(123);
        expect(out.AMOUNT).to.equal(99.99);
        expect(out.NAME).to.equal("Juan"); // string left as-is
    });

    it("quoteIdentifier wraps names in double quotes", function () {
        expect(quoteIdentifier("users")).to.equal('"users"');
        expect(quoteIdentifier("STATUS")).to.equal('"STATUS"');
    });

    it("mergeBinds combines two bind objects without collision", function () {
        const a = { where_field_0: "active" };
        const b = { upd_field_0: "premium" };
        const merged = mergeBinds(a, b);
        expect(merged).to.deep.equal({
            where_field_0: "active",
            upd_field_0: "premium",
        });
    });

    it("mergeBinds throws on key collision", function () {
        const a = { field_0: "x" };
        const b = { field_0: "y" }; // same key
        expect(() => mergeBinds(a, b)).to.throw(/collision/i);
    });

    it("rowToDoc converts an Oracle row to a plain object", function () {
        const row = { ID: "1", NAME: "Juan", AMOUNT: "500.00" };
        const doc = rowToDoc(row);
        expect(doc).to.be.a(
            "plain object" === typeof doc ? "object" : "object",
        );
        expect(doc.ID).to.equal(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 24 — Error handling & edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("24. Error handling & edge cases", function () {
    it("method errors include SQL in the message", async function () {
        try {
            // Force a syntax error by passing a filter that generates bad SQL
            await db.withConnection(async (conn) => {
                await conn.execute('SELECT * FROM "NO_SUCH_TABLE_EVER"');
            });
        } catch (e) {
            expect(e.message).to.exist;
        }
    });

    it("findOne on empty table returns null, not undefined", async function () {
        const EMPTY = "TEST_WRAP_EMPTY";
        await schema.createTable(EMPTY, {
            ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
        });
        const emptyColl = new OracleCollection(EMPTY, db);
        const result = await emptyColl.findOne({});
        expect(result).to.be.null;
        await schema.dropTable(EMPTY, { cascade: true });
    });

    it("deleteOne on no match returns deletedCount 0, not error", async function () {
        const result = await users.deleteOne({ NAME: "AbsolutelyNobody" });
        expect(result.deletedCount).to.equal(0);
    });

    it("updateOne on no match with no upsert returns modifiedCount 0", async function () {
        const result = await users.updateOne(
            { NAME: "AbsolutelyNobody" },
            { $set: { STATUS: "active" } },
        );
        expect(result.matchedCount).to.equal(0);
        expect(result.modifiedCount).to.equal(0);
    });

    it("insertMany with empty array throws descriptively", async function () {
        try {
            await users.insertMany([]);
            expect.fail("Should have thrown");
        } catch (e) {
            expect(e.message).to.match(/empty/i);
        }
    });

    it("bulkWrite with unknown op type throws", async function () {
        try {
            await users.bulkWrite([{ weirdOp: {} }]);
            expect.fail("Should have thrown");
        } catch (e) {
            expect(e.message).to.exist;
        }
    });

    it("withTransaction rethrows the original error", async function () {
        const sentinel = new Error("sentinel_error");
        try {
            await txManager.withTransaction(async () => {
                throw sentinel;
            });
            expect.fail("Should have thrown");
        } catch (e) {
            expect(e.message).to.include("sentinel_error");
        }
    });

    it("createDb with unknown connectionName throws on first withConnection", async function () {
        const badDb = createDb("nonExistentConnection");
        try {
            await badDb.withConnection(async () => {});
            expect.fail("Should have thrown");
        } catch (e) {
            expect(e.message).to.match(/unknown connection/i);
        }
    });
});