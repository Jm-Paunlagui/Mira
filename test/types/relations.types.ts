/**
 * TYPE TESTS for relations and include() (Mira 2.1). Checked by `bun run typecheck`, never run.
 */
import { defineTable, t, relations, hasMany, hasOne, belongsTo, type NestedRow } from "../../src";
import { db } from "./_db";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>(_ok?: T) => {};

const Customers = defineTable("CUSTOMERS", { ID: t.id(), NAME: t.text(30), CITY: t.text(30).nullable() });
const Orders = defineTable("ORDERS", { ID: t.id(), CUSTOMER_ID: t.number(), TOTAL: t.money(), PIC: t.blob().nullable() });
const CustomersR = relations(Customers, {
  orders: hasMany(Orders, { foreignKey: "CUSTOMER_ID" }),
  biggest: hasOne(Orders, { foreignKey: "CUSTOMER_ID" }),
});
const OrdersR = relations(Orders, { customer: belongsTo(Customers, { foreignKey: "CUSTOMER_ID" }) });

type Order = { ID: number; CUSTOMER_ID: number; TOTAL: string }; // PIC (BLOB) is left out of related rows
assert<Equal<NestedRow<typeof Orders.columns>, Order>>();


async function usage() {
  const withOrders = await CustomersR.on(db).find({ CITY: null }).include("orders", { where: { TOTAL: { $gt: 100 } }, sort: { ID: -1 }, limit: 5 }).toArray();
  assert<Equal<typeof withOrders, Array<{ ID: number; NAME: string; CITY: string | null; orders: Order[] }>>>();

  const both = await CustomersR.on(db).find().include("orders").include("biggest", { sort: { TOTAL: -1 } }).project({ NAME: 1 }).next();
  assert<Equal<typeof both, { NAME: string; orders: Order[]; biggest: Order | null } | null>>();

  const withCustomer = await OrdersR.on(db).find().include("customer");
  assert<Equal<typeof withCustomer, Array<{ ID: number; CUSTOMER_ID: number; TOTAL: string; PIC: Buffer | null; customer: { ID: number; NAME: string; CITY: string | null } | null }>>>();

  await CustomersR.on(db).find().include("orders").forEach((r) => assert<Equal<typeof r.orders, Order[]>>());

  // @ts-expect-error no such relation
  CustomersR.on(db).find().include("payments");
  // @ts-expect-error limit applies to hasMany only
  CustomersR.on(db).find().include("biggest", { limit: 1 });
  // @ts-expect-error where is checked against the related table
  CustomersR.on(db).find().include("orders", { where: { NAME: "x" } });
  // @ts-expect-error sort is checked against the related table
  CustomersR.on(db).find().include("orders", { sort: { NAME: 1 } });
  // @ts-expect-error a table without relations has nothing to include
  Customers.on(db).find().include("orders");
  // @ts-expect-error a relation is not a column: it cannot be projected
  CustomersR.on(db).find().include("orders").project({ orders: 1 });
  // @ts-expect-error hasMany's foreign key is a column of the related table
  hasMany(Orders, { foreignKey: "NAME" });
  // @ts-expect-error belongsTo's references is a column of the related table
  belongsTo(Customers, { foreignKey: "CUSTOMER_ID", references: "TOTAL" });
}
void usage;
