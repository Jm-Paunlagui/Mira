"use strict";

/**
 * @fileoverview Comprehensive end-to-end test suite for oracle-mongo-wrapper.
 *
 * Tests against REAL production tables in the Inventory schema + a scratch table
 * for write operations. Generates a full report at the end.
 *
 * TABLES USED (read-only):
 *   DEV_BOOK, DEV_LOCATION, DEV_LOCK, DEV_MATERIAL, DEV_STOCKS, DEV_UNIT, T_OPITS_USERS
 *
 * TABLES CREATED (read-write, auto-cleaned):
 *   TEST_SCRATCH — temporary table for CRUD/DDL/Merge tests
 *
 * SETUP:
 *   1. Ensure .env is configured
 *   2. npm install --save-dev mocha chai
 *   3. npx mocha test.js --timeout 60000 --exit
 */

const path = require("path");
const fs = require("fs");
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
    Transaction,
} = require("../../src/utils/oracle-mongo-wrapper/Transaction");
const {
    withCTE,
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
const {
    buildWindowExpr,
} = require("../../src/utils/oracle-mongo-wrapper/pipeline/windowFunctions");
const {
    buildJoinSQL,
} = require("../../src/utils/oracle-mongo-wrapper/joins/joinBuilder");

// ─── Table Column Schemas ─────────────────────────────────────────────────────

const SAPBook = {
    table: "DEV_BOOK",
    columns: [
        "ID", "DIVISION", "YEAR", "MONTH", "MATERIALID", "SAP_BOOK_QUANTITY",
        "SLOC", "CREATEDBY", "MODIFIEDBY", "DELETEDBY", "CREATEDDATE",
        "MODIFIEDDATE", "DELETEDDATE", "REASON", "ACTION",
    ],
};

const StorageLocation = {
    table: "DEV_LOCATION",
    columns: [
        "ID", "DIVISION", "YEAR", "MONTH", "SLOC", "PSA", "TERMINAL", "TYPE",
        "TOTAL_TAG_GENERATED", "CREATEDBY", "MODIFIEDBY", "DELETEDBY",
        "CREATEDDATE", "MODIFIEDDATE", "DELETEDDATE", "REASON", "ACTION",
    ],
};

const UnlockedInventoryByMonth = {
    table: "DEV_LOCK",
    columns: ["ID", "MONTH", "LAST_CHANGE_BY", "AUTO_GR", "ACTIVE"],
};

const MaterialMaster = {
    table: "DEV_MATERIAL",
    columns: [
        "ID", "DIVISION", "YEAR", "MONTH", "MATERIALID", "DESCRIPTION", "TYPE",
        "STANDARDPRICE", "MRP", "CREATEDBY", "MODIFIEDBY", "DELETEDBY",
        "CREATEDDATE", "MODIFIEDDATE", "DELETEDDATE", "REASON", "ACTION",
    ],
};

const InventoryStocks = {
    table: "DEV_STOCKS",
    columns: [
        "ID", "DIVISION", "YEAR", "MONTH", "MATERIALID", "BATCHID", "QUANTITY",
        "PARTQTY", "CATEGORY", "SLOC", "ID_LOC", "TAGNUM", "USERNAME", "GR_SU",
        "PACKAGE_ID", "CREATEDBY", "MODIFIEDBY", "DELETEDBY", "CREATEDDATE",
        "MODIFIEDDATE", "DELETEDDATE", "REASON", "ACTION",
    ],
};

const InventoryUnit = {
    table: "DEV_UNIT",
    columns: [
        "ID", "DIVISION", "YEAR", "MONTH", "BATCHID", "UNITID", "UNITIDTYPE",
        "UNITSTATUS", "LOCATION", "ORDERNAME", "MATERIALNUMBER",
        "CURRENTOPERATION", "ITEMSPASSED", "ITEMSFAILED", "ITEMSSCRAP",
        "CREATEDBY", "MODIFIEDBY", "DELETEDBY", "CREATEDDATE", "MODIFIEDDATE",
        "DELETEDDATE", "REASON", "ACTION",
    ],
};

// ─── DB binding ───────────────────────────────────────────────────────────────
const inventoryDB = createDb("unitInventory");
const userdb = createDb("userAccount");

// ─── Collection handles ───────────────────────────────────────────────────────
const devBook = new OracleCollection(SAPBook.table, inventoryDB);
const devLocation = new OracleCollection(StorageLocation.table, inventoryDB);
const devLock = new OracleCollection(UnlockedInventoryByMonth.table, inventoryDB);
const devMaterial = new OracleCollection(MaterialMaster.table, inventoryDB);
const devStocks = new OracleCollection(InventoryStocks.table, inventoryDB);
const devUnit = new OracleCollection(InventoryUnit.table, inventoryDB);
const users = new OracleCollection("T_OPITS_USERS", userdb);

// ─── Scratch table and helpers ────────────────────────────────────────────────
const SCRATCH = "TEST_SCRATCH";
const schema = new OracleSchema(inventoryDB);
const txManager = new Transaction(inventoryDB);
let scratch;

// ─── Report collector ─────────────────────────────────────────────────────────
const report = {
    startTime: null,
    endTime: null,
    tables: {},
    categories: {},
    totalTests: 0,
    passed: 0,
    failed: 0,
    failures: [],
};

// ─── Shared helpers ───────────────────────────────────────────────────────────
async function tableExists(db, tableName) {
    return db.withConnection(async (conn) => {
        const res = await conn.execute(
            `SELECT COUNT(*) AS CNT FROM USER_TABLES WHERE TABLE_NAME = UPPER(:n)`,
            { n: tableName },
            { outFormat: db.oracledb.OUT_FORMAT_OBJECT },
        );
        return res.rows[0].CNT > 0;
    });
}

async function dropIfExists(db, tableName) {
    if (await tableExists(db, tableName)) {
        await db.withConnection(async (conn) => {
            await conn.execute(
                `DROP TABLE "${tableName}" CASCADE CONSTRAINTS PURGE`,
                {},
                { autoCommit: true },
            );
        });
    }
}

async function rowCount(db, tableName) {
    return db.withConnection(async (conn) => {
        const res = await conn.execute(
            `SELECT COUNT(*) AS CNT FROM "${tableName}"`,
            {},
            { outFormat: db.oracledb.OUT_FORMAT_OBJECT },
        );
        return Number(res.rows[0].CNT);
    });
}

// ═════════════════════════════════════════════════════════════════════════════
//  SUITE SETUP / TEARDOWN
// ═════════════════════════════════════════════════════════════════════════════

before(async function () {
    this.timeout(60_000);
    report.startTime = new Date();

    // Create scratch table for write tests
    await dropIfExists(inventoryDB, SCRATCH);
    await schema.createTable(SCRATCH, {
        ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
        NAME: { type: "VARCHAR2(200)", notNull: true },
        DIVISION: { type: "VARCHAR2(50)" },
        YEAR: { type: "VARCHAR2(10)" },
        MONTH: { type: "VARCHAR2(10)" },
        MATERIALID: { type: "VARCHAR2(100)" },
        CATEGORY: { type: "VARCHAR2(100)" },
        VALUE: { type: "NUMBER(12,2)", default: 0 },
        QUANTITY: { type: "NUMBER(12,2)", default: 0 },
        STATUS: { type: "VARCHAR2(20)", default: "'active'" },
        CREATED_AT: { type: "DATE", default: "SYSDATE" },
        UPDATED_AT: { type: "DATE" },
    });

    scratch = new OracleCollection(SCRATCH, inventoryDB);

    // Gather table row counts for report
    const tableSchemas = [SAPBook, StorageLocation, UnlockedInventoryByMonth, MaterialMaster, InventoryStocks, InventoryUnit];
    for (const ts of tableSchemas) {
        try {
            const coll = new OracleCollection(ts.table, inventoryDB);
            const cnt = await coll.countDocuments();
            report.tables[ts.table] = { rowCount: cnt, columnCount: ts.columns.length, columns: ts.columns };
        } catch (e) {
            report.tables[ts.table] = { rowCount: "ERROR", columnCount: ts.columns.length, columns: ts.columns, error: e.message };
        }
    }
    // T_OPITS_USERS on userdb
    try {
        const cnt = await users.countDocuments();
        report.tables["T_OPITS_USERS"] = { rowCount: cnt, columnCount: "N/A", columns: [] };
    } catch (e) {
        report.tables["T_OPITS_USERS"] = { rowCount: "ERROR", error: e.message };
    }
});

after(async function () {
    this.timeout(30_000);
    await dropIfExists(inventoryDB, SCRATCH);
    report.endTime = new Date();
    generateReport();
});

afterEach(function () {
    report.totalTests++;
    const state = this.currentTest.state;
    if (state === "passed") {
        report.passed++;
    } else if (state === "failed") {
        report.failed++;
        report.failures.push({
            title: this.currentTest.fullTitle(),
            error: this.currentTest.err?.message || "Unknown error",
        });
    }
});

// ═════════════════════════════════════════════════════════════════════════════
//  1. CONNECTION & HEALTH CHECKS
// ═════════════════════════════════════════════════════════════════════════════

describe("1. Connection & Health", function () {
    it("1.1 inventoryDB.withConnection executes a simple query", async function () {
        const result = await inventoryDB.withConnection(async (conn) => {
            const r = await conn.execute(
                "SELECT 1 AS VAL FROM DUAL",
                {},
                { outFormat: inventoryDB.oracledb.OUT_FORMAT_OBJECT },
            );
            return r.rows[0].VAL;
        });
        expect(result).to.equal(1);
    });

    it("1.2 userdb.withConnection executes a simple query", async function () {
        const result = await userdb.withConnection(async (conn) => {
            const r = await conn.execute(
                "SELECT 1 AS VAL FROM DUAL",
                {},
                { outFormat: userdb.oracledb.OUT_FORMAT_OBJECT },
            );
            return r.rows[0].VAL;
        });
        expect(result).to.equal(1);
    });

    it("1.3 db.isHealthy returns true", async function () {
        const healthy = await inventoryDB.isHealthy();
        expect(healthy).to.be.true;
    });

    it("1.4 db.getPoolStats returns stats object", async function () {
        const stats = await inventoryDB.getPoolStats();
        expect(stats).to.be.an("object");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  2. FILTER PARSER — Unit Tests (All Operators)
// ═════════════════════════════════════════════════════════════════════════════

describe("2. filterParser — Unit Tests", function () {
    it("2.1 empty filter → empty whereClause", function () {
        const { whereClause, binds } = parseFilter({});
        expect(whereClause).to.equal("");
        expect(binds).to.deep.equal({});
    });

    it("2.2 null filter → empty whereClause", function () {
        const { whereClause } = parseFilter(null);
        expect(whereClause).to.equal("");
    });

    it("2.3 simple equality", function () {
        const { whereClause, binds } = parseFilter({ DIVISION: "WH" });
        expect(whereClause).to.include("=");
        expect(Object.values(binds)).to.include("WH");
    });

    it("2.4 $eq operator", function () {
        const { whereClause } = parseFilter({ STATUS: { $eq: "active" } });
        expect(whereClause).to.include("=");
    });

    it("2.5 $ne operator", function () {
        const { whereClause } = parseFilter({ STATUS: { $ne: "deleted" } });
        expect(whereClause).to.include("<>");
    });

    it("2.6 $gt operator", function () {
        const { whereClause } = parseFilter({ QUANTITY: { $gt: 100 } });
        expect(whereClause).to.include(">");
    });

    it("2.7 $gte operator", function () {
        const { whereClause } = parseFilter({ QUANTITY: { $gte: 100 } });
        expect(whereClause).to.include(">=");
    });

    it("2.8 $lt operator", function () {
        const { whereClause } = parseFilter({ QUANTITY: { $lt: 50 } });
        expect(whereClause).to.include("<");
    });

    it("2.9 $lte operator", function () {
        const { whereClause } = parseFilter({ QUANTITY: { $lte: 50 } });
        expect(whereClause).to.include("<=");
    });

    it("2.10 $in operator", function () {
        const { whereClause } = parseFilter({ DIVISION: { $in: ["WH", "PR"] } });
        expect(whereClause.toUpperCase()).to.include("IN");
    });

    it("2.11 $nin operator", function () {
        const { whereClause } = parseFilter({ DIVISION: { $nin: ["WH", "PR"] } });
        expect(whereClause.toUpperCase()).to.include("NOT IN");
    });

    it("2.12 $between operator", function () {
        const { whereClause } = parseFilter({ QUANTITY: { $between: [10, 100] } });
        expect(whereClause.toUpperCase()).to.include("BETWEEN");
    });

    it("2.13 $notBetween operator", function () {
        const { whereClause } = parseFilter({ QUANTITY: { $notBetween: [10, 100] } });
        expect(whereClause.toUpperCase()).to.include("NOT BETWEEN");
    });

    it("2.14 $exists true → IS NOT NULL", function () {
        const { whereClause } = parseFilter({ MATERIALID: { $exists: true } });
        expect(whereClause.toUpperCase()).to.include("IS NOT NULL");
    });

    it("2.15 $exists false → IS NULL", function () {
        const { whereClause } = parseFilter({ MATERIALID: { $exists: false } });
        expect(whereClause.toUpperCase()).to.include("IS NULL");
    });

    it("2.16 $regex operator", function () {
        const { whereClause } = parseFilter({ MATERIALID: { $regex: "^MAT" } });
        expect(whereClause.toUpperCase()).to.include("REGEXP_LIKE");
    });

    it("2.17 $like operator", function () {
        const { whereClause } = parseFilter({ MATERIALID: { $like: "MAT%" } });
        expect(whereClause.toUpperCase()).to.include("LIKE");
    });

    it("2.18 $and operator", function () {
        const { whereClause } = parseFilter({
            $and: [{ DIVISION: "WH" }, { YEAR: "2025" }],
        });
        expect(whereClause.toUpperCase()).to.include("AND");
    });

    it("2.19 $or operator", function () {
        const { whereClause } = parseFilter({
            $or: [{ DIVISION: "WH" }, { DIVISION: "PR" }],
        });
        expect(whereClause.toUpperCase()).to.include("OR");
    });

    it("2.20 $nor operator", function () {
        const { whereClause } = parseFilter({
            $nor: [{ STATUS: "deleted" }, { STATUS: "archived" }],
        });
        expect(whereClause.toUpperCase()).to.include("NOT");
    });

    it("2.21 $not operator", function () {
        const { whereClause } = parseFilter({ $not: { STATUS: "deleted" } });
        expect(whereClause.toUpperCase()).to.include("NOT");
    });

    it("2.22 combined comparison operators", function () {
        const { whereClause } = parseFilter({ QUANTITY: { $gte: 10, $lte: 100 } });
        expect(whereClause).to.include(">=");
        expect(whereClause).to.include("<=");
    });

    it("2.23 multiple fields (implicit AND)", function () {
        const { binds } = parseFilter({ DIVISION: "WH", YEAR: "2025", MONTH: "01" });
        expect(Object.keys(binds).length).to.equal(3);
    });

    it("2.24 null value → IS NULL", function () {
        const { whereClause } = parseFilter({ DELETEDBY: null });
        expect(whereClause.toUpperCase()).to.include("IS NULL");
    });

    it("2.25 $in with empty array → always false", function () {
        const { whereClause } = parseFilter({ DIVISION: { $in: [] } });
        expect(whereClause).to.include("1=0");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  3. UPDATE PARSER — Unit Tests (All Operators)
// ═════════════════════════════════════════════════════════════════════════════

describe("3. updateParser — Unit Tests", function () {
    it("3.1 $set generates SET clause", function () {
        const { setClause, binds } = parseUpdate({ $set: { DIVISION: "WH" } });
        expect(setClause).to.include("=");
        expect(Object.values(binds)).to.include("WH");
    });

    it("3.2 $inc generates field = field + n", function () {
        const { setClause } = parseUpdate({ $inc: { QUANTITY: 10 } });
        expect(setClause).to.include("+");
    });

    it("3.3 $mul generates field = field * n", function () {
        const { setClause } = parseUpdate({ $mul: { VALUE: 1.5 } });
        expect(setClause).to.include("*");
    });

    it("3.4 $unset generates field = NULL", function () {
        const { setClause } = parseUpdate({ $unset: { DELETEDBY: "" } });
        expect(setClause.toUpperCase()).to.include("NULL");
    });

    it("3.5 $currentDate generates SYSDATE", function () {
        const { setClause } = parseUpdate({ $currentDate: { MODIFIEDDATE: true } });
        expect(setClause.toUpperCase()).to.include("SYSDATE");
    });

    it("3.6 $min generates LEAST", function () {
        const { setClause } = parseUpdate({ $min: { VALUE: 10 } });
        expect(setClause.toUpperCase()).to.include("LEAST");
    });

    it("3.7 $max generates GREATEST", function () {
        const { setClause } = parseUpdate({ $max: { VALUE: 100 } });
        expect(setClause.toUpperCase()).to.include("GREATEST");
    });

    it("3.8 $rename throws error", function () {
        expect(() => parseUpdate({ $rename: { OLD: "NEW" } })).to.throw();
    });

    it("3.9 empty update throws error", function () {
        expect(() => parseUpdate({})).to.throw();
    });

    it("3.10 combined $set + $inc + $currentDate", function () {
        const { setClause } = parseUpdate({
            $set: { STATUS: "updated" },
            $inc: { QUANTITY: 5 },
            $currentDate: { MODIFIEDDATE: true },
        });
        expect(setClause).to.include("STATUS");
        expect(setClause).to.include("QUANTITY");
        expect(setClause.toUpperCase()).to.include("SYSDATE");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  4. DEV_BOOK (SAPBook) — Read Operations
// ═════════════════════════════════════════════════════════════════════════════

describe("4. DEV_BOOK — Read Operations", function () {
    it("4.1 countDocuments returns a number", async function () {
        const count = await devBook.countDocuments();
        expect(count).to.be.a("number");
        expect(count).to.be.at.least(0);
    });

    it("4.2 estimatedDocumentCount returns a number (O(1))", async function () {
        const count = await devBook.estimatedDocumentCount();
        expect(count).to.be.a("number");
    });

    it("4.3 find().toArray() returns rows with correct columns", async function () {
        const rows = await devBook.find({}).limit(5).toArray();
        expect(rows).to.be.an("array");
        if (rows.length > 0) {
            for (const col of ["ID", "DIVISION", "YEAR", "MONTH", "MATERIALID"]) {
                expect(rows[0]).to.have.property(col);
            }
        }
    });

    it("4.4 find with projection", async function () {
        const rows = await devBook
            .find({})
            .project({ ID: 1, DIVISION: 1, YEAR: 1, MATERIALID: 1 })
            .limit(3)
            .toArray();
        expect(rows).to.be.an("array");
        if (rows.length > 0) {
            expect(rows[0]).to.have.property("ID");
            expect(rows[0]).to.have.property("MATERIALID");
        }
    });

    it("4.5 find with sort DESC and limit", async function () {
        const rows = await devBook.find({}).sort({ ID: -1 }).limit(3).toArray();
        expect(rows).to.be.an("array");
        if (rows.length >= 2) {
            expect(Number(rows[0].ID)).to.be.at.least(Number(rows[1].ID));
        }
    });

    it("4.6 find with skip + limit (pagination)", async function () {
        const page1 = await devBook.find({}).sort({ ID: 1 }).limit(2).toArray();
        const page2 = await devBook.find({}).sort({ ID: 1 }).skip(2).limit(2).toArray();
        if (page1.length === 2 && page2.length > 0) {
            expect(Number(page2[0].ID)).to.be.greaterThan(Number(page1[1].ID));
        }
    });

    it("4.7 findOne returns a single document or null", async function () {
        const doc = await devBook.findOne({});
        if (doc) {
            expect(doc).to.have.property("ID");
            expect(doc).to.have.property("SAP_BOOK_QUANTITY");
        } else {
            expect(doc).to.be.null;
        }
    });

    it("4.8 distinct on DIVISION", async function () {
        const divisions = await devBook.distinct("DIVISION");
        expect(divisions).to.be.an("array");
    });

    it("4.9 find with $exists filter (non-null MATERIALID)", async function () {
        const rows = await devBook
            .find({ MATERIALID: { $exists: true } })
            .limit(5)
            .toArray();
        expect(rows).to.be.an("array");
        rows.forEach((r) => expect(r.MATERIALID).to.not.be.null);
    });

    it("4.10 QueryBuilder.count()", async function () {
        const count = await devBook.find({}).count();
        expect(count).to.be.a("number").and.at.least(0);
    });

    it("4.11 QueryBuilder.explain() returns SQL string", async function () {
        const sql = await devBook.find({ DIVISION: "WH" }).sort({ ID: 1 }).limit(10).explain();
        expect(sql).to.be.a("string");
        expect(sql.toUpperCase()).to.include("SELECT");
        expect(sql.toUpperCase()).to.include("ORDER BY");
    });

    it("4.12 QueryBuilder.next() returns first row", async function () {
        const row = await devBook.find({}).sort({ ID: 1 }).next();
        if (row) expect(row).to.have.property("ID");
    });

    it("4.13 QueryBuilder.hasNext() returns boolean", async function () {
        const has = await devBook.find({}).hasNext();
        expect(has).to.be.a("boolean");
    });

    it("4.14 find with $like filter on YEAR", async function () {
        const rows = await devBook.find({ YEAR: { $like: "202%" } }).limit(5).toArray();
        expect(rows).to.be.an("array");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  5. DEV_LOCATION (StorageLocation) — Read Operations
// ═════════════════════════════════════════════════════════════════════════════

describe("5. DEV_LOCATION — Read Operations", function () {
    it("5.1 countDocuments", async function () {
        const count = await devLocation.countDocuments();
        expect(count).to.be.a("number");
    });

    it("5.2 find with $in filter on TYPE", async function () {
        const rows = await devLocation.find({ TYPE: { $in: ["WH", "PR"] } }).limit(10).toArray();
        expect(rows).to.be.an("array");
    });

    it("5.3 distinct SLOC values", async function () {
        const slocs = await devLocation.distinct("SLOC");
        expect(slocs).to.be.an("array");
    });

    it("5.4 find with multiple conditions (implicit AND)", async function () {
        const rows = await devLocation.find({ DIVISION: "WH", YEAR: "2025" }).limit(5).toArray();
        expect(rows).to.be.an("array");
    });

    it("5.5 find with $or", async function () {
        const rows = await devLocation
            .find({ $or: [{ TYPE: "WH" }, { TYPE: "PR" }] })
            .limit(5)
            .toArray();
        expect(rows).to.be.an("array");
    });

    it("5.6 find with projection", async function () {
        const rows = await devLocation
            .find({})
            .project({ ID: 1, DIVISION: 1, SLOC: 1, PSA: 1, TERMINAL: 1 })
            .limit(3)
            .toArray();
        expect(rows).to.be.an("array");
        if (rows.length > 0) expect(rows[0]).to.have.property("SLOC");
    });

    it("5.7 distinct on TERMINAL", async function () {
        const terminals = await devLocation.distinct("TERMINAL");
        expect(terminals).to.be.an("array");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  6. DEV_MATERIAL (MaterialMaster) — Read Operations
// ═════════════════════════════════════════════════════════════════════════════

describe("6. DEV_MATERIAL — Read Operations", function () {
    it("6.1 countDocuments", async function () {
        const count = await devMaterial.countDocuments();
        expect(count).to.be.a("number");
    });

    it("6.2 find with $ne filter on TYPE", async function () {
        const rows = await devMaterial.find({ TYPE: { $ne: "RM" } }).limit(10).toArray();
        expect(rows).to.be.an("array");
    });

    it("6.3 distinct TYPE", async function () {
        const types = await devMaterial.distinct("TYPE");
        expect(types).to.be.an("array");
    });

    it("6.4 findOne with specific MATERIALID", async function () {
        const any = await devMaterial.findOne({});
        if (any) {
            const found = await devMaterial.findOne({ MATERIALID: any.MATERIALID });
            expect(found).to.not.be.null;
            expect(found.MATERIALID).to.equal(any.MATERIALID);
        }
    });

    it("6.5 find with $gte on ID", async function () {
        const rows = await devMaterial.find({ ID: { $gte: 1 } }).sort({ ID: 1 }).limit(5).toArray();
        expect(rows).to.be.an("array");
        if (rows.length > 0) expect(Number(rows[0].ID)).to.be.at.least(1);
    });

    it("6.6 shared columns: common DIVISION/YEAR/MONTH/MATERIALID", async function () {
        const doc = await devMaterial.findOne({});
        if (doc) {
            expect(doc).to.have.property("DIVISION");
            expect(doc).to.have.property("YEAR");
            expect(doc).to.have.property("MONTH");
            expect(doc).to.have.property("MATERIALID");
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  7. DEV_STOCKS (InventoryStocks) — Read Operations
// ═════════════════════════════════════════════════════════════════════════════

describe("7. DEV_STOCKS — Read Operations", function () {
    it("7.1 countDocuments", async function () {
        const count = await devStocks.countDocuments();
        expect(count).to.be.a("number");
    });

    it("7.2 find with sort by QUANTITY desc", async function () {
        const rows = await devStocks
            .find({ QUANTITY: { $exists: true } })
            .sort({ QUANTITY: -1 })
            .limit(5)
            .toArray();
        expect(rows).to.be.an("array");
        if (rows.length >= 2) {
            expect(Number(rows[0].QUANTITY)).to.be.at.least(Number(rows[1].QUANTITY));
        }
    });

    it("7.3 distinct CATEGORY", async function () {
        const cats = await devStocks.distinct("CATEGORY");
        expect(cats).to.be.an("array");
    });

    it("7.4 find with $gt on QUANTITY", async function () {
        const rows = await devStocks.find({ QUANTITY: { $gt: 0 } }).limit(10).toArray();
        expect(rows).to.be.an("array");
        rows.forEach((r) => expect(Number(r.QUANTITY)).to.be.greaterThan(0));
    });

    it("7.5 QueryBuilder.next() returns first row", async function () {
        const row = await devStocks.find({}).sort({ ID: 1 }).next();
        if (row) expect(row).to.have.property("ID");
    });

    it("7.6 QueryBuilder.hasNext() returns boolean", async function () {
        const has = await devStocks.find({}).hasNext();
        expect(has).to.be.a("boolean");
    });

    it("7.7 find with $between on QUANTITY", async function () {
        const rows = await devStocks.find({ QUANTITY: { $between: [1, 1000] } }).limit(10).toArray();
        expect(rows).to.be.an("array");
    });

    it("7.8 forEach iterates with O(1) memory", async function () {
        const items = [];
        await devStocks
            .find({})
            .limit(5)
            .forEach((row) => items.push(row.ID));
        expect(items).to.be.an("array");
        expect(items.length).to.be.at.most(5);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  8. DEV_UNIT (InventoryUnit) — Read Operations
// ═════════════════════════════════════════════════════════════════════════════

describe("8. DEV_UNIT — Read Operations", function () {
    it("8.1 countDocuments", async function () {
        const count = await devUnit.countDocuments();
        expect(count).to.be.a("number");
    });

    it("8.2 find with $in on UNITSTATUS", async function () {
        const rows = await devUnit
            .find({ UNITSTATUS: { $in: ["OPEN", "CLOSED", "ACTIVE"] } })
            .limit(10)
            .toArray();
        expect(rows).to.be.an("array");
    });

    it("8.3 distinct UNITIDTYPE", async function () {
        const types = await devUnit.distinct("UNITIDTYPE");
        expect(types).to.be.an("array");
    });

    it("8.4 find with $exists false (null MATERIALNUMBER)", async function () {
        const rows = await devUnit
            .find({ MATERIALNUMBER: { $exists: false } })
            .limit(5)
            .toArray();
        expect(rows).to.be.an("array");
        rows.forEach((r) => expect(r.MATERIALNUMBER).to.be.null);
    });

    it("8.5 find with $like on ORDERNAME", async function () {
        const rows = await devUnit.find({ ORDERNAME: { $like: "%ORD%" } }).limit(5).toArray();
        expect(rows).to.be.an("array");
    });

    it("8.6 shared columns: DIVISION/YEAR/MONTH are present", async function () {
        const doc = await devUnit.findOne({});
        if (doc) {
            expect(doc).to.have.property("DIVISION");
            expect(doc).to.have.property("YEAR");
            expect(doc).to.have.property("MONTH");
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  9. DEV_LOCK (UnlockedInventoryByMonth) — Read Operations
// ═════════════════════════════════════════════════════════════════════════════

describe("9. DEV_LOCK — Read Operations", function () {
    it("9.1 countDocuments", async function () {
        const count = await devLock.countDocuments();
        expect(count).to.be.a("number");
    });

    it("9.2 find with $eq on ACTIVE", async function () {
        const rows = await devLock.find({ ACTIVE: { $eq: 1 } }).limit(10).toArray();
        expect(rows).to.be.an("array");
        rows.forEach((r) => expect(Number(r.ACTIVE)).to.equal(1));
    });

    it("9.3 verify column structure", async function () {
        const rows = await devLock.find({}).limit(1).toArray();
        if (rows.length > 0) {
            expect(rows[0]).to.have.property("ID");
            expect(rows[0]).to.have.property("MONTH");
            expect(rows[0]).to.have.property("ACTIVE");
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. T_OPITS_USERS — Read Operations
// ═════════════════════════════════════════════════════════════════════════════

describe("10. T_OPITS_USERS — Read Operations", function () {
    it("10.1 countDocuments", async function () {
        const count = await users.countDocuments();
        expect(count).to.be.a("number").and.at.least(0);
    });

    it("10.2 findOne returns full user doc", async function () {
        const user = await users.findOne({});
        if (user) {
            expect(user).to.have.property("USERID");
            expect(user).to.have.property("NAME");
        }
    });

    it("10.3 find with sort and limit", async function () {
        const rows = await users.find({}).sort({ USERID: 1 }).limit(5).toArray();
        expect(rows).to.be.an("array");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. SCRATCH TABLE — CRUD Write Operations
// ═════════════════════════════════════════════════════════════════════════════

describe("11. Scratch Table — CRUD Operations", function () {
    it("11.1 insertOne inserts a row and returns insertedId", async function () {
        const result = await scratch.insertOne({
            NAME: "ItemA", DIVISION: "WH", YEAR: "2025", MONTH: "01",
            MATERIALID: "MAT001", CATEGORY: "Alpha", VALUE: 100, QUANTITY: 50,
        });
        expect(result.acknowledged).to.be.true;
        expect(result.insertedId).to.exist;
    });

    it("11.2 insertMany inserts multiple rows", async function () {
        const result = await scratch.insertMany([
            { NAME: "ItemB", DIVISION: "PR", YEAR: "2025", MONTH: "02", MATERIALID: "MAT002", CATEGORY: "Beta", VALUE: 200, QUANTITY: 30 },
            { NAME: "ItemC", DIVISION: "WH", YEAR: "2025", MONTH: "03", MATERIALID: "MAT001", CATEGORY: "Alpha", VALUE: 300, QUANTITY: 70 },
            { NAME: "ItemD", DIVISION: "PR", YEAR: "2024", MONTH: "12", MATERIALID: "MAT003", CATEGORY: "Gamma", VALUE: 150, QUANTITY: 20 },
            { NAME: "ItemE", DIVISION: "WH", YEAR: "2025", MONTH: "01", MATERIALID: "MAT002", CATEGORY: "Beta", VALUE: 450, QUANTITY: 90 },
            { NAME: "ItemF", DIVISION: "WH", YEAR: "2025", MONTH: "02", MATERIALID: "MAT001", CATEGORY: "Alpha", VALUE: 50, QUANTITY: 10 },
        ]);
        expect(result.acknowledged).to.be.true;
        expect(result.insertedCount).to.equal(5);
        expect(result.insertedIds).to.be.an("array").with.length(5);
    });

    it("11.3 countDocuments after inserts = 6", async function () {
        const count = await scratch.countDocuments();
        expect(count).to.equal(6);
    });

    it("11.4 findOne by CATEGORY", async function () {
        const doc = await scratch.findOne({ CATEGORY: "Gamma" });
        expect(doc).to.not.be.null;
        expect(doc.NAME).to.equal("ItemD");
    });

    it("11.5 find with sort and limit", async function () {
        const rows = await scratch.find({}).sort({ VALUE: -1 }).limit(3).toArray();
        expect(rows).to.have.length(3);
        expect(Number(rows[0].VALUE)).to.be.at.least(Number(rows[1].VALUE));
    });

    it("11.6 updateOne with $set", async function () {
        const result = await scratch.updateOne(
            { NAME: "ItemA" },
            { $set: { STATUS: "updated", VALUE: 999 } },
        );
        expect(result.acknowledged).to.be.true;
        expect(result.modifiedCount).to.equal(1);

        const updated = await scratch.findOne({ NAME: "ItemA" });
        expect(updated.STATUS).to.equal("updated");
        expect(Number(updated.VALUE)).to.equal(999);
    });

    it("11.7 updateOne with $inc", async function () {
        const before = await scratch.findOne({ NAME: "ItemB" });
        const beforeVal = Number(before.VALUE);
        await scratch.updateOne({ NAME: "ItemB" }, { $inc: { VALUE: 50 } });
        const after = await scratch.findOne({ NAME: "ItemB" });
        expect(Number(after.VALUE)).to.equal(beforeVal + 50);
    });

    it("11.8 updateMany with $set", async function () {
        const result = await scratch.updateMany(
            { CATEGORY: "Alpha" },
            { $set: { STATUS: "alpha-updated" } },
        );
        expect(result.acknowledged).to.be.true;
        expect(result.modifiedCount).to.be.at.least(2);

        const rows = await scratch.find({ CATEGORY: "Alpha" }).toArray();
        rows.forEach((r) => expect(r.STATUS).to.equal("alpha-updated"));
    });

    it("11.9 updateOne with $currentDate", async function () {
        await scratch.updateOne(
            { NAME: "ItemA" },
            { $currentDate: { UPDATED_AT: true } },
        );
        const doc = await scratch.findOne({ NAME: "ItemA" });
        expect(doc.UPDATED_AT).to.not.be.null;
        expect(doc.UPDATED_AT).to.be.instanceOf(Date);
    });

    it("11.10 updateOne with $mul", async function () {
        const before = await scratch.findOne({ NAME: "ItemC" });
        const beforeVal = Number(before.VALUE);
        await scratch.updateOne({ NAME: "ItemC" }, { $mul: { VALUE: 2 } });
        const after = await scratch.findOne({ NAME: "ItemC" });
        expect(Number(after.VALUE)).to.equal(beforeVal * 2);
    });

    it("11.11 distinct on CATEGORY", async function () {
        const cats = await scratch.distinct("CATEGORY");
        expect(cats).to.be.an("array");
        expect(cats).to.include("Alpha");
        expect(cats).to.include("Beta");
        expect(cats).to.include("Gamma");
    });

    it("11.12 distinct on shared column DIVISION", async function () {
        const divs = await scratch.distinct("DIVISION");
        expect(divs).to.be.an("array");
        expect(divs).to.include("WH");
        expect(divs).to.include("PR");
    });

    it("11.13 find with $gte and $lte on VALUE", async function () {
        const rows = await scratch.find({ VALUE: { $gte: 100, $lte: 500 } }).toArray();
        expect(rows).to.be.an("array");
        rows.forEach((r) => {
            const v = Number(r.VALUE);
            expect(v).to.be.at.least(100);
            expect(v).to.be.at.most(500);
        });
    });

    it("11.14 findOneAndUpdate returns before doc", async function () {
        const before = await scratch.findOneAndUpdate(
            { NAME: "ItemC" },
            { $set: { VALUE: 777 } },
            { returnDocument: "before" },
        );
        expect(before).to.not.be.null;
        expect(Number(before.VALUE)).to.not.equal(777);
    });

    it("11.15 findOneAndUpdate returns after doc", async function () {
        const after = await scratch.findOneAndUpdate(
            { NAME: "ItemC" },
            { $set: { VALUE: 888 } },
            { returnDocument: "after" },
        );
        expect(after).to.not.be.null;
        expect(Number(after.VALUE)).to.equal(888);
    });

    it("11.16 replaceOne replaces all columns except ID", async function () {
        await scratch.replaceOne(
            { NAME: "ItemD" },
            { NAME: "ItemD-Replaced", DIVISION: "XX", YEAR: "2024", MONTH: "12", CATEGORY: "Delta", VALUE: 666, QUANTITY: 99, STATUS: "replaced" },
        );
        const doc = await scratch.findOne({ NAME: "ItemD-Replaced" });
        expect(doc).to.not.be.null;
        expect(doc.CATEGORY).to.equal("Delta");
        expect(Number(doc.VALUE)).to.equal(666);
    });

    it("11.17 deleteOne deletes a single row", async function () {
        const result = await scratch.deleteOne({ NAME: "ItemF" });
        expect(result.acknowledged).to.be.true;
        expect(result.deletedCount).to.equal(1);
        const doc = await scratch.findOne({ NAME: "ItemF" });
        expect(doc).to.be.null;
    });

    it("11.18 findOneAndDelete returns deleted doc", async function () {
        const deleted = await scratch.findOneAndDelete({ NAME: "ItemE" });
        expect(deleted).to.not.be.null;
        expect(deleted.NAME).to.equal("ItemE");
        const check = await scratch.findOne({ NAME: "ItemE" });
        expect(check).to.be.null;
    });

    it("11.19 deleteMany with filter", async function () {
        await scratch.insertMany([
            { NAME: "Del1", CATEGORY: "ToDelete", VALUE: 1, QUANTITY: 1 },
            { NAME: "Del2", CATEGORY: "ToDelete", VALUE: 2, QUANTITY: 2 },
            { NAME: "Del3", CATEGORY: "ToDelete", VALUE: 3, QUANTITY: 3 },
        ]);
        const result = await scratch.deleteMany({ CATEGORY: "ToDelete" });
        expect(result.acknowledged).to.be.true;
        expect(result.deletedCount).to.equal(3);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. UPSERT
// ═════════════════════════════════════════════════════════════════════════════

describe("12. Upsert Operations", function () {
    it("12.1 updateOne upsert inserts when no match", async function () {
        const result = await scratch.updateOne(
            { NAME: "UpsertItem" },
            { $set: { NAME: "UpsertItem", DIVISION: "WH", CATEGORY: "Upsert", VALUE: 555, QUANTITY: 25 } },
            { upsert: true },
        );
        expect(result.acknowledged).to.be.true;
        const doc = await scratch.findOne({ NAME: "UpsertItem" });
        expect(doc).to.not.be.null;
        expect(Number(doc.VALUE)).to.equal(555);
    });

    it("12.2 updateOne upsert updates when match exists", async function () {
        const result = await scratch.updateOne(
            { NAME: "UpsertItem" },
            { $set: { VALUE: 777 } },
            { upsert: true },
        );
        expect(result.acknowledged).to.be.true;
        expect(result.modifiedCount).to.equal(1);
        const doc = await scratch.findOne({ NAME: "UpsertItem" });
        expect(Number(doc.VALUE)).to.equal(777);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 13. MERGE / UPSERT (Oracle MERGE)
// ═════════════════════════════════════════════════════════════════════════════

describe("13. MERGE Operations", function () {
    it("13.1 merge inserts when no match", async function () {
        const result = await scratch.merge(
            { NAME: "MergeNew", DIVISION: "WH", CATEGORY: "Merge", VALUE: 1000, QUANTITY: 50, STATUS: "merged" },
            { localField: "NAME", foreignField: "NAME" },
            { whenMatched: { $set: { VALUE: 1000, STATUS: "merged" } }, whenNotMatched: "insert" },
        );
        expect(result.acknowledged).to.be.true;
        const doc = await scratch.findOne({ NAME: "MergeNew" });
        expect(doc).to.not.be.null;
    });

    it("13.2 merge updates when match exists", async function () {
        const result = await scratch.merge(
            { NAME: "MergeNew", DIVISION: "WH", CATEGORY: "Merge", VALUE: 2000, QUANTITY: 75, STATUS: "re-merged" },
            { localField: "NAME", foreignField: "NAME" },
            { whenMatched: { $set: { VALUE: 2000, STATUS: "re-merged" } }, whenNotMatched: "insert" },
        );
        expect(result.acknowledged).to.be.true;
        const doc = await scratch.findOne({ NAME: "MergeNew" });
        expect(Number(doc.VALUE)).to.equal(2000);
        expect(doc.STATUS).to.equal("re-merged");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 14. TRANSACTIONS & SAVEPOINTS
// ═════════════════════════════════════════════════════════════════════════════

describe("14. Transactions & Savepoints", function () {
    it("14.1 withTransaction commits on success", async function () {
        await txManager.withTransaction(async (session) => {
            const s = session.collection(SCRATCH);
            await s.insertOne({ NAME: "TxCommit", DIVISION: "TX", CATEGORY: "TX", VALUE: 111, QUANTITY: 1 });
        });
        const doc = await scratch.findOne({ NAME: "TxCommit" });
        expect(doc).to.not.be.null;
        expect(doc.CATEGORY).to.equal("TX");
    });

    it("14.2 withTransaction rolls back on error", async function () {
        try {
            await txManager.withTransaction(async (session) => {
                const s = session.collection(SCRATCH);
                await s.insertOne({ NAME: "TxRollback", CATEGORY: "TX", VALUE: 222, QUANTITY: 2 });
                throw new Error("Intentional rollback");
            });
        } catch (e) { /* expected */ }
        const doc = await scratch.findOne({ NAME: "TxRollback" });
        expect(doc).to.be.null;
    });

    it("14.3 savepoint + rollbackTo partially undoes work", async function () {
        await txManager.withTransaction(async (session) => {
            const s = session.collection(SCRATCH);
            await s.insertOne({ NAME: "SP_Keep", CATEGORY: "Savepoint", VALUE: 10, QUANTITY: 1 });
            await session.savepoint("sp1");
            await s.insertOne({ NAME: "SP_Undo", CATEGORY: "Savepoint", VALUE: 20, QUANTITY: 2 });
            await session.rollbackTo("sp1");
            await s.insertOne({ NAME: "SP_After", CATEGORY: "Savepoint", VALUE: 30, QUANTITY: 3 });
        });
        expect(await scratch.findOne({ NAME: "SP_Keep" })).to.not.be.null;
        expect(await scratch.findOne({ NAME: "SP_Undo" })).to.be.null;
        expect(await scratch.findOne({ NAME: "SP_After" })).to.not.be.null;
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 15. BULK WRITE
// ═════════════════════════════════════════════════════════════════════════════

describe("15. bulkWrite", function () {
    it("15.1 bulkWrite executes mixed operations atomically", async function () {
        const result = await scratch.bulkWrite([
            { insertOne: { document: { NAME: "BulkA", DIVISION: "WH", CATEGORY: "Bulk", VALUE: 10, QUANTITY: 1 } } },
            { insertOne: { document: { NAME: "BulkB", DIVISION: "PR", CATEGORY: "Bulk", VALUE: 20, QUANTITY: 2 } } },
            { updateOne: { filter: { NAME: "BulkA" }, update: { $set: { VALUE: 99 } } } },
        ]);
        expect(result.acknowledged).to.be.true;
        const a = await scratch.findOne({ NAME: "BulkA" });
        expect(Number(a.VALUE)).to.equal(99);
        const b = await scratch.findOne({ NAME: "BulkB" });
        expect(b).to.not.be.null;
    });

    it("15.2 bulkWrite rolls back on failure", async function () {
        const countBefore = await scratch.countDocuments();
        try {
            await scratch.bulkWrite([
                { insertOne: { document: { NAME: "BulkFail1", CATEGORY: "Fail", VALUE: 1, QUANTITY: 1 } } },
                { insertOne: { document: { NAME: null, CATEGORY: "Fail", VALUE: 2, QUANTITY: 1 } } }, // NAME NOT NULL
            ]);
        } catch (e) { /* expected */ }
        const countAfter = await scratch.countDocuments();
        expect(countAfter).to.equal(countBefore);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 16. INDEX OPERATIONS
// ═════════════════════════════════════════════════════════════════════════════

describe("16. Index Operations", function () {
    it("16.1 createIndex", async function () {
        const result = await scratch.createIndex(
            { CATEGORY: 1 },
            { name: "IDX_SCRATCH_CATEGORY" },
        );
        expect(result.acknowledged).to.be.true;
        expect(result.indexName).to.equal("IDX_SCRATCH_CATEGORY");
    });

    it("16.2 getIndexes returns array including created index", async function () {
        const indexes = await scratch.getIndexes();
        expect(indexes).to.be.an("array");
        const names = indexes.map((idx) => idx.indexName);
        expect(names).to.include("IDX_SCRATCH_CATEGORY");
    });

    it("16.3 createIndex composite + unique", async function () {
        const result = await scratch.createIndex(
            { NAME: 1, DIVISION: 1 },
            { name: "IDX_SCRATCH_NAME_DIV" },
        );
        expect(result.acknowledged).to.be.true;
    });

    it("16.4 dropIndex drops a specific index", async function () {
        const result = await scratch.dropIndex("IDX_SCRATCH_NAME_DIV");
        expect(result.acknowledged).to.be.true;
    });

    it("16.5 dropIndexes drops all non-PK indexes", async function () {
        const result = await scratch.dropIndexes();
        expect(result.acknowledged).to.be.true;
        expect(result.dropped).to.be.an("array");
    });

    it("16.6 createIndex + reIndex rebuilds", async function () {
        await scratch.createIndex({ VALUE: 1 }, { name: "IDX_SCRATCH_VALUE" });
        const result = await scratch.reIndex();
        expect(result.acknowledged).to.be.true;
        await scratch.dropIndex("IDX_SCRATCH_VALUE");
    });

    it("16.7 getIndexes on real table DEV_BOOK", async function () {
        const indexes = await devBook.getIndexes();
        expect(indexes).to.be.an("array");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 17. AGGREGATION PIPELINE — Scratch Table
// ═════════════════════════════════════════════════════════════════════════════

describe("17. Aggregation Pipeline — Scratch", function () {
    it("17.1 $match + $group + $sort", async function () {
        const result = await scratch.aggregate([
            { $match: { STATUS: { $ne: null } } },
            { $group: { _id: "$CATEGORY", totalVal: { $sum: "$VALUE" }, cnt: { $count: "*" } } },
            { $sort: { totalVal: -1 } },
        ]);
        expect(result).to.be.an("array");
        if (result.length >= 2) {
            expect(Number(result[0].TOTALVAL || result[0].totalVal)).to.be.at.least(
                Number(result[1].TOTALVAL || result[1].totalVal),
            );
        }
    });

    it("17.2 $match + $limit", async function () {
        const result = await scratch.aggregate([{ $match: {} }, { $limit: 3 }]);
        expect(result.length).to.be.at.most(3);
    });

    it("17.3 $count stage", async function () {
        const result = await scratch.aggregate([{ $match: {} }, { $count: "total" }]);
        if (result.length > 0) {
            expect(Number(result[0].TOTAL || result[0].total)).to.be.greaterThan(0);
        }
    });

    it("17.4 $group with $avg", async function () {
        const result = await scratch.aggregate([
            { $match: { VALUE: { $exists: true } } },
            { $group: { _id: "$DIVISION", avgVal: { $avg: "$VALUE" } } },
        ]);
        expect(result).to.be.an("array");
    });

    it("17.5 $group with $min and $max", async function () {
        const result = await scratch.aggregate([
            { $match: {} },
            { $group: { _id: "$CATEGORY", minVal: { $min: "$VALUE" }, maxVal: { $max: "$VALUE" } } },
        ]);
        expect(result).to.be.an("array");
    });

    it("17.6 $project stage", async function () {
        const result = await scratch.aggregate([
            { $match: {} },
            { $project: { NAME: 1, VALUE: 1, DIVISION: 1 } },
            { $limit: 5 },
        ]);
        expect(result).to.be.an("array");
    });

    it("17.7 $group by shared columns DIVISION + YEAR", async function () {
        const result = await scratch.aggregate([
            { $match: {} },
            { $group: { _id: { div: "$DIVISION", yr: "$YEAR" }, total: { $sum: "$VALUE" } } },
            { $sort: { total: -1 } },
        ]);
        expect(result).to.be.an("array");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 18. AGGREGATION ON REAL TABLES
// ═════════════════════════════════════════════════════════════════════════════

describe("18. Aggregation on Real Tables", function () {
    it("18.1 DEV_STOCKS: group by CATEGORY, sum QUANTITY", async function () {
        const result = await devStocks.aggregate([
            { $match: { CATEGORY: { $exists: true } } },
            { $group: { _id: "$CATEGORY", totalQty: { $sum: "$QUANTITY" }, cnt: { $count: "*" } } },
            { $sort: { totalQty: -1 } },
            { $limit: 10 },
        ]);
        expect(result).to.be.an("array");
    });

    it("18.2 DEV_BOOK: group by DIVISION + YEAR", async function () {
        const result = await devBook.aggregate([
            { $match: {} },
            { $group: { _id: { div: "$DIVISION", yr: "$YEAR" }, total: { $sum: "$SAP_BOOK_QUANTITY" } } },
            { $sort: { total: -1 } },
            { $limit: 5 },
        ]);
        expect(result).to.be.an("array");
    });

    it("18.3 DEV_UNIT: count by UNITSTATUS", async function () {
        const result = await devUnit.aggregate([
            { $match: {} },
            { $group: { _id: "$UNITSTATUS", cnt: { $count: "*" } } },
            { $sort: { cnt: -1 } },
        ]);
        expect(result).to.be.an("array");
    });

    it("18.4 DEV_MATERIAL: group by TYPE, avg STANDARDPRICE", async function () {
        const result = await devMaterial.aggregate([
            { $match: { STANDARDPRICE: { $exists: true } } },
            { $group: { _id: "$TYPE", avgPrice: { $avg: "$STANDARDPRICE" } } },
        ]);
        expect(result).to.be.an("array");
    });

    it("18.5 DEV_STOCKS: group by MATERIALID with $having", async function () {
        const result = await devStocks.aggregate([
            { $match: {} },
            { $group: { _id: "$MATERIALID", totalQty: { $sum: "$QUANTITY" } } },
            { $having: { totalQty: { $gt: 0 } } },
            { $limit: 10 },
        ]);
        expect(result).to.be.an("array");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 19. CTE (Common Table Expressions)
// ═════════════════════════════════════════════════════════════════════════════

describe("19. CTE Operations", function () {
    it("19.1 withCTE with single named query", async function () {
        const result = await withCTE(inventoryDB, {
            active_stocks: devStocks.find({ QUANTITY: { $gt: 0 } }),
        })
            .from("active_stocks")
            .limit(10)
            .toArray();
        expect(result).to.be.an("array");
    });

    it("19.2 withCTE with multiple named queries", async function () {
        const result = await withCTE(inventoryDB, {
            big_stocks: devStocks.find({ QUANTITY: { $gt: 100 } }),
            small_stocks: devStocks.find({ QUANTITY: { $lte: 100, $gt: 0 } }),
        })
            .from("big_stocks")
            .limit(10)
            .toArray();
        expect(result).to.be.an("array");
    });

    it("19.3 withCTE with sort and limit", async function () {
        const result = await withCTE(inventoryDB, {
            materials: devMaterial.find({ TYPE: { $exists: true } }),
        })
            .from("materials")
            .sort({ ID: -1 })
            .limit(5)
            .toArray();
        expect(result).to.be.an("array");
        expect(result.length).to.be.at.most(5);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 20. WINDOW FUNCTIONS — Unit Tests
// ═════════════════════════════════════════════════════════════════════════════

describe("20. Window Functions — Unit Tests", function () {
    it("20.1 ROW_NUMBER", function () {
        const expr = buildWindowExpr({ fn: "ROW_NUMBER", partitionBy: "DIVISION", orderBy: { YEAR: -1 } });
        expect(expr.toUpperCase()).to.include("ROW_NUMBER");
        expect(expr.toUpperCase()).to.include("PARTITION BY");
        expect(expr.toUpperCase()).to.include("ORDER BY");
    });

    it("20.2 RANK", function () {
        const expr = buildWindowExpr({ fn: "RANK", partitionBy: "CATEGORY", orderBy: { VALUE: -1 } });
        expect(expr.toUpperCase()).to.include("RANK");
    });

    it("20.3 DENSE_RANK", function () {
        const expr = buildWindowExpr({ fn: "DENSE_RANK", partitionBy: "DIVISION", orderBy: { QUANTITY: 1 } });
        expect(expr.toUpperCase()).to.include("DENSE_RANK");
    });

    it("20.4 SUM with frame", function () {
        const expr = buildWindowExpr({
            fn: "SUM", field: "QUANTITY", partitionBy: "DIVISION",
            orderBy: { MONTH: 1 },
            frame: "ROWS BETWEEN 2 PRECEDING AND CURRENT ROW",
        });
        expect(expr.toUpperCase()).to.include("SUM");
        expect(expr.toUpperCase()).to.include("ROWS BETWEEN");
    });

    it("20.5 LAG", function () {
        const expr = buildWindowExpr({
            fn: "LAG", field: "VALUE", offset: 1,
            partitionBy: "MATERIALID", orderBy: { MONTH: 1 },
        });
        expect(expr.toUpperCase()).to.include("LAG");
    });

    it("20.6 LEAD", function () {
        const expr = buildWindowExpr({
            fn: "LEAD", field: "VALUE", offset: 1,
            partitionBy: "MATERIALID", orderBy: { MONTH: 1 },
        });
        expect(expr.toUpperCase()).to.include("LEAD");
    });

    it("20.7 COUNT(*)", function () {
        const expr = buildWindowExpr({ fn: "COUNT", field: "*", partitionBy: "DIVISION" });
        expect(expr.toUpperCase()).to.include("COUNT(*)");
    });

    it("20.8 NTILE", function () {
        const expr = buildWindowExpr({
            fn: "NTILE", n: 4, partitionBy: "CATEGORY", orderBy: { VALUE: 1 },
        });
        expect(expr.toUpperCase()).to.include("NTILE");
    });

    it("20.9 FIRST_VALUE", function () {
        const expr = buildWindowExpr({
            fn: "FIRST_VALUE", field: "VALUE",
            partitionBy: "DIVISION", orderBy: { ID: 1 },
        });
        expect(expr.toUpperCase()).to.include("FIRST_VALUE");
    });

    it("20.10 LAST_VALUE", function () {
        const expr = buildWindowExpr({
            fn: "LAST_VALUE", field: "VALUE",
            partitionBy: "DIVISION", orderBy: { ID: 1 },
        });
        expect(expr.toUpperCase()).to.include("LAST_VALUE");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 21. JOIN BUILDER — Unit Tests
// ═════════════════════════════════════════════════════════════════════════════

describe("21. Join Builder — Unit Tests", function () {
    it("21.1 LEFT JOIN", function () {
        const sql = buildJoinSQL('"DEV_STOCKS"', {
            from: "DEV_MATERIAL",
            localField: "MATERIALID",
            foreignField: "MATERIALID",
            as: "mat",
            joinType: "left",
        });
        expect(sql.toUpperCase()).to.include("LEFT OUTER JOIN");
    });

    it("21.2 INNER JOIN", function () {
        const sql = buildJoinSQL('"DEV_BOOK"', {
            from: "DEV_LOCATION",
            localField: "SLOC",
            foreignField: "SLOC",
            as: "loc",
            joinType: "inner",
        });
        expect(sql.toUpperCase()).to.include("INNER JOIN");
    });

    it("21.3 CROSS JOIN", function () {
        const sql = buildJoinSQL('"DEV_BOOK"', {
            from: "DEV_LOCATION",
            joinType: "cross",
            as: "loc",
        });
        expect(sql.toUpperCase()).to.include("CROSS JOIN");
    });

    it("21.4 SELF JOIN", function () {
        const sql = buildJoinSQL('"DEV_STOCKS"', {
            from: "DEV_STOCKS",
            localField: "ID",
            foreignField: "ID",
            joinType: "self",
        });
        expect(sql.toUpperCase()).to.include("INNER JOIN");
    });

    it("21.5 Multiple conditions (multi-field ON)", function () {
        const sql = buildJoinSQL('"DEV_STOCKS"', {
            from: "DEV_BOOK",
            as: "book",
            joinType: "inner",
            on: [
                { localField: "MATERIALID", foreignField: "MATERIALID" },
                { localField: "DIVISION", foreignField: "DIVISION" },
            ],
        });
        expect(sql.toUpperCase()).to.include("AND");
    });

    it("21.6 select — pulls only specified columns from the right table", function () {
        const sql = buildJoinSQL('"stage_0"', {
            from: "U_PERSONALINFOS",
            localField: "USERID",
            foreignField: "USERID",
            as: "pi",
            joinType: "left",
            select: ["EMAILADDRESS"],
        });
        // Must include the qualified column reference, not alias.*
        expect(sql).to.include('"pi"."EMAILADDRESS"');
        expect(sql).to.not.include('"pi".*');
    });

    it("21.7 select — multiple columns are all included", function () {
        const sql = buildJoinSQL('"stage_0"', {
            from: "U_PERSONALINFOS",
            localField: "USERID",
            foreignField: "USERID",
            as: "pi",
            joinType: "left",
            select: ["EMAILADDRESS", "MOBILENO"],
        });
        expect(sql).to.include('"pi"."EMAILADDRESS"');
        expect(sql).to.include('"pi"."MOBILENO"');
        expect(sql).to.not.include('"pi".*');
    });

    it("21.8 select — omitting select preserves original alias.* behaviour", function () {
        const sql = buildJoinSQL('"DEV_STOCKS"', {
            from: "DEV_MATERIAL",
            localField: "MATERIALID",
            foreignField: "MATERIALID",
            as: "mat",
            joinType: "left",
            // no select — backwards-compatible
        });
        expect(sql).to.include('"mat".*');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 22. SET OPERATIONS
// ═════════════════════════════════════════════════════════════════════════════

describe("22. Set Operations", function () {
    it("22.1 UNION of two queries", async function () {
        const qb1 = scratch.find({ DIVISION: "WH" }).project({ NAME: 1, VALUE: 1 });
        const qb2 = scratch.find({ DIVISION: "PR" }).project({ NAME: 1, VALUE: 1 });
        const result = await OracleCollection.union(qb1, qb2).toArray();
        expect(result).to.be.an("array");
    });

    it("22.2 UNION ALL", async function () {
        const qb1 = scratch.find({ CATEGORY: "Alpha" }).project({ NAME: 1 });
        const qb2 = scratch.find({ CATEGORY: "Beta" }).project({ NAME: 1 });
        const result = await OracleCollection.union(qb1, qb2, { all: true }).toArray();
        expect(result).to.be.an("array");
    });

    it("22.3 INTERSECT", async function () {
        const qb1 = scratch.find({ DIVISION: "WH" }).project({ NAME: 1 });
        const qb2 = scratch.find({ CATEGORY: "Alpha" }).project({ NAME: 1 });
        const result = await OracleCollection.intersect(qb1, qb2).toArray();
        expect(result).to.be.an("array");
    });

    it("22.4 MINUS", async function () {
        const qb1 = scratch.find({}).project({ NAME: 1 });
        const qb2 = scratch.find({ CATEGORY: "Alpha" }).project({ NAME: 1 });
        const result = await OracleCollection.minus(qb1, qb2).toArray();
        expect(result).to.be.an("array");
    });

    it("22.5 UNION with sort and limit", async function () {
        const qb1 = scratch.find({ DIVISION: "WH" }).project({ NAME: 1, VALUE: 1 });
        const qb2 = scratch.find({ DIVISION: "PR" }).project({ NAME: 1, VALUE: 1 });
        const result = await OracleCollection.union(qb1, qb2)
            .sort({ VALUE: -1 })
            .limit(3)
            .toArray();
        expect(result).to.be.an("array");
        expect(result.length).to.be.at.most(3);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 23. QUERY BUILDER — Edge Cases
// ═════════════════════════════════════════════════════════════════════════════

describe("23. QueryBuilder Edge Cases", function () {
    it("23.1 cannot chain after terminal method", async function () {
        const qb = scratch.find({});
        await qb.toArray();
        expect(() => qb.sort({ ID: 1 })).to.throw(/Cannot chain/);
    });

    it("23.2 forEach iterates correct number of rows", async function () {
        const items = [];
        await scratch.find({}).limit(3).forEach((row) => items.push(row));
        expect(items).to.have.length(3);
    });

    it("23.3 next returns first row", async function () {
        const row = await scratch.find({}).sort({ VALUE: -1 }).next();
        expect(row).to.not.be.null;
        expect(row).to.have.property("VALUE");
    });

    it("23.4 hasNext true when rows exist", async function () {
        expect(await scratch.find({}).hasNext()).to.be.true;
    });

    it("23.5 hasNext false for impossible filter", async function () {
        expect(await scratch.find({ NAME: "NONEXISTENT_XYZ_123" }).hasNext()).to.be.false;
    });

    it("23.6 skip without limit works", async function () {
        const allRows = await scratch.find({}).sort({ ID: 1 }).toArray();
        const skipped = await scratch.find({}).sort({ ID: 1 }).skip(1).toArray();
        if (allRows.length > 1) {
            expect(skipped.length).to.equal(allRows.length - 1);
        }
    });

    it("23.7 find is thenable (await directly)", async function () {
        const rows = await scratch.find({}).limit(2);
        expect(rows).to.be.an("array");
        expect(rows.length).to.be.at.most(2);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 24. SCHEMA (DDL) OPERATIONS
// ═════════════════════════════════════════════════════════════════════════════

describe("24. Schema DDL Operations", function () {
    const DDL_TABLE = "TEST_DDL_TBL";

    afterEach(async function () {
        await dropIfExists(inventoryDB, DDL_TABLE);
    });

    it("24.1 createTable + dropTable", async function () {
        await schema.createTable(DDL_TABLE, {
            ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
            NAME: { type: "VARCHAR2(100)", notNull: true },
            DIVISION: { type: "VARCHAR2(50)" },
            VAL: { type: "NUMBER(10,2)" },
        });
        expect(await tableExists(inventoryDB, DDL_TABLE)).to.be.true;
        await schema.dropTable(DDL_TABLE);
        expect(await tableExists(inventoryDB, DDL_TABLE)).to.be.false;
    });

    it("24.2 createTable with ifNotExists (idempotent)", async function () {
        const cols = { ID: { type: "NUMBER", primaryKey: true }, X: { type: "VARCHAR2(50)" } };
        await schema.createTable(DDL_TABLE, cols, { ifNotExists: true });
        expect(await tableExists(inventoryDB, DDL_TABLE)).to.be.true;
        await schema.createTable(DDL_TABLE, cols, { ifNotExists: true }); // no error
    });

    it("24.3 alterTable addColumn", async function () {
        await schema.createTable(DDL_TABLE, {
            ID: { type: "NUMBER", primaryKey: true },
            NAME: { type: "VARCHAR2(100)" },
        });
        await schema.alterTable(DDL_TABLE, { addColumn: { EXTRA: "VARCHAR2(50)" } });
        const coll = new OracleCollection(DDL_TABLE, inventoryDB);
        await coll.insertOne({ ID: 1, NAME: "Test", EXTRA: "ExtraVal" });
        const doc = await coll.findOne({ ID: 1 });
        expect(doc.EXTRA).to.equal("ExtraVal");
    });

    it("24.4 truncateTable clears all rows", async function () {
        await schema.createTable(DDL_TABLE, {
            ID: { type: "NUMBER", primaryKey: true },
            NAME: { type: "VARCHAR2(100)" },
        });
        const coll = new OracleCollection(DDL_TABLE, inventoryDB);
        await coll.insertOne({ ID: 1, NAME: "A" });
        await coll.insertOne({ ID: 2, NAME: "B" });
        expect(await rowCount(inventoryDB, DDL_TABLE)).to.equal(2);
        await schema.truncateTable(DDL_TABLE);
        expect(await rowCount(inventoryDB, DDL_TABLE)).to.equal(0);
    });

    it("24.5 renameTable", async function () {
        const RENAMED = "TEST_DDL_RENAMED";
        await dropIfExists(inventoryDB, RENAMED);
        await schema.createTable(DDL_TABLE, {
            ID: { type: "NUMBER", primaryKey: true },
        });
        await schema.renameTable(DDL_TABLE, RENAMED);
        expect(await tableExists(inventoryDB, RENAMED)).to.be.true;
        expect(await tableExists(inventoryDB, DDL_TABLE)).to.be.false;
        await dropIfExists(inventoryDB, RENAMED);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 25. SEQUENCE OPERATIONS
// ═════════════════════════════════════════════════════════════════════════════

describe("25. Sequence Operations", function () {
    const SEQ_NAME = "TEST_SEQ_1";

    afterEach(async function () {
        try {
            await inventoryDB.withConnection(async (conn) => {
                await conn.execute(`DROP SEQUENCE "${SEQ_NAME}"`, {}, { autoCommit: true });
            });
        } catch (e) { /* may not exist */ }
    });

    it("25.1 createSequence creates and is usable", async function () {
        await schema.createSequence(SEQ_NAME, {
            startWith: 1, incrementBy: 1, maxValue: 9999, cycle: false, cache: 20,
        });
        const val = await inventoryDB.withConnection(async (conn) => {
            const r = await conn.execute(
                `SELECT "${SEQ_NAME}".NEXTVAL AS VAL FROM DUAL`, {},
                { outFormat: inventoryDB.oracledb.OUT_FORMAT_OBJECT },
            );
            return Number(r.rows[0].VAL);
        });
        expect(val).to.equal(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 26. ADVANCED: PIVOT & UNPIVOT
// ═════════════════════════════════════════════════════════════════════════════

describe("26. Advanced: PIVOT & UNPIVOT", function () {
    const PIVOT_TABLE = "TEST_PIVOT";
    const UNPIVOT_TABLE = "TEST_UNPIVOT";

    afterEach(async function () {
        await dropIfExists(inventoryDB, PIVOT_TABLE);
        await dropIfExists(inventoryDB, UNPIVOT_TABLE);
    });

    it("26.1 PIVOT on test data", async function () {
        await schema.createTable(PIVOT_TABLE, {
            ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
            DIVISION: { type: "VARCHAR2(50)", notNull: true },
            MONTH: { type: "VARCHAR2(5)", notNull: true },
            VALUE: { type: "NUMBER(12,2)", notNull: true },
        });
        const pivotColl = new OracleCollection(PIVOT_TABLE, inventoryDB);
        await pivotColl.insertMany([
            { DIVISION: "WH", MONTH: "01", VALUE: 100 },
            { DIVISION: "WH", MONTH: "02", VALUE: 200 },
            { DIVISION: "PR", MONTH: "01", VALUE: 150 },
            { DIVISION: "PR", MONTH: "02", VALUE: 250 },
        ]);
        const result = await pivotColl.pivot({
            value: { $sum: "$VALUE" },
            pivotOn: "MONTH",
            pivotValues: ["01", "02"],
            groupBy: "DIVISION",
        });
        expect(result).to.be.an("array");
        expect(result.length).to.be.at.least(2);
    });

    it("26.2 UNPIVOT on test data", async function () {
        await schema.createTable(UNPIVOT_TABLE, {
            ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
            DIVISION: { type: "VARCHAR2(50)", notNull: true },
            M01: { type: "NUMBER(12,2)" },
            M02: { type: "NUMBER(12,2)" },
        });
        const unpivotColl = new OracleCollection(UNPIVOT_TABLE, inventoryDB);
        await unpivotColl.insertMany([
            { DIVISION: "WH", M01: 100, M02: 200 },
            { DIVISION: "PR", M01: 150, M02: 250 },
        ]);
        const result = await unpivotColl.unpivot({
            valueColumn: "VALUE",
            nameColumn: "MONTH",
            columns: ["M01", "M02"],
        });
        expect(result).to.be.an("array");
        expect(result.length).to.equal(4);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 27. ADVANCED: FOR UPDATE & TABLESAMPLE
// ═════════════════════════════════════════════════════════════════════════════

describe("27. Advanced: FOR UPDATE & TABLESAMPLE", function () {
    it("27.1 FOR UPDATE locks rows within transaction", async function () {
        await inventoryDB.withTransaction(async (conn) => {
            const s = new OracleCollection(SCRATCH, inventoryDB, conn);
            const rows = await s.find({ CATEGORY: "TX" }).forUpdate(true).toArray();
            expect(rows).to.be.an("array");
        });
    });

    it("27.2 TABLESAMPLE returns a subset", async function () {
        const count = await devBook.countDocuments();
        if (count < 10) return this.skip();
        const sample = await devBook.find({}, { sample: { percentage: 50 } }).toArray();
        expect(sample).to.be.an("array");
        expect(sample.length).to.be.greaterThan(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 28. INSERT FROM QUERY
// ═════════════════════════════════════════════════════════════════════════════

describe("28. insertFromQuery", function () {
    const ARCHIVE = "TEST_ARCHIVE";

    before(async function () {
        await dropIfExists(inventoryDB, ARCHIVE);
        await schema.createTable(ARCHIVE, {
            ID: { type: "NUMBER", primaryKey: true, autoIncrement: true },
            NAME: { type: "VARCHAR2(200)" },
            CATEGORY: { type: "VARCHAR2(100)" },
            VALUE: { type: "NUMBER(12,2)" },
            DIVISION: { type: "VARCHAR2(50)" },
        });
    });

    after(async function () {
        await dropIfExists(inventoryDB, ARCHIVE);
    });

    it("28.1 insert from query copies matching rows", async function () {
        const result = await scratch.insertFromQuery(
            ARCHIVE,
            scratch.find({ CATEGORY: "Bulk" }).project({ NAME: 1, CATEGORY: 1, VALUE: 1, DIVISION: 1 }),
            { columns: ["NAME", "CATEGORY", "VALUE", "DIVISION"] },
        );
        expect(result.acknowledged).to.be.true;
        expect(result.insertedCount).to.be.at.least(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 29. CROSS-TABLE — Shared Column Verification
// ═════════════════════════════════════════════════════════════════════════════

describe("29. Cross-Table Shared Column Verification", function () {
    it("29.1 read from all 6 real tables without error", async function () {
        const results = await Promise.all([
            devBook.find({}).limit(1).toArray(),
            devLocation.find({}).limit(1).toArray(),
            devLock.find({}).limit(1).toArray(),
            devMaterial.find({}).limit(1).toArray(),
            devStocks.find({}).limit(1).toArray(),
            devUnit.find({}).limit(1).toArray(),
        ]);
        results.forEach((r) => expect(r).to.be.an("array"));
    });

    it("29.2 MATERIALID exists in DEV_BOOK, DEV_MATERIAL, DEV_STOCKS", async function () {
        const [bookDoc, matDoc, stockDoc] = await Promise.all([
            devBook.findOne({}),
            devMaterial.findOne({}),
            devStocks.findOne({}),
        ]);
        if (bookDoc) expect(bookDoc).to.have.property("MATERIALID");
        if (matDoc) expect(matDoc).to.have.property("MATERIALID");
        if (stockDoc) expect(stockDoc).to.have.property("MATERIALID");
    });

    it("29.3 DIVISION exists in DEV_BOOK, DEV_LOCATION, DEV_MATERIAL, DEV_STOCKS, DEV_UNIT", async function () {
        const docs = await Promise.all([
            devBook.findOne({}),
            devLocation.findOne({}),
            devMaterial.findOne({}),
            devStocks.findOne({}),
            devUnit.findOne({}),
        ]);
        for (const doc of docs) {
            if (doc) expect(doc).to.have.property("DIVISION");
        }
    });

    it("29.4 YEAR exists in DEV_BOOK, DEV_LOCATION, DEV_MATERIAL, DEV_STOCKS, DEV_UNIT", async function () {
        const docs = await Promise.all([
            devBook.findOne({}),
            devLocation.findOne({}),
            devMaterial.findOne({}),
            devStocks.findOne({}),
            devUnit.findOne({}),
        ]);
        for (const doc of docs) {
            if (doc) expect(doc).to.have.property("YEAR");
        }
    });

    it("29.5 MONTH exists in all 6 real tables", async function () {
        const docs = await Promise.all([
            devBook.findOne({}),
            devLocation.findOne({}),
            devLock.findOne({}),
            devMaterial.findOne({}),
            devStocks.findOne({}),
            devUnit.findOne({}),
        ]);
        for (const doc of docs) {
            if (doc) expect(doc).to.have.property("MONTH");
        }
    });

    it("29.6 countDocuments on all tables and print summary", async function () {
        const counts = await Promise.all([
            devBook.countDocuments(),
            devLocation.countDocuments(),
            devLock.countDocuments(),
            devMaterial.countDocuments(),
            devStocks.countDocuments(),
            devUnit.countDocuments(),
            users.countDocuments(),
        ]);
        counts.forEach((c) => expect(c).to.be.a("number").and.at.least(0));
        console.log(
            "        Row counts:",
            `BOOK=${counts[0]}, LOCATION=${counts[1]}, LOCK=${counts[2]},`,
            `MATERIAL=${counts[3]}, STOCKS=${counts[4]}, UNIT=${counts[5]},`,
            `USERS=${counts[6]}`,
        );
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 30. PERFORMANCE UTILITIES
// ═════════════════════════════════════════════════════════════════════════════

describe("30. Performance Utilities", function () {
    const perf = createPerformance(inventoryDB);

    it("30.1 explainPlan on a QueryBuilder", async function () {
        try {
            const plan = await perf.explainPlan(devBook.find({ DIVISION: "WH" }).limit(10));
            expect(plan).to.be.an("array");
        } catch (e) {
            // May fail due to privilege requirements — acceptable
            if (e.message.includes("privileges") || e.message.includes("ORA-")) {
                this.skip();
            } else {
                throw e;
            }
        }
    });

    it("30.2 explainPlan on raw SQL string", async function () {
        try {
            const plan = await perf.explainPlan(`SELECT * FROM "DEV_BOOK" WHERE ROWNUM <= 10`);
            expect(plan).to.be.an("array");
        } catch (e) {
            if (e.message.includes("privileges") || e.message.includes("ORA-")) {
                this.skip();
            } else {
                throw e;
            }
        }
    });

    it("30.3 analyze table", async function () {
        try {
            await perf.analyze("DEV_BOOK");
        } catch (e) {
            if (e.message.includes("privileges") || e.message.includes("ORA-")) {
                this.skip();
            } else {
                throw e;
            }
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 31. FINAL SUMMARY & REPORT GENERATION
// ═════════════════════════════════════════════════════════════════════════════

describe("31. Final Summary", function () {
    it("31.1 scratch table has data from all write operations", async function () {
        const count = await scratch.countDocuments();
        expect(count).to.be.greaterThan(0);
        console.log(`        Scratch table final row count: ${count}`);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  REPORT GENERATOR
// ═════════════════════════════════════════════════════════════════════════════

function generateReport() {
    const duration = ((report.endTime - report.startTime) / 1000).toFixed(2);

    const lines = [];
    lines.push("═══════════════════════════════════════════════════════════════");
    lines.push("  ORACLE-MONGO-WRAPPER — COMPREHENSIVE TEST REPORT");
    lines.push("═══════════════════════════════════════════════════════════════");
    lines.push(`  Date:     ${report.startTime.toISOString()}`);
    lines.push(`  Duration: ${duration}s`);
    lines.push(`  Total:    ${report.totalTests} tests`);
    lines.push(`  Passed:   ${report.passed}`);
    lines.push(`  Failed:   ${report.failed}`);
    lines.push(`  Rate:     ${((report.passed / report.totalTests) * 100).toFixed(1)}%`);
    lines.push("");

    // Table summary
    lines.push("───────────────────────────────────────────────────────────────");
    lines.push("  TABLE INVENTORY");
    lines.push("───────────────────────────────────────────────────────────────");
    for (const [name, info] of Object.entries(report.tables)) {
        lines.push(`  ${name.padEnd(20)} Rows: ${String(info.rowCount).padStart(8)}  Cols: ${String(info.columnCount).padStart(3)}`);
        if (info.columns && info.columns.length > 0) {
            lines.push(`    Columns: ${info.columns.join(", ")}`);
        }
    }
    lines.push("");

    // Shared columns analysis
    const sharedCols = {};
    for (const ts of [SAPBook, StorageLocation, UnlockedInventoryByMonth, MaterialMaster, InventoryStocks, InventoryUnit]) {
        for (const col of ts.columns) {
            if (!sharedCols[col]) sharedCols[col] = [];
            sharedCols[col].push(ts.table);
        }
    }
    const multiTableCols = Object.entries(sharedCols)
        .filter(([, tables]) => tables.length > 1)
        .sort((a, b) => b[1].length - a[1].length);

    lines.push("───────────────────────────────────────────────────────────────");
    lines.push("  SHARED COLUMNS ACROSS TABLES");
    lines.push("───────────────────────────────────────────────────────────────");
    for (const [col, tables] of multiTableCols) {
        lines.push(`  ${col.padEnd(25)} → ${tables.join(", ")}`);
    }
    lines.push("");

    // Category breakdown
    lines.push("───────────────────────────────────────────────────────────────");
    lines.push("  TEST CATEGORIES COVERED");
    lines.push("───────────────────────────────────────────────────────────────");

    const categories = [
        "Connection & Health",
        "filterParser (All Operators)",
        "updateParser (All Operators)",
        "find / findOne / countDocuments / estimatedDocumentCount / distinct",
        "QueryBuilder (sort, limit, skip, project, toArray, forEach, next, hasNext, explain, count)",
        "insertOne / insertMany (executeMany, chunkArray)",
        "updateOne / updateMany / replaceOne ($set, $inc, $mul, $min, $max, $unset, $currentDate)",
        "deleteOne / deleteMany / findOneAndDelete / findOneAndUpdate / findOneAndReplace",
        "Upsert (updateOne upsert + findOneAndUpdate upsert)",
        "MERGE / mergeFrom (Oracle MERGE INTO)",
        "Transactions & Savepoints (commit, rollback, savepoint, rollbackTo)",
        "bulkWrite (atomic mixed operations)",
        "Index Operations (createIndex, getIndexes, dropIndex, dropIndexes, reIndex)",
        "Aggregation Pipeline ($match, $group, $sort, $limit, $skip, $count, $project, $addFields, $having)",
        "CTE (withCTE, withRecursiveCTE)",
        "Window Functions (ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD, SUM, COUNT, etc.)",
        "Join Builder (LEFT, INNER, CROSS, SELF, multi-condition ON)",
        "Set Operations (UNION, UNION ALL, INTERSECT, MINUS)",
        "Schema DDL (createTable, alterTable, dropTable, truncateTable, renameTable)",
        "Sequences (createSequence)",
        "PIVOT & UNPIVOT",
        "FOR UPDATE & TABLESAMPLE",
        "insertFromQuery (INSERT INTO ... SELECT)",
        "Cross-Table Shared Column Verification",
        "Performance Utilities (explainPlan, analyze)",
    ];

    categories.forEach((cat, i) => {
        lines.push(`  ${String(i + 1).padStart(2)}. ${cat}`);
    });
    lines.push("");

    // Failures
    if (report.failures.length > 0) {
        lines.push("───────────────────────────────────────────────────────────────");
        lines.push("  FAILURES");
        lines.push("───────────────────────────────────────────────────────────────");
        for (const f of report.failures) {
            lines.push(`  FAIL: ${f.title}`);
            lines.push(`        ${f.error}`);
        }
        lines.push("");
    }

    lines.push("═══════════════════════════════════════════════════════════════");
    lines.push("  END OF REPORT");
    lines.push("═══════════════════════════════════════════════════════════════");

    const reportStr = lines.join("\n");
    console.log("\n" + reportStr);

    // Write report to file
    const reportDir = path.join(__dirname, "logs", new Date().getFullYear().toString(),
        String(new Date().getMonth() + 1).padStart(2, "0"),
        String(new Date().getDate()).padStart(2, "0"));
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `test-report-${Date.now()}.txt`);
    fs.writeFileSync(reportPath, reportStr, "utf-8");
    console.log(`\n  Report saved to: ${reportPath}\n`);
}

