/**
 * Stage 4 — Back office after close: price changes from the supplier feed,
 * customer maintenance, staff changes, promotions clean-up, archiving and the
 * quarterly revenue sheet. Updates, upserts, MERGE, replace, find-and-modify,
 * deletes, UPDATE … FROM JOIN, INSERT … SELECT, PIVOT / UNPIVOT.
 */
import type { Ctx } from "../lib/context";
import { cents, sleep, type Sim } from "../lib/harness";
import { STORES, T, type State } from "../lib/data";

export async function backOfficeStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db, raw, rawCount } = ctx;
  const { model } = state;
  const coll = (t: string) => new api.OracleCollection(t, db);
  const products = coll(T.PRODUCTS);
  const customers = coll(T.CUSTOMERS);
  const employees = coll(T.EMPLOYEES);
  const orders = coll(T.ORDERS);
  const schema = new api.OracleSchema(db);

  // Remember the database's point in time before any price changes (read back with flashback in the reports).
  // Flashback needs the table older than the SCN-to-time mapping granularity (a few seconds).
  const age = Date.now() - state.createdAt;
  if (age < 7000) await sleep(7000 - age);
  const [mark] = await raw<{ SCN: number; TS: string }>("SELECT TIMESTAMP_TO_SCN(SYSTIMESTAMP) AS SCN, TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS FROM DUAL");
  state.scnBeforeBackOffice = Number(mark.SCN);
  state.tsBeforeBackOffice = mark.TS;
  await sleep(1500);

  // End-of-day snapshot in a read-only transaction; writes are refused. (Taken here, after the wait:
  // Oracle refuses a read-only transaction that starts within moments of DDL on the table, ORA-01466.)
  const snap = await new api.Transaction(db).withReadOnlyTransaction(async (s) => ({ orders: await s.collection(T.ORDERS).countDocuments(), lines: await s.collection(T.LINES).countDocuments() }));
  sim.eq("withReadOnlyTransaction: consistent end-of-day counts", snap, { orders: model.orders.length, lines: model.orders.reduce((s2, o) => s2 + o.lines.length, 0) });
  await sim.rejects("withReadOnlyTransaction: a write is refused (ORA-01456)", new api.Transaction(db).withReadOnlyTransaction((s) => s.collection(T.PROMOS).insertOne({ CODE: "NOPE" })), /ORA-01456/);


  // Drinks go up 10%.
  const up = await products.updateMany({ CATEGORY: "drink" }, { $mul: { PRICE: 1.1 } }, { returning: ["SKU", "PRICE"] });
  for (const sku of ["P-CALA", "P-COFFEE"]) model.price.set(sku, Math.round(model.price.get(sku)! * 1.1));
  sim.eq("updateMany $mul with RETURNING: drinks +10%", up.returning?.map((r) => [r.SKU, cents(r.PRICE)]).sort(), [["P-CALA", model.price.get("P-CALA")], ["P-COFFEE", model.price.get("P-COFFEE")]]);

  // Supplier price feed: MERGE matched rows from a staging table.
  await schema.createTable(T.PRICE_FEED, { SKU: { type: "VARCHAR2(20)", primaryKey: true }, PRICE: { type: "NUMBER(12,2)" } });
  await coll(T.PRICE_FEED).insertMany([{ SKU: "P-ADOBO", PRICE: 125 }, { SKU: "P-TURON", PRICE: 27.5 }, { SKU: "P-KARE", PRICE: 199 }], { returning: [] });
  await products.mergeFrom(T.PRICE_FEED, { localField: "SKU", foreignField: "SKU" }, { whenMatched: { $set: { PRICE: "$src.PRICE" } } });
  model.price.set("P-ADOBO", 12500);
  model.price.set("P-TURON", 2750);
  const fed = await raw<{ SKU: string; PRICE: string }>(`SELECT SKU, PRICE FROM "${T.PRODUCTS}" WHERE SKU IN ('P-ADOBO','P-TURON','P-KARE') ORDER BY SKU`);
  sim.eq("mergeFrom: matched SKUs take the feed price; an unknown SKU is not inserted", fed.map((r) => [r.SKU, cents(r.PRICE)]), [["P-ADOBO", 12500], ["P-TURON", 2750]]);

  // A new dish: MERGE one document (insert when new, update when matched).
  const kare = { SKU: "P-KARE", NAME: "Kare-Kare", CATEGORY: "meal", PRICE: 199 };
  await products.merge(kare, { localField: "SKU", foreignField: "SKU" }, { whenMatched: { $set: { PRICE: 199 } }, whenNotMatched: "insert" });
  await products.merge({ ...kare, PRICE: 210 }, { localField: "SKU", foreignField: "SKU" }, { whenMatched: { $set: { PRICE: 210 } }, whenNotMatched: "insert" });
  const k = await products.findOne<{ ID: number; PRICE: string }>({ SKU: "P-KARE" });
  sim.eq("merge: inserted once, then updated in place", [await rawCount(T.PRODUCTS, "WHERE SKU = 'P-KARE'"), cents(k?.PRICE)], [1, 21000]);
  model.productIds.set("P-KARE", Number(k?.ID));
  model.price.set("P-KARE", 21000);

  // Recategorise by key in one round trip.
  const rk = await products.bulkUpdateByKeys([{ SKU: "P-LUMPIA", CATEGORY: "fried" }, { SKU: "P-TURON", CATEGORY: "fried" }], { keys: ["SKU"] });
  sim.eq("bulkUpdateByKeys: two items recategorised", [rk.modifiedCount, await rawCount(T.PRODUCTS, "WHERE CATEGORY = 'fried'")], [2, 2]);

  // Customers: a walk-in account upserted, a record replaced, balances adjusted.
  const w1 = await customers.updateOne({ EMAIL: "walkin@canteen.sim" }, { $set: { NAME: "Walk-in", TIER: "regular", CREDIT: 0 } }, { upsert: true });
  const w2 = await customers.updateOne({ EMAIL: "walkin@canteen.sim" }, { $set: { CITY: "Manila" } }, { upsert: true });
  sim.eq("updateOne upsert: inserted, then matched", [w1.upsertedCount, w2.matchedCount, await rawCount(T.CUSTOMERS, "WHERE EMAIL = 'walkin@canteen.sim'")], [1, 1, 1]);
  const walkIn = await customers.findOne<{ ID: number }>({ EMAIL: "walkin@canteen.sim" });
  model.credit.set(Number(walkIn?.ID), 0);

  const teresa = model.customerIds[10];
  const rep = await customers.replaceOne({ ID: teresa }, { ID: 999, NAME: "Teresa Magbanua", EMAIL: "teresa@canteen.sim", TIER: "vip", CITY: "Iloilo", CREDIT: model.credit.get(teresa)! / 100 });
  const tRow = await raw<{ ID: number; NAME: string; TIER: string }>(`SELECT ID, NAME, TIER FROM "${T.CUSTOMERS}" WHERE EMAIL = 'teresa@canteen.sim'`);
  sim.eq("replaceOne: record replaced, id kept", [rep.modifiedCount, Number(tRow[0].ID), tRow[0].NAME, tRow[0].TIER], [1, teresa, "Teresa Magbanua", "vip"]);

  const topUp = await customers.updateMany({ TIER: "vip" }, { $inc: { CREDIT: 500 }, $currentDate: { UPDATED_AT: { $type: "timestamp" } } });
  const vipIds = (await raw<{ ID: number }>(`SELECT ID FROM "${T.CUSTOMERS}" WHERE TIER = 'vip'`)).map((r) => Number(r.ID));
  for (const id of vipIds) model.credit.set(id, model.credit.get(id)! + 50000);
  sim.eq("updateMany $inc + $currentDate: every vip topped up and stamped", [topUp.modifiedCount, await rawCount(T.CUSTOMERS, "WHERE TIER = 'vip' AND UPDATED_AT IS NOT NULL")], [vipIds.length, vipIds.length]);
  const floor = await customers.updateMany({ TIER: "regular" }, { $max: { CREDIT: 100 } });
  for (const id of model.credit.keys()) if (!vipIds.includes(id)) model.credit.set(id, Math.max(model.credit.get(id)!, 10000));
  sim.ok("updateMany $max: regular balances floored at 100.00", floor.modifiedCount > 0 && (await rawCount(T.CUSTOMERS, "WHERE TIER = 'regular' AND CREDIT < 100")) === 0, floor);
  await customers.updateMany({ TIER: "vip" }, { $min: { CREDIT: 5000 } });
  await customers.updateOne({ EMAIL: "walkin@canteen.sim" }, { $unset: { CITY: "" } });
  sim.eq("updateOne $unset: walk-in city cleared", await rawCount(T.CUSTOMERS, "WHERE EMAIL = 'walkin@canteen.sim' AND CITY IS NULL"), 1);
  const credit = await raw<{ ID: number; CREDIT: string }>(`SELECT ID, CREDIT FROM "${T.CUSTOMERS}" ORDER BY ID`);
  sim.eq("credit after maintenance matches the model ($inc, $max, $min caps)", credit.map((c) => [Number(c.ID), cents(c.CREDIT)]), credit.map((c) => [Number(c.ID), Math.min(model.credit.get(Number(c.ID))!, vipIds.includes(Number(c.ID)) ? 500000 : Infinity)]));
  for (const id of vipIds) model.credit.set(id, Math.min(model.credit.get(id)!, 500000));

  // Staff: a raise (before / after images), a replacement, a resignation.
  const before = await employees.findOneAndUpdate<{ SALARY: number }>({ NAME: "Cook" }, { $mul: { SALARY: 1.1 } });
  const after = await employees.findOneAndUpdate<{ SALARY: number }>({ NAME: "Cook" }, { $inc: { SALARY: 1000 } }, { returnDocument: "after" });
  sim.eq("findOneAndUpdate: before image, then after image", [before?.SALARY, after?.SALARY], [30000, 34000]);
  const replaced = await employees.findOneAndReplace<{ NAME: string; SALARY: number }>({ ID: 6 }, { NAME: "Senior Accountant", MANAGER_ID: 3, DEPT: "FIN", SALARY: 52000 }, { returnDocument: "after" });
  sim.eq("findOneAndReplace: returns the new record", [replaced?.NAME, replaced?.SALARY], ["Senior Accountant", 52000]);
  await employees.insertOne({ ID: 8, NAME: "Seasonal Helper", MANAGER_ID: 4, DEPT: "OPS", SALARY: 15000 });
  const gone = await employees.findOneAndDelete<{ NAME: string }>({ ID: 8 });
  sim.eq("findOneAndDelete: returns the removed record, which is gone", [gone?.NAME, await rawCount(T.EMPLOYEES, "WHERE ID = 8")], ["Seasonal Helper", 0]);

  // Promotions clean-up, then the table is dropped.
  const promos = coll(T.PROMOS);
  await promos.insertMany(["A", "B", "C", "D"].map((c) => ({ CODE: `EXP-${c}`, PCT: 1, ACTIVE: "N" })), { returning: [] });
  const d1 = await promos.deleteOne({ CODE: "EXP-A" }, { returning: ["CODE"] });
  const d2 = await promos.deleteMany({ ACTIVE: "N" }, { limit: 2, returning: ["CODE"] });
  const d3 = await promos.deleteMany({ ACTIVE: "N" });
  sim.eq("deleteOne / deleteMany with limit / deleteMany: 1 + 2 + 1 expired promotions removed", [d1.deletedCount, d1.returning?.CODE, d2.deletedCount, d2.returning?.length, d3.deletedCount], [1, "EXP-A", 2, 2, 1]);
  sim.eq("drop: promotions table removed", await promos.drop(), { acknowledged: true });
  sim.eq("drop: table no longer in USER_TABLES", await rawCount("USER_TABLES", "WHERE TABLE_NAME = :t", { t: T.PROMOS }), 0);

  // Copy each customer's tier onto their orders: UPDATE … FROM JOIN.
  await schema.alterTable(T.ORDERS, { addColumn: { CUSTOMER_TIER: "VARCHAR2(10)" } });
  const fj = await orders.updateFromJoin({ target: T.ORDERS, join: { table: T.CUSTOMERS, on: { [`${T.ORDERS}.CUSTOMER_ID`]: `${T.CUSTOMERS}.ID` } }, set: { [`${T.ORDERS}.CUSTOMER_TIER`]: `${T.CUSTOMERS}.TIER` }, where: {} });
  const [{ N: mismatched }] = await raw<{ N: number }>(`SELECT COUNT(*) AS N FROM "${T.ORDERS}" o JOIN "${T.CUSTOMERS}" c ON c.ID = o.CUSTOMER_ID WHERE o.CUSTOMER_TIER IS NULL OR o.CUSTOMER_TIER <> c.TIER`);
  sim.eq("updateFromJoin: every order carries its customer's tier", [fj.modifiedCount, Number(mismatched)], [model.orders.length, 0]);

  // Archive Q1: INSERT … SELECT with an explicit column list, then without one (identity-aware).
  await schema.createTable(T.ARCHIVE, { ID: { type: "NUMBER", primaryKey: true, autoIncrement: true }, RECEIPT_NO: { type: "NUMBER" }, QUARTER: { type: "VARCHAR2(2)" }, TOTAL: { type: "NUMBER(12,2)" } });
  const q1 = model.orders.filter((o) => o.quarter === "Q1");
  const a1 = await orders.insertFromQuery(T.ARCHIVE, orders.find({ QUARTER: "Q1" }).project({ RECEIPT_NO: 1, QUARTER: 1, TOTAL: 1 }), { columns: ["RECEIPT_NO", "QUARTER", "TOTAL"] });
  const [{ S }] = await raw<{ S: string }>(`SELECT NVL(SUM(TOTAL), 0) AS S FROM "${T.ARCHIVE}"`);
  sim.eq("insertFromQuery: Q1 archived with matching revenue", [a1.insertedCount, cents(S)], [q1.length, q1.reduce((s, o) => s + o.total, 0)]);
  const a2 = await coll(T.ARCHIVE).insertFromQuery(T.ARCHIVE, coll(T.ARCHIVE).find({ QUARTER: "Q1" }).project({ RECEIPT_NO: 1, QUARTER: 1, TOTAL: 1 }).limit(1));
  sim.eq("insertFromQuery without columns: identity column skipped automatically", [a2.insertedCount, await rawCount(T.ARCHIVE)], [1, q1.length + 1]);

  // Quarterly revenue sheet: PIVOT orders into one row per branch, store it, UNPIVOT it back.
  const piv = (await orders.pivot({ value: { $sum: "$TOTAL" }, pivotOn: "QUARTER", pivotValues: ["Q1", "Q2", "Q3", "Q4"], groupBy: "STORE_ID" })) as Record<string, unknown>[];
  const expectSheet = STORES.map((s) => [s.STORE_ID, ...["Q1", "Q2", "Q3", "Q4"].map((q) => model.orders.filter((o) => o.storeId === s.STORE_ID && o.quarter === q).reduce((a, o) => a + o.total, 0))]);
  const gotSheet = piv.map((r) => [Number(r.STORE_ID), ...["Q1", "Q2", "Q3", "Q4"].map((q) => (r[q] == null ? 0 : cents(r[q])))]).sort((a, b) => a[0] - b[0]);
  sim.eq("pivot: revenue per branch per quarter", gotSheet, expectSheet.filter((r) => r.slice(1).some((v) => v > 0)));
  await schema.createTable(T.QUARTERLY, { STORE_ID: { type: "NUMBER", primaryKey: true }, Q1: { type: "NUMBER(12,2)" }, Q2: { type: "NUMBER(12,2)" }, Q3: { type: "NUMBER(12,2)" }, Q4: { type: "NUMBER(12,2)" } });
  await coll(T.QUARTERLY).insertMany(piv.map((r) => ({ STORE_ID: r.STORE_ID, Q1: r.Q1, Q2: r.Q2, Q3: r.Q3, Q4: r.Q4 })), { returning: [] });
  const un = (await coll(T.QUARTERLY).unpivot({ valueColumn: "REVENUE", nameColumn: "QTR", columns: ["Q1", "Q2", "Q3", "Q4"] })) as { REVENUE: string }[];
  const cells = expectSheet.flatMap((r) => r.slice(1)).filter((v) => v > 0).length;
  sim.eq("unpivot: one row per non-empty cell, same total revenue", [un.length, un.reduce((a, r) => a + cents(r.REVENUE), 0)], [cells, model.orders.reduce((a, o) => a + o.total, 0)]);
}
