/**
 * TYPE TESTS for typed tables (Mira 2.1). Checked by `bun run typecheck`, never run.
 * Every line marked @ts-expect-error must be a compile error; everything else must
 * compile. An exact-type assertion (`Equal`) fails the build when an inferred type drifts.
 */
import { defineTable, t, Transaction, type RowOf, type InsertOf } from "../../src";
import { db } from "./_db";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>(_ok?: T) => {};

const Customers = defineTable("CUSTOMERS", { ID: t.id(), NAME: t.text(100) });
const Orders = defineTable("ORDERS", {
  ID: t.id(),
  CUSTOMER_ID: t.number().references(Customers, "ID"),
  TOTAL: t.money(),
  QTY: t.number(5),
  RATE: t.decimal(9, 6),
  NOTE: t.text(400).nullable(),
  STATUS: t.text(10).default("'open'"),
  CREATED_AT: t.timestamp().default("SYSTIMESTAMP"),
  DOC: t.clob().nullable(),
  PHOTO: t.blob().nullable(),
  KIND: t.raw<"a" | "b">("VARCHAR2(1)"),
});

// ── Row: what Mira returns ──────────────────────────────────────────────────
type Order = typeof Orders.$row;
assert<Equal<Order, {
  ID: number; CUSTOMER_ID: number; TOTAL: string; QTY: number; RATE: string; NOTE: string | null;
  STATUS: string; CREATED_AT: Date; DOC: string | null; PHOTO: Buffer | null; KIND: "a" | "b";
}>>();
assert<Equal<RowOf<typeof Orders.columns>, Order>>();

// ── Insert: identity left out; nullable, defaulted and BY DEFAULT optional ──
type NewOrder = typeof Orders.$insert;
assert<Equal<NewOrder, InsertOf<typeof Orders.columns>>>();
assert<Equal<NewOrder, {
  CUSTOMER_ID: number; TOTAL: string | number; QTY: number; RATE: string | number; KIND: "a" | "b";
  NOTE?: string | null; STATUS?: string; CREATED_AT?: Date; DOC?: string | null; PHOTO?: Buffer | null;
}>>();

// Identity BY DEFAULT (one identity per table): optional on insert, a number when read.
const Tickets = defineTable("TICKETS", { NO: t.number(10).identityByDefault().primaryKey(), TITLE: t.text(50) });
assert<Equal<typeof Tickets.$insert, { TITLE: string; NO?: number }>>();
assert<Equal<typeof Tickets.$row, { NO: number; TITLE: string }>>();

const orders = Orders.on(db);

