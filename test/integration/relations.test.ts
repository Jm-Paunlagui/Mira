/**
 * INTEGRATION — relations and include() (Mira 2.1) against the live schema.
 * Every expected value is built from the rows inserted here.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { defineTable, t, relations, hasMany, hasOne, belongsTo, Transaction, OracleCollection } from "../../src";
import { db, dropIfExists } from "../helpers/db";

const Customers = defineTable("MIRA_RL_CUSTOMERS", { ID: t.id(), NAME: t.text(30), CITY: t.text(30).nullable() });
const Orders = defineTable("MIRA_RL_ORDERS", {
  ID: t.id(),
  CUSTOMER_ID: t.number().references(Customers, "ID"),
  TOTAL: t.money(),
  RATE: t.decimal(9, 6).nullable(),
  STATUS: t.text(10).default("'open'"),
  AT: t.timestamp(3),
  DAY: t.date(),
  AT_TZ: t.timestampTz(3).nullable(),
  NOTE: t.clob().nullable(),
  PIC: t.blob().nullable(),
});
const CustomersR = relations(Customers, {
  orders: hasMany(Orders, { foreignKey: "CUSTOMER_ID" }),
  biggest: hasOne(Orders, { foreignKey: "CUSTOMER_ID" }),
});
const OrdersR = relations(Orders, { customer: belongsTo(Customers, { foreignKey: "CUSTOMER_ID" }) });

type O = { ID: number; CUSTOMER_ID: number; TOTAL: string; STATUS: string };
const at = (d: number) => new Date(Date.UTC(2026, 0, d, 8, 30, 15, 250));
// Customer 1: three orders, customer 2: one, customer 3: none.
const ORDERS = [
  { CUSTOMER_ID: 1, TOTAL: "10.5", STATUS: "paid", AT: at(1), DAY: at(1) },
  { CUSTOMER_ID: 1, TOTAL: 250, STATUS: "open", AT: at(2), DAY: at(2), RATE: 0.125 },
  { CUSTOMER_ID: 1, TOTAL: "99.9999", STATUS: "paid", AT: at(3), DAY: at(3), NOTE: "n".repeat(6000), PIC: Buffer.from([1, 2]) },
  { CUSTOMER_ID: 2, TOTAL: 5, STATUS: "paid", AT: at(4), DAY: at(4), AT_TZ: at(4) },
];

beforeAll(async () => {
  await dropIfExists(Orders.name, Customers.name);
  await Customers.create(db);
  await Orders.create(db);
  await Customers.on(db).insertMany([{ NAME: "Ana", CITY: "Cebu" }, { NAME: "Bea", CITY: null }, { NAME: "Cy" }]);
  await Orders.on(db).insertMany(ORDERS);
});
afterAll(() => dropIfExists(Orders.name, Customers.name));

describe("relations: include()", () => {
  it("hasMany: every parent row with its related rows, in one statement; none gives []", async () => {
    const q = CustomersR.on(db).find().sort({ ID: 1 }).include("orders", { sort: { ID: 1 } });
    expect((q.untyped._buildSQL().sql.match(/\bSELECT\b/g) ?? []).length).toBe(2); // the parent query + one subquery
    const rows = await q.toArray();
    expect(rows.map((r) => [r.NAME, r.orders.map((o) => o.ID)])).toEqual([["Ana", [1, 2, 3]], ["Bea", [4]], ["Cy", []]]);
  });

  it("related rows keep Mira's types: exact money text, Date columns, CLOB text; BLOB left out", async () => {
    const [ana] = await CustomersR.on(db).find({ ID: 1 }).include("orders", { sort: { ID: 1 } }).toArray();
    expect(ana.orders.map((o) => o.TOTAL)).toEqual(["10.5", "250", "99.9999"]);
    expect(ana.orders.map((o) => o.RATE)).toEqual([null, ".125", null]);
    expect(ana.orders.map((o) => o.STATUS)).toEqual(["paid", "open", "paid"]);
    expect(ana.orders.map((o) => o.AT.getTime())).toEqual([at(1), at(2), at(3)].map((d) => d.getTime()));
    expect(ana.orders[0].DAY.getTime()).toBe(Math.floor(at(1).getTime() / 1000) * 1000); // DATE: no fractions
    expect(ana.orders[2].NOTE).toHaveLength(6000);
    expect("PIC" in ana.orders[2]).toBe(false);
    // The same values as a top-level read of the same rows
    const direct = await Orders.on(db).find({ CUSTOMER_ID: 1 }).sort({ ID: 1 }).project({ TOTAL: 1, RATE: 1, AT: 1 }).toArray();
    expect(ana.orders.map((o) => [o.TOTAL, o.RATE, o.AT.getTime()])).toEqual(direct.map((o) => [o.TOTAL, o.RATE, o.AT.getTime()]));
  });

  it("TIMESTAMP WITH TIME ZONE: the same instant as a direct read of the row", async () => {
    // Compared with a direct read, not with at(4): what is stored depends on the session
    // time zone (Thick mode before the +00:00 session fix), not on include().
    const [bea] = await CustomersR.on(db).find({ ID: 2 }).include("orders").toArray();
    const direct = await Orders.on(db).findOne({ ID: 4 });
    expect(bea.orders[0].AT_TZ?.getTime()).toBe(direct?.AT_TZ?.getTime());
    expect(bea.orders[0].AT_TZ).toBeInstanceOf(Date);
  });

  it("sort, limit and where apply per parent row", async () => {
    const rows = await CustomersR.on(db).find({ ID: { $in: [1, 2] } }).sort({ ID: 1 }).include("orders", { where: { STATUS: "paid" }, sort: { TOTAL: -1 }, limit: 1 }).toArray();
    expect(rows.map((r) => r.orders.map((o) => [o.ID, o.TOTAL]))).toEqual([[[3, "99.9999"]], [[4, "5"]]]);
    const two = await CustomersR.on(db).find({ ID: 1 }).include("orders", { sort: { AT: { order: -1, nulls: "last" } }, limit: 2 }).toArray();
    expect(two[0].orders.map((o) => o.ID)).toEqual([3, 2]);
    const unsorted = await CustomersR.on(db).find({ ID: 1 }).include("orders", { limit: 2 }).toArray();
    expect(unsorted[0].orders).toHaveLength(2);
  });

  it("hasOne: the first related row by sort, or null", async () => {
    const rows = await CustomersR.on(db).find().sort({ ID: 1 }).include("biggest", { sort: { TOTAL: -1 } }).toArray();
    expect(rows.map((r) => r.biggest?.ID ?? null)).toEqual([2, 4, null]);
    const openOnly = await CustomersR.on(db).find().sort({ ID: 1 }).include("biggest", { where: { STATUS: "open" } }).toArray();
    expect(openOnly.map((r) => r.biggest?.ID ?? null)).toEqual([2, null, null]);
  });

  it("belongsTo: the row it points at, with a projection on the parent", async () => {
    const rows = await OrdersR.on(db).find({ ID: { $in: [1, 4] } }).sort({ ID: 1 }).project({ ID: 1, TOTAL: 1 }).include("customer").toArray();
    expect(rows).toEqual([
      { ID: 1, TOTAL: "10.5", customer: { ID: 1, NAME: "Ana", CITY: "Cebu" } },
      { ID: 4, TOTAL: "5", customer: { ID: 2, NAME: "Bea", CITY: null } },
    ]);
  });

  it("several includes, a parent filter, skip and limit together; binds stay apart", async () => {
    const rows = await CustomersR.on(db)
      .find({ NAME: { $in: ["Ana", "Bea", "Cy"] }, CITY: { $ne: null } })
      .sort({ ID: 1 })
      .skip(0)
      .limit(5)
      .include("orders", { where: { STATUS: "paid", TOTAL: { $gt: 1 } } })
      .include("biggest", { where: { STATUS: "open" } })
      .toArray();
    expect(rows.map((r) => [r.NAME, r.orders.length, r.biggest?.ID ?? null])).toEqual([["Ana", 2, 2]]);
  });

  it("next(), forEach() and await give included rows too", async () => {
    const one = await CustomersR.on(db).find({ ID: 2 }).include("orders").next();
    expect(one?.orders.map((o) => o.ID)).toEqual([4]);
    const seen: number[] = [];
    await CustomersR.on(db).find().include("orders").forEach((r) => void seen.push(r.orders.length));
    expect(seen.sort()).toEqual([0, 1, 3]);
    const awaited = await OrdersR.on(db).find({ ID: 3 }).include("customer");
    expect(awaited[0].customer?.NAME).toBe("Ana");
  });

  it("inside a transaction, through on(session)", async () => {
    await new Transaction(db).withTransaction(async (session) => {
      await Orders.on(session).insertOne({ CUSTOMER_ID: 3, TOTAL: 1, AT: at(9), DAY: at(9) });
      const [cy] = await CustomersR.on(session).find({ ID: 3 }).include("orders").toArray();
      expect(cy.orders.map((o) => (o as O).TOTAL)).toEqual(["1"]);
      throw new Error("roll back");
    }).catch((e: Error) => expect(e.message).toMatch(/roll back$/));
    const [cy] = await CustomersR.on(db).find({ ID: 3 }).include("orders").toArray();
    expect(cy.orders).toEqual([]);
  });

  it("errors: unknown relation, twice, options that do not apply, no relations at all", async () => {
    const c = CustomersR.on(db);
    expect(() => c.find().include("nope" as never)).toThrow(/has no relation named nope \(it has: orders, biggest\)/);
    expect(() => c.find().include("orders").include("orders")).toThrow(/orders is already included/);
    expect(() => c.find().include("biggest", { limit: 2 } as never).untyped._buildSQL()).toThrow(/limit applies to hasMany relations only/);
    expect(() => c.find().include("orders", { limit: 0 }).untyped._buildSQL()).toThrow(/limit must be a positive integer/);
    expect(() => OrdersR.on(db).find().include("customer", { sort: { ID: 1 } } as never).untyped._buildSQL()).toThrow(/belongsTo relation has one row/);
    expect(() => c.find().include("orders", { sort: { NOPE: 1 } } as never).untyped._buildSQL()).toThrow(/has no column NOPE to sort on/);
    expect(() => new OracleCollection(Customers.name, db).find().include("orders")).toThrow(/has no relation named orders\. Declare relations/);
    expect(() => Customers.on(db).untyped.find().include("orders")).toThrow(/has no relation named orders/);
  });
});

describe("relations: declaring them", () => {
  it("checks names, keys and columns", () => {
    const NoPk = defineTable("MIRA_RL_NOPK", { A: t.number() });
    expect(() => relations(Customers, { "bad name": hasMany(Orders, { foreignKey: "CUSTOMER_ID" }) })).toThrow(/must be an identifier/);
    expect(() => relations(Customers, { NAME: hasMany(Orders, { foreignKey: "CUSTOMER_ID" }) })).toThrow(/already has a column named NAME/);
    expect(() => relations(Customers, { orders: hasMany(Orders, { foreignKey: "NOPE" as never }) })).toThrow(/MIRA_RL_ORDERS has no column NOPE/);
    expect(() => relations(Customers, { orders: hasMany(Orders, { foreignKey: "CUSTOMER_ID", localKey: "NOPE" }) })).toThrow(/MIRA_RL_CUSTOMERS has no column NOPE/);
    expect(() => relations(Orders, { c: belongsTo(Customers, { foreignKey: "NOPE" }) })).toThrow(/MIRA_RL_ORDERS has no column NOPE/);
    expect(() => relations(Orders, { c: belongsTo(NoPk, { foreignKey: "CUSTOMER_ID" }) })).toThrow(/MIRA_RL_NOPK has no primary key; name the key column/);
    expect(() => relations(NoPk, { o: hasMany(Orders, { foreignKey: "CUSTOMER_ID" }) })).toThrow(/has no primary key/);
    expect(() => relations({} as never, {})).toThrow(/must be a defineTable\(\) table/);
    expect(() => relations(Customers, { x: { kind: "manyToMany", target: Orders } as never })).toThrow(/use hasMany\(\), hasOne\(\) or belongsTo\(\)/);
    // explicit keys and the result keeps the table
    const R = relations(NoPk, { o: hasMany(Orders, { foreignKey: "CUSTOMER_ID", localKey: "A" }) });
    expect([R.name, Object.keys(R.columns), R.relations.o]).toEqual([NoPk.name, ["A"], { kind: "hasMany", target: { name: Orders.name, columns: Orders.columns }, foreignKey: "CUSTOMER_ID", key: "A" }]);
    expect(relations(Orders, { c: belongsTo(Customers, { foreignKey: "CUSTOMER_ID", references: "ID" }) }).relations.c.key).toBe("ID");
    expect(CustomersR.ddl()).toEqual(Customers.ddl());
  });
});
