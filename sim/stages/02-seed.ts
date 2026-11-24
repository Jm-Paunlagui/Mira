/**
 * Stage 2 — Open the branches: load stores, menu, customers, staff and stock.
 * Inserts, batch errors, bulkWrite, indexes and views.
 */
import type { Ctx } from "../lib/context";
import { cents, type Sim } from "../lib/harness";
import { CUSTOMERS, EMPLOYEES, PRODUCTS, STORES, T, stockFor, type State } from "../lib/data";

export async function seedStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db, raw, rawCount } = ctx;
  const { model } = state;
  const coll = (t: string) => new api.OracleCollection(t, db);
  const stores = coll(T.STORES);
  const products = coll(T.PRODUCTS);
  const customers = coll(T.CUSTOMERS);
  const employees = coll(T.EMPLOYEES);
  const stock = coll(T.STOCK);

  const s = await stores.insertMany(STORES, { returning: [] });
  sim.eq("insertMany: 3 branches", s.insertedCount, 3);

  const p = await products.insertMany(PRODUCTS.map((x) => ({ ...x, PRICE: x.PRICE / 100 })));
  sim.eq("insertMany: identity ids returned for all 8 menu items", p.insertedIds.length, 8);
  PRODUCTS.forEach((x, i) => model.productIds.set(x.SKU, Number(p.insertedIds[i])));
  const back = await raw<{ SKU: string; PRICE: string; ACTIVE: string }>(`SELECT SKU, PRICE, ACTIVE FROM "${T.PRODUCTS}" ORDER BY ID`);
  sim.eq("insertMany: prices stored exactly, ACTIVE default applied", back.map((r) => [r.SKU, cents(r.PRICE), r.ACTIVE]), PRODUCTS.map((x) => [x.SKU, x.PRICE, "Y"]));

  // First customer through insertOne (identity id + RETURNING), the rest through insertMany.
  const first = await customers.insertOne({ ...CUSTOMERS[0], CREDIT: CUSTOMERS[0].CREDIT / 100 }, { returning: ["ID", "TIER", "CREDIT"] });
  // With a RETURNING list the id comes back as the out-bind's default type (a string); without one, as a number.
  sim.ok("insertOne: identity id returned, equal to the RETURNING ID", Number(first.insertedId) > 0 && Number(first.insertedId) === Number(first.returning?.ID), first);
  sim.eq("insertOne RETURNING: tier and credit read back", [first.returning?.TIER, cents(first.returning?.CREDIT)], ["vip", CUSTOMERS[0].CREDIT]);
  const rest = await customers.insertMany(CUSTOMERS.slice(1).map((c) => ({ ...c, CREDIT: c.CREDIT / 100 })));
  model.customerIds = [Number(first.insertedId), ...rest.insertedIds.map(Number)];
  CUSTOMERS.forEach((c, i) => model.credit.set(model.customerIds[i], c.CREDIT));
  sim.eq("insertMany: 12 customers on file", await rawCount(T.CUSTOMERS), 12);
  const nullCity = await raw<{ N: string }>(`SELECT NAME AS N FROM "${T.CUSTOMERS}" WHERE CITY IS NULL`);
  sim.eq("insertMany: a null city is stored as NULL", nullCity.map((r) => r.N), ["Teresa M."]);

  // Staff: one row repeats an existing id; batchErrors keeps the rest.
  await employees.insertMany(EMPLOYEES.slice(0, 3), { returning: [] });
  const be = await employees.insertMany([...EMPLOYEES.slice(3), { ID: 1, NAME: "Duplicate CEO", MANAGER_ID: null, DEPT: "EXEC", SALARY: 1 }], { returning: [], batchErrors: true });
  sim.eq("insertMany batchErrors: 4 staff inserted, the duplicate refused", [be.insertedCount, be.batchErrors?.length, be.batchErrors?.[0]?.offset], [4, 1, 4]);
  sim.ok("insertMany batchErrors: the refusal is ORA-00001", String(be.batchErrors?.[0]?.message).includes("ORA-00001"), be.batchErrors);
  await sim.rejects("insertMany without batchErrors is all-or-nothing", employees.insertMany([{ ID: 50, NAME: "Temp" }, { ID: 2, NAME: "dup" }], { returning: [] }), /ORA-00001/);
  sim.eq("insertMany all-or-nothing: the good row was not kept", await rawCount(T.EMPLOYEES, "WHERE ID = 50"), 0);

  const rows = STORES.flatMap((st) => PRODUCTS.map((pr) => ({ STORE_ID: st.STORE_ID, PRODUCT_ID: model.productIds.get(pr.SKU), QTY: stockFor(st.STORE_ID, pr.SKU) })));
  for (const st of STORES) for (const pr of PRODUCTS) model.stock.set(model.key(st.STORE_ID, pr.SKU), stockFor(st.STORE_ID, pr.SKU));
  await stock.insertMany(rows, { returning: [] });
  const [{ Q }] = await raw<{ Q: number }>(`SELECT SUM(QTY) AS Q FROM "${T.STOCK}"`);
  sim.eq("insertMany: 24 stock rows with the opening quantities", [await rawCount(T.STOCK), Number(Q)], [24, [...model.stock.values()].reduce((a, b) => a + b, 0)]);
  await sim.rejects("stock check constraint refuses a negative quantity", stock.insertMany([{ STORE_ID: 1, PRODUCT_ID: model.productIds.get("P-ADOBO"), QTY: -1 }], { returning: [] }), /ORA-02290/);

  // A till log has no ID column. insertOne should still work there.
  await new api.OracleSchema(db).createTable(T.TILL_LOG, { TILL: { type: "VARCHAR2(10)" }, NOTE: { type: "VARCHAR2(60)" } });
  try {
    await coll(T.TILL_LOG).insertOne({ TILL: "T1", NOTE: "opened" });
    sim.eq("DEFECT: insertOne on a table without an ID column inserts the row", await rawCount(T.TILL_LOG), 1);
  } catch (e) {
    sim.ok("DEFECT: insertOne on a table without an ID column inserts the row", false, (e as Error).message.split("\n")[0]);
  }

  // Promotions: every bulkWrite operation in one transaction.
  const schema = new api.OracleSchema(db);
  await schema.createTable(T.PROMOS, { ID: { type: "NUMBER", primaryKey: true, autoIncrement: true }, CODE: { type: "VARCHAR2(20)", notNull: true }, PCT: { type: "NUMBER" }, ACTIVE: { type: "VARCHAR2(1)", default: "'Y'" } });
  const promos = coll(T.PROMOS);
  const bw = await promos.bulkWrite([
    { insertOne: { document: { CODE: "RAINY10", PCT: 10 } } },
    { insertOne: { document: { CODE: "PAYDAY15", PCT: 15 } } },
    { insertOne: { document: { CODE: "OLD5", PCT: 5 } } },
    { insertOne: { document: { CODE: "TEMP", PCT: 1 } } },
    { updateOne: { filter: { CODE: "RAINY10" }, update: { $set: { PCT: 12 } } } },
    { updateMany: { filter: { PCT: { $lt: 10 } }, update: { $set: { ACTIVE: "N" } } } },
    { replaceOne: { filter: { CODE: "PAYDAY15" }, replacement: { CODE: "PAYDAY20", PCT: 20, ACTIVE: "Y" } } },
    { deleteOne: { filter: { CODE: "TEMP" } } },
    { deleteMany: { filter: { ACTIVE: "N" } } },
  ]);
  sim.eq("bulkWrite: one result per operation", bw.results.length, 9);
  const promoRows = await raw<{ CODE: string; PCT: number; ACTIVE: string }>(`SELECT CODE, PCT, ACTIVE FROM "${T.PROMOS}" ORDER BY CODE`);
  sim.eq("bulkWrite: final promotions", promoRows.map((r) => [r.CODE, Number(r.PCT), r.ACTIVE]), [["PAYDAY20", 20, "Y"], ["RAINY10", 12, "Y"]]);
  await sim.rejects("bulkWrite: a failing op rolls the whole batch back", promos.bulkWrite([{ insertOne: { document: { CODE: "GHOST", PCT: 1 } } }, { insertOne: { document: { CODE: null } } }]), /ORA-01400/);
  sim.eq("bulkWrite rollback: GHOST was not kept", await rawCount(T.PROMOS, "WHERE CODE = 'GHOST'"), 0);

  // Indexes.
  const ux = await customers.createIndex({ EMAIL: 1 }, { unique: true, name: "UX_SIM_CUST_EMAIL" });
  sim.eq("createIndex: named unique index", ux.indexName, "UX_SIM_CUST_EMAIL");
  await sim.rejects("unique index refuses a second customer with the same email", customers.insertOne({ NAME: "Copy", EMAIL: "juan@canteen.sim" }), /ORA-00001/);
  const many = await coll(T.ORDERS).createIndexes([{ fields: { CUSTOMER_ID: 1 } }, { fields: { STORE_ID: 1, QUARTER: -1 }, options: { name: "IX_SIM_ORD_STORE_Q" } }]);
  sim.eq("createIndexes: default and custom names", many.indexNames, [`IDX_${T.ORDERS}_CUSTOMER_ID`, "IX_SIM_ORD_STORE_Q"]);
  await stock.createIndex({ QTY: 1 }, { type: "bitmap", name: "BX_SIM_STOCK_QTY" });
  const idx = await coll(T.ORDERS).getIndexes();
  const storeQ = idx.find((i) => i.indexName === "IX_SIM_ORD_STORE_Q");
  sim.eq("getIndexes: composite index has two columns, store first", [storeQ?.columns.length, storeQ?.columns[0]], [2, "STORE_ID"]);
  sim.eq("DEFECT: getIndexes names a descending column (not Oracle's hidden SYS_NC column)", storeQ?.columns, ["STORE_ID", "QUARTER"]);
  sim.ok("getIndexes: the bitmap index reports its type", (await stock.getIndexes()).some((i) => i.indexName === "BX_SIM_STOCK_QTY" && i.type === "BITMAP"));
  sim.eq("reIndex: rebuilds the customer indexes", await customers.reIndex(), { acknowledged: true });
  await stock.dropIndex("BX_SIM_STOCK_QTY");
  sim.ok("dropIndex: bitmap index gone", !(await stock.getIndexes()).some((i) => i.indexName === "BX_SIM_STOCK_QTY"));
  await promos.createIndex({ CODE: 1 });
  const dropped = await promos.dropIndexes();
  sim.eq("dropIndexes: removes every non-key index", dropped.dropped, [`IDX_${T.PROMOS}_CODE`]);

  // Views.
  try {
    await schema.createView(T.VIEW_MENU, products.find({ ACTIVE: "Y" }).project({ SKU: 1, NAME: 1, PRICE: 1 }));
    sim.eq("DEFECT: createView from a filtered query (DDL cannot take bind values)", await rawCount(T.VIEW_MENU), 8);
    await schema.dropView(T.VIEW_MENU);
  } catch (e) {
    sim.ok("DEFECT: createView from a filtered query (DDL cannot take bind values)", false, (e as Error).message.split("\n")[0]);
  }
  await schema.createView(T.VIEW_MENU, products.find({}).project({ SKU: 1, NAME: 1, PRICE: 1 }));
  sim.eq("createView from an unfiltered query: the menu shows 8 items", await rawCount(T.VIEW_MENU), 8);
  await schema.createView(T.VIEW_MENU, `SELECT SKU, NAME, PRICE FROM "${T.PRODUCTS}" WHERE CATEGORY = 'drink'`, { orReplace: true, force: true });
  sim.eq("createView OR REPLACE from SQL: drinks only", await rawCount(T.VIEW_MENU), 2);
  await schema.dropView(T.VIEW_MENU);
  sim.eq("dropView: view removed", await rawCount("USER_VIEWS", "WHERE VIEW_NAME = :v", { v: T.VIEW_MENU }), 0);
  sim.eq("dropView ifExists: a missing view is not an error", await schema.dropView(T.VIEW_MENU, { ifExists: true }), { acknowledged: true });
}