async function usage() {
  // inserts
  await orders.insertOne({ CUSTOMER_ID: 1, TOTAL: 9.5, QTY: 1, RATE: "0.5", KIND: "a" });
  await orders.insertOne({ CUSTOMER_ID: 1, TOTAL: "9.50", QTY: 1, RATE: 1, KIND: "b", NOTE: null, STATUS: "paid" });
  await orders.insertMany([{ CUSTOMER_ID: 1, TOTAL: 1, QTY: 1, RATE: 1, KIND: "a" }]);
  // @ts-expect-error ID is an identity column: Oracle assigns it
  await orders.insertOne({ ID: 5, CUSTOMER_ID: 1, TOTAL: 1, QTY: 1, RATE: 1, KIND: "a" });
  // @ts-expect-error TOTAL is required
  await orders.insertOne({ CUSTOMER_ID: 1, QTY: 1, RATE: 1, KIND: "a" });
  // @ts-expect-error QTY is a number column
  await orders.insertOne({ CUSTOMER_ID: 1, TOTAL: 1, QTY: "one", RATE: 1, KIND: "a" });
  // @ts-expect-error unknown column
  await orders.insertOne({ CUSTOMER_ID: 1, TOTAL: 1, QTY: 1, RATE: 1, KIND: "a", TOTL: 1 });
  // @ts-expect-error STATUS is NOT NULL (it has a default, but null is not a value for it)
  await orders.insertOne({ CUSTOMER_ID: 1, TOTAL: 1, QTY: 1, RATE: 1, KIND: "a", STATUS: null });
  // @ts-expect-error KIND only takes "a" | "b"
  await orders.insertOne({ CUSTOMER_ID: 1, TOTAL: 1, QTY: 1, RATE: 1, KIND: "c" });

  // reads
  const all = await orders.find({ TOTAL: { $gt: 100 }, NOTE: null, STATUS: { $in: ["open", "paid"] } }).sort({ CREATED_AT: -1, NOTE: { order: 1, nulls: "last" } }).limit(5, { withTies: true }).toArray();
  assert<Equal<typeof all, Order[]>>();
  const slim = await orders.find({ QTY: { $between: [1, 10] } }).project({ ID: 1, TOTAL: 1 }).toArray();
  assert<Equal<typeof slim, { ID: number; TOTAL: string }[]>>();
  const noDoc = await orders.find().project({ DOC: 0, PHOTO: 0 }).next();
  assert<Equal<typeof noDoc, Omit<Order, "DOC" | "PHOTO"> | null>>();
  const awaited = await orders.find({ $or: [{ STATUS: "open" }, { NOTE: { $like: "%rush%" } }] });
  assert<Equal<typeof awaited, Order[]>>();
  const one = await orders.findOne({ ID: 1 });
  assert<Equal<typeof one, Order | null>>();
  const statuses = await orders.distinct("STATUS");
  assert<Equal<typeof statuses, string[]>>();
  await orders.find({}).forEach((r) => { assert<Equal<typeof r, Order>>(); });
  const n: number = await orders.countDocuments({ CREATED_AT: { $lt: new Date() } });
  void n;
  // @ts-expect-error unknown column in a filter
  orders.find({ TOTL: 1 });
  // @ts-expect-error QTY compares with numbers
  orders.find({ QTY: { $gt: "5" } });
  // @ts-expect-error $like is for text columns
  orders.find({ QTY: { $like: "5%" } });
  // @ts-expect-error unknown operator
  orders.find({ QTY: { $gtt: 5 } });
  // @ts-expect-error unknown column in a sort
  orders.find().sort({ TOTL: 1 });
  // @ts-expect-error unknown column in a projection
  orders.find().project({ TOTL: 1 });

  // updates and deletes
  await orders.updateOne({ ID: 1 }, { $set: { STATUS: "paid", NOTE: null }, $inc: { QTY: 1 }, $currentDate: { CREATED_AT: true } });
  await orders.updateMany({ STATUS: "open" }, { $mul: { TOTAL: 1.1 } }, { returning: ["ID"] });
  // @ts-expect-error $inc needs a numeric column
  await orders.updateOne({ ID: 1 }, { $inc: { STATUS: 1 } });
  // @ts-expect-error $currentDate needs a date column
  await orders.updateOne({ ID: 1 }, { $currentDate: { STATUS: true } });
  // @ts-expect-error $set checks value types
  await orders.updateOne({ ID: 1 }, { $set: { QTY: "x" } });
  await orders.deleteMany({ STATUS: { $ne: "open" } });

  // aggregates are untyped unless named
  const g = await orders.aggregate<{ STATUS: string; N: number }>([{ $group: { _id: "$STATUS", N: { $count: "*" } } }]);
  assert<Equal<typeof g, { STATUS: string; N: number }[]>>();

  // the untyped escape hatch is the 2.0 API
  await orders.untyped.find({ ANYTHING: 1 }).toArray();
  await orders.find().untyped.project({ X: { $subquery: { collection: "O", fn: "count" } } }).toArray();

  // in a transaction
  await new Transaction(db).withTransaction(async (session) => {
    const o = Orders.on(session);
    await o.insertOne({ CUSTOMER_ID: 1, TOTAL: 1, QTY: 1, RATE: 1, KIND: "a" });
    // @ts-expect-error still typed inside the session
    await o.insertOne({ CUSTOMER_ID: 1 });
  });
}
void usage;

// ── builders ────────────────────────────────────────────────────────────────
// @ts-expect-error the column map must hold column builders
defineTable("X", { A: "NUMBER" });
