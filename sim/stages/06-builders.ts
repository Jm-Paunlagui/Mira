/**
 * Stage 6 — The standalone SQL builders and utilities. Each builder's SQL is
 * run on the database through the untracked raw handle, and its result must
 * equal what the matching collection method returns: the building blocks and
 * the high-level API agree.
 */
import type { Ctx } from "../lib/context";
import { cents, type Sim } from "../lib/harness";
import { T, type State } from "../lib/data";

export async function buildersStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db, raw } = ctx;
  const { model } = state;
  const coll = (t: string) => new api.OracleCollection(t, db);
  const customers = coll(T.CUSTOMERS);
  const orders = coll(T.ORDERS);
  const employees = coll(T.EMPLOYEES);
  const q = api.quoteIdentifier;
  const n = (v: unknown) => Number(v);

  sim.eq("quoteIdentifier: quotes and escapes embedded quotes", [q("SIM_ORDERS"), q('a"b')], ['"SIM_ORDERS"', '"a""b"']);

  // parseFilter + buildOrderBy + buildProjection → a hand-assembled SELECT.
  const filter = { TIER: "vip", CREDIT: { $gte: 100 } };
  const { whereClause, binds } = api.parseFilter(filter);
  const proj = api.buildProjection({ NAME: 1, CREDIT: 1 });
  const order = api.buildOrderBy({ NAME: 1 });
  const viaParts = await raw(`SELECT ${proj.columns} FROM ${q(T.CUSTOMERS)} ${whereClause} ${order}`, binds);
  const viaApi = await customers.find(filter).project({ NAME: 1, CREDIT: 1 }).sort({ NAME: 1 }).toArray();
  sim.eq("parseFilter + buildProjection + buildOrderBy: same rows as find()", viaParts, viaApi);
  sim.eq("buildProjection: exclusion is reported, not selected", api.buildProjection({ EMAIL: 0 }), { columns: "*", isExclusion: true, excludedCols: ["EMAIL"] });

  // parseUpdate + mergeBinds → a hand-assembled UPDATE, rolled back by checking then restoring.
  const upd = api.parseUpdate({ $set: { CATEGORY: "beverage" } });
  const where = api.parseFilter({ CATEGORY: "drink" });
  const both = api.mergeBinds(upd.binds, where.binds);
  await raw(`UPDATE ${q(T.PRODUCTS)} ${upd.setClause} ${where.whereClause}`, both);
  sim.eq("parseUpdate + mergeBinds: the drinks recategorised by hand-built SQL", await coll(T.PRODUCTS).countDocuments({ CATEGORY: "beverage" }), 2);
  await coll(T.PRODUCTS).updateMany({ CATEGORY: "beverage" }, { $set: { CATEGORY: "drink" } });
  let collided = false;
  try {
    api.mergeBinds({ a: 1 }, { a: 2 });
  } catch {
    collided = true;
  }
  sim.ok("mergeBinds: a bind-name collision is refused", collided);

  // convertTypes / rowToDoc: numeric strings become numbers, money stays exact.
  sim.eq("convertTypes / rowToDoc: ids become numbers, money strings stay exact", [api.convertTypes({ ID: "42", TOTAL: "123.45", NAME: "x" }), api.rowToDoc({ ID: "7" })], [{ ID: 42, TOTAL: "123.45", NAME: "x" }, { ID: 7 }]);

  // buildAggregateSQL runs the same pipeline as aggregate().
  const pipe = [{ $match: { QUARTER: { $in: ["Q2", "Q3"] } } }, { $group: { _id: "$QUARTER", TOTAL: { $sum: "$TOTAL" } } }, { $sort: { QUARTER: 1 } }];
  const built = api.buildAggregateSQL(T.ORDERS, pipe, db as never);
  sim.eq("buildAggregateSQL: hand-run SQL equals aggregate()", await raw(built.sql, built.binds), await orders.aggregate(pipe));

  // buildWindowExpr: running total of receipts per branch.
  const w = api.buildWindowExpr({ fn: "SUM", field: "TOTAL", partitionBy: "STORE_ID", orderBy: { RECEIPT_NO: 1 }, frame: "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW" });
  const running = await raw<{ STORE_ID: number; RUN: string }>(`SELECT STORE_ID, ${w} AS RUN FROM ${q(T.ORDERS)} ORDER BY STORE_ID, RECEIPT_NO`);
  const lastPerStore = new Map<number, number>();
  for (const r of running) lastPerStore.set(n(r.STORE_ID), cents(r.RUN));
  const expRun = new Map<number, number>();
  for (const o of model.orders) expRun.set(o.storeId, (expRun.get(o.storeId) ?? 0) + o.total);
  sim.eq("buildWindowExpr: running total ends at each branch's revenue", [...lastPerStore.entries()].sort(), [...expRun.entries()].sort());
  const ranks = await raw<{ NAME: string; R: number }>(`SELECT NAME, ${api.buildWindowExpr({ fn: "ROW_NUMBER", orderBy: { SALARY: -1 } })} AS R FROM ${q(T.EMPLOYEES)} ORDER BY R`);
  sim.eq("buildWindowExpr ROW_NUMBER: the CEO ranks first by salary", [ranks[0]?.NAME, n(ranks[0]?.R)], ["CEO", 1]);

  // buildJoinSQL: orders with their customer's name.
  const join = api.buildJoinSQL(q(T.ORDERS), { from: T.CUSTOMERS, localField: "CUSTOMER_ID", foreignField: "ID", as: "c", joinType: "inner", select: ["NAME"] });
  const joined = await raw<{ RECEIPT_NO: number; NAME: string }>(`${join} ORDER BY ${q(T.ORDERS)}."RECEIPT_NO"`);
  const custName = new Map((await customers.find({}).project({ ID: 1, NAME: 1 }).toArray<{ ID: number; NAME: string }>()).map((c) => [c.ID, c.NAME]));
  sim.eq("buildJoinSQL: every order joined to its customer's name", joined.map((r) => [n(r.RECEIPT_NO), r.NAME]), model.orders.map((o) => [o.receipt, custName.get(o.customerId)]));

  // Subquery builders, each embedded in hand-written SQL and compared with the filter operator.
  const scalar = api.buildScalarSubquery({ collection: T.ORDERS, fn: "count", filter: { CUSTOMER_ID: "$ID" } }, "c");
  const perCust = await raw<{ ID: number; N: number }>(`SELECT c.ID, ${scalar} AS N FROM ${q(T.CUSTOMERS)} c ORDER BY c.ID`);
  sim.eq("buildScalarSubquery: order count per customer", perCust.filter((r) => n(r.N) > 0).map((r) => [n(r.ID), n(r.N)]), [...new Set(model.orders.map((o) => o.customerId))].sort((a, b) => a - b).map((id) => [id, model.orders.filter((o) => o.customerId === id).length]));
  const exists = api.buildExistsSubquery({ collection: T.ORDERS, match: { CUSTOMER_ID: "$ID" } }, "c");
  const notExists = api.buildNotExistsSubquery({ collection: T.ORDERS, match: { CUSTOMER_ID: "$ID" } }, "c");
  const [e1] = await raw<{ N: number }>(`SELECT COUNT(*) AS N FROM ${q(T.CUSTOMERS)} c WHERE ${exists}`);
  const [e2] = await raw<{ N: number }>(`SELECT COUNT(*) AS N FROM ${q(T.CUSTOMERS)} c WHERE ${notExists}`);
  sim.eq("buildExistsSubquery / buildNotExistsSubquery: equal to $exists / $notExists", [n(e1.N), n(e2.N)], [
    await customers.countDocuments({ $exists: { collection: T.ORDERS, match: { CUSTOMER_ID: "$ID" } } }),
    await customers.countDocuments({ $notExists: { collection: T.ORDERS, match: { CUSTOMER_ID: "$ID" } } }),
  ]);
  const corr = api.buildCorrelatedSubquery({ collection: T.EMPLOYEES, field: "SALARY", aggregate: "$avg", where: { DEPT: "$outer.DEPT" } }, "e");
  const above = await raw<{ NAME: string }>(`SELECT e.NAME FROM ${q(T.EMPLOYEES)} e WHERE e.SALARY > ${corr} ORDER BY e.NAME`);
  const aboveApi = await employees.find({ SALARY: { $gt: { $subquery: { collection: T.EMPLOYEES, aggregate: "$avg", field: "SALARY", where: { DEPT: "$outer.DEPT" } } } } }).sort({ NAME: 1 }).toArray<{ NAME: string }>();
  sim.eq("buildCorrelatedSubquery: equal to the correlated $subquery filter", above.map((r) => r.NAME), aboveApi.map((r) => r.NAME));
  const inSel = api.buildInSelectSubquery(orders.find({}).project({ CUSTOMER_ID: 1 }));
  const [i1] = await raw<{ N: number }>(`SELECT COUNT(*) AS N FROM ${q(T.CUSTOMERS)} c WHERE c.ID ${inSel}`);
  sim.eq("buildInSelectSubquery: equal to $inSelect", n(i1.N), await customers.countDocuments({ ID: { $inSelect: orders.find({}).project({ CUSTOMER_ID: 1 }) } }));
  const all = api.buildAnyAllSubquery({ collection: T.PRODUCTS, field: "PRICE" }, "ALL");
  const priciest = await raw<{ SKU: string }>(`SELECT SKU FROM ${q(T.PRODUCTS)} WHERE PRICE >= ${all}`);
  const maxSku = [...model.price.entries()].sort((a, b) => b[1] - a[1])[0][0];
  sim.eq("buildAnyAllSubquery ALL: the most expensive dish", priciest.map((r) => r.SKU), [maxSku]);

  // Oracle advanced builders vs the collection methods.
  const cbSpec = { startWith: { MANAGER_ID: null }, connectBy: { MANAGER_ID: "$PRIOR ID" }, includeLevel: true, orderSiblings: { NAME: 1 } };
  const cb = api.buildConnectBy(T.EMPLOYEES, cbSpec as never);
  sim.eq("buildConnectBy: hand-run SQL equals connectBy()", await raw(cb.sql, cb.binds), await employees.connectBy(cbSpec as never));
  const pvSpec = { value: { $sum: "$TOTAL" }, pivotOn: "QUARTER", pivotValues: ["Q1", "Q2", "Q3", "Q4"], groupBy: "STORE_ID" };
  const pv = api.buildPivot(T.ORDERS, pvSpec);
  const byStore = (rows: Record<string, unknown>[]) => [...rows].sort((a, b) => n(a.STORE_ID) - n(b.STORE_ID));
  sim.eq("buildPivot: hand-run SQL equals pivot()", byStore(await raw(pv.sql, pv.binds)), byStore((await orders.pivot(pvSpec)) as Record<string, unknown>[]));
  const upSpec = { valueColumn: "REVENUE", nameColumn: "QTR", columns: ["Q1", "Q2", "Q3", "Q4"], includeNulls: true };
  const up = api.buildUnpivot(T.QUARTERLY, upSpec);
  const upRows = await raw(up.sql, up.binds);
  sim.eq("buildUnpivot INCLUDE NULLS: one row per branch per quarter", upRows.length, 4 * (await ctx.rawCount(T.QUARTERLY)));
  sim.eq("buildUnpivot: equal to unpivot() with includeNulls", upRows, await coll(T.QUARTERLY).unpivot(upSpec));
}
