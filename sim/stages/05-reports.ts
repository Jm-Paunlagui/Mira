/**
 * Stage 5 — Management reports. Every query result is compared with the
 * in-memory model: QueryBuilder terminals and chaining, filter operators,
 * subqueries, the aggregation pipeline (every stage), set operations, CTEs,
 * hierarchical queries, flashback and sampling.
 */
import type { Ctx } from "../lib/context";
import { cents, type Sim } from "../lib/harness";
import { CUSTOMERS, STORES, T, type State } from "../lib/data";

export async function reportsStage(sim: Sim, ctx: Ctx, state: State) {
  const { api, db, raw } = ctx;
  const { model } = state;
  const coll = (t: string) => new api.OracleCollection(t, db);
  const customers = coll(T.CUSTOMERS);
  const orders = coll(T.ORDERS);
  const lines = coll(T.LINES);
  const products = coll(T.PRODUCTS);
  const employees = coll(T.EMPLOYEES);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const custRows = await raw<{ ID: number; NAME: string; TIER: string; CITY: string | null; CREDIT: string; EMAIL: string }>(`SELECT ID, NAME, TIER, CITY, CREDIT, EMAIL FROM "${T.CUSTOMERS}" ORDER BY ID`);
  const byId = new Map(custRows.map((c) => [Number(c.ID), c]));

  // ── QueryBuilder terminals and chaining ──────────────────────────────────
  const names = (rows: unknown[]) => (rows as { NAME: string }[]).map((r) => r.NAME);
  const allByName = custRows.map((c) => c.NAME).sort();
  const pages: string[] = [];
  for (let p = 0; p < 4; p++) pages.push(...names(await customers.find({}).sort({ NAME: 1 }).skip(p * 4).limit(4).project({ NAME: 1 }).toArray()));
  sim.eq("find().sort().skip().limit().project(): pages cover every customer once, in order", pages, allByName);
  const awaited = await customers.find({ TIER: "vip" }).sort({ NAME: 1 });
  sim.eq("await find(): thenable returns the vip list", names(awaited), custRows.filter((c) => c.TIER === "vip").map((c) => c.NAME).sort());
  const richest = await customers.find({}).sort({ CREDIT: -1, ID: 1 }).next<{ ID: number }>();
  const maxCredit = Math.max(...custRows.map((c) => cents(c.CREDIT)));
  sim.eq("next(): the highest balance first", cents(byId.get(Number(richest?.ID))?.CREDIT), maxCredit);
  sim.eq("hasNext(): true for a known email, false for an unknown one", [await customers.find({ EMAIL: "maria@canteen.sim" }).hasNext(), await customers.find({ EMAIL: "nobody@canteen.sim" }).hasNext()], [true, false]);
  sim.eq("count(): paid + settled orders", await orders.find({ STATUS: { $in: ["paid", "settled"] } }).count(), model.orders.length);
  let streamed = 0;
  let streamedTotal = 0;
  await orders.find({ STORE_ID: 1 }).project({ TOTAL: 1 }).forEach(async (r) => {
    streamed++;
    streamedTotal += cents((r as { TOTAL: string }).TOTAL);
  });
  const makati = model.orders.filter((o) => o.storeId === 1);
  sim.eq("forEach(): streams every Makati order with an async consumer", [streamed, streamedTotal], [makati.length, sum(makati.map((o) => o.total))]);
  const sql = await customers.find({ TIER: "vip" }).sort({ NAME: 1 }).limit(5).explain();
  sim.ok("explain(): returns the SQL that would run", /FROM "SIM_CUSTOMERS".*WHERE "TIER" = :.*ORDER BY "NAME" ASC.*FETCH FIRST 5 ROWS ONLY/s.test(sql), sql);
  sim.eq("findOne / countDocuments / distinct", [
    (await customers.findOne<{ NAME: string }>({ EMAIL: "jose@canteen.sim" }))?.NAME,
    await customers.countDocuments({ TIER: "regular" }),
    ((await customers.distinct("CITY", { TIER: "vip" })) as (string | null)[]).map(String).sort(),
  ], [
    "Jose Rizal",
    custRows.filter((c) => c.TIER === "regular").length,
    [...new Set(custRows.filter((c) => c.TIER === "vip").map((c) => String(c.CITY)))].sort(),
  ]);

  // ── Filter operators ─────────────────────────────────────────────────────
  const count = (f: Record<string, unknown>) => customers.countDocuments(f);
  const custs = custRows.map((c) => ({ ...c, ID: Number(c.ID), C: cents(c.CREDIT) }));
  sim.eq("$gt / $lte / $ne / $between / $notBetween", [
    await count({ CREDIT: { $gt: 1000 } }),
    await count({ CREDIT: { $lte: 1000 }, TIER: { $ne: "vip" } }),
    await count({ CREDIT: { $between: [100, 2000] } }),
    await count({ CREDIT: { $notBetween: [100, 2000] } }),
  ], [
    custs.filter((c) => c.C > 100000).length,
    custs.filter((c) => c.C <= 100000 && c.TIER !== "vip").length,
    custs.filter((c) => c.C >= 10000 && c.C <= 200000).length,
    custs.filter((c) => c.C < 10000 || c.C > 200000).length,
  ]);
  sim.eq("$in / $nin / $exists / null", [
    await count({ CITY: { $in: ["Cebu", "Davao"] } }),
    await count({ CITY: { $nin: ["Cebu", "Davao"] } }),
    await count({ CITY: { $exists: false } }),
    await count({ CITY: null }),
  ], [
    custs.filter((c) => c.CITY === "Cebu" || c.CITY === "Davao").length,
    custs.filter((c) => c.CITY !== null && c.CITY !== "Cebu" && c.CITY !== "Davao").length,
    custs.filter((c) => c.CITY === null).length,
    custs.filter((c) => c.CITY === null).length,
  ]);
  sim.eq("$or / $and / $nor / $not", [
    await count({ $or: [{ TIER: "vip" }, { CITY: "Davao" }] }),
    await count({ $and: [{ TIER: "regular" }, { CITY: "Manila" }] }),
    await count({ $nor: [{ TIER: "vip" }, { CITY: null }] }),
    await count({ $not: { TIER: "vip" } }),
  ], [
    custs.filter((c) => c.TIER === "vip" || c.CITY === "Davao").length,
    custs.filter((c) => c.TIER === "regular" && c.CITY === "Manila").length,
    custs.filter((c) => !(c.TIER === "vip" || c.CITY === null)).length,
    custs.filter((c) => c.TIER !== "vip").length,
  ]);
  sim.eq("$regex (case-insensitive) / $like", [await count({ NAME: { $regex: "^m", $options: "i" } }), await count({ EMAIL: { $like: "%@canteen.sim" } })], [custs.filter((c) => /^m/i.test(c.NAME)).length, custs.length]);
  const ids = [...Array.from({ length: 2500 }, (_, i) => 100000 + i), ...model.customerIds.slice(0, 5)];
  sim.eq("$in / $nin with 2,505 values (one collection bind, no ORA-01795)", [await count({ ID: { $in: ids } }), await count({ ID: { $nin: ids } })], [5, custs.length - 5]);
  sim.eq("$any / $all", [await count({ TIER: { $any: ["vip", "gold"] } }), await count({ TIER: { $all: ["vip"] } })], [custs.filter((c) => c.TIER === "vip").length, custs.filter((c) => c.TIER === "vip").length]);
  const buyers = new Set(model.orders.map((o) => o.customerId));
  sim.eq("$exists / $notExists subqueries: customers with and without orders", [
    await count({ $exists: { collection: T.ORDERS, match: { CUSTOMER_ID: "$ID" } } }),
    await count({ $notExists: { collection: T.ORDERS, match: { CUSTOMER_ID: "$ID" } } }),
  ], [buyers.size, custs.length - buyers.size]);
  sim.eq("$inSelect: customers whose id appears in the orders", await count({ ID: { $inSelect: orders.find({}).project({ CUSTOMER_ID: 1 }) } }), buyers.size);
  const staff = (await raw<{ ID: number; MANAGER_ID: number | null; NAME: string; DEPT: string; SALARY: number }>(`SELECT ID, MANAGER_ID, NAME, DEPT, SALARY FROM "${T.EMPLOYEES}"`)).map((e) => ({
    ...e,
    ID: Number(e.ID),
    MANAGER_ID: e.MANAGER_ID == null ? null : Number(e.MANAGER_ID),
    SALARY: Number(e.SALARY),
  }));
  const avgOf = (d: string) => sum(staff.filter((e) => e.DEPT === d).map((e) => e.SALARY)) / staff.filter((e) => e.DEPT === d).length;
  const aboveAvg = await employees.find({ SALARY: { $gt: { $subquery: { collection: T.EMPLOYEES, aggregate: "$avg", field: "SALARY", where: { DEPT: "$outer.DEPT" } } } } }).sort({ NAME: 1 }).toArray();
  sim.eq("correlated $subquery: staff paid above their department's average", names(aboveAvg), staff.filter((e) => e.SALARY > avgOf(e.DEPT)).map((e) => e.NAME).sort());
  const withCount = await customers.find({ EMAIL: "juan@canteen.sim" }).project({ NAME: 1, ORDERS: { $subquery: { collection: T.ORDERS, fn: "count", filter: { CUSTOMER_ID: "$ID" } } } }).toArray<{ ORDERS: number }>();
  sim.eq("scalar $subquery projection: Juan's order count", withCount[0]?.ORDERS, model.orders.filter((o) => o.customerId === model.customerIds[0]).length);
  // $now compiles to SYSTIMESTAMP (WITH TIME ZONE). Against a plain TIMESTAMP column Oracle converts the
  // column with the SESSION time zone, so when the app's zone differs from the database server's the window
  // is shifted by the offset. bun test runs with TZ=UTC, which hides this; the simulation uses the real zone.
  sim.eq("DEFECT: $now window on a TIMESTAMP column holds when the app and database time zones differ", await orders.countDocuments({ CREATED_AT: { $gte: { $now: { minus: { hours: 1 } } }, $lte: { $now: true } } }), model.orders.length);

  // ── Aggregation pipeline ─────────────────────────────────────────────────
  const revenueByStore = STORES.map((s) => ({ store: s.STORE_ID, total: sum(model.orders.filter((o) => o.storeId === s.STORE_ID).map((o) => o.total)), n: model.orders.filter((o) => o.storeId === s.STORE_ID).length })).filter((r) => r.n > 0);
  const g = await orders.aggregate([{ $match: { STATUS: { $in: ["paid", "settled"] } } }, { $group: { _id: "$STORE_ID", TOTAL: { $sum: "$TOTAL" }, N: { $count: "*" } } }, { $sort: { STORE_ID: 1 } }]);
  sim.eq("aggregate $match → $group → $sort: revenue and order count per branch", g.map((r) => ({ store: Number(r.STORE_ID), total: cents(r.TOTAL), n: Number(r.N) })), revenueByStore);
  const best = [...revenueByStore].sort((a, b) => b.total - a.total)[0];
  const h = await orders.aggregate([{ $group: { _id: "$STORE_ID", TOTAL: { $sum: "$TOTAL" } } }, { $having: { TOTAL: { $gte: best.total / 100 } } }, { $sort: { TOTAL: -1 } }, { $limit: 1 }]);
  sim.eq("aggregate $having + $limit: the top branch", h.map((r) => Number(r.STORE_ID)), [best.store]);
  const sk = await orders.aggregate([{ $sort: { RECEIPT_NO: 1 } }, { $skip: 2 }, { $limit: 3 }, { $project: { RECEIPT_NO: 1 } }]);
  sim.eq("aggregate $sort → $skip → $limit → $project: receipts 3 to 5", sk.map((r) => Number(r.RECEIPT_NO)), model.orders.slice(2, 5).map((o) => o.receipt));
  const cnt = await orders.aggregate([{ $match: { QUARTER: "Q2" } }, { $count: "n" }]);
  sim.eq("aggregate $count: Q2 orders", Number(cnt[0].N), model.orders.filter((o) => o.quarter === "Q2").length);
  const proj = await customers.aggregate([
    { $match: { EMAIL: "juan@canteen.sim" } },
    { $project: { LABEL: { $concat: ["$NAME", " <", "$EMAIL", ">"] }, UP: { $toUpper: "$TIER" }, LOW: { $toLower: "$NAME" }, INITIAL: { $substr: ["$NAME", 1, 1] }, CLASS: { $cond: { if: { CREDIT: { $gte: 1000 } }, then: "high", else: "low" } }, TOWN: { $ifNull: ["$CITY", "unknown"] }, DOUBLE: { $mul: ["$CREDIT", 2] }, PLUS: { $add: ["$CREDIT", 1] }, MINUS: { $subtract: ["$CREDIT", 1] }, HALF: { $divide: ["$CREDIT", 2] } } },
  ]);
  const juan = custs.find((c) => c.EMAIL === "juan@canteen.sim")!;
  const pr = proj[0] ?? {};
  sim.eq("aggregate $project expressions: $concat $toUpper $toLower $substr $cond $ifNull $mul $add $subtract $divide", [pr.LABEL, pr.UP, pr.LOW, pr.INITIAL, pr.CLASS, pr.TOWN, cents(pr.DOUBLE), cents(pr.PLUS), cents(pr.MINUS), cents(pr.HALF)], [
    "Juan Dela Cruz <juan@canteen.sim>", "VIP", "juan dela cruz", "J", juan.C >= 100000 ? "high" : "low", "Manila", juan.C * 2, juan.C + 100, juan.C - 100, juan.C / 2,
  ]);
  const af = await orders.aggregate([{ $match: { STORE_ID: 2 } }, { $addFields: { NET: { $mul: ["$TOTAL", 0.88] }, BRANCH: "Cebu" } }, { $sort: { RECEIPT_NO: 1 } }, { $limit: 1 }]);
  const firstCebu = model.orders.find((o) => o.storeId === 2)!;
  sim.eq("aggregate $addFields: computed and literal fields beside the original columns", [af[0]?.BRANCH, cents(af[0]?.NET), cents(af[0]?.TOTAL)], ["Cebu", Math.round(firstCebu.total * 0.88), firstCebu.total]);
  const win = await employees.aggregate([{ $project: { NAME: 1, DEPT: 1, RNK: { $window: { fn: "RANK", partitionBy: "DEPT", orderBy: { SALARY: -1 } } } } }, { $match: { RNK: 1 } }, { $sort: { DEPT: 1 } }]);
  const topPaid = [...new Set(staff.map((e) => e.DEPT))].sort().map((d) => staff.filter((e) => e.DEPT === d).sort((a, b) => b.SALARY - a.SALARY)[0].NAME);
  sim.eq("aggregate $window RANK partitioned by department: the top earner of each", names(win), topPaid);
  const look = await orders.aggregate([{ $lookup: { from: T.CUSTOMERS, localField: "CUSTOMER_ID", foreignField: "ID", as: "c", joinType: "inner", select: ["NAME"] } }, { $match: { RECEIPT_NO: model.orders[0].receipt } }]);
  sim.eq("aggregate $lookup: the first order joined to its customer's name", look[0]?.NAME, byId.get(model.orders[0].customerId)?.NAME);
  const fac = await orders.aggregate([{ $facet: { makati: [{ $match: { STORE_ID: 1 } }, { $count: "n" }], q4: [{ $match: { QUARTER: "Q4" } }, { $count: "n" }] } }]);
  sim.eq("aggregate $facet: two counts in one query", Object.fromEntries(fac.map((r) => [r.facet_name, Number(r.N)])), { makati: makati.length, q4: model.orders.filter((o) => o.quarter === "Q4").length });
  const buckets = await customers.aggregate([{ $bucket: { groupBy: "$CREDIT", boundaries: [0, 1000, 3000, 100000], default: "other" } }]);
  const bucketOf = (c: number) => (c < 100000 ? "0" : c < 300000 ? "1000" : c < 10000000 ? "3000" : "other");
  const expBuckets: Record<string, number> = {};
  for (const c of custs) expBuckets[bucketOf(c.C)] = (expBuckets[bucketOf(c.C)] ?? 0) + 1;
  sim.eq("aggregate $bucket: customers by balance band", Object.fromEntries(buckets.map((b) => [String(b.BUCKET), Number(b.COUNT)])), expBuckets);
  const lat = await customers.aggregate([{ $match: { TIER: "vip" } }, { $lateralJoin: { subquery: orders.find({ CUSTOMER_ID: "$outer.ID" }).project({ CUSTOMER_ID: 1, TOTAL: 1 }).sort({ TOTAL: -1 }).limit(1), as: "BIG" } }]);
  const vipBuyers = custs.filter((c) => c.TIER === "vip" && buyers.has(c.ID));
  sim.eq("aggregate $lateralJoin: each vip buyer's biggest order (correlated, not a cross join)", lat.map((r) => [Number(r.ID), cents(r.TOTAL)]).sort((a, b) => a[0] - b[0]), vipBuyers.map((c) => [c.ID, Math.max(...model.orders.filter((o) => o.customerId === c.ID).map((o) => o.total))]));
  const unw = await orders.aggregate([{ $unwind: "$LINES" }, { $replaceRoot: { newRoot: "$" } }, { $count: "n" }]);
  sim.eq("aggregate $unwind / $replaceRoot: pass-through on relational rows", Number(unw[0]?.N), model.orders.length);

  // Pipeline writes: $merge (upsert into a summary table, re-runnable) and $out (INSERT … SELECT).
  const schema = new api.OracleSchema(db);
  await schema.createTable(T.STORE_TOTALS, { STORE_ID: { type: "NUMBER", primaryKey: true }, TOTAL: { type: "NUMBER(12,2)" } });
  const mergePipe = [{ $group: { _id: "$STORE_ID", TOTAL: { $sum: "$TOTAL" } } }, { $merge: { into: T.STORE_TOTALS, on: { STORE_ID: "STORE_ID" }, fields: ["STORE_ID", "TOTAL"] } }];
  await orders.aggregate(mergePipe);
  await orders.aggregate(mergePipe);
  const totals = await raw<{ STORE_ID: number; TOTAL: string }>(`SELECT STORE_ID, TOTAL FROM "${T.STORE_TOTALS}" ORDER BY STORE_ID`);
  sim.eq("aggregate $merge: run twice, one row per branch with its revenue", totals.map((r) => [Number(r.STORE_ID), cents(r.TOTAL)]), revenueByStore.map((r) => [r.store, r.total]));
  await raw(`CREATE TABLE "${T.ORDERS_OUT}" AS SELECT RECEIPT_NO, TOTAL FROM "${T.ORDERS}" WHERE 1 = 0`);
  await orders.aggregate([{ $match: { QUARTER: "Q3" } }, { $project: { RECEIPT_NO: 1, TOTAL: 1 } }, { $out: T.ORDERS_OUT }]);
  const q3 = model.orders.filter((o) => o.quarter === "Q3");
  sim.eq("aggregate $out: Q3 receipts copied", (await raw<{ R: number }>(`SELECT RECEIPT_NO AS R FROM "${T.ORDERS_OUT}" ORDER BY 1`)).map((r) => Number(r.R)), q3.map((o) => o.receipt));

  // ── Set operations ───────────────────────────────────────────────────────
  const vip = () => customers.find({ TIER: "vip" }).project({ NAME: 1 });
  const cebu = () => customers.find({ CITY: "Cebu" }).project({ NAME: 1 });
  const vipN = custs.filter((c) => c.TIER === "vip").map((c) => c.NAME);
  const cebuN = custs.filter((c) => c.CITY === "Cebu").map((c) => c.NAME);
  sim.eq("union: vip or Cebu, no duplicates", names(await api.OracleCollection.union(vip(), cebu()).sort({ NAME: 1 }).toArray()), [...new Set([...vipN, ...cebuN])].sort());
  sim.eq("union all: every row from both", (await api.OracleCollection.union(vip(), cebu(), { all: true }).toArray()).length, vipN.length + cebuN.length);
  sim.eq("intersect: vip AND Cebu (awaited directly)", names(await api.OracleCollection.intersect(vip(), cebu()).sort({ NAME: 1 })).sort(), vipN.filter((n) => cebuN.includes(n)).sort());
  sim.eq("minus with skip + limit: vip outside Cebu, second page of one", names(await api.OracleCollection.minus(vip(), cebu()).sort({ NAME: 1 }).skip(1).limit(1)), vipN.filter((n) => !cebuN.includes(n)).sort().slice(1, 2));

  // ── CTEs and hierarchies ─────────────────────────────────────────────────
  const big = model.orders.filter((o) => o.total >= 30000);
  const cte = (await api
    .withCTE(db, { VIPS: customers.find({ TIER: "vip" }).project({ ID: 1, NAME: 1 }), BIG: orders.find({ TOTAL: { $gte: 300 } }).project({ CUSTOMER_ID: 1, TOTAL: 1 }) })
    .from("VIPS")
    .join({ from: "BIG", localField: "ID", foreignField: "CUSTOMER_ID", joinType: "inner" })
    .sort({ TOTAL: -1 })
    .skip(0)
    .limit(100)
    .toArray()) as { TOTAL: string }[];
  const vipIds = new Set(custs.filter((c) => c.TIER === "vip").map((c) => c.ID));
  sim.eq("withCTE: vip customers' orders of 300.00 or more", cte.map((r) => cents(r.TOTAL)), big.filter((o) => vipIds.has(o.customerId)).map((o) => o.total).sort((a, b) => b - a));
  const org = (await api.withRecursiveCTE(db, "ORG", { anchor: employees.find({ MANAGER_ID: null }), recursive: { collection: T.EMPLOYEES, joinOn: { MANAGER_ID: "$ORG.ID" } } }).sort({ LVL: 1, NAME: 1 }).skip(0).limit(50).toArray()) as { NAME: string; LVL: number }[];
  const depth = (id: number | null): number => (id == null ? 0 : 1 + depth(staff.find((e) => e.ID === id)?.MANAGER_ID ?? null));
  const expectOrg = staff.map((e) => [e.NAME, depth(e.ID)] as [string, number]).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  sim.eq("withRecursiveCTE: the whole org chart with levels", org.map((r) => [r.NAME, Number(r.LVL)]), expectOrg);
  const cb = (await employees.connectBy({ startWith: { MANAGER_ID: null }, connectBy: { MANAGER_ID: "$PRIOR ID" }, includeLevel: true, orderSiblings: { NAME: 1 }, maxLevel: 2 })) as { NAME: string; LEVEL: number }[];
  sim.eq("connectBy: top two levels, siblings in name order", cb.map((r) => [r.NAME, Number(r.LEVEL)]), [["CEO", 1], ["CFO", 2], ["COO", 2]]);

  // ── Flashback and sampling (direct QueryBuilder) ─────────────────────────
  const past = await new api.QueryBuilder(T.PRODUCTS, { SKU: "P-ADOBO" }, db, null, { asOf: { scn: state.scnBeforeBackOffice } }).next<{ PRICE: string }>();
  const pastTs = await new api.QueryBuilder(T.PRODUCTS, { SKU: "P-COFFEE" }, db, null, { asOf: { timestamp: state.tsBeforeBackOffice } }).next<{ PRICE: string }>();
  sim.eq("QueryBuilder AS OF SCN / TIMESTAMP: prices before the back-office changes", [cents(past?.PRICE), cents(pastTs?.PRICE)], [12000, 5500]);
  sim.eq("current prices after the changes", [cents((await products.findOne<{ PRICE: string }>({ SKU: "P-ADOBO" }))?.PRICE), cents((await products.findOne<{ PRICE: string }>({ SKU: "P-COFFEE" }))?.PRICE)], [model.price.get("P-ADOBO"), model.price.get("P-COFFEE")]);
  sim.eq("QueryBuilder SAMPLE(~100%) with a seed: every line", (await new api.QueryBuilder(T.LINES, {}, db, null, { sample: { percentage: 99.999999, seed: 7 } }).toArray()).length, await lines.countDocuments());

  // Check the count of customers matches the fixture plus the walk-in.
  sim.eq("customers on file: the 12 loaded plus the walk-in", custs.length, CUSTOMERS.length + 1);
}
