/**
 * INTEGRATION — typed tables (Mira 2.1) against the live schema:
 *   - create() from a definition, then typed CRUD (values come back as the row type says)
 *   - on(session) inside a transaction
 *   - the generator round trip: definition → table → catalogue → generated code →
 *     import it → the same ddl()
 *   - the `mira generate types` command line
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineTable, t, generateTableTypes, Transaction, type TypedTable } from "../../src/utils/oracle-mongo-wrapper";
import { db, dropIfExists } from "../helpers/db";

const P = "MIRA_TT_PARENT";
const C = "MIRA_TT_ORDERS";

// The parent's key is an identity BY DEFAULT: Oracle assigns it unless the insert gives one.
const Parents = defineTable(P, { ID: t.number(10).identityByDefault().primaryKey(), NAME: t.text(50, "char") });
const Orders = defineTable(C, {
  ID: t.id(),
  PARENT_ID: t.number().references(Parents, "ID"),
  TOTAL: t.money(),
  RATE: t.decimal(9, 6).nullable(),
  QTY: t.number(5),
  NOTE: t.text(400).nullable(),
  STATUS: t.text(10).default("'open'"),
  CODE: t.char(3).nullable(),
  CREATED_AT: t.timestamp().default("SYSTIMESTAMP"),
  DUE: t.date().nullable(),
  AT: t.timestamp(3).nullable(),
  AT_TZ: t.timestampTz(3).nullable(),
  DOC: t.clob().nullable(),
  PHOTO: t.blob().nullable(),
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-tt-"));
const srcIndex = path.resolve(import.meta.dir, "../../src/utils/oracle-mongo-wrapper/index.ts").replace(/\\/g, "/");

beforeAll(async () => {
  await dropIfExists(C, P);
  await Parents.create(db);
  await Orders.create(db);
  await Parents.on(db).insertMany([{ NAME: "Ñandú" }, { NAME: "Bea" }, { ID: 900, NAME: "Given" }]);
});
afterAll(async () => {
  await dropIfExists(C, P);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("typed tables: create() and typed CRUD", () => {
  const orders = Orders.on(db);

  it("insert without the identity column; defaults fill in; money and decimals come back exact", async () => {
    const res = await orders.insertOne({ PARENT_ID: 1, TOTAL: "1234567890.1234", QTY: 2, RATE: 0.125, NOTE: null });
    expect(res.acknowledged).toBe(true);
    await orders.insertMany([
      { PARENT_ID: 2, TOTAL: 10, QTY: 1, STATUS: "paid", DUE: new Date("2026-12-01T00:00:00Z"), DOC: "x".repeat(5000), PHOTO: Buffer.from([1, 2, 3]) },
      { PARENT_ID: 900, TOTAL: "0.5", QTY: 3, CODE: "ABC", AT: new Date("2026-05-06T07:08:09.123Z") },
    ]);
    const rows = await orders.find({}).sort({ ID: 1 }).toArray();
    expect(rows.map((r) => r.ID)).toEqual([1, 2, 3]);
    expect(rows[0].TOTAL).toBe("1234567890.1234");
    // Exact decimal string as Oracle writes it: no leading zero (2.0 behaviour, unchanged here).
    expect(rows[0].RATE).toBe(".125");
    expect(rows[0].STATUS).toBe("open");
    expect(rows[0].CREATED_AT).toBeInstanceOf(Date);
    expect(rows[1].DOC).toHaveLength(5000);
    expect(Buffer.isBuffer(rows[1].PHOTO) && rows[1].PHOTO.equals(Buffer.from([1, 2, 3]))).toBe(true);
    // identity BY DEFAULT: Oracle assigned 1 and 2, and took the given 900
    expect((await Parents.on(db).find({}).sort({ ID: 1 }).toArray()).map((p) => [p.ID, p.NAME])).toEqual([[1, "Ñandú"], [2, "Bea"], [900, "Given"]]);
    expect(rows[2].CODE).toBe("ABC");
    expect(rows[2].AT?.getTime()).toBe(new Date("2026-05-06T07:08:09.123Z").getTime());
  });

  it("filters, sort, projection, findOne, distinct, count", async () => {
    const big = await orders.find({ TOTAL: { $gt: 5 }, NOTE: null }).sort({ TOTAL: -1 }).project({ ID: 1, TOTAL: 1 }).toArray();
    expect(big).toEqual([{ ID: 1, TOTAL: "1234567890.1234" }, { ID: 2, TOTAL: "10" }]);
    expect((await orders.findOne({ STATUS: "paid" }))?.ID).toBe(2);
    expect((await orders.distinct("STATUS")).sort()).toEqual(["open", "paid"]);
    expect(await orders.countDocuments({ $or: [{ STATUS: "paid" }, { QTY: { $gte: 3 } }] })).toBe(2);
    expect(await orders.find({ CODE: { $like: "AB%" } }).count()).toBe(1);
  });

  it("update and delete with typed operators", async () => {
    await orders.updateOne({ ID: 2 }, { $inc: { QTY: 4 }, $set: { NOTE: "rush" } });
    const two = await orders.findOne({ ID: 2 });
    expect([two?.QTY, two?.NOTE]).toEqual([5, "rush"]);
    expect((await orders.deleteMany({ STATUS: "open", TOTAL: { $lt: 1 } })).deletedCount).toBe(1);
    expect(await orders.countDocuments()).toBe(2);
  });

  it("on(session) works inside a transaction, and rolls back with it", async () => {
    await expect(
      new Transaction(db).withTransaction(async (session) => {
        const o = Orders.on(session);
        await o.insertOne({ PARENT_ID: 1, TOTAL: 1, QTY: 1 });
        expect(await o.countDocuments()).toBe(3);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect(await orders.countDocuments()).toBe(2);
  });

  it("the foreign key from references() is enforced", async () => {
    await expect(orders.insertOne({ PARENT_ID: 999, TOTAL: 1, QTY: 1 })).rejects.toThrow(/ORA-02291/);
  });

  it("aggregate takes a named row type; untyped is the 2.0 API", async () => {
    const g = await orders.aggregate<{ STATUS: string; N: number }>([{ $group: { _id: "$STATUS", N: { $count: "*" } } }, { $sort: { STATUS: 1 } }]);
    expect(g.map((r) => [r.STATUS, Number(r.N)])).toEqual([["open", 1], ["paid", 1]]);
    expect(await orders.untyped.find({ STATUS: "paid" }).count()).toBe(1);
  });
});

describe("typed tables: generator round trip", () => {
  it("definition → table → catalogue → generated code → the same ddl()", async () => {
    const code = await generateTableTypes(db, { tables: [P, C], importFrom: srcIndex });
    const file = path.join(tmp, "tables.ts");
    fs.writeFileSync(file, code);
    const mod = (await import(pathToFileURL(file).href)) as Record<string, TypedTable<never>>;
    expect(Object.keys(mod).sort()).toEqual(["MiraTtOrders", "MiraTtParent"]);
    expect(mod.MiraTtParent.ddl()).toEqual(Parents.ddl());
    // NUMBER(5) reads back as NUMBER(5); every other column text is identical.
    expect(mod.MiraTtOrders.ddl()).toEqual(Orders.ddl());
    expect(Object.keys(mod.MiraTtOrders.columns)).toEqual(Object.keys(Orders.columns));
  });

  it("the generated definition works as a typed collection", async () => {
    const code = await generateTableTypes(db, { tables: ["MIRA_TT_%"], importFrom: srcIndex });
    const file = path.join(tmp, "pattern.ts");
    fs.writeFileSync(file, code);
    const mod = (await import(pathToFileURL(file).href)) as Record<string, TypedTable<never>>;
    expect(Object.keys(mod).sort()).toEqual(["MiraTtOrders", "MiraTtParent"]);
    expect(await mod.MiraTtOrders.on(db).countDocuments()).toBe(2);
  });
});

describe("typed tables: `mira generate types` command line", () => {
  const cli = path.resolve(import.meta.dir, "../../src/cli/mira.ts");
  const run = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", cli, ...args], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  it("writes the module to --out", () => {
    const out = path.join(tmp, "cli", "tables.ts");
    const r = run("generate", "types", "--tables", `${P},${C}`, "--out", out, "--import", srcIndex);
    expect(r.code).toBe(0);
    expect(r.err).toContain("wrote 2 table definition(s)");
    const code = fs.readFileSync(out, "utf8");
    expect(code).toContain(`export const MiraTtOrders = defineTable("${C}", {`);
    expect(code).toContain(`import { defineTable, t } from "${srcIndex}";`);
  });

  it("prints to stdout, with no log lines mixed in", () => {
    const r = run("generate", "types", `--tables=${P}`, "--env", path.resolve(import.meta.dir, "../../.env.example"));
    expect(r.code).toBe(0);
    expect(r.out.startsWith("// Generated by `mira generate types`")).toBe(true);
    expect(r.out).toContain("export const MiraTtParent");
  });

  it("usage, help and errors", () => {
    const bad = run("generate", "stuff");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("Usage:");
    const help = run("--help");
    expect(help.code).toBe(0);
    expect(help.out).toContain("--tables");
    const noValue = run("generate", "types", "--out");
    expect(noValue.code).toBe(1);
    expect(noValue.err).toContain("--out needs a value");
    const noEnv = run("generate", "types", "--env", path.join(tmp, "missing.env"));
    expect(noEnv.code).toBe(1);
    expect(noEnv.err).toContain("env file not found");
  });
});
